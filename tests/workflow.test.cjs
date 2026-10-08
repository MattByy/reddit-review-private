const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Harness,COPY}=require('./workflow-harness.cjs');
async function setup(t){const h=await new Harness().init();t.after(()=>h.close());return h;}

test('migration keeps public reads but fences claims, completions and publication RPCs',async t=>{
  const h=await setup(t);
  assert.equal((await h.sql("select has_function_privilege('anon','file_agent_draft(jsonb,text,uuid,text,uuid)','execute') allowed"))[0].allowed,false);
  assert.equal((await h.sql("select has_function_privilege('anon','review_scenario_run(uuid,text,text,text)','execute') allowed"))[0].allowed,false);
  assert.equal((await h.sql("select has_column_privilege('anon','jobs','claim_token','select') allowed"))[0].allowed,false);
  assert.equal((await h.sql("select has_column_privilege('anon','jobs','status','select') allowed"))[0].allowed,true);
  assert.equal((await h.call(h.dispatch,'/api/dispatch',{},'POST','')).status,401);
  assert.equal((await h.call(h.operator,'/api/operator',{rpc:'review_scenario_run'},'POST','test-agent')).status,401);
});

test('expired claim carries saved progress to a fresh worker and rejects the old token',async t=>{
  const h=await setup(t);
  await h.api('/jobs',{request_id:'research-1',title:'Find a useful thread',payload:{task:'find_threads'}});
  const one=(await h.api('/jobs/claim',{agent:'session-one'})).body.jobs[0];
  assert.ok(one.claim_token);
  await h.api(`/jobs/${one.id}/checkpoint`,{agent:'session-one',claim_token:one.claim_token,checkpoint:{queries_done:['query-one']}});
  await h.sql("update jobs set lease_until=now()-interval '1 second' where id=$1",[one.id]);
  const two=(await h.api('/jobs/claim',{agent:'fresh-session'})).body.jobs[0];
  assert.deepEqual(two.checkpoint,{queries_done:['query-one']});assert.notEqual(one.claim_token,two.claim_token);
  const stale=await h.api(`/jobs/${one.id}/complete`,{agent:'session-one',claim_token:one.claim_token,status:'done'});
  assert.equal(stale.status,409);
  const done=await h.api(`/jobs/${two.id}/complete`,{agent:'fresh-session',claim_token:two.claim_token,status:'done',result:{reason:'finished'}});
  assert.equal(done.body.job.status,'done');
});

test('thread finder registers, queues once, and filing a claimed draft completes the job atomically',async t=>{
  const h=await setup(t),thread=await h.thread();
  const register=await h.api('/threads',{id:thread.id,url:thread.url,title:'Test need',subreddit:'test',discovery:{source:'test source',query:'proxy debugging'}});
  assert.equal(register.status,200,JSON.stringify(register));
  const payload={account_id:'test-account',intent_evidence:'Reader needs output diagnostics',experiment:{id:'test',topic:'debugging',variant:'checklist'}};
  const [first,repeat]=await Promise.all([h.api('/threads/abc123/queue',payload),h.api('/threads/abc123/queue',payload)]);
  assert.equal(first.body.job.id,repeat.body.job.id);
  const j=(await h.api('/jobs/claim',{agent:'writer'})).body.jobs[0];
  assert.ok(j.context.observation.thread);assert.equal(j.actionable,true);
  const req={job_id:j.id,agent:'writer',claim_token:j.claim_token,kind:'comment',body:COPY};
  const filed=await h.api('/drafts',req);assert.equal(filed.status,200,JSON.stringify(filed));
  const again=await h.api('/drafts',req);assert.equal(again.body.draft.id,filed.body.draft.id);
  assert.equal((await h.sql('select status,draft_id from jobs where id=$1',[j.id]))[0].status,'done');
  assert.equal((await h.sql('select count(*)::int n from drafts'))[0].n,1);
  const different=await h.api('/drafts',{...req,body:COPY+' Changed'});assert.equal(different.status,409);
  assert.equal((await h.sql('select verdict from rule_checks'))[0].verdict,'skipped');
});

