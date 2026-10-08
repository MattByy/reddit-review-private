-- Existing review helpers captured read-only, without production rows.
CREATE OR REPLACE FUNCTION public.review_draft(p_draft_id uuid, p_action text, p_body text, p_note text, p_editor text)
 RETURNS drafts
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare cur drafts; new_status text; out_row drafts;
begin
  select * into cur from drafts where id = p_draft_id;
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
CREATE OR REPLACE FUNCTION public.scenario_review_snapshot(p_run_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select jsonb_build_object('scenario', r.scenario_slug, 'spec', s.spec,
    'subreddit', r.subreddit, 'thread_id', r.thread_id, 'thread_url', r.thread_url,
    'acts', (select jsonb_agg(jsonb_build_object(
      'id', a.id, 'seq', a.seq, 'kind', a.kind, 'depends_on', a.depends_on,
      'after_min', a.after_min, 'draft_id', a.draft_id,
      'body', d.body, 'title', d.title, 'draft_kind', d.kind,
      'mode', d.mode, 'thread_id', d.thread_id, 'subreddit', d.subreddit
    ) order by a.seq) from scenario_acts a left join drafts d on d.id = a.draft_id
      where a.run_id = r.id))
  from scenario_runs r join scenarios s on s.slug = r.scenario_slug where r.id = p_run_id
$function$;
CREATE OR REPLACE FUNCTION public.scenario_self_reply(p_draft_id uuid, p_parent_url text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce((scenario_context(p_draft_id, p_parent_url)->>'self_reply')::boolean, false)
$function$;
