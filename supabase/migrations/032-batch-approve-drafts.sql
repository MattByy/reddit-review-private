-- Batch approve multiple drafts in one transaction.
-- Apply after migration 031.
begin;

create or replace function approve_draft_batch(
  p_draft_ids uuid[], p_note text, p_editor text
) returns table (
  draft_id uuid, thread_id text, kind text, mode text, body text, 
  status text, error text
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  did uuid; cur drafts; out_row drafts; idx int; err text; batch_count int;
begin
  if nullif(btrim(p_editor), '') is null then 
    raise exception 'editor is required'; 
  end if;
  
  if p_draft_ids is null or array_length(p_draft_ids, 1) = 0 then 
    raise exception 'at least one draft_id is required'; 
  end if;
  
  if array_length(p_draft_ids, 1) > 100 then 
    raise exception 'at most 100 drafts per batch'; 
  end if;
  
  batch_count := 0;
  
  -- Iterate and approve each draft in the batch
  foreach did in array p_draft_ids loop
    select * into cur from drafts where id = did;
    if cur.id is null then
      return query select did, null::text, null::text, null::text, null::text, null::text, 
                          'draft not found'::text;
      continue;
    end if;
    
    if cur.status = 'posted' then
      return query select did, cur.thread_id, cur.kind, cur.mode, cur.body, 
                          cur.status::text, 'draft is already posted'::text;
      continue;
    end if;
    
    if cur.status = 'approved' then
      return query select did, cur.thread_id, cur.kind, cur.mode, cur.body, 
                          cur.status::text, 'draft is already approved'::text;
      continue;
    end if;
    
    -- Check redirect_pending
    if cur.redirect_pending then
      return query select did, cur.thread_id, cur.kind, cur.mode, cur.body, 
                          cur.status::text, 
                          format('draft was sent back to the agent (mode %s) and no new body has arrived', cur.mode)::text;
      continue;
    end if;
    
    -- Check reply parent constraints
    if cur.kind = 'reply' and not (cur.parent_url is null and
      (scenario_context(did)->>'allowed')::boolean and
      exists (select 1 from scenario_acts where draft_id = did and depends_on is not null)) then
      if cur.parent_url is null then
        return query select did, cur.thread_id, cur.kind, cur.mode, cur.body, 
                            cur.status::text, 'reply draft has no parent_url'::text;
        continue;
      end if;
      if cur.parent_confirmed_by is null and not scenario_self_reply(did, cur.parent_url) then
        return query select did, cur.thread_id, cur.kind, cur.mode, cur.body, 
                            cur.status::text, 
                            'reply draft: confirm the reply targets the intended parent before approving'::text;
        continue;
      end if;
    end if;
    
    -- All checks passed, approve this draft
    insert into draft_revisions (draft_id, editor, action, body_before, body_after, note)
    values (did, coalesce(p_editor, 'unknown'), 'approve', cur.body, cur.body, p_note);
    
    update drafts set
      status = 'approved',
      send_cleared_at = now(),
      reviewed_at = now(),
      updated_at = now()
    where id = did
    returning * into out_row;
    
    insert into activity_log (actor, action, detail)
    values (coalesce(p_editor, 'unknown'), 'draft_approve',
            jsonb_build_object('draft', did, 'thread', cur.thread_id, 'kind', cur.kind, 
                              'mode', cur.mode, 'cleared', true, 'batch', true));
    
    return query select did, out_row.thread_id, out_row.kind, out_row.mode, out_row.body, 
                        out_row.status::text, null::text;
    
    batch_count := batch_count + 1;
  end loop;
  
  if batch_count = 0 then
    return query select p_draft_ids[1], null::text, null::text, null::text, null::text, 
                        null::text, 'no valid drafts to approve'::text;
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
