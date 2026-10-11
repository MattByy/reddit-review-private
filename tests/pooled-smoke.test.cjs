// Isolated one-message contract test: real handlers/SQL, simulated provider and Reddit.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {Harness}=require('./workflow-harness.cjs');

test('pooled first-message test persists one task and verified URL without private account selection or submission',async t=>{
  const saved={ENGAIN_DELIVERY:process.env.ENGAIN_DELIVERY,ENGAIN_PROJECT_ID:process.env.ENGAIN_PROJECT_ID};
  process.env.ENGAIN_DELIVERY='pool';delete process.env.ENGAIN_PROJECT_ID;
  const h=await new Harness().init();
  t.after(async()=>{await h.close();for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  h.project=true;await h.sql("update workflow_state set value='{\"enabled\":true}' where key='message_workflow'");await h.thread();
  const caps=await h.api('/delivery');assert.equal(caps.status,200);assert.equal(caps.body.mode,'pool');assert.equal(caps.body.available,true);
  const request={request_id:randomUUID(),strategy:'direct',max_messages:1,max_depth:1};
  const queued=await h.api('/threads/abc123/queue',request);assert.equal(queued.status,200);
  const again=await h.api('/threads/abc123/queue',request);assert.equal(again.body.experiment.id,queued.body.experiment.id);
  const claimed=await h.api('/jobs/claim',{agent:'pooled-smoke',kinds:['write'],limit:1});
  const [job]=claimed.body.jobs;assert.equal(job.actionable,true);
  const body='Posting on behalf of Geonode: compare the response status and body before changing another setting.';
  const filed=await h.api('/messages/'+job.message.id,{agent:'pooled-smoke',claim_token:job.claim_token,reply_mode:'opening',content_action:'direct',body,rationale:'One attributed contribution for an isolated delivery test.'});
  assert.equal(filed.status,200);assert.equal(filed.body.message.contains_brand,true);
  const tick=require('../api/cron/tick.js');
  const sent=await h.call(tick,'/api/cron/tick',undefined,'GET','test-cron');assert.equal(sent.status,200);
  assert.equal(h.vendor.length,1);const task=h.vendor[0];
  assert.equal(task.projectId,'project-test');assert.equal(task.content,body);assert.equal(task.userAccountId,undefined);assert.equal(task.posterAccount,undefined);assert.equal(task.rank,undefined);
  let [message]=await h.sql('select * from experiment_messages where id=$1',[job.message.id]);
  assert.equal(message.task_id,task._id);assert.equal(message.status,'submitted');assert.equal(message.reddit_url,null);
  const url='https://www.reddit.com/r/test/comments/abc123/example/poolone/';task.status='published';task.redditUrl=url;
  h.reddit.get('abc123')[1].data.children.push(h.comment('poolone',body,'t3_abc123',[],'pooled_provider_writer'));
  await h.sql('update experiment_messages set next_check_at=null where id=$1',[message.id]);
  const observed=await h.call(tick,'/api/cron/tick',undefined,'GET','test-cron');assert.equal(observed.status,200);
  [message]=await h.sql('select * from experiment_messages where id=$1',[message.id]);
  assert.equal(message.reddit_url,url);assert.equal(message.status,'visible');assert.ok(message.verified_at);
  const [flow]=await h.sql('select * from message_experiments where id=$1',[queued.body.experiment.id]);
  assert.equal(flow.status,'monitoring');assert.ok(flow.brand_visible_at);assert.equal(flow.success_at,null);
  assert.equal((await h.sql('select count(*)::int n from experiment_messages'))[0].n,1);
  // The top-level tick also observes archived private tasks with read-only GETs.
  // The new pooled message must never select a private account or submit through Beta.
  assert.equal(h.calls.filter(c=>c.url.endsWith('/accounts-beta/accounts')).length,0);
  assert.equal(h.calls.filter(c=>c.url.includes('/accounts-beta/')&&c.method!=='GET').length,0);
  assert.equal(h.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/api/v1/tasks/comment')).length,1);
});
