-- Run against an isolated database with schema migrations through 030 installed.
-- Test data is rolled back, including a failed assertion.
begin;
do $$
declare sid uuid; first_run sequence_runs; second_run sequence_runs; did uuid;
  test_steps jsonb := '[{"type":"write","kind":"comment"},{"type":"approve"},{"type":"send"},{"type":"wait_live"},{"type":"write","kind":"reply","account_id":"test-multi-b","reply_to_step":4}]';
begin
  insert into accounts(id, active, disclosed, disclosure_line) values
    ('test-multi-a', true, true, '(Operated by Alpha)'),
    ('test-multi-b', true, true, '(Operated by Beta)'),
    ('test-multi-inactive', false, true, '(Operated by Beta)');
  insert into sequences(name, steps) values ('Multi-account regression', test_steps) returning id into sid;
  first_run := start_sequence_run(sid, 'https://www.reddit.com/r/testing/comments/mt1234/topic/', 'test-multi-a', null, 'test');
  assert first_run.account_id = 'test-multi-a', 'step overrides must not replace the default account';
  insert into engain_tasks(id, project_id, content, thread_id, user_account_id, status, reddit_url)
    values ('test-multi-task', 'accounts-beta', 'Parent content', 'mt1234', 'test-multi-a', 'published',
      'https://www.reddit.com/r/testing/comments/mt1234/topic/mt5678/');
  second_run := start_sequence_run(sid, first_run.thread_url, 'test-multi-b', null, 'test');
  assert second_run.id <> first_run.id, 'two accounts must be able to start runs on one thread';
  assert second_run.steps = test_steps, 'run must snapshot per-step accounts and dependencies';
  assert sequence_steps_valid(test_steps) is null;
  assert sequence_steps_valid(jsonb_set(test_steps, '{4,reply_to_step}', '5')) is not null, 'future dependency';
  assert sequence_steps_valid(jsonb_set(test_steps, '{4,reply_to_step}', '1')) is not null, 'non-publication dependency';
  assert sequence_steps_valid(jsonb_set(test_steps, '{4,reply_to_step}', 'null')) is not null, 'null dependency';
  assert sequence_steps_valid(jsonb_set(test_steps, '{4,target_url}', '"https://www.reddit.com/r/testing/comments/mt1234/topic/mt5678/"')) is not null, 'ambiguous dependency';
  update sequences set steps = jsonb_set(test_steps, '{4,account_id}', '"test-multi-inactive"') where id = sid;
  begin
    perform start_sequence_run(sid, first_run.thread_url, 'test-multi-a', null, 'test');
    raise exception 'inactive account accepted' using errcode = 'XX000';
  exception when raise_exception then null;
  end;
  update sequences set steps = first_run.steps where id = sid;
  update threads set locked = true where id = 'mt1234';
  begin
    perform start_sequence_run(sid, first_run.thread_url, 'test-multi-a', null, 'test');
    raise exception 'locked thread accepted' using errcode = 'XX000';
  exception when raise_exception then null;
  end;
  update threads set locked = false where id = 'mt1234';
  insert into drafts(thread_id, kind, mode, body, status, account_id, parent_url)
    values ('mt1234','reply','reply','A different observation. (Operated by Beta)','pending','test-multi-b',
      'https://www.reddit.com/r/testing/comments/mt1234/topic/mt5678/') returning id into did;
  begin
    perform review_draft(did, 'approve', null, null, 'test');
    raise exception 'unconfirmed parent accepted' using errcode = 'XX000';
  exception when raise_exception then null;
  end;
  update drafts set parent_confirmed_by = 'test' where id = did;
  perform review_draft(did, 'approve', null, null, 'test');
  assert exists (select 1 from posting_queue where draft_id = did), 'reviewed cross-account reply must enter queue';
  perform redirect_draft(did, 'reply', 'https://www.reddit.com/r/testing/comments/mt1234/topic/mt5678/', null, 'test');
  assert not exists (select 1 from posting_queue where draft_id = did), 'redirect must require another review';
end $$;
rollback;
