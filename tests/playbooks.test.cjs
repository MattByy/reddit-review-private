const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Harness,COPY}=require('./workflow-harness.cjs');
const BOOK='bdb2d105-817b-4e40-8849-9f93a7d00001';
const PARENT='https://www.reddit.com/r/test/comments/abc123/example/opening/';
const REPLY=COPY.replace('Keep the test small','Start with one saved response');
async function setup(t){
  const h=await new Harness().init();t.after(()=>h.close());await h.thread();
  await h.sql("insert into accounts(id,label,reddit_username,active,usable,disclosed) values('account-b','Account B','geonode_b',true,true,true)");
  return h;
}
function operator(h,body){return h.call(h.operator,'/api/operator',body,'POST','test-operator');}
function start(h,extra={}){return operator(h,{rpc:'start_playbook_run',args:{p_sequence_id:BOOK,p_thread_id:'abc123',p_account_a:'test-account',p_account_b:'account-b',p_request_id:randomUUID(),...extra}});}
async function fileJob(h,kind,body=COPY){
  const j=(await h.api('/jobs/claim',{agent:'writer',kinds:['write']})).body.jobs[0];
  assert.ok(j,'The expected write job exists');
  const request={job_id:j.id,agent:'writer',claim_token:j.claim_token,kind,body,thread_context:{parent:j.context.observation.target}};
  const filed=await h.api('/drafts',request);assert.equal(filed.status,200,JSON.stringify(filed));
  return {job:j,draft:filed.body.draft,request};
}
async function approve(h,id){
  const result=await operator(h,{rpc:'review_draft',args:{p_draft_id:id,p_action:'approve',p_body:null,p_note:'Test approval'}});
  assert.equal(result.status,200,JSON.stringify(result));
}
async function opening(h){
  const run=await start(h);assert.equal(run.status,200,JSON.stringify(run));
  await h.engine.runEngine();const first=await fileJob(h,'comment');
  await h.engine.runEngine();await approve(h,first.draft.id);
  await h.sender.runQueue('held');assert.equal(h.vendor.length,0,'Approval alone does not skip Send');
  await h.engine.runEngine();await h.sender.runQueue('opening');assert.equal(h.vendor.length,1);
  await h.engine.runEngine();
  await h.thread('abc123',[h.comment('opening',COPY,'t3_abc123',[],'geonode_test')]);
  Object.assign(h.vendor[0],{status:'completed',resultUrl:PARENT});
  await h.monitor.poll();await h.engine.runEngine();
  assert.equal((await h.sql('select current from sequence_runs where id=$1',[run.body.id]))[0].current,3,'A vendor URL alone does not release the reply');
  await h.monitor.verifyRecent();await h.engine.runEngine();
  return {run:run.body,first};
}
async function finishDelay(h,id){
  await h.sql("update sequence_runs set state=jsonb_set(state,'{4,until}',to_jsonb((now()-interval '1 second')::text)),next_at=now() where id=$1",[id]);
  await h.engine.runEngine();
}

test('playbook start assigns two accounts, snapshots steps, and retries without another run',async t=>{
  const h=await setup(t),id=randomUUID();
  assert.equal((await start(h,{p_account_b:'test-account'})).status,400);
  const [one,two]=await Promise.all([start(h,{p_request_id:id}),start(h,{p_request_id:id})]);
  assert.equal(one.status,200,JSON.stringify(one));assert.equal(two.status,200,JSON.stringify(two));
  assert.equal(one.body.id,two.body.id);assert.equal(one.body.steps[0].account_id,'test-account');assert.equal(one.body.steps[5].account_id,'account-b');
  assert.equal((await start(h,{p_request_id:id,p_account_b:'test-account'})).status,400);
  assert.equal((await start(h)).status,400,'Only one open playbook per thread');
  assert.equal((await h.sql('select count(*)::int n from sequence_runs'))[0].n,1);
  assert.equal((await h.sql("select has_function_privilege('anon','start_playbook_run(uuid,text,text,text,uuid,text)','execute') allowed"))[0].allowed,false);
  const books=await h.api('/playbooks');assert.equal(books.body.playbooks[0].id,BOOK);
  assert.equal(books.body.playbooks[0].steps.some(s=>s.type==='check_replies'),false);
});