test('concurrent dispatch calls create one vendor task and one durable attempt',async t=>{
  const h=await setup(t);await h.thread();const d=await h.file();await h.approve(d.id);
  await Promise.all([h.sender.runQueue('test-one'),h.sender.runQueue('test-two')]);
  assert.equal(h.vendor.length,1);
  assert.equal((await h.sql('select count(*)::int n from publication_attempts'))[0].n,1);
  assert.equal((await h.sql('select status from drafts'))[0].status,'dispatched');
  assert.equal((await h.sql('select count(*)::int n from eval_log'))[0].n,1);
});

test('response lost after vendor acceptance is held unknown and never blindly resubmitted',async t=>{
  const h=await setup(t);await h.thread();const d=await h.file();await h.approve(d.id);h.vendorMode='lost-response';
  const first=await h.sender.runQueue('first');assert.equal(first.body.results[0].outcome,'submission_unknown');
  assert.equal(h.vendor.length,1);assert.equal((await h.sql('select state from publication_attempts'))[0].state,'unknown');
  await h.sender.runQueue('fresh-process');assert.equal(h.vendor.length,1);
  const boot=await h.api('/bootstrap');assert.equal(boot.body.uncertain_submissions.length,1);
  const status=await h.api('/status');assert.equal(status.status,200,JSON.stringify(status));assert.match(status.body.items[0].stage,/submission unknown/);
  await h.db.exec('set role anon');
  assert.match((await h.sql('select stage from status_items'))[0].stage,/submission unknown/);
  await assert.rejects(h.sql('select vendor_response from publication_attempts'),/permission denied/);
  await h.db.exec('reset role');
  const attempt=(await h.sql('select id from publication_attempts'))[0];
  const result=await h.call(h.operator,'/api/operator',{reconcile_attempt:attempt.id,task_id:'vendor-1'},'POST','test-operator');
  assert.equal(result.status,200,JSON.stringify(result));assert.equal((await h.sql('select state from publication_attempts'))[0].state,'accepted');
});

test('publication reservations enforce pacing across unrelated drafts',async t=>{
  const h=await setup(t);await h.thread();const a=await h.file(),b=await h.file({request_id:'file-2',body:COPY.replace('Keep the test small','Start with one example')});
  await h.approve(a.id);await h.approve(b.id);await h.sender.runQueue('test');
  assert.equal(h.vendor.length,1);assert.equal((await h.sql('select count(*)::int n from publication_attempts'))[0].n,1);
});

test('nested reply reader locates the requested parent and only its direct external children',async t=>{
  const h=await setup(t);
  const child=h.comment('child','Actual question','t1_target');
  const own=h.comment('own','Our reply','t1_target',[],'geonode_test');
  const target=h.comment('target','Target body','t1_outer',[child,own]);
  await h.thread('abc123',[h.comment('outer','Outer body','t3_abc123',[target])]);
  const result=await h.reader.repliesTo('https://www.reddit.com/r/test/comments/abc123/example/target/',new Set(['geonode_test']));
  assert.equal(result.comment.id,'target');assert.equal(result.comment.depth,1);
  assert.deepEqual(result.replies.map(r=>r.id),['child']);assert.equal(result.replies[0].depth,2);
  const args={replies:result.replies,url:result.url,thread_id:'abc123',account_id:'test-account'};
  await Promise.all([h.monitor.planReplies(args),h.monitor.planReplies({...args,sequence_run_id:null,step:6})]);
  assert.equal((await h.sql("select count(*)::int n from jobs where kind='draft_followup'"))[0].n,1);
});

