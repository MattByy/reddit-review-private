begin;
alter table experiment_messages add column provider_published_at timestamptz,add column provider_evidence jsonb;

-- Both supported evidence sources may advance work. Independent Reddit
-- verification and an Engain publication report retain separate timestamps.
create or replace function advance_message_experiment(p_experiment_id uuid) returns message_experiments
language plpgsql security definer set search_path=public,pg_temp as $$
declare e message_experiments; m experiment_messages; mid uuid; published timestamptz;
begin
  select * into e from message_experiments where id=p_experiment_id for update;
  if e.status<>'active' then return e; end if;
  select * into m from experiment_messages where experiment_id=e.id and step=e.current_step;
  if m.status<>'visible' then return e; end if;
  published:=coalesce(m.verified_at,m.provider_published_at);
  if published is null then return e; end if;
  if m.contains_brand then
    update message_experiments set status='monitoring',brand_visible_at=published,success_step=m.step,monitor_until=published+interval '7 days',updated_at=now()
      where id=e.id returning * into e;
    update experiment_messages set monitor_until=greatest(monitor_until,e.monitor_until),monitor_complete_at=null where experiment_id=e.id and status='visible';
  elsif m.step>=e.max_messages then
    update message_experiments set status='exhausted',reason='Message limit reached',updated_at=now() where id=e.id returning * into e;
  elsif e.max_depth<2 then
    update message_experiments set status='exhausted',reason='Reply depth limit reached',updated_at=now() where id=e.id returning * into e;
  else
    insert into experiment_messages(experiment_id,step,previous_message_id,kind,target_url,decision_due_at)
      values(e.id,m.step+1,m.id,'reply',m.reddit_url,experiment_queue_due(e.id)) returning id into mid;
    update message_experiments set current_step=m.step+1,updated_at=now() where id=e.id returning * into e;
    perform create_experiment_write_job(mid);
  end if;
  return e;
end $$;

create function observe_engain_message(p_message_id uuid,p_task jsonb) returns experiment_messages
language plpgsql security definer set search_path=public,pg_temp as $$
declare m experiment_messages; e message_experiments; publication_url text;
begin
  select * into e from message_experiments where id=(select experiment_id from experiment_messages where id=p_message_id) for update;
  select * into m from experiment_messages where id=p_message_id for update;
  if m.task_id is null or coalesce(p_task->>'_id',p_task->>'id') is distinct from m.task_id
    or p_task->>'status' is distinct from 'published' or p_task->>'content' is distinct from m.body
    or rtrim(p_task->>'threadUrl','/') is distinct from rtrim(m.target_url,'/') then raise exception 'Engain publication does not match the saved task'; end if;
  publication_url:=p_task->>'redditUrl';
  if publication_url is null or publication_url !~ ('^https://(www\.)?reddit\.com/r/[A-Za-z0-9_]+/comments/'||e.thread_id||'/[^/]+/[A-Za-z0-9]+/?$') then
    raise exception 'Engain returned an invalid comment URL'; end if;
  if m.status='removed' then return m; end if;
  update experiment_messages set status='visible',provider_status='published',reddit_url=publication_url,
    provider_published_at=coalesce(provider_published_at,now()),provider_evidence=p_task,
    evidence=jsonb_build_object('source','engain','status','published','checked_at',now()),
    last_checked_at=now(),last_visibility='provider_reported',reason=null,
    monitor_until=coalesce(monitor_until,now()+interval '7 days'),
    monitor_complete_at=case when monitor_until<=now() then now() else monitor_complete_at end,
    next_check_at=now()+interval '30 minutes',updated_at=now() where id=m.id returning * into m;
  if e.status='monitoring' and e.monitor_until<=now() and e.removed_at is null and m.step=e.success_step then
    update message_experiments set status='succeeded',success_at=now(),updated_at=now() where id=e.id;
  else perform advance_message_experiment(e.id); end if;
  return m;
end $$;

revoke all on function observe_engain_message(uuid,jsonb) from public,anon,authenticated;
grant execute on function observe_engain_message(uuid,jsonb) to service_role;

-- Keep writing decisions and their queue representation in the same transaction.
create function finish_writing_task(p_id uuid,p_agent text,p_token uuid,p_outcome text,p_reason text,p_retry_minutes int default 30) returns jobs
language plpgsql security definer set search_path=public,pg_temp as $$
declare j jobs; m experiment_messages; e message_experiments;
begin
  select * into e from message_experiments where id=(select experiment_id from experiment_messages where job_id=p_id) for update;
  select * into m from experiment_messages where job_id=p_id for update;
  if m.id is null or m.status<>'awaiting_draft' or e.status<>'active' then raise exception 'Task is no longer writable'; end if;
  if p_outcome not in ('skip','defer','blocked') or nullif(btrim(p_reason),'') is null then raise exception 'Outcome and reason required'; end if;
  j:=complete_job(p_id,p_agent,case when p_outcome='skip' then 'skipped' else 'blocked' end,
    jsonb_build_object('reason',left(p_reason,2000)),null,p_token,case when p_outcome='defer' then p_retry_minutes end);
  update experiment_messages set status=case when p_outcome='skip' then 'stopped' when j.status='planned' then 'awaiting_draft' else 'held' end,
    reason=left(p_reason,2000),decision_due_at=j.due_at,updated_at=now() where id=m.id;
  if j.status<>'planned' then
    update message_experiments set status=case when p_outcome='skip' then 'stopped' else 'blocked' end,reason=left(p_reason,2000),updated_at=now() where id=e.id;
  end if;
  return j;
end $$;
revoke all on function finish_writing_task(uuid,text,uuid,text,text,int) from public,anon,authenticated;
grant execute on function finish_writing_task(uuid,text,uuid,text,text,int) to service_role;
notify pgrst,'reload schema';
commit;
