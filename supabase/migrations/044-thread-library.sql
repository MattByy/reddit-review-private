begin;
create table thread_library (
  thread_id text primary key, url text not null, subreddit text not null, title text not null default '', body text,
  opportunity_id text, project_id text, kind text not null check(kind in ('new_opportunities','seo_opportunities')),
  posted_at timestamptz, score integer, num_comments integer, relevance double precision,
  provider_reasons jsonb, first_seen timestamptz not null default now(), last_collected_at timestamptz not null,
  reddit_checked_at timestamptz, refresh_attempted_at timestamptz, reddit_observation jsonb, refresh_error text
);
create index thread_library_rank on thread_library(relevance desc,last_collected_at desc,thread_id);
create index thread_library_refresh on thread_library(reddit_checked_at nulls first);
alter table thread_library enable row level security;
revoke all on thread_library from public,anon,authenticated;
grant all on thread_library to service_role;
insert into workflow_state(key,value) values('thread_library_config',
  '{"min_age_hours":6,"max_age_days":60,"min_comments":5,"min_score":1,"min_relevance":0.6,"provider_fresh_hours":24,"reddit_fresh_minutes":60}') on conflict(key) do nothing;

-- The historical collector was outside this repository. Keep its known facts;
-- importing a row is not a fresh provider or Reddit observation.
do $$ begin
  if to_regclass('public.opportunities') is not null then
    insert into thread_library(thread_id,url,subreddit,title,body,opportunity_id,project_id,kind,posted_at,score,num_comments,relevance,provider_reasons,first_seen,last_collected_at)
    select distinct on(o.thread_id) o.thread_id,coalesce(t.url,'https://www.reddit.com/r/'||o.subreddit||'/comments/'||o.thread_id||'/_/'),
      o.subreddit,coalesce(o.title,''),o.content,o.id,o.project_id,o.kind,o.posted_utc,o.score,o.num_comments,
      case when o.relevance>1 then o.relevance/100.0 else o.relevance end,to_jsonb(o.reasons),coalesce(o.first_seen,now()),coalesce(o.last_seen,o.first_seen,now())
    from opportunities o left join threads t on t.id=o.thread_id
    where o.thread_id is not null and o.subreddit is not null and o.kind in ('new_opportunities','seo_opportunities')
    order by o.thread_id,o.last_seen desc nulls last on conflict(thread_id) do nothing;
  end if;
end $$;

create view thread_library_entries with(security_invoker=on) as
select l.*,exists(select 1 from message_experiments e where e.thread_id=l.thread_id) as has_experiment
from thread_library l;
revoke all on thread_library_entries from public,anon,authenticated;
grant select on thread_library_entries to service_role;

create function claim_thread_collector(p_token uuid) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare s workflow_state;
begin
  insert into workflow_state(key,value) values('thread_collector_lock','{}') on conflict(key) do nothing;
  select * into s from workflow_state where key='thread_collector_lock' for update;
  if (s.value->>'until')::timestamptz>now() then return false; end if;
  update workflow_state set value=jsonb_build_object('token',p_token,'until',now()+interval '2 minutes'),updated_at=now() where key=s.key;
  return true;
end $$;
create function release_thread_collector(p_token uuid) returns void language sql security definer set search_path=public,pg_temp as $$
  update workflow_state set value='{}',updated_at=now() where key='thread_collector_lock' and value->>'token'=p_token::text
$$;

alter table message_experiments add column queue_lane text not null default 'work' check(queue_lane in ('work','test'));
alter table jobs add column queue_lane text not null default 'work' check(queue_lane in ('work','test'));
create index jobs_lane_due on jobs(queue_lane,status,due_at);

alter function start_message_experiment(text,text,uuid,integer,integer) rename to start_message_experiment_before_lanes;
create function start_message_experiment(p_thread_id text,p_strategy text,p_request_id uuid,p_max_messages integer default 6,p_max_depth integer default 4,p_queue_lane text default 'work')
returns message_experiments language plpgsql security definer set search_path=public,pg_temp as $$
declare e message_experiments;
begin
  perform pg_advisory_xact_lock(hashtextextended('message-experiment:start',0));
  if p_queue_lane not in ('work','test') or p_queue_lane is null then raise exception 'Unknown queue lane'; end if;
  if p_queue_lane='test' and (p_strategy is distinct from 'direct' or p_max_messages<>1 or p_max_depth<>1) then
    raise exception 'A live test is one direct opening with max_messages=1 and max_depth=1'; end if;
  select * into e from message_experiments where id=p_request_id;
  if found and e.queue_lane<>p_queue_lane then raise exception 'Request ID belongs to a different queue lane'; end if;
  e:=start_message_experiment_before_lanes(p_thread_id,p_strategy,p_request_id,p_max_messages,p_max_depth);
  update message_experiments set queue_lane=p_queue_lane,source=case when p_queue_lane='test' then 'test' else source end where id=e.id returning * into e;
  update jobs set queue_lane=p_queue_lane where id in(select job_id from experiment_messages where experiment_id=e.id);
  return e;
end $$;

-- The old signature remains a safe work-only wrapper for existing callers.
create function claim_jobs_in_lane(p_agent text,p_kinds text[],p_limit integer default 3,p_lane text default 'work',p_experiment_id uuid default null)
returns setof jobs language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if nullif(btrim(p_agent),'') is null or p_lane is null or p_lane not in ('work','test') then raise exception 'Valid agent and queue lane required'; end if;
  if p_lane='test' and p_experiment_id is null then raise exception 'Claim a test with its exact experiment_id'; end if;
  update jobs j set status='blocked',blocked_reason='Lease attempts exhausted',finished_at=now()
    where j.queue_lane=p_lane and j.status in ('claimed','planned') and j.attempts>=5
      and coalesce(j.lease_until,j.claimed_at+interval '30 minutes',j.due_at)<now()
      and (p_experiment_id is null or j.payload->>'experiment_id'=p_experiment_id::text);
  return query update jobs j set status='claimed',claimed_by=p_agent,claimed_at=now(),claim_token=gen_random_uuid(),lease_until=now()+interval '30 minutes',attempts=j.attempts+1
    where j.id in(select q.id from jobs q where q.queue_lane=p_lane and q.kind=any(p_kinds) and q.due_at<=now() and q.attempts<5
      and (p_experiment_id is null or q.payload->>'experiment_id'=p_experiment_id::text)
      and (q.status='planned' or(q.status='claimed' and coalesce(q.lease_until,q.claimed_at+interval '30 minutes')<now()))
      order by q.due_at,q.id for update skip locked limit greatest(1,least(coalesce(p_limit,3),5))) returning j.*;
end $$;
create or replace function claim_jobs(p_agent text,p_kinds text[],p_limit integer default 5) returns setof jobs
language sql security definer set search_path=public,pg_temp as $$
  select * from claim_jobs_in_lane(p_agent,p_kinds,p_limit,'work',null)
$$;
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
  and p.proname in('claim_thread_collector','release_thread_collector','claim_jobs_in_lane','start_message_experiment','start_message_experiment_before_lanes') loop
    execute format('revoke all on function %s from public,anon,authenticated',f);
    execute format('grant execute on function %s to service_role',f);
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
