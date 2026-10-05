-- psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/script-review.sql
-- Requires full schema through 033. No vendor transport. Always rolls back.
begin;
\ir fixtures/review-scripts.sql

do $$
declare r scenario_runs; d drafts; first_id uuid; second_id uuid;
  standalone uuid; invalid_reply uuid; res record; n int; failed boolean;
begin
  for r in select * from scenario_runs where scenario_slug like 'review-fixture-%' loop
    assert not scenario_approved(r.id), 'new script must wait for review';
    select draft_id into first_id from scenario_acts where run_id=r.id and seq=1;
    select draft_id into second_id from scenario_acts where run_id=r.id and seq=2;
    perform review_script_segment(first_id,'approve',null,null,'fixture reviewer');
    assert not scenario_approved(r.id), 'one approved segment cannot release a script';
    perform review_scenario_run(r.id,'approve',null,'fixture reviewer');
    assert scenario_approved(r.id), 'complete script should now be approved';
    assert (select count(*) from script_segments where script_id=r.id) in (3,4,5);
    assert not exists (select 1 from posting_queue where draft_id in
      (select draft_id from scenario_acts where run_id=r.id)), 'fixture cannot enter posting queue';
    select * into d from drafts where id=second_id;
    perform review_script_segment(second_id,'edit',d.body || ' Edited.',null,'fixture reviewer');
    assert not scenario_approved(r.id), 'edit invalidates release';
    assert (select effective_review_status from script_review_state where id=r.id)='pending';
    perform review_script_segment(second_id,'approve',null,null,'fixture reviewer');
    assert not scenario_approved(r.id), 'segment reapproval cannot release parent';
    perform review_scenario_run(r.id,'approve',null,'fixture reviewer');
    assert scenario_approved(r.id);
    perform review_script_segment(second_id,'reject',null,'Fixture rejection','fixture reviewer');
    assert not scenario_approved(r.id), 'rejected segment blocks release';
    failed := false;
    begin
      perform review_scenario_run(r.id,'approve',null,'fixture reviewer');
    exception when others then failed := true; end;
    assert failed, 'whole-script approval must refuse rejected segment';
  end loop;
  insert into drafts(thread_id,kind,body,status) values
    ('reviewfixture','comment','Standalone test (Operated by Fixture Team)','pending') returning id into standalone;
  insert into drafts(thread_id,kind,body,status) values
    ('reviewfixture','reply','No parent test (Operated by Fixture Team)','pending') returning id into invalid_reply;
  n := 0;
  for res in select * from approve_draft_batch(array[standalone,invalid_reply,standalone],null,'fixture reviewer') loop
    n := n+1;
    if res.draft_id=standalone then assert res.error is null and res.status='approved';
    else assert res.error is not null; end if;
  end loop;
  assert n=2, 'one result per distinct draft, no synthetic extra error row';
  assert (select status from drafts where id=invalid_reply)='pending', 'failed item must roll back';
  assert (select count(*) from draft_revisions where draft_id=standalone and action='approve')=1;
  -- The same batch endpoint can review a segment without releasing its parent.
  select * into d from drafts where id=first_id;
  perform review_script_segment(first_id,'edit',d.body,null,'fixture reviewer');
  for res in select * from approve_draft_batch(array[first_id],null,'fixture reviewer') loop
    assert res.error is null and res.status='approved';
  end loop;
  assert not scenario_approved((select run_id from scenario_acts where draft_id=first_id));
  failed := false;
  begin perform approve_draft_batch('{}'::uuid[],null,'fixture reviewer');
  exception when others then failed := true; end;
  assert failed, 'empty batch rejected';
  -- Reject an incomplete parent even when its template has just one act.
  insert into scenarios(slug,name,hypothesis,spec) values
    ('review-fixture-single','Invalid single','TEST ONLY','{"acts":[{"seq":1,"kind":"comment"}]}');
  insert into scenario_runs(scenario_slug,subreddit) values ('review-fixture-single','testing') returning * into r;
  failed := false;
  begin perform review_scenario_run(r.id,'approve',null,'fixture reviewer');
  exception when others then failed := true; end;
  assert failed, 'script needs multiple segments';
end $$;
rollback;
