begin;
create table message_strategies (
  id text primary key, name text not null, brief text not null, opening_mentions_brand boolean not null, position integer not null
);
insert into message_strategies values
  ('direct','Direct mention','Answer the thread with a relevant, factual Geonode mention.',true,1),
  ('question','Ask a question','Ask one useful question about the actual problem, without a brand mention.',false,2),
  ('context','Relevant context','Add a relevant observation or substantiated experience. Never invent personal experience. No brand mention.',false,3),
  ('help','Practical help','Offer a concrete troubleshooting step or useful explanation without a brand mention.',false,4),
  ('method','Suggest a method','Describe a useful method or comparison criterion without a brand mention.',false,5);
create table message_experiments (
  id uuid primary key default gen_random_uuid(), thread_id text not null references threads(id),
  strategy_id text not null references message_strategies(id), brand text not null default 'Geonode',
  status text not null default 'active' check(status in ('active','succeeded','removed','exhausted','stopped','blocked')),
  max_messages integer not null default 5 check(max_messages between 1 and 10),
  current_step integer not null default 1, success_step integer, success_at timestamptz,
  removed_at timestamptz, removal_step integer, removal_class text, reason text,
  source text not null default 'experiment', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index message_experiment_one_active_thread on message_experiments(thread_id) where status='active';
create table experiment_messages (
  id uuid primary key default gen_random_uuid(), experiment_id uuid not null references message_experiments(id),
  step integer not null check(step>0), parent_message_id uuid references experiment_messages(id),
  kind text not null check(kind in ('comment','reply')), target_url text not null,
  body text, contains_brand boolean not null default false, rationale text,
  status text not null default 'awaiting_draft' check(status in ('awaiting_draft','queued','held','submitting','unknown','submitted','visible','removed','failed','stopped')),
  job_id uuid references jobs(id), source_draft_id uuid references drafts(id),
  provider_status text, transport jsonb, task_id text, reddit_url text, author text,
  rule_check jsonb, context jsonb, evidence jsonb, reason text, removal_class text,
  verified_at timestamptz, removed_at timestamptz, next_check_at timestamptz,
  cancel_requested_at timestamptz, cancel_result text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(experiment_id,step), unique(source_draft_id)
);
create unique index experiment_messages_task on experiment_messages(task_id) where task_id is not null;
create index experiment_messages_due on experiment_messages(status,next_check_at);
create table message_publications (
  id uuid primary key default gen_random_uuid(), message_id uuid not null unique references experiment_messages(id),
  state text not null check(state in ('submitting','unknown','accepted','failed','retry_wait')),
  body text not null, target_url text not null, transport jsonb not null,
  task_id text, response jsonb, reason text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table message_strategies enable row level security;
alter table message_experiments enable row level security;
alter table experiment_messages enable row level security;
alter table message_publications enable row level security;
revoke all on message_strategies,message_experiments,experiment_messages,message_publications from public,anon,authenticated;
grant select,insert,update,delete on message_strategies,message_experiments,experiment_messages,message_publications to service_role;

create function create_experiment_write_job(p_message_id uuid) returns jobs
language plpgsql security definer set search_path=public,pg_temp as $$
declare m experiment_messages; e message_experiments; s message_strategies; j jobs;
begin
  select * into m from experiment_messages where id=p_message_id;
  select * into e from message_experiments where id=m.experiment_id;
  select * into s from message_strategies where id=e.strategy_id;
  if e.status<>'active' or m.status<>'awaiting_draft' then raise exception 'Message is not waiting for a draft'; end if;
  insert into jobs(kind,thread_id,target_url,title,payload,dedupe_key,created_by)
    values('write',e.thread_id,m.target_url,'Write message '||m.step||' · '||s.name,
      jsonb_build_object('task','experiment_message','message_id',m.id,'experiment_id',e.id,'step',m.step,
        'kind',m.kind,'opening_strategy',s.id,'brand',e.brand,'brief',
        case when m.step=1 then s.brief else 'Read the verified previous message and current thread. Decide a useful next reply. Mention Geonode only when relevant, or continue without it. Never invent experience, a customer or an independent endorsement.' end),
      'experiment-message:'||m.id,'message-engine')
    on conflict(dedupe_key) do update set status='planned',attempts=0,claimed_by=null,claim_token=null,lease_until=null,
      finished_at=null,blocked_reason=null,due_at=now(),result=null
    returning * into j;
  update experiment_messages set job_id=j.id where id=m.id;
  return j;
end $$;

create function start_message_experiment(p_thread_id text,p_strategy text,p_request_id uuid,p_max_messages integer default 5)
returns message_experiments language plpgsql security definer set search_path=public,pg_temp as $$
declare e message_experiments; t threads; chosen text; mid uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('message-experiment:start',0));
  if p_request_id is null then raise exception 'A request ID is required'; end if;
  select * into e from message_experiments where id=p_request_id;
  if found then
    if e.thread_id<>p_thread_id or (p_strategy is not null and e.strategy_id<>p_strategy) or e.max_messages<>p_max_messages then
      raise exception 'Request ID belongs to a different experiment'; end if;
    return e;
  end if;
  select * into t from threads where id=p_thread_id;
  if t.id is null or t.locked is true or t.archived is true then raise exception 'Choose an available thread'; end if;
  if p_max_messages is null or p_max_messages not between 1 and 10 then raise exception 'Use between 1 and 10 messages'; end if;
  chosen:=p_strategy;
  if chosen is null then
    select s.id into chosen from message_strategies s left join message_experiments x on x.strategy_id=s.id and x.source='experiment'
      group by s.id,s.position order by count(x.id),s.position limit 1;
  end if;
  if not exists(select 1 from message_strategies where id=chosen) then raise exception 'Unknown opening strategy'; end if;
  insert into message_experiments(id,thread_id,strategy_id,max_messages) values(p_request_id,t.id,chosen,p_max_messages) returning * into e;
  insert into experiment_messages(experiment_id,step,kind,target_url) values(e.id,1,'comment',t.url) returning id into mid;
  perform create_experiment_write_job(mid);
  return e;
end $$;

create function file_experiment_message(p_message_id uuid,p_agent text,p_token uuid,p_body text,p_rationale text,p_context jsonb)
returns experiment_messages language plpgsql security definer set search_path=public,pg_temp as $$
declare m experiment_messages; e message_experiments; j jobs; s message_strategies; branded boolean;
begin
  select * into m from experiment_messages where id=p_message_id;
  select * into e from message_experiments where id=m.experiment_id for update;
  select * into m from experiment_messages where id=p_message_id for update;
  if m.id is null or e.status<>'active' or e.current_step<>m.step then raise exception 'Experiment no longer needs this message'; end if;
  if m.status='queued' and m.body=p_body then return m; end if;
  if m.status<>'awaiting_draft' then raise exception 'Message is no longer editable'; end if;
  if nullif(btrim(p_body),'') is null or length(p_body)>10000 then raise exception 'Message must contain 1–10000 characters'; end if;
  select * into j from jobs where id=m.job_id for update;
  if j.status<>'claimed' or j.claimed_by is distinct from p_agent or j.claim_token is distinct from p_token or p_token is null or j.lease_until<=now() then
    raise exception 'Stale or foreign job lease' using errcode='40001'; end if;
  select * into s from message_strategies where id=e.strategy_id;
  branded:=p_body ~* '\mgeonode\M';
  if m.step=1 and branded<>s.opening_mentions_brand then raise exception 'Opening message does not match its assigned brand condition'; end if;
  if m.parent_message_id is not null and not exists(select 1 from experiment_messages p where p.id=m.parent_message_id and p.status='visible'
    and p.reddit_url=m.target_url and p.experiment_id=e.id) then raise exception 'The preceding message is not visible'; end if;
  update experiment_messages set body=p_body,contains_brand=branded,rationale=p_rationale,context=p_context,status='queued',reason=null,
    next_check_at=null,updated_at=now() where id=m.id returning * into m;
  perform complete_job(j.id,p_agent,'done',jsonb_build_object('message_id',m.id),null,p_token);
  return m;
end $$;

create function edit_experiment_message(p_message_id uuid,p_body text,p_expected_body text)
returns experiment_messages language plpgsql security definer set search_path=public,pg_temp as $$
declare m experiment_messages; e message_experiments; branded boolean;
begin
  select * into m from experiment_messages where id=p_message_id;
  select * into e from message_experiments where id=m.experiment_id for update;
  select * into m from experiment_messages where id=p_message_id for update;
  if e.status<>'active' or m.status not in ('awaiting_draft','queued','held') or m.body is distinct from p_expected_body
    or exists(select 1 from message_publications where message_id=m.id and state<>'retry_wait') then raise exception 'Message changed or was already submitted. Refresh before editing.'; end if;
  if nullif(btrim(p_body),'') is null or length(p_body)>10000 then raise exception 'Message must contain 1–10000 characters'; end if;
  branded:=p_body ~* '\mgeonode\M';
  if m.step=1 and branded<>(select opening_mentions_brand from message_strategies where id=e.strategy_id) then
    raise exception 'Keep the opening strategy: this message has the wrong brand condition'; end if;
  update jobs set status='skipped',lease_until=null,claim_token=null,finished_at=now(),result='{"reason":"Message edited in dashboard"}'
    where id=m.job_id and status in ('planned','claimed','blocked');
  update experiment_messages set body=p_body,contains_brand=branded,status='queued',reason=null,rule_check=null,next_check_at=null,updated_at=now()
    where id=m.id returning * into m;
  return m;
end $$;

create function stop_message_experiment(p_experiment_id uuid,p_reason text default 'Stopped in dashboard')
returns message_experiments language plpgsql security definer set search_path=public,pg_temp as $$
declare e message_experiments;
begin
  select * into e from message_experiments where id=p_experiment_id for update;
  if e.id is null then raise exception 'Experiment not found'; end if;
  if e.status not in ('active','blocked') then return e; end if;
  update message_experiments set status='stopped',reason=p_reason,updated_at=now() where id=e.id returning * into e;
  update experiment_messages set status='stopped',reason=p_reason,updated_at=now()
    where experiment_id=e.id and status in ('awaiting_draft','queued','held');
  update experiment_messages set cancel_requested_at=coalesce(cancel_requested_at,now())
    where experiment_id=e.id and status in ('submitting','submitted','unknown');
  update jobs set status='blocked',blocked_reason=p_reason,lease_until=null,claim_token=null,finished_at=now()
    where id in (select job_id from experiment_messages where experiment_id=e.id) and status in ('planned','claimed');
  return e;
end $$;

create function advance_message_experiment(p_experiment_id uuid) returns message_experiments
language plpgsql security definer set search_path=public,pg_temp as $$
declare e message_experiments; m experiment_messages; mid uuid;
begin
  select * into e from message_experiments where id=p_experiment_id for update;
  if e.status<>'active' then return e; end if;
  select * into m from experiment_messages where experiment_id=e.id and step=e.current_step;
  if m.status<>'visible' then return e; end if;
  if m.contains_brand then
    update message_experiments set status='succeeded',success_at=coalesce(success_at,m.verified_at),success_step=m.step,updated_at=now()
      where id=e.id returning * into e;
  elsif m.step>=e.max_messages then
    update message_experiments set status='exhausted',reason='Reached the message limit without a brand mention',updated_at=now() where id=e.id returning * into e;
  else
    insert into experiment_messages(experiment_id,step,parent_message_id,kind,target_url)
      values(e.id,m.step+1,m.id,'reply',m.reddit_url) returning id into mid;
    update message_experiments set current_step=m.step+1,updated_at=now() where id=e.id returning * into e;
    perform create_experiment_write_job(mid);
  end if;
  return e;
end $$;

create function observe_experiment_message(p_message_id uuid,p_visibility text,p_url text,p_evidence jsonb,p_reason text,p_removal_class text default null)
returns experiment_messages language plpgsql security definer set search_path=public,pg_temp as $$
declare m experiment_messages; e message_experiments;
begin
  select * into m from experiment_messages where id=p_message_id;
  select * into e from message_experiments where id=m.experiment_id for update;
  select * into m from experiment_messages where id=p_message_id for update;
  if m.id is null or m.task_id is null then raise exception 'Submitted message required'; end if;
  if p_visibility not in ('visible','removed','unknown') then raise exception 'Invalid observation'; end if;
  -- Removal is terminal; an older observation cannot resurrect a branch.
  if m.status='removed' then return m; end if;
  update experiment_messages set
    status=case when p_visibility='unknown' then status else p_visibility end,
    reddit_url=coalesce(p_url,reddit_url),evidence=p_evidence,reason=p_reason,
    author=coalesce(p_evidence->>'author',author),
    verified_at=case when p_visibility='visible' then coalesce(verified_at,now()) else verified_at end,
    removed_at=case when p_visibility='removed' then coalesce(removed_at,now()) else removed_at end,
    removal_class=case when p_visibility='removed' then coalesce(p_removal_class,'unknown') else removal_class end,
    next_check_at=now()+interval '30 minutes',updated_at=now() where id=m.id returning * into m;
  if p_visibility='removed' then
    update message_experiments set status=case when success_at is not null then 'succeeded' when status='stopped' then 'stopped' else 'removed' end,
      removed_at=coalesce(removed_at,now()),removal_step=coalesce(removal_step,m.step),removal_class=coalesce(removal_class,m.removal_class),
      reason=coalesce(p_reason,'Message removed'),updated_at=now() where id=e.id;
    update experiment_messages set status='stopped',reason='An earlier message was removed',updated_at=now()
      where experiment_id=e.id and step>m.step and status in ('awaiting_draft','queued','held');
    update experiment_messages set cancel_requested_at=coalesce(cancel_requested_at,now())
      where experiment_id=e.id and step>m.step and status in ('submitting','submitted','unknown');
    update jobs set status='blocked',blocked_reason='An earlier message was removed',lease_until=null,claim_token=null,finished_at=now()
      where id in (select job_id from experiment_messages where experiment_id=e.id and step>m.step) and status in ('planned','claimed');
  elsif p_visibility='visible' then
    perform advance_message_experiment(e.id);
  end if;
  return m;
end $$;

create function reserve_experiment_message(p_message_id uuid,p_body text,p_transport jsonb,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare m experiment_messages; e message_experiments; reserved message_publications; last_global timestamptz; last_sub timestamptz; total_today int; sub text;
begin
  perform pg_advisory_xact_lock(hashtextextended('geonode:publication',0));
  select * into m from experiment_messages where id=p_message_id;
  select * into e from message_experiments where id=m.experiment_id for update;
  select * into m from experiment_messages where id=p_message_id for update;
  if e.status<>'active' or m.status<>'queued' or m.body is distinct from p_body or e.current_step<>m.step then
    return jsonb_build_object('ok',false,'reason','Message or experiment changed'); end if;
  if exists(select 1 from message_publications where message_id=m.id and state<>'retry_wait') then return jsonb_build_object('ok',false,'reason','Delivery already reserved'); end if;
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

create function accept_experiment_message(p_attempt_id uuid,p_task_id text,p_status text,p_response jsonb)
returns experiment_messages language plpgsql security definer set search_path=public,pg_temp as $$
declare a message_publications; m experiment_messages; e message_experiments;
begin
  select * into a from message_publications where id=p_attempt_id;
  select * into m from experiment_messages where id=a.message_id;
  select * into e from message_experiments where id=m.experiment_id for update;
  select * into a from message_publications where id=p_attempt_id for update;
  if a.id is null or nullif(p_task_id,'') is null then raise exception 'Attempt and task ID required'; end if;
  if a.task_id is not null and a.task_id<>p_task_id then raise exception 'Attempt already has another task'; end if;
  if exists(select 1 from experiment_messages where task_id=p_task_id and id<>a.message_id) then raise exception 'Task belongs to another message'; end if;
  update message_publications set state='accepted',task_id=p_task_id,response=p_response,reason=null,updated_at=now() where id=a.id;
  update experiment_messages set status=case when status in ('visible','removed') then status else 'submitted' end,
    task_id=p_task_id,provider_status=p_status,next_check_at=now(),updated_at=now(),
    cancel_requested_at=case when e.status<>'active' then coalesce(cancel_requested_at,now()) else cancel_requested_at end
    where id=a.message_id returning * into m;
  return m;
end $$;

-- Definite provider refusal and rate limiting are different from uncertain delivery.
create function fail_experiment_message(p_message_id uuid,p_reason text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare m experiment_messages; e message_experiments;
begin
  select * into m from experiment_messages where id=p_message_id;
  select * into e from message_experiments where id=m.experiment_id for update;
  if m.id is null then raise exception 'Message not found'; end if;
  update experiment_messages set status='failed',reason=p_reason,updated_at=now() where id=m.id and status not in ('visible','removed','stopped');
  if e.status='active' then
    perform stop_message_experiment(e.id,p_reason);
    update message_experiments set status='blocked',reason=p_reason,updated_at=now() where id=e.id;
  end if;
end $$;

create function defer_experiment_publication(p_attempt_id uuid,p_response jsonb) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare a message_publications; e message_experiments;
begin
  select * into a from message_publications where id=p_attempt_id;
  select e1.* into e from message_experiments e1 join experiment_messages m on m.experiment_id=e1.id where m.id=a.message_id for update of e1;
  if a.state<>'submitting' or a.task_id is not null then raise exception 'Submission cannot be retried'; end if;
  update message_publications set state='retry_wait',response=p_response,reason='Engain rate limit; no task created',updated_at=now() where id=a.id;
  update experiment_messages set status=case when e.status='active' then 'queued' else 'stopped' end,
    reason='Engain rate limit; retry scheduled',next_check_at=now()+interval '15 minutes',updated_at=now() where id=a.message_id;
end $$;

create view message_experiment_results with (security_invoker=on) as
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
  round(avg(e.success_step-1) filter(where e.success_at is not null),2) average_replies
from message_strategies s left join message_experiments e on e.strategy_id=s.id and e.source='experiment' group by s.id,s.name,s.position;
revoke all on message_experiment_results from public,anon,authenticated;
grant select on message_experiment_results to service_role;
create view message_depth_results with (security_invoker=on) as
select n.step,n.step-1 replies,
  (select count(*)::integer from message_experiments where success_step=n.step and source='experiment') successes,
  (select count(*)::integer from message_experiments where removal_step=n.step and source='experiment') removals,
  (select count(*)::integer from experiment_messages m join message_experiments e on e.id=m.experiment_id where m.step=n.step and m.task_id is not null and e.source='experiment') submitted
from generate_series(1,10) as n(step);
revoke all on message_depth_results from public,anon,authenticated;
grant select on message_depth_results to service_role;

-- Retain existing unsent messages without changing their wording. Their old
-- drafts remain available as history; only the new engine delivers them.
do $$
declare d drafts; eid uuid; mid uuid;
begin
  for d in select distinct on (thread_id) * from drafts
    where kind='comment' and mode<>'scenario' and status in ('pending','edited','approved')
      and thread_id is not null and pullback_requested_at is null
      and not exists(select 1 from engain_tasks where draft_id=drafts.id)
      and not exists(select 1 from publication_attempts where draft_id=drafts.id)
    order by thread_id,created_at desc
  loop
    insert into message_experiments(thread_id,strategy_id,source)
      values(d.thread_id,case when d.body ~* '\mgeonode\M' then 'direct' else 'help' end,'existing_message') returning id into eid;
    insert into experiment_messages(experiment_id,step,kind,target_url,body,contains_brand,status,source_draft_id,context,reason)
      values(eid,1,'comment',(select url from threads where id=d.thread_id),d.body,d.body ~* '\mgeonode\M',
        case when d.redirect_pending or d.gate_failed_at is not null then 'held' else 'queued' end,d.id,d.thread_context,
        coalesce(d.gate_failure,d.redirect_note,d.automatic_note)) returning id into mid;
    update drafts set sequence_hold=true where id=d.id;
  end loop;
end $$;
-- Fence an older deployed sender during the migration/deployment window.
-- Already reserved legacy tasks remain reconcilable; no new legacy send can reserve.
alter function reserve_publication(uuid,text,text,text) rename to reserve_legacy_publication;
create function reserve_publication(p_draft_id uuid,p_body text,p_parent_url text,p_account_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if exists(select 1 from workflow_state where key='message_workflow' and value->>'enabled'='true') then
    return jsonb_build_object('ok',false,'reason','Legacy publication was replaced by message experiments');
  end if;
  return reserve_legacy_publication(p_draft_id,p_body,p_parent_url,p_account_id);
end $$;
revoke all on function reserve_publication(uuid,text,text,text) from public,anon,authenticated;
grant execute on function reserve_publication(uuid,text,text,text) to service_role;

insert into workflow_state(key,value) values('message_workflow','{"enabled":true}')
  on conflict(key) do update set value=excluded.value,updated_at=now();
update jobs set status='blocked',blocked_reason='Replaced by message experiments',lease_until=null,claim_token=null,finished_at=now()
  where kind in ('write','draft_followup','check_replies') and status in ('planned','claimed') and coalesce(payload->>'task','')<>'experiment_message';
update sequence_runs set status='cancelled',note='Replaced by message experiments',updated_at=now() where status='open';
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.proname in ('create_experiment_write_job','start_message_experiment','file_experiment_message','edit_experiment_message',
      'fail_experiment_message','defer_experiment_publication','stop_message_experiment','advance_message_experiment','observe_experiment_message','reserve_experiment_message','accept_experiment_message')
  loop
    execute format('revoke all on function %s from public,anon,authenticated',f);
    execute format('grant execute on function %s to service_role',f);
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