test('publication verification rejects wrong URLs and tracks later cancellation even after a URL appeared',async t=>{
  const h=await setup(t);await h.thread();const d=await h.file();await h.approve(d.id);await h.sender.runQueue('test');
  h.vendor[0].status='completed';h.vendor[0].resultUrl='https://www.reddit.com/r/test/comments/abc123/example/ours/';
  await h.thread('abc123',[h.comment('ours','A different comment','t3_abc123',[],'stranger')]);
  await h.monitor.poll();await h.monitor.verifyRecent();
  assert.equal((await h.sql('select visibility from engain_tasks'))[0].visibility,'unknown');
  assert.notEqual((await h.sql('select bucket from status_items'))[0].bucket,'posted');
  h.vendor[0].status='cancelled';h.vendor[0].failureReason='Community does not accept this submission';
  await h.monitor.poll();
  assert.equal((await h.sql('select status from drafts'))[0].status,'cancelled');
  assert.match((await h.sql('select error from engain_tasks'))[0].error,/Community/);
  const outcome=await h.api('/outcomes');assert.ok(outcome.body.events.some(e=>e.event==='vendor_cancelled'));
});

test('verified comment, reader reply, and nested answer complete the publication loop',async t=>{
  const h=await setup(t);await h.thread();const d=await h.file({thread_context:{experiment:{id:'debug-1',topic:'debugging',variant:'checklist'}}});await h.approve(d.id);await h.sender.runQueue('test');
  const reader=h.comment('reader1','Which output fields should I check?','t1_ours');
  await h.thread('abc123',[h.comment('ours',COPY,'t3_abc123',[reader],'geonode_test')]);
  Object.assign(h.vendor[0],{status:'completed',resultUrl:'https://www.reddit.com/r/test/comments/abc123/example/ours/'});
  await h.monitor.poll();await h.monitor.verifyRecent();
  assert.equal((await h.sql('select status from drafts where id=$1',[d.id]))[0].status,'posted');
  const job=(await h.api('/jobs/claim',{agent:'new-session'})).body.jobs[0];assert.equal(job.kind,'draft_followup');assert.equal(job.context.observation.target.id,'reader1');
  const response=await h.api('/drafts',{job_id:job.id,agent:'new-session',claim_token:job.claim_token,kind:'reply',body:COPY.replace('Keep the test small','Compare the expected fields'),thread_context:{parent:job.context.observation.target}});
  assert.equal(response.status,200,JSON.stringify(response));
  assert.equal(response.body.draft.thread_context.experiment.id,'debug-1');
  await h.approve(response.body.draft.id);
  await h.db.exec("update publication_attempts set created_at=now()-interval '2 days'; update engain_tasks set submitted_at=now()-interval '2 days'");
  await h.sender.runQueue('answer');assert.equal(h.vendor.length,2);assert.match(h.vendor[1].targetUrl,/reader1/);
  reader.data.replies.data.children=[h.comment('answer',response.body.draft.body,'t1_reader1',[],'geonode_test')];
  Object.assign(h.vendor[1],{status:'completed',resultUrl:'https://www.reddit.com/r/test/comments/abc123/example/answer/'});
  await h.monitor.poll();await h.monitor.verifyRecent();
  const task=(await h.sql("select visibility,parent_fullname,reply_depth from engain_tasks where id='vendor-2'"))[0];
  assert.equal(task.visibility,'visible');assert.equal(task.parent_fullname,'t1_reader1');assert.equal(task.reply_depth,2);
});

test('edited parent invalidates approval; deleted parent blocks dependent work',async t=>{
  const h=await setup(t);const p=h.comment('reader1','Initial question');await h.thread('abc123',[p]);
  const d=await h.file({kind:'reply',parent_url:'https://www.reddit.com/r/test/comments/abc123/example/reader1/',thread_context:{parent:{body:'Initial question'}}});
  await h.approve(d.id);p.data.body='Changed question';await h.sender.runQueue('test');
  assert.equal(h.vendor.length,0);assert.equal((await h.sql('select status from drafts'))[0].status,'pending');
  const context=await h.reader.conversation(d.parent_url);
  const revise=await h.api('/drafts/'+d.id,{body:COPY,thread_context:{parent:context.target}},'PATCH');assert.equal(revise.status,200,JSON.stringify(revise));
  await h.approve(d.id);p.data.body='[deleted]';await h.sender.runQueue('test');assert.equal(h.vendor.length,0);
  assert.match((await h.sql('select gate_failure from drafts'))[0].gate_failure,/removed, deleted/);
});

