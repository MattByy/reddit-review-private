-- Account A comments; account B replies to that verified comment.
-- Runs snapshot their accounts and steps. Reader monitoring remains separate.
begin;
alter table sequences add column if not exists playbook boolean not null default false;
alter table sequence_runs add column if not exists playbook boolean not null default false;

create or replace function playbook_steps_valid(p_steps jsonb)
returns boolean language plpgsql immutable as $$
declare s jsonb; written boolean := false; sent boolean := false; live boolean := false; checked boolean := false;
begin
  if jsonb_typeof(p_steps) is distinct from 'array' or jsonb_array_length(p_steps)=0 then return false; end if;
  for s in select value from jsonb_array_elements(p_steps) loop
    case s->>'type'
      when 'write' then
        if coalesce(s->>'kind','') not in ('comment','reply','post') then return false; end if;
        if s->>'kind'='reply' then
          if s->>'target'='previous_comment' then
            if not live then return false; end if;
          elsif coalesce(s->>'target_url','') !~ '^https://(www\.)?reddit\.com/r/[^/]+/comments/[a-zA-Z0-9]+/[^/]*/[a-zA-Z0-9]+' then return false;
          end if;
        end if;
        if s->>'kind'='post' and (nullif(s->>'subreddit','') is null or nullif(s->>'title','') is null) then return false; end if;
        written := true; sent := false; live := false; checked := false;
      when 'approve' then if not written then return false; end if;
      when 'send' then if not written then return false; end if; sent := true;
      when 'wait_live' then if not sent then return false; end if; live := true;
      when 'wait' then if coalesce((s->>'minutes')::numeric,0)<=0 then return false; end if;
      when 'check_replies' then if not live then return false; end if; checked := true;
      when 'answer_replies' then if not checked then return false; end if;
      when 'agent_task' then if nullif(btrim(s->>'instruction'),'') is null then return false; end if;
      else return false;
    end case;
  end loop;
  return true;
exception when others then return false;
end $$;

insert into sequences(id,name,description,steps,playbook,created_by) values (
  'bdb2d105-817b-4e40-8849-9f93a7d00001', 'Comment → reply from another account',
  'Account A posts the first comment. After it is live and the delay has passed, account B replies directly to it. Each draft goes through Review.',
  '[{"type":"write","kind":"comment","role":"account_a","brief":"Write the opening comment for this thread."},
    {"type":"approve"},{"type":"send"},{"type":"wait_live"},{"type":"wait","minutes":1440},
    {"type":"write","kind":"reply","role":"account_b","target":"previous_comment","brief":"Reply directly to the opening comment from account A, using its published text as context."},
    {"type":"approve"},{"type":"send"},{"type":"wait_live"}]', true, 'migration-038'
) on conflict(id) do nothing;

create or replace function start_playbook_run(p_sequence_id uuid,p_thread_id text,p_account_a text,p_account_b text,p_request_id uuid,p_editor text)
returns sequence_runs language plpgsql security definer set search_path=public,pg_temp as $$
declare book sequences; t threads; r sequence_runs; steps jsonb;
begin
  if p_request_id is null then raise exception 'A stable request ID is required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('playbook:'||p_request_id::text,0));
  select * into r from sequence_runs where id=p_request_id;
  if r.id is not null then
    if not r.playbook or r.sequence_id<>p_sequence_id or r.thread_id is distinct from p_thread_id
      or r.steps->0->>'account_id' is distinct from p_account_a or r.steps->5->>'account_id' is distinct from p_account_b then
      raise exception 'Request ID already belongs to a different run';
    end if;
    return r;
  end if;
  if p_account_a is null or p_account_b is null or p_account_a=p_account_b then raise exception 'Choose two different accounts'; end if;
  if (select count(*) from accounts where id in (p_account_a,p_account_b) and active and disclosed and usable is true)<>2 then
    raise exception 'Both accounts must be active, usable and disclosed';
  end if;
  select * into book from sequences where id=p_sequence_id and playbook and enabled;
  if book.id is null then raise exception 'Playbook is missing or disabled'; end if;
  select * into t from threads where id=p_thread_id;
  if t.id is null or t.locked is true or t.archived is true then raise exception 'Choose an available registered thread'; end if;
  if exists(select 1 from sequence_runs where thread_id=p_thread_id and status='open' and playbook) then
    raise exception 'This thread already has an open playbook run';
  end if;
  select jsonb_agg(case when value->>'type'='write' then value||jsonb_build_object('account_id',
    case value->>'role' when 'account_a' then p_account_a when 'account_b' then p_account_b end) else value end order by ord)
    into steps from jsonb_array_elements(book.steps) with ordinality x(value,ord);
  if not playbook_steps_valid(steps) or steps->0->>'role' is distinct from 'account_a'
    or steps->5->>'role' is distinct from 'account_b' or steps->5->>'target' is distinct from 'previous_comment' then
    raise exception 'Unsupported playbook steps';
  end if;
  insert into sequence_runs(id,sequence_id,name,steps,state,thread_id,thread_url,subreddit,account_id,created_by,playbook)
    values(p_request_id,book.id,book.name,steps,'[]',t.id,t.url,t.subreddit,p_account_a,p_editor,true) returning * into r;
  return r;
end $$;
create unique index one_open_playbook_per_thread on sequence_runs(thread_id) where playbook and status='open';

