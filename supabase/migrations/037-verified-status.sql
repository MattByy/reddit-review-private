-- Only observed publication counts as live. Keep the view column contract.
-- Public status may read outcome metadata, never the provider response payload.
grant select(draft_id,state,reason) on publication_attempts to anon;
create policy publication_status_read on publication_attempts for select to anon using(true);
create or replace view status_items with (security_invoker = on) as
with base as (
  select d.id, d.kind, d.body, d.status as draft_status, d.thread_id, d.parent_url,
         coalesce(d.subreddit, t.subreddit) as subreddit, coalesce(d.title, t.title) as title, t.url as thread_url,
         d.gate_failure, d.gate_failed_at, d.reject_reason, d.send_after, d.sequence_hold, d.send_cleared_at,
         d.created_at, d.reviewed_at,
         task.id as task_id, task.status as task_status, coalesce(task.reddit_url, d.posted_url) as reddit_url,
         task.published_at, task.submitted_at, task.reply_count, task.visibility, task.error,
         coalesce(d.account_id, task.user_account_id) as account_id,
         sq.sequence_run_id, sq.step as seq_step, sq.kind as job_kind, sq.payload as job_payload,
         sa.run_id as scenario_run_id, sa.seq as scenario_seq,
         attempt.state as attempt_state, attempt.reason as attempt_reason
  from drafts d
  left join threads t on t.id = d.thread_id
  left join lateral (select * from engain_tasks e where e.draft_id = d.id order by e.submitted_at desc nulls last limit 1) task on true
  left join lateral (select j.sequence_run_id, j.step, j.kind, j.payload from jobs j where j.draft_id = d.id order by j.created_at desc limit 1) sq on true
  left join scenario_acts sa on sa.draft_id = d.id
  left join publication_attempts attempt on attempt.draft_id=d.id
)
select b.id, 'draft'::text as src,
  case when b.scenario_run_id is not null or (b.job_kind = 'write' and b.sequence_run_id is not null) then 'script'
       when b.job_kind = 'draft_followup' then 'follow_up' else coalesce(b.kind, 'comment') end as type,
  b.kind,
  coalesce(sr.name, r2.scenario_slug) as script_name,
  coalesce(b.sequence_run_id, b.scenario_run_id) as script_id,
  case when b.sequence_run_id is not null then 'sequence' when b.scenario_run_id is not null then 'scenario' end as script_source,
  coalesce(b.seq_step + 1, b.scenario_seq) as step,
  coalesce(jsonb_array_length(sr.steps), (select count(*)::int from scenario_acts x where x.run_id = b.scenario_run_id)) as of,
  b.job_payload->>'author' as replying_to,
  case
    when b.visibility='visible' and coalesce(b.task_status,'') !~* 'failed|cancel|error|reject|remov|delet' then 'posted'
    when b.draft_status = 'rejected' then 'rejected'
    when b.attempt_state in ('submitting','unknown','failed') then 'review'
    when b.draft_status in ('cancelled', 'removed', 'skip', 'unverified') or coalesce(b.task_status, '') ~* '^(failed|cancelled|canceled|error)$|remov|delet' then 'ignored'
    when b.draft_status in ('pending', 'edited', 'draft') or b.gate_failed_at is not null then 'review'
    when b.draft_status in ('approved', 'dispatched', 'posted', 'done') then 'planned'
    else 'ignored' end as bucket,
  case
    when b.visibility in ('removed','deleted') or coalesce(b.task_status,'') ~* 'remov|delet' then 'removed from Reddit'
    when b.visibility='visible' and coalesce(b.task_status,'') !~* 'failed|cancel|error|reject' then 'verified on Reddit'
    when coalesce(b.task_status,'') ~* 'failed|cancel|error|reject' then b.task_status || coalesce(': '||b.error,' (reason not supplied)')
    when b.reddit_url is not null then 'Engain returned a URL; Reddit visibility ' || coalesce(b.visibility,'unverified')
    when b.draft_status = 'rejected' then 'rejected' || coalesce(': ' || b.reject_reason, '')
    when b.attempt_state in ('submitting','unknown','failed') then 'submission ' || b.attempt_state || ': ' || coalesce(b.attempt_reason,'waiting for provider response')
    when b.gate_failed_at is not null then 'refused at send: ' || coalesce(b.gate_failure, '')
    when b.task_id is not null then 'with Engain (' || coalesce(b.task_status, 'submitted') || ')'
    when b.draft_status in ('pending', 'edited') then 'waiting for review'
    when b.sequence_hold then 'approved, held until its sequence reaches Send'
    when b.send_after > now() then 'approved, queued for ' || to_char(b.send_after at time zone 'UTC', 'Mon DD HH24:MI') || ' UTC'
    when b.draft_status = 'approved' then 'approved, goes out on the next send pass'
    else b.draft_status end as stage,
  b.body, b.subreddit, b.title, b.thread_id, b.thread_url, b.parent_url, b.reddit_url, b.account_id, a.label as account_label,
  b.reply_count,
  (select count(*)::int from jobs f where f.kind = 'draft_followup' and b.reddit_url is not null and f.payload->>'our_comment_url' = b.reddit_url) as followups,
  coalesce(b.published_at, b.submitted_at, b.reviewed_at, b.created_at) as at,
  b.created_at
from base b
left join sequence_runs sr on sr.id = b.sequence_run_id
left join scenario_runs r2 on r2.id = b.scenario_run_id
left join accounts a on a.id = b.account_id
union all
select sr.id, 'sequence', 'script', sr.steps->sr.current->>'kind', sr.name, sr.id, 'sequence',
  sr.current + 1, jsonb_array_length(sr.steps), null, 'planned',
  coalesce(sr.state->sr.current->>'note', 'waiting') || ' (' || coalesce(sr.steps->sr.current->>'type', '') || ')',
  sr.steps->sr.current->>'brief', sr.subreddit, null, sr.thread_id, sr.thread_url, null, null, sr.account_id, a.label,
  null, 0, sr.next_at, sr.created_at
from sequence_runs sr left join accounts a on a.id = sr.account_id
where sr.status = 'open'
  and not exists (select 1 from jobs j where j.sequence_run_id = sr.id and j.step = sr.current and j.draft_id is not null);
grant select on status_items to anon, authenticated;
