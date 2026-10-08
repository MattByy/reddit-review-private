begin;
CREATE OR REPLACE FUNCTION public.review_draft(p_draft_id uuid, p_action text, p_body text, p_note text, p_editor text)
 RETURNS drafts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO public, pg_temp
AS $function$
declare cur drafts; new_status text; out_row drafts;
begin
  select * into cur from drafts where id = p_draft_id for update;
  if cur.id is null then raise exception 'draft % not found', p_draft_id; end if;
  if cur.status = 'posted' then raise exception 'draft % is already posted', p_draft_id; end if;

  if    p_action = 'approve' then new_status := 'approved';
  elsif p_action = 'edit'    then new_status := 'edited';
  elsif p_action = 'reject'  then new_status := 'rejected';
  else  raise exception 'unknown review action: %', p_action;
  end if;

  if p_action = 'approve' then
    if cur.redirect_pending then
      raise exception 'draft % was sent back to the agent (mode %) and no new body has arrived. Wait for it or reject.', p_draft_id, cur.mode;
    end if;
    if cur.kind = 'reply' and not (cur.parent_url is null and
      (scenario_context(p_draft_id)->>'allowed')::boolean and
      exists (select 1 from scenario_acts where draft_id = p_draft_id and depends_on is not null)) then
      if cur.parent_url is null then
        raise exception 'reply draft % has no parent_url', p_draft_id;
      end if;
      if is_our_url(cur.parent_url) and not scenario_self_reply(p_draft_id, cur.parent_url) then
        raise exception 'reply draft % answers one of OUR OWN comments (%). Never two of our accounts in one exchange. Reject it.', p_draft_id, cur.parent_url;
      end if;
      if cur.parent_confirmed_by is null and not scenario_self_reply(p_draft_id, cur.parent_url) then
        raise exception 'reply draft %: confirm the parent is a real stranger before approving', p_draft_id;
      end if;
    end if;
    if p_action = 'approve' and (p_body is not null and p_body <> cur.body) then
      raise exception 'approve carries no body. Save the edit first, then approve the saved text.';
    end if;
  end if;

  insert into draft_revisions (draft_id, editor, action, body_before, body_after, note)
  values (p_draft_id, coalesce(p_editor,'unknown'), p_action, cur.body,
          case when p_action='edit' then p_body else cur.body end, p_note);

  update drafts set
    body            = case when p_action='edit' then p_body else body end,
    status          = new_status,
    reject_reason   = case when p_action='reject' then p_note else reject_reason end,
    send_cleared_at = case when p_action='approve' then now() else null end,
    gate_failed_at  = case when p_action='approve' then gate_failed_at else null end,
    gate_failure    = case when p_action='approve' then gate_failure else null end,
    reviewed_at     = now(),
    updated_at      = now()
  where id = p_draft_id
  returning * into out_row;

  insert into activity_log (actor, action, detail)
  values (coalesce(p_editor,'unknown'), 'draft_' || p_action,
          jsonb_build_object('draft', p_draft_id, 'thread', cur.thread_id, 'kind', cur.kind, 'mode', cur.mode,
                             'cleared', p_action = 'approve'));
  return out_row;
end $function$;
CREATE OR REPLACE FUNCTION public.review_scenario_run(p_run_id uuid, p_action text, p_note text, p_editor text)
 RETURNS scenario_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    if jsonb_array_length(template.spec->'acts') < 1 or
       (select count(*) from scenario_acts where run_id = p_run_id) <> jsonb_array_length(template.spec->'acts') then
      raise exception 'a playbook needs at least one segment and every planned segment must be filed';
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
end $function$;

-- A public read key is not authority to approve or alter a queue.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('review_draft','redirect_draft','request_pullback','approve_draft_batch',
      'review_script_segment','review_scenario_run','set_account_disclosed','save_sequence','start_sequence_run','cancel_sequence_run') loop
    execute format('revoke all on function %s from public, anon, authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
revoke insert,update,delete,truncate on drafts,accounts,jobs,engain_tasks,scenario_runs,scenario_acts,sequence_runs,sequences from anon,authenticated;

create or replace function acquire_workflow_clock(p_token uuid) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare taken text;
begin
  insert into workflow_state(key,value) values('tick-lease',jsonb_build_object('token',p_token,'until',now()+interval '2 minutes'))
  on conflict(key) do update set value=excluded.value,updated_at=now()
    where (workflow_state.value->>'until')::timestamptz<now() returning key into taken;
  return taken is not null;
end $$;
create or replace function release_workflow_clock(p_token uuid) returns void
language sql security definer set search_path=public,pg_temp as $$
  delete from workflow_state where key='tick-lease' and value->>'token'=p_token::text;
$$;
revoke all on function acquire_workflow_clock(uuid),release_workflow_clock(uuid) from public,anon,authenticated;
grant execute on function acquire_workflow_clock(uuid),release_workflow_clock(uuid) to service_role;
commit;
