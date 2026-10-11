begin;
-- Account authorization is separate from whether a profile was inspected.
alter table accounts add column if not exists approved boolean not null default true;
alter table drafts add column if not exists automatic_note text;
alter table drafts add column if not exists automatic_checked_at timestamptz;
update accounts set approved=true,active=true;
insert into activity_log(actor,action,detail) values('operator','all_accounts_enabled',jsonb_build_object('reason','User requested all accounts enabled and no further publishing approvals','count',(select count(*) from accounts)));
insert into workflow_state(key,value) values('publishing','{"automatic":true}') on conflict(key) do update set value=excluded.value,updated_at=now();

create or replace function choose_draft_account(p_draft_id uuid)
returns setof accounts language plpgsql security definer set search_path=public,pg_temp as $$
declare d drafts; selected text;
begin
  select * into d from drafts where id=p_draft_id;
  if d.id is null then return; end if;
  selected := d.account_id;
  if selected is null then
    select user_account_id into selected from engain_tasks where thread_id=d.thread_id and user_account_id is not null
      and lower(coalesce(status,'')) not in ('failed','cancelled','canceled','removed','deleted','rejected','error') order by submitted_at limit 1;
  end if;
  if selected is null then
    select account_id into selected from drafts where thread_id=d.thread_id and account_id is not null
      and status not in ('rejected','cancelled','removed') order by created_at limit 1;
  end if;
  if selected is null then
    select a.id into selected from accounts a where a.active and a.approved and a.usable is true
      order by (select count(*) from drafts q where q.account_id=a.id and q.status in ('pending','edited','approved')),a.label,a.id limit 1;
  end if;
  return query select * from accounts a where a.id=selected and a.active and a.approved and a.usable is true;
end $$;

create or replace function prepare_automatic_draft(p_draft_id uuid,p_expected_body text,p_account_id text,p_body text,p_context jsonb)
returns drafts language plpgsql security definer set search_path=public,pg_temp as $$
declare d drafts; a accounts; play jsonb;
begin
  if not coalesce((select (value->>'automatic')::boolean from workflow_state where key='publishing'),false) then raise exception 'Automatic publishing is disabled'; end if;
  select * into d from drafts where id=p_draft_id for update;
  if d.id is null or d.status not in ('pending','edited','approved') or d.redirect_pending or d.gate_failed_at is not null
    or d.pullback_requested_at is not null or d.body is distinct from p_expected_body or d.mode='scenario'
    or (d.account_id is not null and d.account_id<>p_account_id)
    or exists(select 1 from publication_attempts where draft_id=d.id) or exists(select 1 from engain_tasks where draft_id=d.id) then
    raise exception 'Draft changed or has already been submitted'; end if;
  select * into a from accounts where id=p_account_id;
  if a.id is null or not a.approved or not a.active or a.usable is distinct from true then raise exception 'Account is unavailable'; end if;
  play := playbook_job_context(d.origin_job_id,a.id,d.parent_url);
  if (play->>'playbook')::boolean and not (play->>'ready')::boolean then raise exception '%',play->>'reason'; end if;
  if d.kind='reply' and (d.parent_url is null or nullif(p_context->'parent'->>'body','') is null
    or (is_our_url(d.parent_url) and not coalesce((play->>'self_reply')::boolean,false))) then raise exception 'Reply parent is not established'; end if;
  if d.body is distinct from p_body then
    insert into draft_revisions(draft_id,editor,action,body_before,body_after,note)
      values(d.id,'automatic','edit',d.body,p_body,'Added the assigned account attribution');
  end if;
  update drafts set account_id=a.id,body=p_body,status='approved',send_cleared_at=now(),thread_context=p_context,automatic_note=null,automatic_checked_at=now(),
    parent_confirmed_by=case when kind='reply' then 'automatic-context-check' else parent_confirmed_by end,
    parent_confirmed_at=case when kind='reply' then now() else parent_confirmed_at end,updated_at=now()
    where id=d.id returning * into d;
  insert into activity_log(actor,action,detail) values('automatic','draft_prepared',jsonb_build_object('draft',d.id,'account',a.id));
  return d;
end $$;

