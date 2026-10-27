const test=require('node:test'),assert=require('node:assert/strict');
const {Harness}=require('./workflow-harness.cjs');
const {randomUUID}=require('node:crypto');
async function setup(t){
  const previous=process.env.ENGAIN_DELIVERY;process.env.ENGAIN_DELIVERY='pool';
  const h=await new Harness().init({contextSource:'engain'});h.project=true;h.opportunities=[];
  await h.sql("update workflow_state set value='{\"enabled\":true}' where key='message_workflow'");
  t.after(async()=>{await h.close();if(previous===undefined)delete process.env.ENGAIN_DELIVERY;else process.env.ENGAIN_DELIVERY=previous;});
  h.candidate=async(id='abc123')=>{
    const thread=await h.thread(id);h.reddit.set(id,new Response('{}',{status:403}));
    h.opportunities.push({id:'opp-'+id,type:'new_opportunities',redditPostId:id,relevance:.9,reasons:['Relevant'],
      postContent:{url:thread.url,title:'Parsing a proxy response',content:'Which fields should I save before changing my parser?',createdUtc:Math.floor(Date.now()/1000)-86400*7,score:20,numComments:10}});
  };
  h.next=async(agent='writer')=>{const r=await h.api('/work/next',{agent});assert.equal(r.status,200,JSON.stringify(r));return r.body.task;};
  h.fileWork=async(task,extra={})=>{const body=(task.brand.opening_required?'Geonode team here: ':'')+'Save a raw response and compare the field types before changing the parser.';
    const input={agent:'writer',lease_token:task.lease_token,body,...extra};const r=await h.api('/work/'+task.id,input);assert.equal(r.status,200,JSON.stringify(r));return {input,item:r.body.item};};
  h.due=async()=>{await h.db.exec("update message_publications set created_at=now()-interval '2 days';update experiment_messages set next_check_at=null,decision_due_at=now();update jobs set due_at=now() where status='planned'");};
  h.published=async(id,cid='m1')=>{const m=await h.messages.getMessage(id),v=h.vendor.find(v=>v._id===m.task_id);v.status='published';v.redditUrl='https://www.reddit.com/r/test/comments/abc123/example/'+cid+'/';return v;};
  return h;
}
test('next discovers Engain threads, resumes the same lease, and minimal submission approves and delivers each saved mode',async t=>{
  const h=await setup(t),assigned=[];
  for(let i=0;i<5;i++)await h.candidate('post'+i);
  for(let i=0;i<5;i++){
    const task=await h.next();assert.ok(task);assert.equal(task.can_write,true);assigned.push(task.mode);
    assert.equal(task.context.observation.source,'engain');assert.equal(task.context.observation.thread.body,'Which fields should I save before changing my parser?');
    assert.equal(task.context.observation.partial,true);assert.deepEqual(task.context.observation.comments,[]);
    assert.match(task.prompt,/Engain/);assert.match(task.prompt,/Never invent/);
    const resumed=await h.next();assert.equal(resumed.id,task.id);assert.equal(resumed.lease_token,task.lease_token);assert.equal(resumed.mode,task.mode);
    const filed=await h.fileWork(task);assert.equal(filed.item.state,'queued');assert.ok(filed.item.approved_at);assert.equal(filed.item.approved_by,'writer');assert.equal(filed.item.mode,task.mode);
    assert.equal((await h.api('/work/'+task.id,filed.input)).status,200);
    await h.due();await h.messages.dispatch();
  }
  assert.deepEqual(assigned.sort(),['context','direct','help','method','question']);assert.equal(h.vendor.length,5);
  const queue=(await h.api('/work')).body;assert.equal(queue.items.length,5);assert.ok(queue.items.every(m=>m.engain_task_id&&m.engain_check.verdict==='pass'));
  assert.equal(h.calls.some(c=>new URL(c.url).hostname.endsWith('reddit.com')),false);
  assert.equal((await h.call(h.agent,'/api/agent/work',undefined,'GET',null)).status,401);
});
test('only a matching Engain publication advances work; replies carry the actual parent text, while Reddit verification stays separate',async t=>{
  const h=await setup(t);await h.candidate();
  await h.rpc('configure_message_writer',{p_actions:['help']});
  const first=await h.next(),filed=await h.fileWork(first);await h.messages.dispatch();
  await h.due();await h.messages.tick();assert.equal((await h.sql('select count(*)::int n from experiment_messages'))[0].n,1,'in_review cannot advance');
  const v=await h.published(filed.item.id);const original=v.content;v.content='Different text';
  await h.due();await h.messages.tick();assert.equal((await h.sql('select count(*)::int n from experiment_messages'))[0].n,1);
  v.content=original;v.redditUrl='https://www.reddit.com/r/test/comments/wrong123/example/m1/';
  await h.due();await h.messages.tick();assert.equal((await h.sql('select count(*)::int n from experiment_messages'))[0].n,1);
  v.redditUrl='https://www.reddit.com/r/test/comments/abc123/example/m1/';
  await h.due();await h.messages.tick();await h.due();await h.messages.tick();
  assert.equal((await h.sql('select count(*)::int n from experiment_messages'))[0].n,2,'repeated provider reports create only one follow-up');
  const m=await h.messages.getMessage(filed.item.id);assert.ok(m.provider_published_at);assert.equal(m.verified_at,null);assert.equal(m.last_visibility,'provider_reported');
  const next=await h.next();assert.equal(next.type,'write_reply');assert.equal(next.can_write,true);assert.equal(next.targets[0].reply_mode,'reply');
  assert.equal(next.targets[0].observation.target.body,original);assert.equal(next.targets[0].observation.target.author,null);
  const second=await h.fileWork(next,{body:'Also distinguish missing fields from null values.'});await h.due();await h.messages.dispatch();
  const savedSecond=await h.messages.getMessage(second.item.id),sent=h.vendor.find(t=>t._id===savedSecond.task_id);
  assert.equal(sent.threadUrl,v.redditUrl);
  const parent=await h.published(second.item.id,'m2');await h.due();await h.messages.tick();await h.due();
  const third=await h.next();assert.deepEqual(third.targets.map(t=>t.reply_mode),['chain','sibling']);assert.ok(third.targets.every(t=>t.available));
  const missing=await h.api('/work/'+third.id,{agent:'writer',lease_token:third.lease_token,body:'A third point.'});assert.equal(missing.status,422);
  parent.status='mod_removed';await h.due();await h.messages.tick();
  const attempt=await h.api('/work/'+third.id,{agent:'writer',lease_token:third.lease_token,body:'A third point.',placement:'sibling'});assert.notEqual(attempt.status,200);
  assert.equal(h.calls.some(c=>new URL(c.url).hostname.endsWith('reddit.com')),false);
});
test('skip and defer update the queue atomically, honor leases and do not silently consume a different strategy',async t=>{
  const h=await setup(t);await h.candidate();const task=await h.next();
  const bad=await h.api('/work/'+task.id,{agent:'other',lease_token:task.lease_token,outcome:'skip',reason:'Not relevant'});assert.notEqual(bad.status,200);
  const deferred=await h.api('/work/'+task.id,{agent:'writer',lease_token:task.lease_token,outcome:'defer',reason:'Need the missing technical detail',retry_minutes:15});assert.equal(deferred.status,200);
  let m=await h.messages.getMessage(task.message_id);assert.equal(m.status,'awaiting_draft');assert.equal(m.suggested_action,task.mode);
  assert.equal((await h.api('/work/next',{agent:'writer',discover:false})).body.task,null);
  await h.due();const resumed=await h.next();assert.equal(resumed.id,task.id);assert.notEqual(resumed.lease_token,task.lease_token);
  const skipped=await h.api('/work/'+resumed.id,{agent:'writer',lease_token:resumed.lease_token,outcome:'skip',reason:'No useful contribution remains'});assert.equal(skipped.status,200);
  m=await h.messages.getMessage(task.message_id);assert.equal(m.status,'stopped');assert.equal(m.approved_at,null);assert.equal(h.vendor.length,0);
  const [rights]=await h.sql("select has_function_privilege('anon','observe_engain_message(uuid,jsonb)','EXECUTE') observe,has_function_privilege('anon','finish_writing_task(uuid,text,uuid,text,text,int)','EXECUTE') finish");assert.equal(rights.observe,false);assert.equal(rights.finish,false);
});
test('Engain context outages and failed rule checks stay queued with reasons instead of falling back to Reddit',async t=>{
  const h=await setup(t);await h.candidate();const task=await h.next();
  await h.sql("update thread_library set last_collected_at=now()-interval '10 minutes'");const opportunity=h.opportunities.pop();
  const unavailable=await h.next();assert.equal(unavailable.can_write,false);
  h.opportunities.push(opportunity);const filed=await h.fileWork(await h.next());h.ruleVerdict={verdict:'fail',summary:'Community rule blocks this message'};
  await h.messages.dispatch();assert.equal(h.vendor.length,0);const q=(await h.api('/work')).body.items.find(m=>m.id===filed.item.id);assert.equal(q.state,'held');assert.equal(q.engain_check.verdict,'fail');assert.match(q.reason,/Community rule/);
  assert.equal(h.calls.some(c=>new URL(c.url).hostname.endsWith('reddit.com')),false);
});
test('old manual targets without an Engain source defer and cannot starve fresh Engain discovery',async t=>{
  const h=await setup(t);await h.thread('manual123');
  await h.rpc('start_message_experiment',{p_thread_id:'manual123',p_strategy:'question',p_request_id:randomUUID()});
  await h.candidate();const response=await h.api('/work/next',{agent:'writer'});
  assert.equal(response.status,200,JSON.stringify(response));assert.equal(response.body.source,'engain_opportunity');
  assert.equal(response.body.task.can_write,true);assert.equal(response.body.task.context.observation.thread.id,'abc123');
  assert.equal(response.body.deferred.length,1);
  const [old]=await h.sql("select status,reason,decision_due_at from experiment_messages where target_url like '%manual123%'");
  assert.equal(old.status,'awaiting_draft');assert.match(old.reason,/No Engain opportunity/);assert.ok(Date.parse(old.decision_due_at)>Date.now()+55*60000);
  assert.equal(h.calls.some(c=>new URL(c.url).hostname.endsWith('reddit.com')),false);
});
