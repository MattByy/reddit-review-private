-- Multi-account sequences. Apply after migration 029. Human review and disclosure remain required.
begin;

create or replace function sequence_steps_valid(p_steps jsonb) returns text
language plpgsql immutable as $$
declare s jsonb; i int := 0; t text;
begin
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' then return 'steps must be a list'; end if;
  if jsonb_array_length(p_steps) = 0 then return 'add at least one step'; end if;
  if jsonb_array_length(p_steps) > 30 then return 'at most 30 steps'; end if;
  for s in select value from jsonb_array_elements(p_steps) loop
    i := i + 1; t := s->>'type';
    if t is null or t not in ('write', 'approve', 'send', 'wait_live', 'wait', 'check_replies', 'answer_replies', 'agent_task') then
      return format('step %s: unknown type %s', i, coalesce(t, 'null'));
    end if;
    if t = 'write' and coalesce(s->>'kind', '') not in ('comment', 'reply', 'post') then
      return format('step %s: write needs kind comment, reply or post', i); end if;
    if t = 'write' and s->>'kind' = 'reply' and coalesce(s->>'target_url', '') = '' and not (s ? 'reply_to_step') then
      return format('step %s: a reply needs the URL of the comment it answers', i); end if;
    if s ? 'reply_to_step' then
      if t <> 'write' or s->>'kind' <> 'reply' then return format('step %s: reply_to_step only applies to replies', i); end if;
      if coalesce(s->>'target_url', '') <> '' then return format('step %s: choose target_url or reply_to_step', i); end if;
      if coalesce(s->>'reply_to_step', '') !~ '^[1-9][0-9]*$' then return format('step %s: reply_to_step must be a positive step number', i); end if;
      if (s->>'reply_to_step')::numeric >= i then return format('step %s: reply_to_step must precede this step', i); end if;
      if p_steps->((s->>'reply_to_step')::int - 1)->>'type' is distinct from 'wait_live' then
        return format('step %s: reply_to_step must reference wait_live', i); end if;
    end if;
    if s ? 'account_id' and (jsonb_typeof(s->'account_id') <> 'string' or btrim(s->>'account_id') = '') then
      return format('step %s: account_id must be a nonempty string', i); end if;
    if t = 'wait' and coalesce((s->>'minutes')::numeric, 0) <= 0 then
      return format('step %s: wait needs minutes', i); end if;
    if t = 'agent_task' and coalesce(btrim(s->>'instruction'), '') = '' then
      return format('step %s: agent task needs an instruction', i); end if;
  end loop;
  return null;
end $$;

create or replace function start_sequence_run(p_sequence_id uuid, p_thread_url text,
                                              p_account_id text, p_note text, p_editor text)
returns sequence_runs language plpgsql security definer set search_path = public, pg_temp as $$
declare seq sequences; acct accounts; tid text; sub text; cur sequence_runs; aid text; err text;
begin
  if nullif(btrim(p_editor), '') is null then raise exception 'editor is required'; end if;
  select * into seq from sequences where id = p_sequence_id;
  if seq.id is null or not seq.enabled then raise exception 'no enabled sequence %', p_sequence_id; end if;
  err := sequence_steps_valid(seq.steps);
  if err is not null then raise exception '%', err; end if;
  for aid in select p_account_id union select value->>'account_id' from jsonb_array_elements(seq.steps) where value ? 'account_id' loop
    select * into acct from accounts where id = aid;
    if acct.id is null then raise exception 'account % not found', aid; end if;
    if not acct.active or not acct.disclosed or nullif(btrim(acct.disclosure_line), '') is null then
      raise exception 'account % must be active and disclosed with a disclosure line', aid;
    end if;
  end loop;
  if nullif(btrim(p_thread_url), '') is not null then
    if p_thread_url !~* '^https?://(www\.|old\.)?reddit\.com/r/[^/]+/comments/[a-z0-9]+/' then
      raise exception 'a Reddit thread permalink is required';
    end if;
    tid := lower(substring(p_thread_url from '/comments/([A-Za-z0-9]+)'));
    sub := substring(p_thread_url from '/r/([A-Za-z0-9_]+)');
    if tid is null then raise exception 'that is not a reddit thread URL (it needs /comments/<id>/)'; end if;
    insert into threads(id, url, subreddit, title, screen_source)
      values (tid, split_part(p_thread_url, '?', 1), sub, null, 'sequence')
      on conflict (id) do nothing;
    if exists (select 1 from threads where id = tid and (archived or locked)) then
      raise exception 'thread % is archived or locked', tid;
    end if;
    select subreddit into sub from threads where id = tid;
  end if;
  insert into sequence_runs(sequence_id, name, steps, state, thread_id, thread_url, subreddit, account_id, note, created_by)
    values (seq.id, seq.name, seq.steps,
            (select coalesce(jsonb_agg(jsonb_build_object('status', 'waiting')), '[]'::jsonb) from jsonb_array_elements(seq.steps)),
            tid, nullif(split_part(coalesce(p_thread_url, ''), '?', 1), ''), sub, p_account_id, p_note, p_editor)
    returning * into cur;
  insert into activity_log(actor, action, detail) values (p_editor, 'sequence_run_started',
    jsonb_build_object('run', cur.id, 'sequence', seq.name, 'thread', tid, 'account', p_account_id));
  return cur;
end $$;

