const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Harness,COPY}=require('./workflow-harness.cjs');
async function setup(t){
  const h=await new Harness().init();t.after(()=>h.close());await h.thread();
  await h.sql("update workflow_state set value='{\"automatic\":true}' where key='publishing'");
  await h.sql('update accounts set disclosed=false');return h;
}
function operator(h,body){return h.call(h.operator,'/api/operator',body,'POST','test-operator');}
test('all accounts are enabled separately from profile disclosure, while provider availability is preserved',async t=>{
  const h=await setup(t);
  await h.sql("insert into accounts(id,label,usable) values('waiting','Waiting',false)");
  const accounts=(await h.api('/accounts')).body.accounts;
  assert.equal(accounts.find(a=>a.id==='test-account').can_post,true);
  assert.equal(accounts.find(a=>a.id==='waiting').approved,true);
  assert.equal(accounts.find(a=>a.id==='waiting').can_post,false);
  assert.equal((await h.api('/bootstrap')).body.capabilities.can_draft_for_account,true);
});
test('legacy drafts get an account and attribution, then send without any review calls',async t=>{
  const h=await setup(t);
  const [d]=await h.sql("insert into drafts(thread_id,kind,mode,status,body,source) values('abc123','comment','comment','pending',$1,'agent_api') returning id",[COPY.replace(' (Geonode team here)','')]);
  const sent=await h.sender.runQueue('automatic');assert.equal(h.vendor.length,1,JSON.stringify(sent));
  const [saved]=await h.sql('select * from drafts where id=$1',[d.id]);
  assert.equal(saved.account_id,'test-account');assert.match(h.vendor[0].body,/Geonode team here/);
  assert.equal(saved.reviewed_at,null,'Automation does not pretend a human reviewed the text');
  assert.ok((await h.sql("select id from activity_log where action='draft_prepared'")).length);
});
test('previously cleared drafts with no account are assigned automatically',async t=>{
  const h=await setup(t);
  const [d]=await h.sql("insert into drafts(thread_id,kind,mode,status,body,source,send_cleared_at) values('abc123','comment','comment','approved',$1,'agent_api',now()) returning id",[COPY]);
  const sent=await h.sender.runQueue('legacy-cleared');assert.equal(h.vendor.length,1,JSON.stringify(sent));
  assert.equal((await h.sql('select account_id from drafts where id=$1',[d.id]))[0].account_id,'test-account');
});
test('a complete two-account playbook publishes without a single draft approval',async t=>{
  const h=await setup(t);await h.sql("insert into accounts(id,label,reddit_username,usable) values('account-b','B','u/Geonode_B',true)");
  const result=await operator(h,{rpc:'start_playbook_run',args:{p_sequence_id:'bdb2d105-817b-4e40-8849-9f93a7d00001',p_thread_id:'abc123',p_account_a:'test-account',p_account_b:'account-b',p_request_id:randomUUID()}});
  assert.equal(result.status,200,JSON.stringify(result));const run=result.body;
  async function file(kind,body){
    const j=(await h.api('/jobs/claim',{agent:'automatic-writer',kinds:['write']})).body.jobs[0];
    const filed=await h.api('/drafts',{job_id:j.id,agent:'automatic-writer',claim_token:j.claim_token,kind,body,thread_context:{parent:j.context.observation.target}});
    assert.equal(filed.status,200,JSON.stringify(filed));return filed.body.draft;
  }
  await h.engine.runEngine();await file('comment',COPY);await h.engine.runEngine();await h.sender.runQueue('first');
  assert.equal(h.vendor.length,1);assert.equal(h.vendor[0].userAccountId,'test-account');
  const parent='https://www.reddit.com/r/test/comments/abc123/example/first/';
  await h.thread('abc123',[h.comment('first',COPY,'t3_abc123',[],'geonode_test')]);
  Object.assign(h.vendor[0],{status:'completed',resultUrl:parent});await h.monitor.poll();await h.monitor.verifyRecent();await h.engine.runEngine();
  await h.sql("update sequence_runs set state=jsonb_set(state,'{4,until}',to_jsonb((now()-interval '1 second')::text)),next_at=now() where id=$1",[run.id]);
  await h.engine.runEngine();const replyBody=COPY.replace('Keep the test small','Compare the parser output');
  const second=await file('reply',replyBody);await h.engine.runEngine();
  assert.equal((await h.sql('select count(*)::int n from posting_queue where draft_id=$1',[second.id]))[0].n,1,'Production posting view includes an assigned reply to our own comment');
  await h.db.exec("update publication_attempts set created_at=now()-interval '2 days'; update engain_tasks set submitted_at=now()-interval '2 days'");
  const sent=await h.sender.runQueue('second');assert.equal(h.vendor.length,2,JSON.stringify(sent));
  assert.equal(h.vendor[1].userAccountId,'account-b');assert.equal(h.vendor[1].targetUrl,parent);
  await h.thread('abc123',[h.comment('first',COPY,'t3_abc123',[h.comment('second',replyBody,'t1_first',[],'geonode_b')],'geonode_test')]);
  Object.assign(h.vendor[1],{status:'completed',resultUrl:parent.replace('first/','second/')});
  await h.monitor.poll();await h.monitor.verifyRecent();await h.engine.runEngine();
  assert.equal((await h.sql('select status from sequence_runs where id=$1',[run.id]))[0].status,'done');
  assert.equal((await h.sql("select count(*)::int n from draft_revisions where action='approve'"))[0].n,0);
});
test('stopping a draft prevents automatic publication; saving and resuming need no approval',async t=>{
  const h=await setup(t),d=await h.file();
  const action=(p_action,extra={})=>operator(h,{rpc:'update_queued_draft',args:{p_draft_id:d.id,p_action,p_body:null,p_account_id:null,...extra}});
  assert.equal((await action('stop')).status,200);await h.sender.runQueue('stopped');assert.equal(h.vendor.length,0);
  const changed=COPY.replace('Keep the test small','Begin with a small test');
  assert.equal((await action('save',{p_body:changed,p_account_id:'test-account'})).status,200);
  await h.sender.runQueue('still-stopped');assert.equal(h.vendor.length,0);
  assert.equal((await action('resume')).status,200);await h.sender.runQueue('resumed');assert.equal(h.vendor.length,1);assert.equal(h.vendor[0].body,changed);
});
test('automatic preparation records unreadable targets, preserves stops, and fences its RPCs',async t=>{
  const h=await setup(t),d=await h.file();h.reddit.set('abc123',new Response('{}',{status:403}));
  await h.sender.runQueue('unknown');assert.equal(h.vendor.length,0);
  const [saved]=await h.sql('select automatic_note,automatic_checked_at,status from drafts where id=$1',[d.id]);
  assert.ok(saved.automatic_note);assert.ok(saved.automatic_checked_at);assert.equal(saved.status,'pending');
  assert.equal((await h.sql("select has_function_privilege('anon','prepare_automatic_draft(uuid,text,text,text,jsonb)','execute') allowed"))[0].allowed,false);
  assert.equal((await h.sql("select has_function_privilege('anon','update_queued_draft(uuid,text,text,text,text)','execute') allowed"))[0].allowed,false);
});
