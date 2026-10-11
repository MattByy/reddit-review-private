begin;
alter table experiment_messages
  add column previous_message_id uuid references experiment_messages(id),
  add column reply_mode text check(reply_mode in ('opening','reply','chain','sibling')),
  add column depth integer check(depth>0),
  add column decision_due_at timestamptz not null default now(),
  add column last_checked_at timestamptz,
  add column last_visible_at timestamptz,
  add column last_visibility text,
  add column monitor_until timestamptz,
  add column monitor_complete_at timestamptz;
alter table message_experiments drop constraint message_experiments_status_check;
alter table message_experiments add constraint message_experiments_status_check
  check(status in ('active','monitoring','succeeded','removed','exhausted','stopped','blocked'));
alter table message_experiments add column brand_visible_at timestamptz,add column monitor_until timestamptz;

-- Preserve every existing body, chosen parent and provider task.
update experiment_messages m set previous_message_id=p.id
  from experiment_messages p where p.experiment_id=m.experiment_id and p.step=m.step-1;
with recursive tree as (
  select id,1 as level from experiment_messages where parent_message_id is null
  union all select m.id,t.level+1 from experiment_messages m join tree t on m.parent_message_id=t.id
) update experiment_messages m set depth=t.level from tree t where m.id=t.id;
update experiment_messages set reply_mode=case when step=1 then 'opening' when step=2 then 'reply' else 'chain' end,
  last_visible_at=verified_at,last_checked_at=verified_at,last_visibility=case when status='visible' then 'visible' when status='removed' then 'removed' else null end,
  monitor_until=verified_at+interval '7 days',decision_due_at=created_at;
update message_experiments e set brand_visible_at=m.verified_at,monitor_until=m.verified_at+interval '7 days',success_at=null,
  status=case when e.removed_at is not null then 'removed' else 'monitoring' end
  from experiment_messages m where m.experiment_id=e.id and m.step=e.success_step and e.status='succeeded';
update experiment_messages m set monitor_until=greatest(m.monitor_until,e.monitor_until)
  from message_experiments e where e.id=m.experiment_id and e.status='monitoring';
-- A queue item has a published source, but its reply parent is selected only when written.
update experiment_messages set parent_message_id=null,reply_mode=null,depth=null where step>1 and status='awaiting_draft' and body is null;

