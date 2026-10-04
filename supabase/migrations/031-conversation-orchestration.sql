-- Conversation orchestration. Apply after migration 030.
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
    if t is null or t not in ('write', 'approve', 'send', 'wait_live', 'wait', 'check_replies', 'answer_replies', 'agent_task', 'conversation_aware', 'asymmetric_participation', 'depth_variation') then
      return format('step %s: unknown type %s', i, coalesce(t, 'null'));
    end if;
    if t = 'depth_variation' and coalesce(s->>'depth', '') not in ('brief','standard','detailed') then
      return format('step %s: depth must be brief, standard or detailed', i); end if;
    if t = 'asymmetric_participation' and s ? 'max_engagements' then
      if coalesce(s->>'max_engagements', '') !~ '^[1-9][0-9]?$|^100$' then
        return format('step %s: max_engagements must be an integer from 1 to 100', i); end if;
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

notify pgrst, 'reload schema';
commit;
