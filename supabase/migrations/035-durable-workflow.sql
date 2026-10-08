-- Stateless workers: fenced leases, atomic filing and durable publication attempts.
-- Additive migration; preserves historical drafts, runs and vendor tasks.
begin;
alter table jobs add column if not exists claim_token uuid;
alter table jobs add column if not exists lease_until timestamptz;
alter table jobs add column if not exists checkpoint jsonb not null default '{}'::jsonb;
alter table drafts add column if not exists origin_job_id uuid references jobs(id);
alter table drafts add column if not exists filing_key text;
create unique index if not exists drafts_origin_job_once on drafts(origin_job_id) where origin_job_id is not null;
create unique index if not exists drafts_filing_once on drafts(filing_key) where filing_key is not null;
alter table threads add column if not exists discovery jsonb not null default '{}'::jsonb;
alter table engain_tasks add column if not exists visibility text not null default 'unverified';
alter table engain_tasks add column if not exists verified_at timestamptz;
alter table engain_tasks add column if not exists observed_at timestamptz;
alter table engain_tasks add column if not exists next_check_at timestamptz;
alter table engain_tasks add column if not exists reddit_comment_id text;
alter table engain_tasks add column if not exists parent_fullname text;
alter table engain_tasks add column if not exists reply_depth int;
alter table engain_tasks add column if not exists vendor_payload jsonb;