create or replace function review_draft(
  p_draft_id uuid, p_action text, p_body text, p_note text, p_editor text
) returns drafts language plpgsql security definer as $$
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
      if cur.parent_confirmed_by is null and not scenario_self_reply(p_draft_id, cur.parent_url) then
        raise exception 'reply draft %: confirm the reply targets the intended parent before approving', p_draft_id;
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
end $$;

create or replace function redirect_draft(
  p_draft_id uuid, p_mode text, p_parent_url text, p_note text, p_editor text
) returns drafts language plpgsql security definer as $$
declare cur drafts; out_row drafts; new_kind text; purl text;
begin
  select * into cur from drafts where id = p_draft_id;
  if cur.id is null then raise exception 'draft % not found', p_draft_id; end if;
  if p_mode not in ('comment','reply','sharpen') then raise exception 'mode must be comment, reply or sharpen'; end if;
  if cur.kind = 'post' then raise exception 'a post draft has no mode to change'; end if;
  if cur.status not in ('pending','edited','approved') then
    raise exception 'draft % is %, only a pending, edited or approved draft can be redirected', p_draft_id, cur.status;
  end if;
  if exists (select 1 from engain_tasks e where e.draft_id = p_draft_id) then
    raise exception 'draft % has already been sent to Engain. Pull it back instead.', p_draft_id;
  end if;

  if p_mode = 'reply' then
    purl := nullif(trim(p_parent_url), '');
    if purl is null or purl !~* '^https?://(www\.|old\.)?reddit\.com/r/[^/]+/comments/[a-z0-9]+/[^/]+/[a-z0-9]+/?' then
      raise exception 'reply needs the permalink of the parent comment (…/comments/<post>/<slug>/<comment>/)';
    end if;
    new_kind := 'reply';
  else
    purl := null;
    new_kind := 'comment';
  end if;

  insert into draft_revisions (draft_id, editor, action, body_before, body_after, note)
  values (p_draft_id, coalesce(p_editor,'unknown'), 'redirect', cur.body, cur.body,
          'mode ' || cur.mode || ' -> ' || p_mode || coalesce(' parent ' || purl, '') || coalesce(': ' || p_note, ''));

  update drafts set
    mode                = p_mode,
    kind                = new_kind,
    parent_url          = purl,
    redirect_pending    = true,
    redirected_at       = now(),
    redirect_note       = p_note,
    status              = 'pending',
    send_cleared_at     = null,
    gate_failed_at      = null,
    gate_failure        = null,
    parent_confirmed_by = null,
    parent_confirmed_at = null,
    updated_at          = now()
  where id = p_draft_id
  returning * into out_row;

  insert into activity_log (actor, action, detail)
  values (coalesce(p_editor,'unknown'), 'draft_redirected',
          jsonb_build_object('draft', p_draft_id, 'thread', cur.thread_id, 'from', cur.mode, 'to', p_mode, 'parent', purl));
  return out_row;
end $$;

create or replace view posting_queue as
select d.id            as draft_id,
       d.thread_id,
       d.kind,
       d.mode,
       d.parent_url,
       d.body,
       d.upvotes_suggested,
       d.upvotes_reason,
       d.send_cleared_at,
       d.models,
       d.strategy,
       d.prompt_version,
       d.source,
       d.parent_confirmed_by,
       t.url            as thread_url,
       coalesce(d.subreddit, t.subreddit) as subreddit,
       coalesce(d.title,     t.title)     as title,
       t.archived,
       t.locked,
       rc.verdict       as rule_verdict,
       rc.removal_risk
from drafts d
left join threads t on t.id = d.thread_id
left join lateral (
  select verdict, removal_risk from rule_checks
  where draft_id = d.id order by checked_at desc limit 1
) rc on true
where d.status = 'approved'
  and coalesce(d.body, '') <> ''
  and d.redirect_pending = false
  and d.gate_failed_at is null
  and d.pullback_requested_at is null
  and scenario_ready(d.id)
  and (d.kind <> 'reply' or (d.parent_url is not null and (
    scenario_self_reply(d.id, d.parent_url)
    or (d.parent_confirmed_by is not null))))
  and (d.kind = 'post'
       or (t.id is not null and t.archived is not true and t.locked is not true))
  and not exists (select 1 from engain_tasks e where e.draft_id = d.id);


create or replace function set_account_disclosed(p_account_id text, p_disclosed boolean,
                                                 p_note text, p_editor text)
returns accounts language plpgsql security definer set search_path = public, pg_temp as $$
declare cur accounts;
begin
  if nullif(btrim(p_editor), '') is null then raise exception 'reviewer is required'; end if;
  if p_disclosed and nullif(btrim(p_note), '') is null then
    raise exception 'say how the profile identifies its operator (bio text, flair, display name)';
  end if;
  update accounts set disclosed = p_disclosed,
    disclosed_by = case when p_disclosed then p_editor end,
    disclosed_at = case when p_disclosed then now() end,
    notes = coalesce(nullif(btrim(p_note), ''), notes)
  where id = p_account_id returning * into cur;
  if cur.id is null then raise exception 'account % not found', p_account_id; end if;
  insert into activity_log(actor, action, detail) values (p_editor,
    case when p_disclosed then 'account_disclosed' else 'account_undisclosed' end,
    jsonb_build_object('account', p_account_id, 'label', cur.label, 'note', p_note));
  return cur;
end $$;

-- New accounts need an operator-specific line configured before use.
alter table accounts alter column disclosure_line set default '';
comment on view posting_queue is 'Reviewed drafts eligible for sending, including replies between disclosed managed accounts. Reply parent confirmation remains required.';
notify pgrst, 'reload schema';
commit;