create function experiment_queue_due(p_experiment_id uuid) returns timestamptz
language sql stable security definer set search_path=public,pg_temp as $$
  with activity as (
    select a.created_at as at,t.subreddit from message_publications a join experiment_messages m on m.id=a.message_id
      join message_experiments e on e.id=m.experiment_id join threads t on t.id=e.thread_id where a.state not in ('failed','retry_wait')
    union all select submitted_at,subreddit from engain_tasks where status is distinct from 'test_artifact'
  ) select greatest(now(),max(at)+interval '45 minutes',
    max(at) filter(where subreddit=(select t.subreddit from message_experiments e join threads t on t.id=e.thread_id where e.id=p_experiment_id))+interval '24 hours',
    case when count(*) filter(where at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')>=20
      then (date_trunc('day',now() at time zone 'UTC')+interval '1 day') at time zone 'UTC' else now() end) from activity
$$;

create or replace function create_experiment_write_job(p_message_id uuid) returns jobs
language plpgsql security definer set search_path=public,pg_temp as $$
declare m experiment_messages; e message_experiments; s message_strategies; j jobs;
begin
  select * into m from experiment_messages where id=p_message_id;
  select * into e from message_experiments where id=m.experiment_id;
  select * into s from message_strategies where id=e.strategy_id;
  if e.status<>'active' or m.status<>'awaiting_draft' then raise exception 'Message is not queued for writing'; end if;
  insert into jobs(kind,thread_id,target_url,title,payload,dedupe_key,created_by,due_at)
    values('write',e.thread_id,m.target_url,'Message '||m.step||' · '||s.name,
      jsonb_build_object('task','experiment_message','message_id',m.id,'experiment_id',e.id,'step',m.step,'previous_message_id',m.previous_message_id,
        'kind',m.kind,'opening_strategy',s.id,'brand',e.brand,'brief',case when m.step=1 then s.brief
        when m.step=2 then 'Reply to the published opening. Decide whether this reply should mention Geonode. No sibling option on the first reply.'
        else 'Choose chain (reply underneath the latest published message) or sibling (reply to its parent), then decide whether to mention Geonode. Write only this message. The queue owns timing; wait is not a content action.' end),
      'experiment-message:'||m.id,'message-engine',m.decision_due_at)
    on conflict(dedupe_key) do update set status='planned',attempts=0,claimed_by=null,claim_token=null,lease_until=null,
      finished_at=null,blocked_reason=null,due_at=excluded.due_at,payload=excluded.payload,target_url=excluded.target_url,result=null returning * into j;
  update experiment_messages set job_id=j.id where id=m.id;
  return j;
end $$;

-- Called inside a locked experiment transaction by filing/editing, never to post.
create function choose_experiment_parent(p_message_id uuid,p_reply_mode text) returns experiment_messages
language plpgsql security definer set search_path=public,pg_temp as $$
declare m experiment_messages; prior experiment_messages; parent experiment_messages;
begin
  select * into m from experiment_messages where id=p_message_id;
  if m.step=1 then
    if p_reply_mode is not null and p_reply_mode<>'opening' then raise exception 'The first message is an opening comment'; end if;
    update experiment_messages set reply_mode='opening',depth=1 where id=m.id returning * into m;return m;
  end if;
  select * into prior from experiment_messages where id=m.previous_message_id;
  if prior.id is null or prior.experiment_id<>m.experiment_id or prior.step<>m.step-1 or prior.status<>'visible' or prior.reddit_url is null or prior.contains_brand then
    raise exception 'The preceding publication cannot return to the writing queue'; end if;
  if m.step=2 then
    if p_reply_mode is not null and p_reply_mode<>'reply' then raise exception 'The first follow-up must reply to the opening'; end if;
    parent:=prior;
  elsif p_reply_mode='chain' then parent:=prior;
  elsif p_reply_mode='sibling' then
    select * into parent from experiment_messages where id=prior.parent_message_id and experiment_id=m.experiment_id;
  else raise exception 'Choose chain or sibling for this queue turn'; end if;
  if parent.id is null or parent.status<>'visible' or parent.reddit_url is null or parent.depth is null then raise exception 'Selected parent is not verified visible'; end if;
  update experiment_messages set parent_message_id=parent.id,target_url=parent.reddit_url,depth=parent.depth+1,
    reply_mode=case when m.step=2 then 'reply' else p_reply_mode end where id=m.id returning * into m;
  return m;
end $$;

drop function file_experiment_message(uuid,text,uuid,text,text,jsonb);
create function file_experiment_message(p_message_id uuid,p_agent text,p_token uuid,p_body text,p_rationale text,p_context jsonb,p_reply_mode text default null)
returns experiment_messages language plpgsql security definer set search_path=public,pg_temp as $$
declare m experiment_messages; e message_experiments; j jobs; branded boolean; mode text;
begin
  select * into m from experiment_messages where id=p_message_id;
  select * into e from message_experiments where id=m.experiment_id for update;
  select * into m from experiment_messages where id=p_message_id for update;
  if m.id is null or e.status<>'active' or e.current_step<>m.step then raise exception 'Experiment no longer needs this message'; end if;
  mode:=coalesce(p_reply_mode,case when m.step=1 then 'opening' when m.step=2 then 'reply' end);
  if m.status='queued' and m.body=p_body and m.reply_mode=mode then return m; end if;
  if m.status<>'awaiting_draft' or m.decision_due_at>now() then raise exception 'This message is not due for writing'; end if;
  select * into j from jobs where id=m.job_id for update;
  if j.status<>'claimed' or j.claimed_by is distinct from p_agent or j.claim_token is distinct from p_token or p_token is null or j.lease_until<=now() then
    raise exception 'Stale or foreign job lease' using errcode='40001'; end if;
  if nullif(btrim(p_body),'') is null or length(p_body)>10000 then raise exception 'Message must contain 1–10000 characters'; end if;
  branded:=p_body ~* '\mgeonode\M';
  if m.step=1 and branded<>(select opening_mentions_brand from message_strategies where id=e.strategy_id) then raise exception 'Opening message does not match its assigned brand condition'; end if;
  m:=choose_experiment_parent(m.id,mode);
  update experiment_messages set body=p_body,contains_brand=branded,rationale=p_rationale,context=p_context,status='queued',reason=null,
    next_check_at=null,updated_at=now() where id=m.id returning * into m;
  perform complete_job(j.id,p_agent,'done',jsonb_build_object('message_id',m.id,'reply_mode',m.reply_mode,'parent_message_id',m.parent_message_id),null,p_token);
  return m;
end $$;

drop function edit_experiment_message(uuid,text,text);
create function edit_experiment_message(p_message_id uuid,p_body text,p_expected_body text,p_reply_mode text default null,p_expected_parent uuid default null)
returns experiment_messages language plpgsql security definer set search_path=public,pg_temp as $$
declare m experiment_messages; e message_experiments; branded boolean;
begin
  select * into m from experiment_messages where id=p_message_id;
  select * into e from message_experiments where id=m.experiment_id for update;
  select * into m from experiment_messages where id=p_message_id for update;
  if e.status<>'active' or m.status not in ('awaiting_draft','queued','held') or m.body is distinct from p_expected_body
    or m.parent_message_id is distinct from p_expected_parent or exists(select 1 from message_publications where message_id=m.id and state<>'retry_wait') then
    raise exception 'Message changed or was already submitted. Refresh before editing.'; end if;
  if nullif(btrim(p_body),'') is null or length(p_body)>10000 then raise exception 'Message must contain 1–10000 characters'; end if;
  branded:=p_body ~* '\mgeonode\M';
  if m.step=1 and branded<>(select opening_mentions_brand from message_strategies where id=e.strategy_id) then raise exception 'Keep the assigned opening brand condition'; end if;
  m:=choose_experiment_parent(m.id,p_reply_mode);
  update jobs set status='skipped',lease_until=null,claim_token=null,finished_at=now(),result='{"reason":"Message edited in dashboard"}' where id=m.job_id and status in ('planned','claimed','blocked');
  update experiment_messages set body=p_body,contains_brand=branded,status='queued',reason=null,rule_check=null,next_check_at=null,updated_at=now() where id=m.id returning * into m;
  return m;
end $$;

create or replace function advance_message_experiment(p_experiment_id uuid) returns message_experiments
language plpgsql security definer set search_path=public,pg_temp as $$
declare e message_experiments; m experiment_messages; mid uuid;
begin
  select * into e from message_experiments where id=p_experiment_id for update;
  if e.status<>'active' then return e; end if;
  select * into m from experiment_messages where experiment_id=e.id and step=e.current_step;
  if m.status<>'visible' then return e; end if;
  if m.contains_brand then
    update message_experiments set status='monitoring',brand_visible_at=m.verified_at,success_step=m.step,monitor_until=m.verified_at+interval '7 days',updated_at=now()
      where id=e.id returning * into e;
    update experiment_messages set monitor_until=greatest(monitor_until,e.monitor_until),monitor_complete_at=null where experiment_id=e.id and status='visible';
  elsif m.step>=e.max_messages then
    update message_experiments set status='exhausted',reason='Reached the message limit without a brand mention',updated_at=now() where id=e.id returning * into e;
  else
    insert into experiment_messages(experiment_id,step,previous_message_id,kind,target_url,decision_due_at)
      values(e.id,m.step+1,m.id,'reply',m.reddit_url,experiment_queue_due(e.id)) returning id into mid;
    update message_experiments set current_step=m.step+1,updated_at=now() where id=e.id returning * into e;
    perform create_experiment_write_job(mid);
  end if;
  return e;
end $$;

create or replace function observe_experiment_message(p_message_id uuid,p_visibility text,p_url text,p_evidence jsonb,p_reason text,p_removal_class text default null)
returns experiment_messages language plpgsql security definer set search_path=public,pg_temp as $$
declare m experiment_messages; e message_experiments;
begin
  select * into m from experiment_messages where id=p_message_id;
  select * into e from message_experiments where id=m.experiment_id for update;
  select * into m from experiment_messages where id=p_message_id for update;
  if m.id is null or m.task_id is null then raise exception 'Submitted message required'; end if;
  if p_visibility not in ('visible','removed','unknown') then raise exception 'Invalid observation'; end if;
  if m.status='removed' then return m; end if;
  update experiment_messages set status=case when p_visibility='unknown' then status else p_visibility end,
    reddit_url=coalesce(p_url,reddit_url),evidence=p_evidence,reason=p_reason,author=coalesce(p_evidence->>'author',author),
    verified_at=case when p_visibility='visible' then coalesce(verified_at,now()) else verified_at end,
    last_checked_at=now(),last_visibility=p_visibility,last_visible_at=case when p_visibility='visible' then now() else last_visible_at end,
    monitor_until=case when p_visibility='visible' then coalesce(monitor_until,now()+interval '7 days') else monitor_until end,
    monitor_complete_at=case when p_visibility='visible' and monitor_until<=now() then now() else monitor_complete_at end,
    removed_at=case when p_visibility='removed' then coalesce(removed_at,now()) else removed_at end,
    removal_class=case when p_visibility='removed' then coalesce(p_removal_class,'unknown') else removal_class end,
    next_check_at=now()+interval '30 minutes',updated_at=now() where id=m.id returning * into m;
  if p_visibility='removed' then
    update message_experiments set status=case when success_at is not null then 'succeeded' when status='stopped' then 'stopped' else 'removed' end,
      removed_at=coalesce(removed_at,now()),removal_step=coalesce(removal_step,m.step),removal_class=coalesce(removal_class,m.removal_class),
      reason=coalesce(p_reason,'Message removed'),updated_at=now() where id=e.id;
    update experiment_messages set status='stopped',reason='An earlier message was removed',updated_at=now()
      where experiment_id=e.id and status in ('awaiting_draft','queued','held');
    update experiment_messages set cancel_requested_at=coalesce(cancel_requested_at,now())
      where experiment_id=e.id and status in ('submitting','submitted','unknown');
    update jobs set status='blocked',blocked_reason='An earlier message was removed',lease_until=null,claim_token=null,finished_at=now()
      where id in (select job_id from experiment_messages where experiment_id=e.id) and status in ('planned','claimed');
  elsif p_visibility='visible' then
    if e.status='monitoring' and m.step=e.success_step and e.monitor_until<=now() and e.removed_at is null then
      update message_experiments set status='succeeded',success_at=now(),updated_at=now() where id=e.id;
    else perform advance_message_experiment(e.id); end if;
  end if;
  return m;
end $$;

drop function reserve_experiment_message(uuid,text,jsonb,jsonb);
create function reserve_experiment_message(p_message_id uuid,p_body text,p_transport jsonb,p_context jsonb,p_target_url text default null,p_parent_message_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare m experiment_messages; e message_experiments; reserved message_publications; last_global timestamptz; last_sub timestamptz; total_today int; sub text;
begin
  perform pg_advisory_xact_lock(hashtextextended('geonode:publication',0));
  select * into m from experiment_messages where id=p_message_id;
  select * into e from message_experiments where id=m.experiment_id for update;
  select * into m from experiment_messages where id=p_message_id for update;
  if e.status<>'active' or m.status<>'queued' or m.body is distinct from p_body or e.current_step<>m.step or m.decision_due_at>now()
    or m.target_url is distinct from p_target_url or m.parent_message_id is distinct from p_parent_message_id then
    return jsonb_build_object('ok',false,'reason','Message or experiment changed'); end if;
  if exists(select 1 from message_publications where message_id=m.id and state<>'retry_wait') then return jsonb_build_object('ok',false,'reason','Delivery already reserved'); end if;
  if m.previous_message_id is not null and not exists(select 1 from experiment_messages prior where prior.id=m.previous_message_id and prior.experiment_id=e.id and prior.status='visible' and prior.step=m.step-1 and not prior.contains_brand) then
    return jsonb_build_object('ok',false,'reason','The latest publication is no longer eligible'); end if;
  if m.parent_message_id is not null and not exists(select 1 from experiment_messages p where p.id=m.parent_message_id and p.experiment_id=e.id and p.status='visible' and p.reddit_url=m.target_url) then
    return jsonb_build_object('ok',false,'reason','Previous message is no longer visible'); end if;
  if coalesce(p_transport->>'mode','') not in ('pool','private') or (p_transport->>'mode'='pool' and nullif(p_transport->>'project_id','') is null)
    or (p_transport->>'mode'='private' and nullif(p_transport->>'account_id','') is null) then raise exception 'Invalid delivery route'; end if;
  if exists(select 1 from message_publications a join experiment_messages x on x.id=a.message_id join message_experiments r on r.id=x.experiment_id
    where r.thread_id=e.thread_id and a.body=p_body and a.state not in ('failed','retry_wait')) or
    exists(select 1 from engain_tasks where thread_id=e.thread_id and content=p_body and status is distinct from 'test_artifact') then
    return jsonb_build_object('ok',false,'reason','This message was already submitted on this thread'); end if;
  select subreddit into sub from threads where id=e.thread_id;
  with activity as (
    select a.created_at at,t.subreddit from message_publications a join experiment_messages x on x.id=a.message_id
      join message_experiments r on r.id=x.experiment_id join threads t on t.id=r.thread_id where a.state not in ('failed','retry_wait')
    union all select submitted_at,subreddit from engain_tasks where status is distinct from 'test_artifact'
  ) select max(at),max(at) filter(where subreddit=sub),count(*) filter(where at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')
    into last_global,last_sub,total_today from activity;
  if last_global>now()-interval '45 minutes' or last_sub>now()-interval '24 hours' or total_today>=20 then
    return jsonb_build_object('ok',false,'reason','Waiting for the sending interval (45 minutes overall, 24 hours per subreddit, 20 per day)'); end if;
  insert into message_publications(message_id,state,body,target_url,transport)
    values(m.id,'submitting',p_body,m.target_url,p_transport)
    on conflict(message_id) do update set state='submitting',body=excluded.body,target_url=excluded.target_url,transport=excluded.transport,
      response=null,reason=null,created_at=now(),updated_at=now() where message_publications.state='retry_wait' returning * into reserved;
  update experiment_messages set status='submitting',transport=p_transport,context=p_context,reason=null,updated_at=now() where id=m.id;
  return jsonb_build_object('ok',true,'attempt',reserved);
end $$;

create or replace view message_experiment_results with (security_invoker=on) as
select s.id strategy_id,s.name,s.position,
  count(e.id)::integer total,
  count(e.id) filter(where e.status='active')::integer active,
  count(e.id) filter(where e.status in ('succeeded','removed','exhausted'))::integer finished,
  count(e.id) filter(where e.success_at is not null)::integer successes,
  count(e.id) filter(where e.success_at is not null and e.removed_at is null)::integer successes_still_visible,
  count(e.id) filter(where e.removed_at is not null)::integer removals,
  count(e.id) filter(where e.success_at is not null and e.removed_at is not null)::integer later_removals,
  count(e.id) filter(where e.status='exhausted')::integer exhausted,
  count(e.id) filter(where e.status in ('blocked','stopped'))::integer excluded,
  round(100.0*count(e.id) filter(where e.success_at is not null)/nullif(count(e.id) filter(where e.status in ('succeeded','removed','exhausted')),0),1) success_percent,
  round(avg(e.success_step-1) filter(where e.success_at is not null),2) average_replies,
  count(e.id) filter(where e.status='monitoring')::integer monitoring,
  count(e.id) filter(where e.brand_visible_at is not null)::integer brand_mentions
from message_strategies s left join message_experiments e on e.strategy_id=s.id and e.source='experiment' group by s.id,s.name,s.position;
revoke all on message_experiment_results from public,anon,authenticated;
grant select on message_experiment_results to service_role;
create or replace view message_depth_results with (security_invoker=on) as
select n.step,n.step-1 replies,
  (select count(*)::integer from message_experiments where success_step=n.step and success_at is not null and source='experiment') successes,
  (select count(*)::integer from message_experiments where removal_step=n.step and source='experiment') removals,
  (select count(*)::integer from experiment_messages m join message_experiments e on e.id=m.experiment_id where m.step=n.step and m.task_id is not null and e.source='experiment') submitted
from generate_series(1,10) as n(step);
revoke all on message_depth_results from public,anon,authenticated;
grant select on message_depth_results to service_role;

create or replace function stop_message_experiment(p_experiment_id uuid,p_reason text default 'Stopped in dashboard')
returns message_experiments language plpgsql security definer set search_path=public,pg_temp as $$
declare e message_experiments;
begin
  select * into e from message_experiments where id=p_experiment_id for update;
  if e.id is null then raise exception 'Experiment not found'; end if;
  if e.status not in ('active','monitoring','blocked') then return e; end if;
  update message_experiments set status='stopped',reason=p_reason,updated_at=now() where id=e.id returning * into e;
  update experiment_messages set status='stopped',reason=p_reason,updated_at=now()
    where experiment_id=e.id and status in ('awaiting_draft','queued','held');
  update experiment_messages set cancel_requested_at=coalesce(cancel_requested_at,now())
    where experiment_id=e.id and status in ('submitting','submitted','unknown');
  update jobs set status='blocked',blocked_reason=p_reason,lease_until=null,claim_token=null,finished_at=now()
    where id in (select job_id from experiment_messages where experiment_id=e.id) and status in ('planned','claimed');
  return e;
end $$;


create view message_shape_results with (security_invoker=on) as
with shapes as (
  select e.id,e.status,e.success_at,
    string_agg(m.depth::text,',' order by m.step) as depths,
    string_agg(coalesce(p.step,0)::text,',' order by m.step) as parents
  from message_experiments e join experiment_messages m on m.experiment_id=e.id and m.verified_at is not null
    left join experiment_messages p on p.id=m.parent_message_id
  where e.source='experiment' group by e.id,e.status,e.success_at
) select depths,parents,count(*)::integer experiments,
  count(*) filter(where status in ('succeeded','removed','exhausted'))::integer finished,
  count(*) filter(where success_at is not null)::integer successes,
  round(100.0*count(*) filter(where success_at is not null)/nullif(count(*) filter(where status in ('succeeded','removed','exhausted')),0),1) success_percent
from shapes group by depths,parents;
revoke all on message_shape_results from public,anon,authenticated;
grant select on message_shape_results to service_role;

-- A candidate undergoing the seven-day check still owns the thread.
drop index message_experiment_one_active_thread;
create unique index message_experiment_one_active_thread on message_experiments(thread_id) where status in ('active','monitoring');

-- Refresh only unclaimed future writing; invalidate old leases before a worker can file a forced chain.
do $$
declare m experiment_messages;
begin
  for m in select * from experiment_messages where status='awaiting_draft'
  loop
    update experiment_messages set decision_due_at=case when m.step>1 then experiment_queue_due(m.experiment_id) else m.decision_due_at end where id=m.id;
    perform create_experiment_write_job(m.id);
  end loop;
end $$;
update workflow_state set value=value||'{"protocol_version":4,"queue_decisions":true}'::jsonb,updated_at=now() where key='message_workflow';
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.proname in ('experiment_queue_due','choose_experiment_parent','file_experiment_message','edit_experiment_message','reserve_experiment_message')
  loop
    execute format('revoke all on function %s from public,anon,authenticated',f);
    execute format('grant execute on function %s to service_role',f);
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
