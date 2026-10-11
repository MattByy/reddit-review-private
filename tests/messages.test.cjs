const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {Harness}=require('./workflow-harness.cjs');
async function setup(t){const h=await new Harness().init();t.after(()=>h.close());await h.sql("update workflow_state set value='{\"enabled\":true}' where key='message_workflow'");h.project=true;await h.thread();return h;}
async function start(h,strategy='question',max_messages=5,id='abc123',request_id=randomUUID()){
  const r=await h.api('/threads/'+id+'/queue',{request_id,strategy,max_messages});assert.equal(r.status,200,JSON.stringify(r));return r.body.experiment;
}
async function current(h,e){return (await h.sql('select * from experiment_messages where experiment_id=$1 order by step desc limit 1',[e.id]))[0];}
async function draft(h,e,body){
  await h.db.exec("update experiment_messages set decision_due_at=now(); update jobs set due_at=now() where kind='write';");
  const claim=await h.api('/jobs/claim',{agent:'writer',kinds:['write'],limit:5});assert.equal(claim.status,200,JSON.stringify(claim));
  const j=claim.body.jobs.find(j=>j.payload.experiment_id===e.id);assert.ok(j,JSON.stringify(claim));assert.equal(j.actionable,true,JSON.stringify(j));
  const r=await h.api('/messages/'+j.payload.message_id,{agent:'writer',claim_token:j.claim_token,body,rationale:'A useful response to the actual thread.'});assert.equal(r.status,200,JSON.stringify(r));return r.body.message;
}
async function send(h){const result=await h.messages.dispatch();assert.equal(result[0]?.state,'submitted',JSON.stringify(result));return h.vendor.at(-1);}
async function due(h){await h.sql('update experiment_messages set next_check_at=null');}
async function unpace(h){await h.db.exec("update message_publications set created_at=now()-interval '2 days'; update experiment_messages set next_check_at=null;");}
async function publish(h,m,comment='opening',parent='t3_abc123',author='provider_writer'){
  const task=h.vendor.find(t=>t._id===m.task_id)||(h.vendor.length===1?h.vendor[0]:null);assert.ok(task);
  task.status='published';task.redditUrl='https://www.reddit.com/r/test/comments/abc123/example/'+comment+'/';task.resultUrl=task.redditUrl;
  h.reddit.get('abc123')[1].data.children.push(h.comment(comment,m.body,parent,[],author));await due(h);await h.messages.tick();
}
test('one adaptive ladder, correct pool contracts, verified success, later removal and complete metrics',async t=>{
  const h=await setup(t),e=await start(h);const bootstrap=await h.api('/bootstrap');assert.equal(bootstrap.body.protocol_version,5);assert.equal(bootstrap.body.accounts,undefined);
  let m=await draft(h,e,'Which output fields do you need from the response?');assert.equal(m.contains_brand,false);assert.doesNotMatch(m.body,/Geonode/);
  const task=await send(h);assert.equal(task.content,m.body);assert.equal(task.projectId,'project-test');assert.equal(task.url,m.target_url);assert.equal(task.userAccountId,undefined);assert.equal(task.posterAccount,undefined);assert.equal(task.rank,undefined);
  await h.messages.tick();assert.equal((await current(h,e)).step,1,'Engain in_review is not publication');
  m=await current(h,e);await publish(h,m);m=await current(h,e);assert.equal(m.step,2);assert.equal(m.status,'awaiting_draft');assert.equal(m.target_url,task.redditUrl);assert.equal(m.kind,'reply');
  m=await draft(h,e,'Geonode team here: the relevant comparison is the fields your parser actually needs.');await unpace(h);await send(h);
  const check=h.calls.filter(c=>c.url.endsWith('/api/v1/rule-check')).at(-1).body;assert.equal(check.taskType,'reply');assert.equal(check.context.parentCommentUrl,task.redditUrl);assert.equal(check.context.parentComment,task.content);
  const call=h.calls.filter(c=>c.url.endsWith('/api/v1/tasks/reply')).at(-1);assert.equal(call.body.url,task.redditUrl);
  m=await current(h,e);await publish(h,m,'brandreply','t1_opening');
  const [finished]=await h.sql('select * from message_experiments where id=$1',[e.id]);assert.equal(finished.status,'monitoring');assert.equal(finished.success_at,null);
  await h.sql("update message_experiments set monitor_until=now()-interval '1 minute' where id=$1",[e.id]);
  await h.sql("update experiment_messages set monitor_until=now()-interval '1 minute' where experiment_id=$1",[e.id]);
  await h.messages.verify(await current(h,e),h.vendor[1].redditUrl);assert.equal(finished.success_step,2);assert.equal((await current(h,e)).step,2);
  let [stats]=await h.sql("select * from message_experiment_results where strategy_id='question'");assert.equal(stats.success_percent,'100.0');assert.equal(stats.average_replies,'1.00');
  await h.rpc('observe_experiment_message',{p_message_id:(await current(h,e)).id,p_visibility:'removed',p_url:h.vendor[1].redditUrl,p_evidence:{source:'engain'},p_reason:'Automoderator removed this comment',p_removal_class:'automod'});
  const [after]=await h.sql('select * from message_experiments where id=$1',[e.id]);assert.equal(after.status,'succeeded');assert.ok(after.removed_at);assert.equal(after.removal_class,'automod');
  [stats]=await h.sql("select * from message_experiment_results where strategy_id='question'");assert.equal(stats.successes,1);assert.equal(stats.later_removals,1);assert.equal(stats.successes_still_visible,0);
  assert.equal((await h.messages.rows()).depths.find(d=>d.step===2).successes,1);
});
test('start is idempotent, strategies balance, opening condition and leases are enforced',async t=>{
  const h=await setup(t),request=randomUUID(),e=await start(h,null,5,'abc123',request);assert.equal(e.strategy_id,'direct');assert.equal((await start(h,null,5,'abc123',request)).id,e.id);
  await h.thread('def456');assert.equal((await start(h,null,5,'def456')).strategy_id,'question');
  const c=await h.api('/jobs/claim',{agent:'writer',kinds:['write'],limit:5}),j=c.body.jobs.find(j=>j.payload.experiment_id===e.id),mid=j.payload.message_id;
  assert.equal((await h.api('/messages/'+mid,{agent:'writer',claim_token:j.claim_token,body:'No brand here.'})).status,400);
  assert.equal((await h.api('/messages/'+mid,{agent:'writer',claim_token:randomUUID(),body:'Geonode team here.'})).status,409);
  const good={agent:'writer',claim_token:j.claim_token,body:'Geonode team here: what response format do you need?'};
  assert.equal((await h.api('/messages/'+mid,good)).status,200);assert.equal((await h.api('/messages/'+mid,good)).status,200);
  assert.equal((await h.sql('select count(*)::int n from experiment_messages'))[0].n,2);
});
test('private fallback uses provider availability without account approvals or a project',async t=>{
  const h=await setup(t);h.project=false;await h.sql('update accounts set approved=false,active=false,disclosed=false');const e=await start(h);await draft(h,e,'Which output format is required?');
  const task=await send(h);assert.equal(task.userAccountId,'test-account');assert.equal(task.body,'Which output format is required?');assert.equal(task.content,undefined);
  let m=await current(h,e);assert.equal(m.rule_check.verdict,'skipped');await publish(h,m,'opening','t3_abc123','wrong_author');assert.equal((await current(h,e)).step,1);
  h.reddit.get('abc123')[1].data.children[0].data.author='geonode_test';await due(h);await h.messages.tick();assert.equal((await current(h,e)).step,2);
});
test('missing Reddit context and mismatched publication never advance',async t=>{
  const h=await setup(t),e=await start(h);await draft(h,e,'What data is missing?');const task=await send(h),m=await current(h,e);
  task.status='published';task.redditUrl='https://www.reddit.com/r/test/comments/abc123/example/one/';
  h.reddit.set('abc123',new Response('{}',{status:403}));await due(h);await h.messages.tick();assert.equal((await current(h,e)).status,'submitted');
  await h.thread();h.reddit.get('abc123')[1].data.children.push(h.comment('one','A different body'));await due(h);await h.messages.tick();assert.equal((await current(h,e)).step,1);
  h.reddit.get('abc123')[1].data.children[0].data.body=m.body;h.reddit.get('abc123')[1].data.children[0].data.parent_id='t1_wrong';await due(h);await h.messages.tick();assert.equal((await current(h,e)).step,1);
  task.redditUrl='https://www.reddit.com/r/test/comments/zzz999/example/one/';await due(h);await h.messages.tick();assert.equal((await current(h,e)).step,1);
});
test('removal stops the next draft and invalidates its claim',async t=>{
  const h=await setup(t),e=await start(h);await draft(h,e,'What data is missing?');await send(h);await publish(h,await current(h,e));
  await h.db.exec("update experiment_messages set decision_due_at=now(); update jobs set due_at=now() where kind='write';");
  const claimed=await h.api('/jobs/claim',{agent:'writer',kinds:['write']}),j=claimed.body.jobs[0];h.vendor[0].status='mod_removed';h.vendor[0].statusMessage='Moderator removed this comment';await due(h);await h.messages.tick();
  const [x]=await h.sql('select * from message_experiments where id=$1',[e.id]);assert.equal(x.status,'removed');assert.equal(x.removal_step,1);assert.equal((await current(h,e)).status,'stopped');
  assert.equal((await h.api('/messages/'+j.payload.message_id,{agent:'writer',claim_token:j.claim_token,body:'Geonode reply.'})).status,409);
});
test('uncertain provider response reconciles without duplicate sends, pool and private',async t=>{
  const h=await setup(t);for(const pool of [true,false]){
    h.project=pool;const id=pool?'abc123':'def456';await h.thread(id);const e=await start(h,'question',5,id);await draft(h,e,'Which fields are required for '+id+'?');await unpace(h);
    h.vendorMode='lost-response';assert.equal((await h.messages.dispatch())[0].state,'unknown');const n=h.vendor.length;h.vendorMode='normal';await unpace(h);
    // Keep the provider creation time inside the reservation matching window.
    h.vendor.at(-1).creationDate=new Date().toISOString();await h.sql("update message_publications set created_at=now()-interval '3 minutes' where message_id=$1",[(await current(h,e)).id]);
    await h.messages.tick();assert.equal((await current(h,e)).status,'submitted');assert.equal(h.vendor.length,n);await h.messages.dispatch();assert.equal(h.vendor.length,n);
  }
});
test('concurrent senders reserve one task and the send fence respects edits and stops',async t=>{
  const h=await setup(t),e=await start(h);await draft(h,e,'Which format do you need?');await Promise.all([h.messages.dispatch(),h.messages.dispatch()]);assert.equal(h.vendor.length,1);assert.equal((await h.sql('select count(*)::int n from message_publications'))[0].n,1);
  await h.thread('def456');const second=await start(h,'question',5,'def456');let m=await draft(h,second,'Which format is expected?');await unpace(h);
  const original=global.fetch;global.fetch=async(url,options)=>{if(String(url).endsWith('/api/v1/rule-check'))await h.messages.change({action:'stop',experiment_id:second.id});return original(url,options);};
  await h.messages.dispatch();global.fetch=original;assert.equal(h.vendor.length,1);assert.equal((await current(h,second)).status,'stopped');
});
test('Engain rule verdicts and HTTP 429 defer or hold automatically',async t=>{
  const h=await setup(t),e=await start(h);let m=await draft(h,e,'Which fields do you need?');h.ruleStatus=429;assert.equal((await h.messages.dispatch())[0].state,'waiting_check');assert.equal(h.vendor.length,0);
  h.ruleStatus=200;h.ruleVerdict={verdict:'fail',removalRisk:10,summary:'Community rule conflict'};await due(h);assert.equal((await h.messages.dispatch())[0].state,'held');
  await h.messages.change({action:'edit',message_id:m.id,expected_body:m.body,body:'Which response format is required?'});h.ruleVerdict={verdict:'warn',removalRisk:85,summary:'Advisory risk'};
  h.vendorMode='rate-limit';assert.equal((await h.messages.dispatch())[0].state,'waiting_rate_limit');assert.equal((await current(h,e)).status,'queued');assert.equal(h.vendor.length,0);
  h.vendorMode='normal';await due(h);await send(h);assert.equal(h.vendor.length,1);assert.equal((await h.sql('select count(*)::int n from message_publications'))[0].n,1);
});
test('maximum depth exhausts; stopped and blocked work is excluded from success rates',async t=>{
  const h=await setup(t),e=await start(h,'question',1);await draft(h,e,'Which fields are required?');await send(h);await publish(h,await current(h,e));
  assert.equal((await h.sql('select status from message_experiments where id=$1',[e.id]))[0].status,'exhausted');assert.equal((await current(h,e)).step,1);
  await h.thread('def456');const s=await start(h,'question',5,'def456');await h.messages.change({action:'stop',experiment_id:s.id});
  await h.thread('ghi789');const b=await start(h,'question',5,'ghi789');await draft(h,b,'Which output fields are required?');await unpace(h);h.vendorMode='reject';assert.equal((await h.messages.dispatch())[0].state,'failed');
  const [stats]=await h.sql("select * from message_experiment_results where strategy_id='question'");assert.equal(stats.finished,1);assert.equal(stats.excluded,2);assert.equal(stats.success_percent,'0.0');
});
test('dashboard requires authentication; anonymous roles cannot mutate or read message tables',async t=>{
  const h=await setup(t);assert.equal((await h.call(h.messagesHandler,'/api/messages',undefined,'GET',null)).status,401);
  const [priv]=await h.sql("select has_table_privilege('anon','experiment_messages','SELECT') readable,has_function_privilege('anon','start_message_experiment(text,text,uuid,integer,integer)','EXECUTE') callable");assert.equal(priv.readable,false);assert.equal(priv.callable,false);
  const response=await h.call(h.messagesHandler,'/api/messages',{action:'start',thread_url:'https://www.reddit.com/r/test/comments/new123/title/',request_id:randomUUID()},'POST','test-operator');assert.equal(response.status,200,JSON.stringify(response));assert.equal(response.body.thread_id,'new123');
  assert.equal((await h.call(h.messagesHandler,'/api/messages',{action:'start',thread_url:'https://example.com/evil',request_id:randomUUID()},'POST','test-operator')).status,422);
});
test('migration preserves existing text and holds, retires legacy work and excludes imports from trial statistics',async t=>{
  const h=await new Harness().init({beforeMessages:async db=>{
    await db.db.exec("insert into threads(id,url,title,subreddit) values('old111','https://www.reddit.com/r/test/comments/old111/title/','Old one','test'),('old222','https://www.reddit.com/r/test/comments/old222/title/','Old two','test'); insert into drafts(thread_id,kind,mode,status,body,gate_failed_at,gate_failure) values('old111','comment','comment','pending','An existing useful question?',null,null),('old222','comment','comment','pending','Geonode team here: existing text.',now(),'Old rule failure'); insert into jobs(kind,title,status,payload) values('write','Old upfront conversation','planned','{}');");
  }});t.after(()=>h.close());
  const imported=await h.sql('select body,status,contains_brand from experiment_messages order by body');assert.equal(imported.length,2);assert.deepEqual(imported,[{body:'An existing useful question?',status:'queued',contains_brand:false},{body:'Geonode team here: existing text.',status:'held',contains_brand:true}]);
  assert.equal((await h.sql("select status from jobs where title='Old upfront conversation'"))[0].status,'blocked');assert.equal((await h.sql('select count(*)::int n from drafts where sequence_hold=true'))[0].n,2);
  assert.equal((await h.sql('select sum(total)::int n from message_experiment_results'))[0].n,0);
});
test('a direct opening succeeds at zero replies; stopped in-flight work stays stopped after cancellation',async t=>{
  const h=await setup(t),e=await start(h,'direct');await draft(h,e,'Geonode team here: compare only the fields your parser needs.');await send(h);await publish(h,await current(h,e));
  await h.sql("update message_experiments set monitor_until=now()-interval '1 minute' where id=$1",[e.id]);
  await h.sql("update experiment_messages set monitor_until=now()-interval '1 minute' where experiment_id=$1",[e.id]);
  await h.messages.verify(await current(h,e),h.vendor[0].redditUrl);
  const [stats]=await h.sql("select * from message_experiment_results where strategy_id='direct'");assert.equal(stats.average_replies,'0.00');assert.equal((await current(h,e)).step,1);
  await h.thread('def456');const stopped=await start(h,'question',5,'def456');await draft(h,stopped,'What data is needed?');await unpace(h);await send(h);
  await h.messages.change({action:'stop',experiment_id:stopped.id});await due(h);await h.messages.tick();assert.ok((await current(h,stopped)).cancel_requested_at);assert.match((await current(h,stopped)).cancel_result,/Cancellation requested/);
  h.vendor.at(-1).status='cancelled';await due(h);await h.messages.tick();assert.equal((await h.sql('select status from message_experiments where id=$1',[stopped.id]))[0].status,'stopped');
});
test('cron selects the message engine and never submits archived drafts',async t=>{
  const h=await setup(t),e=await start(h);await draft(h,e,'Which fields are relevant?');
  await h.sql("insert into drafts(thread_id,kind,mode,status,body) values('abc123','comment','comment','pending','Legacy Geonode copy')");
  const tick=require('../api/cron/tick.js');const r=await h.call(tick,'/api/cron/tick',undefined,'GET','test-cron');assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.workflow,'message_experiments');assert.equal(h.vendor.length,1);assert.equal(h.vendor[0].content,'Which fields are relevant?');
  assert.equal((await h.api('/drafts',{request_id:randomUUID(),thread_id:'abc123',body:'Legacy new draft'})).status,410);
  assert.equal((await h.rpc('reserve_publication',{p_draft_id:randomUUID(),p_body:'Legacy',p_parent_url:null,p_account_id:'test-account'})).ok,false);
  assert.equal((await h.call(h.operator,'/api/operator',{rpc:'start_playbook_run',args:{}},'POST','test-operator')).status,410);
});