test('posts are polled and verified without assuming that the first comment is the post',async t=>{
  const h=await setup(t);
  const d=await h.file({kind:'post',subreddit:'test',title:'A public troubleshooting question'});await h.approve(d.id);await h.sender.runQueue('test');
  await h.thread('post123');const listing=h.reddit.get('post123');Object.assign(listing[0].data.children[0].data,{selftext:COPY,author:'geonode_test'});
  Object.assign(h.vendor[0],{status:'completed',resultUrl:'https://www.reddit.com/r/test/comments/post123/example/'});
  await h.monitor.poll();await h.monitor.verifyRecent();assert.equal((await h.sql('select status from drafts'))[0].status,'posted');
  assert.equal((await h.sql('select thread_id from engain_tasks'))[0].thread_id,'post123');
});

test('unknown Reddit responses and rate limits defer without filing or publishing',async t=>{
  const h=await setup(t);await h.thread();h.reddit.set('abc123',new Response('{}',{status:403}));
  const unavailable=await h.api('/drafts',{request_id:'blocked',thread_id:'abc123',account_id:'test-account',body:COPY});assert.equal(unavailable.status,409);
  await h.thread();h.project=true;h.ruleStatus=429;
  const limited=await h.api('/drafts',{request_id:'limited',thread_id:'abc123',account_id:'test-account',body:COPY});assert.equal(limited.status,503);
  assert.equal((await h.sql('select count(*)::int n from drafts'))[0].n,0);assert.equal(h.vendor.length,0);
  assert.equal((await h.sql('select count(*)::int n from workflow_events'))[0].n,2);
});

test('overlapping cron runs cannot both own the clock; a terminal lease exhaustion is visible',async t=>{
  const h=await setup(t);const one='11111111-1111-4111-8111-111111111111',two='22222222-2222-4222-8222-222222222222';
  assert.equal(await h.rpc('acquire_workflow_clock',{p_token:one}),true);assert.equal(await h.rpc('acquire_workflow_clock',{p_token:two}),false);
  await h.rpc('release_workflow_clock',{p_token:two});assert.equal(await h.rpc('acquire_workflow_clock',{p_token:two}),false);
  await h.rpc('release_workflow_clock',{p_token:one});assert.equal(await h.rpc('acquire_workflow_clock',{p_token:two}),true);
  await h.sql("insert into jobs(kind,status,attempts,lease_until) values('write','claimed',5,now()-interval '1 hour')");
  await h.api('/jobs/claim',{agent:'new'});
  assert.equal((await h.api('/bootstrap')).body.unfinished[0].status,'blocked');
});

test('a complete one-act playbook can be reviewed; an empty or incomplete one cannot',async t=>{
  const h=await setup(t);await h.thread();const d=await h.file();
  await h.sql("insert into scenarios(slug,name,hypothesis,spec) values('single','One answer','Test one useful answer',$1)",[JSON.stringify({acts:[{seq:1,kind:'comment'}]})]);
  const [run]=await h.sql("insert into scenario_runs(scenario_slug,subreddit,thread_id,account_id) values('single','test','abc123','test-account') returning id");
  const review=()=>h.call(h.operator,'/api/operator',{rpc:'review_scenario_run',args:{p_run_id:run.id,p_action:'approve',p_note:'Test approved'}},'POST','test-operator');
  assert.equal((await review()).status,400);
  await h.sql("update drafts set mode='scenario' where id=$1",[d.id]);
  await h.sql("insert into scenario_acts(run_id,seq,kind,draft_id,status) values($1,1,'comment',$2,'due')",[run.id,d.id]);
  const approved=await review();assert.equal(approved.status,200,JSON.stringify(approved));assert.equal(approved.body.review_status,'approved');
});

