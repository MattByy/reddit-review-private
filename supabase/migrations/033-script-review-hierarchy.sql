-- 033: Script is a run; segment is an ordered act backed by one draft.
-- Apply after 032. No new parallel source of truth and no automatic approvals.
begin;
alter table scenario_runs add column if not exists narrative_type text;
comment on column scenario_runs.narrative_type is
  'Optional editorial category, e.g. product_announcement, educational, case_study.';
-- Fail visibly on ambiguous legacy membership; never guess which script owns it.
create unique index if not exists scenario_acts_one_script_per_draft
  on scenario_acts(draft_id) where draft_id is not null;
alter table scenario_acts add constraint scenario_segment_order
  check (seq > 0 and (depends_on is null or (depends_on > 0 and depends_on < seq))) not valid;
alter table scenario_acts add constraint scenario_segment_parent
  foreign key (run_id, depends_on) references scenario_acts(run_id, seq)
  deferrable initially deferred not valid;

create or replace view script_segments with (security_invoker = true) as
select a.run_id as script_id, a.id as segment_id, a.seq as position,
  a.depends_on, a.draft_id, a.kind, a.status as publication_status,
  d.body, d.status as review_status, d.reviewed_at
from scenario_acts a left join drafts d on d.id = a.draft_id;
grant select on script_segments to anon, authenticated, service_role;

create or replace function scenario_approved(p_run_id uuid)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select exists (select 1 from scenario_runs r join scenario_run_reviews v on v.id = r.review_id
    where r.id = p_run_id and r.status = 'open' and r.review_status = 'approved'
      and (select count(*) from scenario_acts where run_id = r.id) >= 2
      and v.run_id = r.id and v.action = 'approve'
      and v.snapshot = scenario_review_snapshot(r.id)
      and not exists (select 1 from scenario_acts a join drafts d on d.id = a.draft_id
        where a.run_id = r.id and (a.status in ('rejected', 'failed', 'skipped', 'removed') or d.status not in ('approved', 'posted'))))
$$;

create or replace function review_scenario_run(
  p_run_id uuid, p_action text, p_note text, p_editor text
) returns scenario_runs language plpgsql security definer
set search_path = public, pg_temp as $$
declare cur scenario_runs; template scenarios; rev uuid; act record;
begin
  select * into cur from scenario_runs where id = p_run_id for update;
  if cur.id is null then raise exception 'scenario run % not found', p_run_id; end if;
  if p_action is null or p_action not in ('approve', 'reject') then
    raise exception 'unknown review action: %', p_action;
  end if;
  if nullif(btrim(p_editor), '') is null then raise exception 'reviewer is required'; end if;
  if cur.review_status = 'rejected' then raise exception 'script was rejected permanently'; end if;
  if p_action = 'reject' and nullif(btrim(p_note), '') is null then
    raise exception 'a rejection reason is required';
  end if;
  select * into template from scenarios where slug = cur.scenario_slug for share;
  -- Lock every existing act and draft before taking the snapshot. A concurrent
  -- edit afterwards invalidates the snapshot in the database send gate.
  perform 1 from scenario_acts where run_id = p_run_id order by seq for update;
  perform 1 from drafts where id in (select draft_id from scenario_acts where run_id = p_run_id)
    order by id for update;
  if p_action = 'approve' then
    if cur.status <> 'open' then raise exception 'script is not open'; end if;
    if not template.enabled or template.same_thread_accounts then
      raise exception 'disabled or ring scripts cannot be approved';
    end if;
    if jsonb_typeof(template.spec->'acts') is distinct from 'array' then
      raise exception 'script template needs an acts array';
    end if;
    if jsonb_array_length(template.spec->'acts') < 2 or
       (select count(*) from scenario_acts where run_id = p_run_id) <> jsonb_array_length(template.spec->'acts') then
      raise exception 'a script needs at least two segments and every planned segment must be filed';
    end if;
    if exists (
      select 1 from scenario_acts a left join drafts d on d.id = a.draft_id
      left join lateral (select value from jsonb_array_elements(template.spec->'acts')
        where (value->>'seq')::int = a.seq) spec on true
      where a.run_id = p_run_id and (spec.value is null or d.id is null or
        nullif(btrim(d.body), '') is null or d.redirect_pending or
        d.status in ('rejected', 'cancelled', 'removed', 'unverified') or
        a.status in ('rejected', 'failed', 'skipped', 'removed') or
        a.kind <> spec.value->>'kind' or d.kind <> a.kind or d.mode <> 'scenario' or
        a.depends_on is distinct from (spec.value->>'depends_on')::int or
        a.after_min <> coalesce((spec.value->>'after_min')::int, 0))
    ) then raise exception 'script has missing, changed, rejected or unfinished acts'; end if;
    -- Reuse draft review validation/revisions for all unsent text. Already
    -- accepted tasks keep their task id and factual dispatch/publication state.
    for act in select a.*, d.engain_task_id from scenario_acts a join drafts d on d.id = a.draft_id
      where a.run_id = p_run_id and a.task_id is null and d.engain_task_id is null
        and a.status in ('pending', 'due')
        and not exists (select 1 from engain_tasks e where e.draft_id = d.id)
      order by a.seq loop
      perform review_draft(act.draft_id, 'approve', null, p_note, p_editor);
    end loop;
  else
    -- A local rejection cannot recall a task already accepted by the vendor.
    -- Preserve its IDs/URLs/timestamps and keep tracking evidence, but forbid
    -- every later act and prevent vendor status from resurrecting the script.
    insert into draft_revisions (draft_id, editor, action, body_before, body_after, note)
      select d.id, p_editor, 'reject', d.body, d.body, p_note from drafts d
      where d.id in (select draft_id from scenario_acts where run_id = p_run_id);
    update drafts set status = 'rejected', send_cleared_at = null,
      reject_reason = p_note, reviewed_at = now(), updated_at = now()
      where id in (select draft_id from scenario_acts where run_id = p_run_id);
    update scenario_acts set status = 'rejected', due_at = null where run_id = p_run_id;
  end if;
  insert into scenario_run_reviews(run_id, editor, action, note, snapshot)
    values(p_run_id, p_editor, p_action, p_note, scenario_review_snapshot(p_run_id)) returning id into rev;
  update scenario_runs set review_status = case when p_action = 'approve' then 'approved' else 'rejected' end,
    review_id = rev, reviewed_by = p_editor, reviewed_at = now(), review_note = p_note,
    status = case when p_action = 'reject' then 'rejected' else status end,
    abort_reason = case when p_action = 'reject' then p_note else abort_reason end
    where id = p_run_id returning * into cur;
  insert into activity_log(actor, action, detail) values(p_editor, 'scenario_' || p_action,
    jsonb_build_object('run', p_run_id, 'review', rev, 'note', p_note));
  return cur;