test('account A comments then account B replies to that exact comment without any reader reply',async t=>{
  const h=await setup(t),{run,first}=await opening(h);
  assert.equal(h.vendor[0].userAccountId,'test-account');
  assert.equal((await h.sql('select count(*)::int n from jobs'))[0].n,1,'No reader is needed and the reply still waits for its delay');
  await finishDelay(h,run.id);await h.engine.runEngine();
  const reply=await fileJob(h,'reply',REPLY);
  assert.equal(reply.job.account_id,'account-b');assert.equal(reply.job.target_url,PARENT);
  assert.equal(reply.draft.parent_url,PARENT);assert.equal(reply.draft.account_id,'account-b');
  assert.equal(reply.job.context.observation.target.author,'geonode_test');
  assert.equal((await h.api('/drafts',reply.request)).body.draft.id,reply.draft.id);
  const revise=await h.api('/drafts/'+reply.draft.id,{body:REPLY,thread_context:{parent:reply.job.context.observation.target}},'PATCH');
  assert.equal(revise.status,200,JSON.stringify(revise));
  const wrongAccount=await operator(h,{draft_id:reply.draft.id,patch:{account_id:'test-account'}});assert.equal(wrongAccount.status,409);
  const unconfirmed=await operator(h,{rpc:'review_draft',args:{p_draft_id:reply.draft.id,p_action:'approve',p_body:null,p_note:null}});
  assert.equal(unconfirmed.status,400,'A reviewer must confirm the planned parent');
  await operator(h,{draft_id:reply.draft.id,patch:{parent_confirmed_by:'reviewer'}});await approve(h,reply.draft.id);
  await h.engine.runEngine();await h.sender.runQueue('paced');assert.equal(h.vendor.length,1,'Existing pacing still applies');
  await h.db.exec("update publication_attempts set created_at=now()-interval '2 days'; update engain_tasks set submitted_at=now()-interval '2 days'");
  const send=await h.sender.runQueue('reply');assert.equal(h.vendor.length,2,JSON.stringify(send));
  assert.equal(h.vendor[1].userAccountId,'account-b');assert.equal(h.vendor[1].targetUrl,PARENT);
  await h.thread('abc123',[h.comment('opening',COPY,'t3_abc123',[h.comment('second',REPLY,'t1_opening',[],'geonode_b')],'geonode_test')]);
  Object.assign(h.vendor[1],{status:'completed',resultUrl:PARENT.replace('opening/','second/')});
  await h.monitor.poll();await h.monitor.verifyRecent();await h.engine.runEngine();
  assert.equal((await h.sql('select status from sequence_runs where id=$1',[run.id]))[0].status,'done');
  assert.equal((await h.sql("select count(*)::int n from jobs where kind='write'"))[0].n,2);
  assert.equal((await h.sql("select count(*)::int n from jobs where kind='draft_followup'"))[0].n,0);
  assert.equal((await h.sql('select status from drafts where id=$1',[first.draft.id]))[0].status,'posted');
});

test('playbook proof rejects arbitrary parents and removed parents at filing and reservation',async t=>{
  const h=await setup(t),{run}=await opening(h);await finishDelay(h,run.id);
  const reply=await fileJob(h,'reply',REPLY);
  const proof=await h.rpc('playbook_job_context',{p_job_id:reply.job.id,p_account_id:'account-b',p_parent_url:PARENT.replace('opening/','elsewhere/')});
  assert.equal(proof.ready,false);
  const standalone=await h.api('/drafts',{request_id:'unlinked',kind:'reply',thread_id:'abc123',account_id:'account-b',parent_url:PARENT,body:REPLY,thread_context:{parent:{body:COPY}}});
  assert.equal(standalone.status,422,'An arbitrary standalone reply cannot borrow another run’s parent');
  await operator(h,{draft_id:reply.draft.id,patch:{parent_confirmed_by:'reviewer'}});await approve(h,reply.draft.id);await h.engine.runEngine();
  await h.sql("update engain_tasks set visibility='removed' where id='vendor-1'");
  const reserve=await h.rpc('reserve_publication',{p_draft_id:reply.draft.id,p_body:REPLY,p_parent_url:PARENT,p_account_id:'account-b'});
  assert.equal(reserve.ok,false);assert.match(reserve.reason,/parent/);
  await h.sender.runQueue('removed');assert.equal(h.vendor.length,1);
});

test('cancelled opening stops the dependent writing job and a changed parent invalidates approval',async t=>{
  const h=await setup(t),{run}=await opening(h);await finishDelay(h,run.id);
  const reply=await fileJob(h,'reply',REPLY);
  await operator(h,{draft_id:reply.draft.id,patch:{parent_confirmed_by:'reviewer'}});await approve(h,reply.draft.id);await h.engine.runEngine();
  h.reddit.get('abc123')[1].data.children[0].data.body=COPY+' Edited';
  await h.sender.runQueue('changed');
  assert.equal((await h.sql('select status from drafts where id=$1',[reply.draft.id]))[0].status,'pending');
  h.vendor[0].status='cancelled';await h.monitor.poll();
  const draft=(await h.sql('select send_cleared_at,gate_failure from drafts where id=$1',[reply.draft.id]))[0];
  assert.equal(draft.send_cleared_at,null);assert.match(draft.gate_failure,/Parent cancelled/);assert.equal(h.vendor.length,1);
});