test('parent cancellation blocks queued descendants and cancels an already submitted descendant',async t=>{
  const h=await setup(t);await h.thread();const d=await h.file();await h.approve(d.id);await h.sender.runQueue('test');
  const parent='https://www.reddit.com/r/test/comments/abc123/example/ours/';
  const child=await h.file({request_id:'child',body:COPY.replace('Keep the test small','Start from the reader question')});
  await h.sql("insert into engain_tasks(id,draft_id,thread_id,content,status,project_id) values('child-task',$1,'abc123',$2,'pending','accounts-beta')",[child.id,child.body]);
  const [j]=await h.sql("insert into jobs(kind,thread_id,payload,draft_id) values('draft_followup','abc123',$1,$2) returning id",[JSON.stringify({our_comment_url:parent}),child.id]);
  Object.assign(h.vendor[0],{status:'cancelled',resultUrl:parent});await h.monitor.poll();
  assert.equal((await h.sql('select status from jobs where id=$1',[j.id]))[0].status,'blocked');
  assert.ok((await h.sql("select cancel_requested_at from engain_tasks where id='child-task'"))[0].cancel_requested_at);
});

test('sequence cannot advance past a cancelled parent even when the vendor supplied a URL',async t=>{
  const h=await setup(t);await h.thread();const d=await h.file();await h.approve(d.id);await h.sender.runQueue('test');
  await h.sql("update engain_tasks set status='cancelled',reddit_url='https://www.reddit.com/r/test/comments/abc123/example/ours/'");
  await h.sql("insert into sequence_runs(sequence_id,account_id,steps,state,current) values(gen_random_uuid(),'test-account',$1,$2,1)",[
    JSON.stringify([{type:'send'},{type:'wait_live'},{type:'answer_replies'}]),JSON.stringify([{status:'done',out:{task_id:'vendor-1'}},{status:'waiting'},{status:'waiting'}])]);
  const result=await h.engine.runEngine();assert.equal(result.results[0].status,'failed');assert.equal((await h.sql('select current from sequence_runs'))[0].current,1);
});

test('pullback uses the posts endpoint and waits for explicit cancellation confirmation',async t=>{
  const h=await setup(t);const d=await h.file({kind:'post',subreddit:'test',title:'Controlled test post'});await h.approve(d.id);await h.sender.runQueue('test');
  await h.sql('update engain_tasks set cancel_requested_at=now()');
  const pullback=require('../api/cron/pullback.js');
  const result=await h.call(pullback,'/api/cron/pullback',{},'GET','test-cron');
  assert.equal(result.body.results[0].outcome,'cancelled',JSON.stringify(result));
  assert.ok(h.calls.some(c=>c.method==='POST'&&c.url.endsWith('/accounts-beta/posts/vendor-1/cancel')));
  assert.ok((await h.sql('select cancelled_at from engain_tasks'))[0].cancelled_at);
});

test('the actual tick handler sends, verifies, and gives a fresh worker durable follow-up work',async t=>{
  const h=await setup(t);await h.thread();const d=await h.file();await h.approve(d.id);
  const tick=require('../api/cron/tick.js');
  const first=await h.call(tick,'/api/cron/tick',{},'GET','test-cron');assert.equal(first.body.ok,true,JSON.stringify(first));assert.equal(h.vendor.length,1);
  assert.equal((await h.sql("select count(*)::int n from jobs where payload->>'task'='find_threads'"))[0].n,1);
  const reply=h.comment('reader1','A follow-up question','t1_ours');
  await h.thread('abc123',[h.comment('ours',COPY,'t3_abc123',[reply],'geonode_test')]);
  Object.assign(h.vendor[0],{status:'completed',resultUrl:'https://www.reddit.com/r/test/comments/abc123/example/ours/'});
  const second=await h.call(tick,'/api/cron/tick',{},'GET','test-cron');assert.equal(second.body.ok,true,JSON.stringify(second));assert.equal(h.vendor.length,1);
  const jobs=(await h.api('/jobs/claim',{agent:'fresh-next-hour',kinds:['draft_followup']})).body.jobs;
  assert.equal(jobs.length,1);assert.equal(jobs[0].context.observation.target.body,'A follow-up question');assert.ok(jobs[0].claim_token);
  assert.equal((await h.sql("select count(*)::int n from workflow_state where key='tick-lease'"))[0].n,0);
});