end $$;
revoke all on function review_scenario_run(uuid, text, text, text) from public;
grant execute on function review_scenario_run(uuid, text, text, text) to anon, authenticated, service_role;


-- Segment permission does not release its parent script. Invalidate a prior
-- parent review explicitly, including edits whose text is later restored.
create or replace function review_script_segment(
  p_draft_id uuid, p_action text, p_body text, p_note text, p_editor text
) returns drafts language plpgsql security definer set search_path = public, pg_temp as $$
declare rid uuid; cur scenario_runs; result drafts;
begin
  if nullif(btrim(p_editor), '') is null then raise exception 'reviewer is required'; end if;
  if p_action = 'reject' and nullif(btrim(p_note), '') is null then raise exception 'a rejection reason is required'; end if;
  select run_id into rid from scenario_acts where draft_id = p_draft_id;
  if rid is null then raise exception 'draft is not a script segment'; end if;
  select * into cur from scenario_runs where id = rid for update;
  if cur.status <> 'open' or cur.review_status = 'rejected' then raise exception 'script is not open'; end if;
  perform 1 from drafts where id = p_draft_id for update;
  if exists (select 1 from scenario_acts where draft_id = p_draft_id and task_id is not null)
    or exists (select 1 from drafts where id = p_draft_id and engain_task_id is not null)
    or exists (select 1 from engain_tasks where draft_id = p_draft_id) then
    raise exception 'segment has already been sent';
  end if;
  result := review_draft(p_draft_id, p_action, p_body, p_note, p_editor);
  update scenario_runs set review_status = 'pending', review_id = null,
    reviewed_at = null, reviewed_by = null, review_note = null where id = rid;
  return result;
end $$;
revoke all on function review_script_segment(uuid,text,text,text,text) from public;
grant execute on function review_script_segment(uuid,text,text,text,text) to anon, authenticated, service_role;

-- One result per distinct requested ID. Each exception rolls back only that
-- item's changes. Both paths use review_draft's authoritative validation.
create or replace function approve_draft_batch(
  p_draft_ids uuid[], p_note text, p_editor text
) returns table (draft_id uuid, thread_id text, kind text, mode text, body text, status text, error text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare did uuid; cur drafts;
begin
  if nullif(btrim(p_editor), '') is null then raise exception 'editor is required'; end if;
  if coalesce(cardinality(p_draft_ids), 0) = 0 then raise exception 'at least one draft_id is required'; end if;
  if cardinality(p_draft_ids) > 100 then raise exception 'at most 100 drafts per batch'; end if;
  -- Consistent lock order with whole-script review: parents, then drafts.
  perform 1 from scenario_runs r where r.id in
    (select a.run_id from scenario_acts a where a.draft_id = any(p_draft_ids)) order by r.id for update;
  perform 1 from drafts d where d.id = any(p_draft_ids) order by d.id for update;
  for did in select distinct x from unnest(p_draft_ids) as ids(x) order by x loop
    begin
      select * into cur from drafts d where d.id = did;
      if cur.id is null then raise exception 'draft not found'; end if;
      if cur.status not in ('pending', 'edited') then raise exception 'draft is not awaiting review'; end if;
      if exists (select 1 from scenario_acts a where a.draft_id = did) then
        cur := review_script_segment(did, 'approve', null, p_note, p_editor);
      elsif cur.mode = 'scenario' then
        raise exception 'script segment has no parent script';
      else
        cur := review_draft(did, 'approve', null, p_note, p_editor);
      end if;
      return query select did, cur.thread_id, cur.kind, cur.mode, cur.body, cur.status, null::text;
    exception when others then
      return query select did, cur.thread_id, cur.kind, cur.mode, cur.body, cur.status, SQLERRM;
    end;
  end loop;
end $$;
revoke all on function approve_draft_batch(uuid[],text,text) from public;
grant execute on function approve_draft_batch(uuid[],text,text) to anon, authenticated, service_role;
create or replace view script_review_state with (security_invoker = true) as
select r.*, (select count(*) from scenario_acts a where a.run_id = r.id) as segment_count,
  case when r.status <> 'open' then r.review_status
    when r.review_status = 'rejected' then 'rejected'
    when scenario_approved(r.id) then 'approved' else 'pending' end as effective_review_status
from scenario_runs r;
grant select on script_review_state to anon, authenticated, service_role;
notify pgrst, 'reload schema';
commit;