create or replace function update_queued_draft(p_draft_id uuid,p_action text,p_body text,p_account_id text,p_editor text)
returns drafts language plpgsql security definer set search_path=public,pg_temp as $$
declare d drafts; play jsonb;
begin
  select * into d from drafts where id=p_draft_id for update;
  if d.id is null or d.status not in ('pending','edited','approved','rejected') or d.mode='scenario'
    or exists(select 1 from publication_attempts where draft_id=d.id) or exists(select 1 from engain_tasks where draft_id=d.id) then
    raise exception 'This draft is already submitted or belongs to a legacy script'; end if;
  if p_action not in ('save','stop','resume') then raise exception 'Unknown draft action'; end if;
  if p_action='save' then
    if nullif(btrim(p_body),'') is null then raise exception 'Comment cannot be empty'; end if;
    if p_account_id is not null and not exists(select 1 from accounts where id=p_account_id and approved and active and usable is true) then raise exception 'Account is unavailable'; end if;
    play := playbook_job_context(d.origin_job_id,p_account_id,d.parent_url);
    if (play->>'playbook')::boolean and not (play->>'ready')::boolean then raise exception '%',play->>'reason'; end if;
  end if;
  insert into draft_revisions(draft_id,editor,action,body_before,body_after,note)
    values(d.id,p_editor,case when p_action='stop' then 'reject' when p_action='resume' then 'edit' else 'edit' end,d.body,coalesce(p_body,d.body),'Drafts: '||p_action);
  update drafts set body=case when p_action='save' then p_body else body end,
    account_id=case when p_action='save' then p_account_id else account_id end,
    status=case when p_action='stop' then 'rejected' when p_action='resume' then 'pending' when d.status='rejected' then 'rejected' else 'pending' end,
    reject_reason=case when p_action='stop' then 'Stopped by operator' else null end,
    send_cleared_at=null,parent_confirmed_by=null,parent_confirmed_at=null,gate_failed_at=null,gate_failure=null,
    redirect_pending=false,automatic_note=null,automatic_checked_at=null,updated_at=now() where id=d.id returning * into d;
  return d;
end $$;

revoke all on function choose_draft_account(uuid),prepare_automatic_draft(uuid,text,text,text,jsonb),update_queued_draft(uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function choose_draft_account(uuid),prepare_automatic_draft(uuid,text,text,text,jsonb),update_queued_draft(uuid,text,text,text,text) to service_role;

-- Update the new run and reservation gates, retaining the existing function signatures.
do $$
declare fn regprocedure; definition text;
begin
  foreach fn in array array['start_playbook_run(uuid,text,text,text,uuid,text)'::regprocedure,'reserve_publication(uuid,text,text,text)'::regprocedure] loop
    definition:=pg_get_functiondef(fn);
    definition:=replace(replace(replace(definition,'and disclosed and usable','and approved and usable'),'not a.disclosed','not a.approved'),'active, usable and disclosed','active, usable and enabled');
    execute definition;
  end loop;
  fn:=to_regprocedure('start_sequence_run(uuid,text,text,text,text)');
  if fn is not null then
    definition:=pg_get_functiondef(fn);
    definition:=replace(definition,'not acct.disclosed or not acct.active','not acct.approved or not acct.active or acct.usable is distinct from true');
    definition:=replace(definition,'is not disclosed. Mark it on Plan once its profile says Geonode runs it.','is not currently available.');
    execute definition;
  end if;
end $$;

update sequences set description='Account A posts the first comment. After it is live and the delay has passed, account B replies directly to it. Drafts are checked and queued automatically.' where playbook;

create or replace view posting_queue as
select d.id as draft_id,d.thread_id,d.kind,d.mode,d.parent_url,d.body,d.upvotes_suggested,d.upvotes_reason,d.send_cleared_at,
  d.models,d.strategy,d.prompt_version,d.source,d.parent_confirmed_by,t.url as thread_url,coalesce(d.subreddit,t.subreddit) as subreddit,
  coalesce(d.title,t.title) as title,t.archived,t.locked,rc.verdict as rule_verdict,rc.removal_risk
from drafts d left join threads t on t.id=d.thread_id
left join lateral(select verdict,removal_risk from rule_checks where draft_id=d.id order by checked_at desc limit 1) rc on true
where d.status='approved' and coalesce(d.body,'')<>'' and not d.redirect_pending and d.gate_failed_at is null and d.pullback_requested_at is null
  and scenario_ready(d.id)
  and (d.kind<>'reply' or (d.parent_url is not null and (scenario_self_reply(d.id,d.parent_url)
    or (d.parent_confirmed_by is not null and (not is_our_url(d.parent_url)
      or coalesce((playbook_job_context(d.origin_job_id,d.account_id,d.parent_url)->>'self_reply')::boolean,false))))))
  and (d.kind='post' or (t.id is not null and t.archived is not true and t.locked is not true))
  and not exists(select 1 from engain_tasks e where e.draft_id=d.id);
grant select on posting_queue to anon,authenticated,service_role;
do $$
declare view_name text; definition text;
begin
  foreach view_name in array array['status_items','plan_timeline'] loop
    if to_regclass('public.'||view_name) is not null then
      definition:=pg_get_viewdef(('public.'||view_name)::regclass,true);
      definition:=replace(definition,'waiting for a human to approve on Review','waiting for automatic checks');
      definition:=replace(definition,'waiting for review','waiting for automatic checks');
      definition:=replace(definition,'approved, held until its sequence reaches Send','ready, waiting for its run to reach Send');
      definition:=replace(definition,'approved, goes out on the next send pass','queued for the next send pass');
      execute format('create or replace view public.%I as %s',view_name,definition);
    end if;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