-- This proof uses persisted run state and the actual verified parent task,
-- never an agent-supplied flag or an arbitrary comment from another run.
create or replace function playbook_job_context(p_job_id uuid,p_account_id text,p_parent_url text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare j jobs; r sequence_runs; s jsonb; parent engain_tasks; parent_job jobs; parent_step int;
begin
  select * into j from jobs where id=p_job_id;
  select * into r from sequence_runs where id=j.sequence_run_id;
  if r.id is null or not r.playbook then return jsonb_build_object('playbook',false,'ready',false); end if;
  s := r.steps->j.step;
  if r.status<>'open' or j.kind<>'write' or s->>'type' is distinct from 'write'
    or j.account_id is distinct from p_account_id or s->>'account_id' is distinct from p_account_id
    or j.thread_id is distinct from r.thread_id then
    return jsonb_build_object('playbook',true,'ready',false,'reason','Run or account assignment changed');
  end if;
  if s->>'kind'='comment' and j.step=0 and p_parent_url is null then
    return jsonb_build_object('playbook',true,'ready',true,'self_reply',false);
  end if;
  if s->>'kind' is distinct from 'reply' or s->>'target' is distinct from 'previous_comment' then
    return jsonb_build_object('playbook',true,'ready',false,'reason','Reply must target the preceding comment');
  end if;
  select max(ord-1)::int into parent_step from jsonb_array_elements(r.steps) with ordinality x(value,ord)
    where ord-1<j.step and value->>'type'='write';
  select * into parent_job from jobs where sequence_run_id=r.id and step=parent_step and kind='write';
  select * into parent from engain_tasks where draft_id=parent_job.draft_id;
  if parent.id is null or parent.visibility is distinct from 'visible' or parent.reddit_url is null
    or lower(coalesce(parent.status,'')) in ('failed','cancelled','canceled','removed','deleted','rejected','error')
    or parent.cancel_requested_at is not null
    or parent.thread_id is distinct from r.thread_id or parent.user_account_id is distinct from parent_job.account_id
    or parent.user_account_id=p_account_id or rtrim(parent.reddit_url,'/') is distinct from rtrim(p_parent_url,'/')
    or j.target_url is distinct from p_parent_url then
    return jsonb_build_object('playbook',true,'ready',false,'reason','The preceding account comment is not a verified available parent');
  end if;
  return jsonb_build_object('playbook',true,'ready',true,'self_reply',true,'parent_task_id',parent.id,'parent_account_id',parent.user_account_id);
end $$;

revoke all on function start_playbook_run(uuid,text,text,text,uuid,text) from public,anon,authenticated;
grant execute on function start_playbook_run(uuid,text,text,text,uuid,text) to service_role;
revoke all on function playbook_job_context(uuid,text,text) from public;
grant execute on function playbook_job_context(uuid,text,text) to anon,authenticated,service_role;

-- Review and reservation definitions follow below, with the same playbook proof.

CREATE OR REPLACE FUNCTION public.review_draft(p_draft_id uuid, p_action text, p_body text, p_note text, p_editor text)
 RETURNS drafts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO public, pg_temp
AS $function$
declare cur drafts; new_status text; out_row drafts; play jsonb;
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
    play := playbook_job_context(cur.origin_job_id,cur.account_id,cur.parent_url);
    if (play->>'playbook')::boolean and not (play->>'ready')::boolean then raise exception '%',play->>'reason'; end if;
    if cur.redirect_pending then
      raise exception 'draft % was sent back to the agent (mode %) and no new body has arrived. Wait for it or reject.', p_draft_id, cur.mode;
    end if;
    if cur.kind = 'reply' and not (cur.parent_url is null and
      (scenario_context(p_draft_id)->>'allowed')::boolean and
      exists (select 1 from scenario_acts where draft_id = p_draft_id and depends_on is not null)) then
      if cur.parent_url is null then
        raise exception 'reply draft % has no parent_url', p_draft_id;
      end if;
      if is_our_url(cur.parent_url) and not scenario_self_reply(p_draft_id, cur.parent_url) and not coalesce((play->>'self_reply')::boolean,false) then
        raise exception 'reply draft % answers one of OUR OWN comments (%). Start a playbook run to assign the reply account and parent.', p_draft_id, cur.parent_url;
      end if;
      if cur.parent_confirmed_by is null and not scenario_self_reply(p_draft_id, cur.parent_url) then
        raise exception 'reply draft %: confirm the intended parent before approving', p_draft_id;
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

create or replace function reserve_publication(p_draft_id uuid,p_body text,p_parent_url text,p_account_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare d drafts; a accounts; attempt publication_attempts; last_global timestamptz; last_sub timestamptz; today_count int; sub text; thread_url text; play jsonb;
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
  play := playbook_job_context(d.origin_job_id,p_account_id,p_parent_url);
  if (play->>'playbook')::boolean and not (play->>'ready')::boolean then
    return jsonb_build_object('ok',false,'reason',play->>'reason'); end if;
  if not coalesce((play->>'self_reply')::boolean,false) and (exists(select 1 from engain_tasks where thread_id=d.thread_id and user_account_id<>p_account_id and lower(coalesce(status,'')) not in ('failed','cancelled','canceled','removed','deleted','rejected'))
    or exists(select 1 from publication_attempts where thread_id=d.thread_id and account_id<>p_account_id and state<>'failed')) then
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

notify pgrst, 'reload schema';
commit;