create table if not exists publication_attempts (
  id uuid primary key default gen_random_uuid(), draft_id uuid not null unique references drafts(id),
  state text not null check(state in ('submitting','unknown','accepted','failed')),
  account_id text not null, subreddit text, body text not null, parent_url text,
  task_type text not null, thread_id text, thread_url text, task_id text,
  reason text, vendor_response jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists thread_observations (
  thread_id text primary key references threads(id), observed_at timestamptz not null default now(),
  snapshot jsonb not null
);
create table if not exists workflow_events (
  id uuid primary key default gen_random_uuid(), event_key text not null unique,
  event text not null, source text not null, draft_id uuid references drafts(id), task_id text,
  thread_id text, experiment jsonb not null default '{}'::jsonb, reason text, detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists workflow_events_recent on workflow_events(at desc);
create table if not exists workflow_state (key text primary key, value jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
alter table publication_attempts enable row level security;
alter table thread_observations enable row level security;
alter table workflow_events enable row level security;
alter table workflow_state enable row level security;
grant all on publication_attempts,thread_observations,workflow_events,workflow_state to service_role;
grant select on publication_attempts,thread_observations,workflow_events to authenticated;

create or replace function claim_jobs(p_agent text,p_kinds text[],p_limit int default 5)
returns setof jobs language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if nullif(btrim(p_agent),'') is null then raise exception 'agent name required'; end if;
  update jobs set status='blocked',blocked_reason='Lease expired after five attempts. Operator review required.',finished_at=now()
    where status in ('claimed','planned') and attempts>=5 and coalesce(lease_until,claimed_at+interval '30 minutes',due_at)<now();
  return query update jobs j set status='claimed',claimed_by=p_agent,claimed_at=now(),
    claim_token=gen_random_uuid(),lease_until=now()+interval '30 minutes',attempts=j.attempts+1
    where j.id in (select q.id from jobs q where q.kind=any(p_kinds) and q.due_at<=now() and q.attempts<5
      and (q.status='planned' or(q.status='claimed' and coalesce(q.lease_until,q.claimed_at+interval '30 minutes')<now()))
      order by q.due_at,q.id for update skip locked limit greatest(1,least(coalesce(p_limit,5),10))) returning j.*;
end $$;

create or replace function checkpoint_job(p_id uuid,p_agent text,p_token uuid,p_checkpoint jsonb)
returns jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare j jobs;
begin
  update jobs set checkpoint=coalesce(p_checkpoint,'{}'),lease_until=now()+interval '30 minutes'
    where id=p_id and status='claimed' and claimed_by=p_agent and claim_token=p_token and lease_until>now() returning * into j;
  if j.id is null then raise exception 'stale or foreign job lease' using errcode='40001'; end if;
  return j;
end $$;

-- Remove the unfenced overload: all completions, including cron, carry a token.
drop function if exists complete_job(uuid,text,text,jsonb,uuid);
create or replace function complete_job(p_id uuid,p_agent text,p_status text,p_result jsonb,p_draft_id uuid default null,p_token uuid default null,p_retry_minutes int default null)
returns jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare j jobs;
begin
  select * into j from jobs where id=p_id for update;
  if j.id is null or j.claimed_by is distinct from p_agent or j.claim_token is distinct from p_token or p_token is null then
    raise exception 'stale or foreign job lease' using errcode='40001'; end if;
  if j.status in ('done','skipped','blocked','failed') and j.status=p_status then return j; end if;
  if j.status<>'claimed' or j.lease_until<=now() then raise exception 'job lease expired' using errcode='40001'; end if;
  if p_status not in ('done','skipped','failed','blocked') then raise exception 'invalid completion status'; end if;
  if p_retry_minutes is not null and p_status<>'blocked' then raise exception 'only blocked work may be deferred'; end if;
  update jobs set status=case when p_retry_minutes is not null and attempts<5 then 'planned' else p_status end,
    result=p_result,finished_at=case when p_retry_minutes is null or attempts>=5 then now() end,
    due_at=case when p_retry_minutes is not null then now()+make_interval(mins=>greatest(1,least(p_retry_minutes,1440))) else due_at end,
    draft_id=coalesce(p_draft_id,draft_id),blocked_reason=case when p_status in ('blocked','failed') then coalesce(p_result->>'reason',p_status) end,
    lease_until=null where id=p_id returning * into j;
  insert into activity_log(actor,action,detail) values(p_agent,'job_'||j.status,jsonb_build_object('job',p_id,'result',p_result));
  return j;
end $$;

create or replace function file_agent_draft(p_row jsonb,p_key text,p_job_id uuid default null,p_agent text default null,p_token uuid default null)
returns drafts language plpgsql security definer set search_path=public,pg_temp as $$
declare j jobs; d drafts; incoming drafts;
begin
  if nullif(p_key,'') is null then raise exception 'filing key required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('file:'||p_key,0));
  select * into d from drafts where filing_key=p_key or(p_job_id is not null and origin_job_id=p_job_id) limit 1;
  if d.id is not null then
    if d.body is distinct from p_row->>'body' or d.kind is distinct from p_row->>'kind' or d.parent_url is distinct from p_row->>'parent_url'
      or d.thread_id is distinct from p_row->>'thread_id' or d.account_id is distinct from p_row->>'account_id' then
      raise exception 'filing key already used for different content' using errcode='23505'; end if;
    return d;
  end if;
  if p_job_id is not null then
    select * into j from jobs where id=p_job_id for update;
    if j.id is null or j.status<>'claimed' or j.claimed_by is distinct from p_agent or j.claim_token is distinct from p_token or p_token is null or j.lease_until<=now() then
      raise exception 'stale or foreign job lease' using errcode='40001'; end if;
  end if;
  incoming=jsonb_populate_record(null::drafts,p_row);
  insert into drafts(kind,mode,thread_id,parent_url,subreddit,title,body,body_original,status,source,account_id,thread_context,
    agent_note,prompt_version,models,sharpen,send_after,sequence_hold,filing_key,origin_job_id)
  values(incoming.kind,incoming.mode,incoming.thread_id,incoming.parent_url,incoming.subreddit,incoming.title,incoming.body,incoming.body,
    'pending','agent_api',incoming.account_id,incoming.thread_context,incoming.agent_note,incoming.prompt_version,incoming.models,incoming.sharpen,
    incoming.send_after,coalesce(incoming.sequence_hold,false),p_key,p_job_id) returning * into d;
  if p_job_id is not null then
    perform complete_job(p_job_id,p_agent,'done',jsonb_build_object('draft_id',d.id),d.id,p_token);
  end if;
  insert into workflow_events(event_key,event,source,draft_id,thread_id,experiment,detail)
    values('filed:'||d.id,'awaiting_review','agent_api',d.id,d.thread_id,coalesce(d.thread_context->'experiment','{}'),
      jsonb_build_object('request_id',p_key,'subreddit',d.subreddit)) on conflict(event_key) do nothing;
  return d;
end $$;

create or replace function reserve_publication(p_draft_id uuid,p_body text,p_parent_url text,p_account_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare d drafts; a accounts; attempt publication_attempts; last_global timestamptz; last_sub timestamptz; today_count int; sub text; thread_url text;
begin
  -- All entry points share this short transaction. No lock is held across HTTP.
  perform pg_advisory_xact_lock(hashtextextended('geonode:publication',0));
  select * into attempt from publication_attempts where draft_id=p_draft_id;
  if attempt.id is not null then return jsonb_build_object('ok',false,'reason','publication already reserved','attempt',attempt); end if;
  select * into d from drafts where id=p_draft_id for update;
  if d.id is null or d.status<>'approved' or d.send_cleared_at is null or d.redirect_pending or d.sequence_hold or d.gate_failed_at is not null or d.pullback_requested_at is not null
    or d.body is distinct from p_body or d.parent_url is distinct from p_parent_url or (d.account_id is not null and d.account_id<>p_account_id) or d.send_after>now() then
    return jsonb_build_object('ok',false,'reason','approval, content or schedule changed'); end if;
  select * into a from accounts where id=p_account_id;
  if a.id is null or not a.active or not a.disclosed or a.usable is distinct from true then
    return jsonb_build_object('ok',false,'reason','account not eligible'); end if;
  if exists(select 1 from engain_tasks where draft_id=d.id) then return jsonb_build_object('ok',false,'reason','draft already submitted'); end if;
  if exists(select 1 from engain_tasks where thread_id=d.thread_id and user_account_id<>p_account_id and lower(coalesce(status,'')) not in ('failed','cancelled','canceled','removed','deleted','rejected'))
    or exists(select 1 from publication_attempts where thread_id=d.thread_id and account_id<>p_account_id and state<>'failed') then
    return jsonb_build_object('ok',false,'reason','another account is assigned to this thread'); end if;
  select coalesce(d.subreddit,t.subreddit),t.url into sub,thread_url from (select 1) x left join threads t on t.id=d.thread_id;
  with activity as (
    select coalesce(e.draft_id::text,e.id) key,e.subreddit,e.submitted_at at from engain_tasks e where e.status is distinct from 'test_artifact'
    union all select draft_id::text,subreddit,created_at from publication_attempts
  ), logical as (select key,subreddit,max(at) at from activity group by key,subreddit)
  select max(at),max(at) filter(where subreddit=sub),count(*) filter(where at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')
    into last_global,last_sub,today_count from logical;
  if last_global>now()-interval '45 minutes' or last_sub>now()-interval '24 hours' or today_count>=20 then
    return jsonb_build_object('ok',false,'reason','publication pacing limit'); end if;
  insert into publication_attempts(draft_id,state,account_id,subreddit,body,parent_url,task_type,thread_id,thread_url)
    values(d.id,'submitting',p_account_id,sub,p_body,p_parent_url,d.kind,d.thread_id,thread_url) returning * into attempt;
  return jsonb_build_object('ok',true,'attempt',attempt);
end $$;

create or replace function accept_publication(p_attempt_id uuid,p_task_id text,p_status text,p_response jsonb)
returns engain_tasks language plpgsql security definer set search_path=public,pg_temp as $$
declare a publication_attempts; d drafts; t engain_tasks;
begin
  select * into a from publication_attempts where id=p_attempt_id for update;
  if a.id is null or nullif(p_task_id,'') is null then raise exception 'publication attempt and vendor task required'; end if;
  if a.task_id is not null and a.task_id<>p_task_id then raise exception 'attempt already has a different task'; end if;
  select * into d from drafts where id=a.draft_id for update;
  insert into engain_tasks(id,draft_id,thread_id,project_id,task_type,subreddit,thread_url,content,status,user_account_id,vendor,labels,mode,models)
    values(p_task_id,d.id,a.thread_id,'accounts-beta',a.task_type,a.subreddit,a.thread_url,a.body,coalesce(p_status,'pending'),a.account_id,'engain-accounts',array['geonode-disclosed'],d.mode,d.models)
    on conflict(id) do nothing;
  select * into t from engain_tasks where id=p_task_id;
  if t.draft_id is distinct from d.id then raise exception 'vendor task already belongs to a different draft'; end if;
  insert into eval_log(draft_id,task_id,thread_id,subreddit,kind,mode,prompt_version,models,user_account_id)
    select d.id,p_task_id,a.thread_id,a.subreddit,a.task_type,d.mode,d.prompt_version,d.models,a.account_id
    where not exists(select 1 from eval_log where task_id=p_task_id);
  update publication_attempts set state='accepted',task_id=p_task_id,vendor_response=p_response,updated_at=now() where id=a.id;
  update drafts set status=case when status='rejected' then status else 'dispatched' end,engain_task_id=p_task_id,engain_status=p_status,engain_seen_at=now() where id=d.id;
  if d.status='rejected' or d.pullback_requested_at is not null then
    update engain_tasks set cancel_requested_at=coalesce(cancel_requested_at,now()),cancel_requested_by='approval withdrawn during submission' where id=p_task_id;
  end if;
  update scenario_acts set status='dispatched',task_id=p_task_id,account_id=a.account_id,dispatched_at=now(),engain_status=p_status,engain_seen_at=now()
    where draft_id=d.id and status<>'rejected';
  return t;
end $$;

create or replace function ensure_finder_job() returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j jobs;
begin
  perform pg_advisory_xact_lock(hashtextextended('geonode:finder',0));
  select * into j from jobs where kind='agent_task' and payload->>'task'='find_threads' order by created_at desc limit 1;
  if j.id is not null and (j.status in ('planned','claimed','blocked','failed') or j.finished_at>now()-interval '1 hour') then return to_jsonb(j); end if;
  insert into jobs(kind,title,payload,dedupe_key,created_by) values('agent_task','Find relevant threads using the current query map',
    '{"task":"find_threads","max_candidates":5}', 'finder:'||to_char(now() at time zone 'UTC','YYYY-MM-DD-HH24'),'cron/tick') on conflict(dedupe_key) do nothing returning * into j;
  return to_jsonb(j);
end $$;

-- All workflow mutations are server-side. Lease tokens are never exposed to anon.
create or replace function track_draft_decision() returns trigger language plpgsql
security definer set search_path=public,pg_temp as $$
begin
  if new.status is distinct from old.status and new.status in ('approved','rejected') then
    insert into workflow_events(event_key,event,source,draft_id,thread_id,experiment,reason,detail)
      values('decision:'||gen_random_uuid(),new.status,'draft_state',new.id,new.thread_id,
        coalesce(new.thread_context->'experiment','{}'),case when new.status='rejected' then new.reject_reason end,
        jsonb_build_object('request_id',coalesce(new.filing_key,new.id::text),'subreddit',new.subreddit));
  end if;
  return new;
end $$;
drop trigger if exists workflow_draft_decision on drafts;
create trigger workflow_draft_decision after update on drafts for each row execute function track_draft_decision();
revoke all on function track_draft_decision() from public,anon,authenticated;
grant execute on function track_draft_decision() to service_role;
revoke all on function claim_jobs(text,text[],int),checkpoint_job(uuid,text,uuid,jsonb),complete_job(uuid,text,text,jsonb,uuid,uuid,int),file_agent_draft(jsonb,text,uuid,text,uuid),reserve_publication(uuid,text,text,text),accept_publication(uuid,text,text,jsonb),ensure_finder_job() from public,anon,authenticated;
grant execute on function claim_jobs(text,text[],int),checkpoint_job(uuid,text,uuid,jsonb),complete_job(uuid,text,text,jsonb,uuid,uuid,int),file_agent_draft(jsonb,text,uuid,text,uuid),reserve_publication(uuid,text,text,text),accept_publication(uuid,text,text,jsonb),ensure_finder_job() to service_role;
revoke select on jobs from anon,authenticated;
grant select(id,kind,run_id,act_id,draft_id,account_id,thread_id,target_url,payload,due_at,status,blocked_reason,claimed_by,claimed_at,attempts,result,created_by,created_at,finished_at,dedupe_key,title,sequence_run_id,step,lease_until,checkpoint) on jobs to anon,authenticated;
-- Views explicitly list safe fields. The server supplies leased worker context.
commit;
