begin;
alter table message_experiments add column max_depth integer not null default 4 check(max_depth between 1 and 10);
alter table message_experiments alter column max_messages set default 6;
-- Preserve historical trees; new experiments default to four levels.
update message_experiments e set max_depth=greatest(4,coalesce((select max(depth) from experiment_messages where experiment_id=e.id),1));
alter table message_strategies add column action_name text,add column followup_brief text;
update message_strategies set action_name=case id when 'direct' then 'Relevant recommendation' else name end,
 followup_brief=case id
 when 'direct' then 'Recommend a relevant tool or approach with factual support and required attribution.'
 when 'question' then 'Ask one useful question that moves the current discussion forward.'
 when 'context' then 'Add a relevant observation or substantiated experience. Never invent experience.'
 when 'help' then 'Offer a concrete troubleshooting step or explanation.'
 when 'method' then 'Suggest a method or comparison criterion.' end;
alter table experiment_messages add column suggested_action text references message_strategies(id),
 add column content_action text references message_strategies(id),add column action_override_reason text,
 add column draft_body text,add column humanization jsonb;
-- Do not invent action labels for already written or imported messages.

create function assign_message_action() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare e message_experiments;
begin
 select * into e from message_experiments where id=new.experiment_id;
 if e.source<>'experiment' then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended('message-content-assignment',0));
 if new.step=1 then new.suggested_action:=e.strategy_id;
 else
   select s.id into new.suggested_action from message_strategies s
     left join experiment_messages m on m.suggested_action=s.id and (case when m.step=2 then 'first_reply' when m.step>2 then 'later_reply' else 'opening' end)=(case when new.step=2 then 'first_reply' else 'later_reply' end)
     left join message_experiments x on x.id=m.experiment_id and x.source='experiment'
     group by s.id order by count(x.id),random() limit 1;
 end if;
 return new;
end $$;

create trigger message_action_assignment before insert on experiment_messages for each row execute function assign_message_action();

create function enforce_message_limits() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare e message_experiments; actual_depth integer;
begin
 select * into e from message_experiments where id=new.experiment_id;
 if new.step>e.max_messages then raise exception 'Maximum message count reached'; end if;
 if new.parent_message_id is not null then
   select depth+1 into actual_depth from experiment_messages where id=new.parent_message_id and experiment_id=new.experiment_id;
   if actual_depth is null or new.depth is distinct from actual_depth then raise exception 'Reply depth must match its parent'; end if;
 end if;
 if new.depth>e.max_depth then raise exception 'Maximum reply depth reached; choose an eligible sibling'; end if;
 return new;
end $$;
create trigger message_limits before insert or update of step,depth,parent_message_id on experiment_messages for each row execute function enforce_message_limits();

drop function start_message_experiment(text,text,uuid,integer);
create function start_message_experiment(p_thread_id text,p_strategy text,p_request_id uuid,p_max_messages integer default 6,p_max_depth integer default 4)
returns message_experiments language plpgsql security definer set search_path=public,pg_temp as $$
declare e message_experiments; t threads; chosen text; mid uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('message-experiment:start',0));
  if p_request_id is null then raise exception 'A request ID is required'; end if;
  select * into e from message_experiments where id=p_request_id;
  if found then
    if e.thread_id<>p_thread_id or (p_strategy is not null and e.strategy_id<>p_strategy) or e.max_messages<>p_max_messages or e.max_depth<>p_max_depth then
      raise exception 'Request ID belongs to a different experiment'; end if;
    return e;
  end if;
  select * into t from threads where id=p_thread_id;
  if t.id is null or t.locked is true or t.archived is true then raise exception 'Choose an available thread'; end if;
  if p_max_messages is null or p_max_messages not between 1 and 10 then raise exception 'Use between 1 and 10 messages'; end if;
  if p_max_depth is null or p_max_depth not between 1 and 10 then raise exception 'Use between 1 and 10 levels'; end if;
  chosen:=p_strategy;
  if chosen is null then
    select s.id into chosen from message_strategies s left join message_experiments x on x.strategy_id=s.id and x.source='experiment'
      group by s.id,s.position order by count(x.id),s.position limit 1;
  end if;
  if not exists(select 1 from message_strategies where id=chosen) then raise exception 'Unknown opening strategy'; end if;
  insert into message_experiments(id,thread_id,strategy_id,max_messages,max_depth) values(p_request_id,t.id,chosen,p_max_messages,p_max_depth) returning * into e;
  insert into experiment_messages(experiment_id,step,kind,target_url) values(e.id,1,'comment',t.url) returning id into mid;
  perform create_experiment_write_job(mid);
  return e;
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
  elsif e.max_depth<2 then
    update message_experiments set status='exhausted',reason='Reached the depth limit; no reply target remains',updated_at=now() where id=e.id returning * into e;
  else
    insert into experiment_messages(experiment_id,step,previous_message_id,kind,target_url,decision_due_at)
      values(e.id,m.step+1,m.id,'reply',m.reddit_url,experiment_queue_due(e.id)) returning id into mid;
    update message_experiments set current_step=m.step+1,updated_at=now() where id=e.id returning * into e;
    perform create_experiment_write_job(mid);
  end if;
  return e;
