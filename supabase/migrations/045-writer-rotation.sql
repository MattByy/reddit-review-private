begin;
-- Rotation state is shared by ordinary queue assignments, across all stages.
-- Explicit openings and isolated tests never consume a rotation slot.
insert into workflow_state(key,value) values('message_writer',
  '{"enabled_actions":["direct","question","context","help","method"],"remaining":[],"cycle_id":null}')
  on conflict(key) do nothing;
alter table message_experiments add column opening_assignment jsonb;
alter table experiment_messages add column writer_assignment jsonb,
  add column approved_at timestamptz, add column approved_by text;

create function configure_message_writer(p_actions text[]) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare normalized text[]; current_value jsonb;
begin
  if p_actions is null or cardinality(p_actions) not between 1 and 5
    or exists(select 1 from unnest(p_actions) a where a is null or not exists(select 1 from message_strategies where id=a))
    or cardinality(p_actions)<>(select count(distinct a) from unnest(p_actions) a) then
    raise exception 'Choose one to five distinct supported content modes'; end if;
  select array_agg(id order by position) into normalized from message_strategies where id=any(p_actions);
  select value into current_value from workflow_state where key='message_writer' for update;
  if current_value->'enabled_actions' is distinct from to_jsonb(normalized) then
    current_value:=jsonb_build_object('enabled_actions',normalized,'remaining','[]'::jsonb,'cycle_id',null);
    update workflow_state set value=current_value,updated_at=now() where key='message_writer';
  end if;
  return current_value;
end $$;

create function next_message_action() returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare config jsonb; remaining text[]; chosen text; cycle uuid; size integer;
begin
  select value into config from workflow_state where key='message_writer' for update;
  size:=jsonb_array_length(config->'enabled_actions');
  if size is null or size=0 then raise exception 'Configure writer content modes first'; end if;
  select array_agg(a) into remaining from jsonb_array_elements_text(config->'remaining') a;
  cycle:=(config->>'cycle_id')::uuid;
  if coalesce(cardinality(remaining),0)=0 then
    select array_agg(a order by random()) into remaining from jsonb_array_elements_text(config->'enabled_actions') a;
    cycle:=gen_random_uuid();
  end if;
  chosen:=remaining[1];
  update workflow_state set value=config||jsonb_build_object('remaining',remaining[2:cardinality(remaining)],'cycle_id',cycle),updated_at=now()
    where key='message_writer';
  return jsonb_build_object('source','rotation','mode',chosen,'cycle_id',cycle,
    'position',size-cardinality(remaining)+1,'size',size,'target_percent',100.0/size,'enabled_actions',config->'enabled_actions');
end $$;

create or replace function assign_message_action() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare e message_experiments; s message_strategies; assignment jsonb;
begin
  select * into e from message_experiments where id=new.experiment_id;
  if e.source not in ('experiment','test') then return new; end if;
  if new.step=1 then
    new.suggested_action:=e.strategy_id;
    assignment:=coalesce(e.opening_assignment,jsonb_build_object('source',case when e.queue_lane='test' then 'test' else 'fixed' end,'mode',e.strategy_id));
  else
    assignment:=next_message_action();
    new.suggested_action:=assignment->>'mode';
  end if;
  select * into s from message_strategies where id=new.suggested_action;
  new.writer_assignment:=assignment||jsonb_build_object('prompt_version','writer-rotation-v1','name',s.action_name,
    'brief',case when new.step=1 then s.brief else s.followup_brief end);
  return new;
end $$;

create or replace function start_message_experiment(p_thread_id text,p_strategy text,p_request_id uuid,p_max_messages integer default 6,p_max_depth integer default 4,p_queue_lane text default 'work')
returns message_experiments language plpgsql security definer set search_path=public,pg_temp as $$
declare e message_experiments; t threads; chosen text; mid uuid; assignment jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('message-experiment:start',0));
  if p_request_id is null then raise exception 'A request ID is required'; end if;
  if p_queue_lane is null or p_queue_lane not in ('work','test') then raise exception 'Unknown queue lane'; end if;
  if p_queue_lane='test' and (p_strategy is distinct from 'direct' or p_max_messages<>1 or p_max_depth<>1) then
    raise exception 'A live test is one direct opening with max_messages=1 and max_depth=1'; end if;
  select * into e from message_experiments where id=p_request_id;
  if found then
    if e.thread_id<>p_thread_id or (p_strategy is not null and e.strategy_id<>p_strategy) or e.max_messages<>p_max_messages or e.max_depth<>p_max_depth or e.queue_lane<>p_queue_lane then
      raise exception 'Request ID belongs to a different experiment or queue lane'; end if;
    return e;
  end if;
  select * into t from threads where id=p_thread_id;
  if t.id is null or t.locked is true or t.archived is true then raise exception 'Choose an available thread'; end if;
  if p_max_messages is null or p_max_messages not between 1 and 10 then raise exception 'Use between 1 and 10 messages'; end if;
  if p_max_depth is null or p_max_depth not between 1 and 10 then raise exception 'Use between 1 and 10 levels'; end if;
  chosen:=p_strategy;
  if chosen is null then assignment:=next_message_action();chosen:=assignment->>'mode'; end if;
  if not exists(select 1 from message_strategies where id=chosen) then raise exception 'Unknown opening strategy'; end if;
  insert into message_experiments(id,thread_id,strategy_id,max_messages,max_depth,queue_lane,source,opening_assignment)
    values(p_request_id,t.id,chosen,p_max_messages,p_max_depth,p_queue_lane,case when p_queue_lane='test' then 'test' else 'experiment' end,assignment) returning * into e;
  insert into experiment_messages(experiment_id,step,kind,target_url) values(e.id,1,'comment',t.url) returning id into mid;
  perform create_experiment_write_job(mid);
  update jobs set queue_lane=p_queue_lane where id=(select job_id from experiment_messages where id=mid);
  return e;
end $$;

-- Record approval in the same transaction that queues the final text. Exact
-- retries and delivery status changes preserve this evidence. No fabricated
-- approval timestamps are backfilled for historical messages.
create function record_message_approval() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.status='queued' and (old.status in ('awaiting_draft','held') or old.body is distinct from new.body
    or old.content_action is distinct from new.content_action or old.parent_message_id is distinct from new.parent_message_id) then
    new.approved_at:=now();
    select claimed_by into new.approved_by from jobs where id=new.job_id and status='claimed';
    new.approved_by:=coalesce(new.approved_by,'dashboard');
  end if;
  return new;
end $$;
create trigger message_automatic_approval before update on experiment_messages for each row execute function record_message_approval();

do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.proname in ('configure_message_writer','next_message_action','assign_message_action','record_message_approval','start_message_experiment') loop
    execute format('revoke all on function %s from public,anon,authenticated',f);
    execute format('grant execute on function %s to service_role',f);
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