end $$;


-- Assign suggestions to unwritten queue turns only. Existing copy is unchanged.
do $$
declare m experiment_messages; a text;
begin
 for m in select * from experiment_messages where status='awaiting_draft' and body is null order by created_at,id loop
   if m.step=1 then select strategy_id into a from message_experiments where id=m.experiment_id;
   else
     select s.id into a from message_strategies s left join experiment_messages x on x.suggested_action=s.id
       and (case when x.step=2 then 2 when x.step>2 then 3 else 1 end)=(case when m.step=2 then 2 else 3 end)
       group by s.id order by count(x.id),random() limit 1;
   end if;
   update experiment_messages set suggested_action=a where id=m.id;
 end loop;
end $$;

create function save_message_decision(p_message_id uuid,p_action text,p_override text,p_draft text,p_humanization jsonb,p_body text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare m experiment_messages; e message_experiments; chosen text;
begin
 select * into m from experiment_messages where id=p_message_id;
 select * into e from message_experiments where id=m.experiment_id;
 chosen:=coalesce(p_action,m.content_action,m.suggested_action);
 p_humanization:=nullif(p_humanization,'null'::jsonb);
 if chosen=m.content_action and p_override is null then p_override:=m.action_override_reason; end if;
 if chosen is not null and not exists(select 1 from message_strategies where id=chosen) then raise exception 'Unknown content action'; end if;
 if m.step=1 and chosen is not null and chosen<>e.strategy_id then raise exception 'Keep the assigned opening strategy'; end if;
 if chosen is distinct from m.suggested_action and m.suggested_action is not null and nullif(btrim(p_override),'') is null then
   raise exception 'Explain why this context needs a different content action'; end if;
 if p_humanization is not null then
   if jsonb_typeof(p_humanization)<>'object' or nullif(btrim(p_humanization->>'tool'),'') is null or nullif(btrim(p_draft),'') is null
     or length(p_draft)>10000 or (p_humanization->>'meaning_preserved') is distinct from 'true' then raise exception 'Record the humanizer tool, source draft and meaning check'; end if;
   if (p_draft ~* '\mgeonode\M')<>(p_body ~* '\mgeonode\M') then raise exception 'Humanizing must preserve the brand decision'; end if;
 end if;
 update experiment_messages set content_action=chosen,action_override_reason=case when chosen is distinct from suggested_action then p_override else null end,
   draft_body=p_draft,humanization=case when p_humanization is not null then p_humanization||'{"source":"agent_reported"}'::jsonb else null end where id=m.id;
end $$;

alter function file_experiment_message(uuid,text,uuid,text,text,jsonb,text) rename to file_experiment_message_core;
create function file_experiment_message(p_message_id uuid,p_agent text,p_token uuid,p_body text,p_rationale text,p_context jsonb,p_reply_mode text default null,
 p_content_action text default null,p_override_reason text default null,p_draft_body text default null,p_humanization jsonb default null)
returns experiment_messages language plpgsql security definer set search_path=public,pg_temp as $$
declare m experiment_messages;
begin
 perform 1 from message_experiments where id=(select experiment_id from experiment_messages where id=p_message_id) for update;
 select * into m from experiment_messages where id=p_message_id for update;
 if m.status='queued' and m.body=p_body and m.reply_mode=coalesce(p_reply_mode,case when m.step=1 then 'opening' when m.step=2 then 'reply' end) then
   if (p_content_action is not null and p_content_action is distinct from m.content_action)
     or (p_draft_body is not null and p_draft_body is distinct from m.draft_body) then raise exception 'A filed decision cannot be relabeled by retrying'; end if;
   return file_experiment_message_core(p_message_id,p_agent,p_token,p_body,p_rationale,p_context,p_reply_mode);
 end if;
 perform save_message_decision(m.id,p_content_action,p_override_reason,p_draft_body,p_humanization,p_body);
 return file_experiment_message_core(p_message_id,p_agent,p_token,p_body,p_rationale,p_context,p_reply_mode);
end $$;

alter function edit_experiment_message(uuid,text,text,text,uuid) rename to edit_experiment_message_core;
create function edit_experiment_message(p_message_id uuid,p_body text,p_expected_body text,p_reply_mode text default null,p_expected_parent uuid default null,
 p_content_action text default null,p_override_reason text default null)
returns experiment_messages language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform 1 from message_experiments where id=(select experiment_id from experiment_messages where id=p_message_id) for update;
 perform save_message_decision(p_message_id,p_content_action,p_override_reason,null,null,p_body);
 return edit_experiment_message_core(p_message_id,p_body,p_expected_body,p_reply_mode,p_expected_parent);
end $$;

create view message_action_results with (security_invoker=on) as
with observations as (
 select m.*,case when m.step=1 then 'opening' when m.step=2 then 'first_reply' else 'later_reply' end stage
 from experiment_messages m join message_experiments e on e.id=m.experiment_id where e.source='experiment'
), labels as (
 select o.*,v.basis,v.action from observations o cross join lateral (values ('suggested',o.suggested_action),('chosen',o.content_action)) v(basis,action) where v.action is not null
)
select stage,basis,action,count(*)::integer assigned,
 count(*) filter(where body is not null)::integer written,
 count(*) filter(where task_id is not null)::integer submitted,
 count(*) filter(where verified_at is not null)::integer published,
 count(*) filter(where removed_at is not null)::integer removed,
 count(*) filter(where monitor_complete_at is not null)::integer checked_seven_days,
 count(*) filter(where status in ('awaiting_draft','queued','held','submitting','submitted','unknown') and verified_at is null)::integer pending,
 count(*) filter(where status='failed')::integer delivery_failed,
 count(*) filter(where content_action is distinct from suggested_action and content_action is not null)::integer overrides,
 round(100.0*count(*) filter(where verified_at is not null)/nullif(count(*) filter(where body is not null),0),1) publication_percent
from labels group by stage,basis,action;
revoke all on message_action_results from public,anon,authenticated;
grant select on message_action_results to service_role;

-- Old writer leases must refresh the expanded decision context.
update jobs set status='planned',claimed_by=null,claim_token=null,lease_until=null,finished_at=null
 where id in (select job_id from experiment_messages where status='awaiting_draft') and status='claimed';
update workflow_state set value=value||'{"protocol_version":5,"balanced_content_suggestions":true}'::jsonb,updated_at=now() where key='message_workflow';
do $$
declare f regprocedure;
begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
 and p.proname in ('start_message_experiment','assign_message_action','enforce_message_limits','save_message_decision','file_experiment_message','file_experiment_message_core','edit_experiment_message','edit_experiment_message_core') loop
   execute format('revoke all on function %s from public,anon,authenticated',f);
   execute format('grant execute on function %s to service_role',f);
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
