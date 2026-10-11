const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {Harness}=require('./workflow-harness.cjs');
async function setup(t){
  const previous=process.env.ENGAIN_DELIVERY;process.env.ENGAIN_DELIVERY='pool';
  const h=await new Harness().init();h.project=true;h.opportunities=[];
  await h.sql("update workflow_state set value='{\"enabled\":true}' where key='message_workflow'");
  t.after(async()=>{await h.close();if(previous===undefined)delete process.env.ENGAIN_DELIVERY;else process.env.ENGAIN_DELIVERY=previous;});
  h.library=require('../api/_library.js');
  h.candidate=async(id='abc123',changes={})=>{
    const thread=await h.thread(id),createdUtc=Math.floor(Date.now()/1000)-86400*7;
    Object.assign(h.reddit.get(id)[0].data.children[0].data,{score:20,num_comments:10,created_utc:createdUtc,over_18:false});
    const row={id:'opp-'+id,type:'new_opportunities',redditPostId:id,postContent:{url:thread.url,title:'Proxy parsing question '+id,content:'A technical question',createdUtc,score:20,numComments:10},relevance:.9,reasons:['Relevant topic'],...changes};
    h.opportunities.push(row);return row;
  };return h;
}
const request=()=>({request_id:randomUUID(),queue_lane:'test',strategy:'direct',max_messages:1,max_depth:1});
test('collector saves and refreshes one canonical library row without writing jobs; filters and read permissions work',async t=>{
  const h=await setup(t),r=await h.candidate();h.opportunities.push({...r,id:'opp-duplicate'});
  await h.candidate('old123',{postContent:{...r.postContent,url:'https://www.reddit.com/r/test/comments/old123/example/',createdUtc:Math.floor(Date.now()/1000)-86400*90}});
  const result=await h.api('/library/collect',{});assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(result.body.writing_jobs_created,0);assert.equal((await h.sql('select count(*)::int n from thread_library'))[0].n,2);
  assert.equal((await h.sql('select count(*)::int n from jobs'))[0].n,0);
  assert.equal((await h.api('/library')).body.items.length,1);
  assert.equal((await h.api('/library?scope=all&q=parsing')).body.items.length,2);
  assert.equal((await h.api('/library')).body.items[0].selection.eligible,false);
  const fresh=await h.library.refresh('abc123');assert.equal(fresh.selection.eligible,true);assert.equal(fresh.score,20);
  await h.library.collect();assert.equal((await h.library.list()).items[0].selection.eligible,true,'Collection preserves fresh Reddit evidence');
  await h.sql('set role anon');await assert.rejects(h.sql('select * from thread_library'));await assert.rejects(h.sql('select * from thread_library_entries'));await h.sql('reset role');
  assert.equal((await h.call(h.agent,'/api/agent/library',undefined,'GET',null)).status,401);
  assert.equal((await h.call(require('../api/library.js'),'/api/library',{action:'settings',settings:{min_comments:0}},'POST',null)).status,401);
  assert.equal((await h.call(require('../api/cron/collect.js'),'/api/cron/collect',undefined,'GET',null)).status,401);
  assert.equal(h.vendor.length,0);
});
test('each collection reads newest pages as well as saved backlog; failed provider fetch retains cursor and releases lock',async t=>{
  const h=await setup(t),r=await h.candidate();let fail=false;
  h.opportunityFeed=u=>new Response(JSON.stringify(fail?{error:'Rate limited'}:{opportunities:u.searchParams.get('type')==='new_opportunities'?[r]:[],isDone:u.searchParams.has('cursor'),continueCursor:u.searchParams.has('cursor')?null:'page2'}),{status:fail?429:200});
  await h.library.collect();h.calls=[];await h.library.collect();
  const feeds=h.calls.filter(c=>new URL(c.url).pathname==='/api/v1/opportunities').map(c=>new URL(c.url));
  assert.equal(feeds.length,4);assert.equal(feeds.filter(u=>!u.searchParams.has('cursor')).length,2);assert.equal(feeds.filter(u=>u.searchParams.get('cursor')==='page2').length,2);
  await h.library.collect();fail=true;await assert.rejects(h.library.collect(),/429/);
  const [state]=await h.sql("select value from workflow_state where key='thread_collector'");assert.equal(state.value.cursors.new_opportunities,'page2');assert.match(state.value.last_error,/429/);
  const [lock]=await h.sql("select value from workflow_state where key='thread_collector_lock'");assert.deepEqual(lock.value,{});
  fail=false;await h.library.collect();assert.equal(h.vendor.length,0);
});
test('unreadable or inactive Reddit targets never become writing jobs; changed context blocks filing and sending',async t=>{
  const h=await setup(t);await h.candidate();await h.library.collect();const good=h.reddit.get('abc123');
  h.reddit.set('abc123',new Response('{}',{status:403}));let queued=await h.api('/library/abc123/queue',request());assert.equal(queued.status,409);assert.equal((await h.sql('select count(*)::int n from jobs'))[0].n,0);
  h.reddit.set('abc123',good);good[0].data.children[0].data.num_comments=0;
  queued=await h.api('/library/abc123/queue',request());assert.equal(queued.status,409);assert.match(queued.body.error,/minimum discussion/);
  good[0].data.children[0].data.num_comments=10;const input=request();queued=await h.api('/library/abc123/queue',input);assert.equal(queued.status,200,JSON.stringify(queued));
  assert.equal((await h.api('/library/abc123/queue',input)).body.experiment.id,queued.body.experiment.id,'Start retries remain idempotent');
  const claim=await h.api('/jobs/claim',{agent:'test-writer',kinds:['write'],queue_lane:'test',experiment_id:queued.body.experiment.id,limit:1});const job=claim.body.jobs[0];assert.equal(job.actionable,true);
  const body='Posting on behalf of Geonode: compare the response fields before changing your parser.',fields={agent:'test-writer',claim_token:job.claim_token,reply_mode:'opening',content_action:'direct',body,draft_body:body,humanization:{tool:'agent:self-edit',meaning_preserved:true}};
  good[0].data.children[0].data.num_comments=1;assert.equal((await h.api('/messages/'+job.message.id,fields)).status,409);
  good[0].data.children[0].data.num_comments=10;assert.equal((await h.api('/messages/'+job.message.id,fields)).status,200);
  good[0].data.children[0].data.num_comments=0;await h.messages.dispatch();assert.equal(h.vendor.length,0);
  assert.match((await h.sql('select reason from experiment_messages where id=$1',[job.message.id]))[0].reason,/minimum discussion/);
});
test('test claims require the exact experiment; ordinary and legacy claims cannot steal tests and statistics exclude them',async t=>{
  const h=await setup(t);for(const id of ['work123','test123','test456'])await h.thread(id);
  const work=await h.api('/threads/work123/queue',{...request(),queue_lane:'work'}),a=await h.api('/threads/test123/queue',request()),b=await h.api('/threads/test456/queue',request());
  for(const r of [work,a,b])assert.equal(r.status,200,JSON.stringify(r));
  assert.equal((await h.api('/jobs/claim',{agent:'tester',kinds:['write'],queue_lane:'test'})).status,422);
  const claimed=await h.api('/jobs/claim',{agent:'tester',kinds:['write'],queue_lane:'test',experiment_id:b.body.experiment.id,limit:5});assert.equal(claimed.body.jobs.length,1);assert.equal(claimed.body.jobs[0].experiment.id,b.body.experiment.id);
  const normal=await h.api('/jobs/claim',{agent:'worker',kinds:['write'],limit:5});assert.equal(normal.body.jobs.length,1);assert.equal(normal.body.jobs[0].experiment.id,work.body.experiment.id);
  assert.equal((await h.rpc('claim_jobs',{p_agent:'legacy',p_kinds:['write'],p_limit:5})).length,0);
  assert.equal((await h.sql('select status from jobs where payload->>\'experiment_id\'=$1',[a.body.experiment.id]))[0].status,'planned');
  const stats=await h.sql('select * from message_experiment_results');assert.equal(stats.reduce((n,r)=>n+Number(r.active),0),1);
  const [m]=await h.sql("select id from experiment_messages where experiment_id=$1",[b.body.experiment.id]);assert.ok(m.id);
});
test('pool lock is inspectable and prevents private fallback when no project exists; settings and URL validation reject invalid input',async t=>{
  const h=await setup(t);h.project=false;const caps=await h.api('/delivery');assert.equal(caps.body.pooled_only,true);assert.equal(caps.body.requested_mode,'pool');assert.equal(caps.body.available,false);assert.equal(caps.body.mode,'pool');
  assert.equal(h.calls.some(c=>c.url.includes('/accounts-beta/')),false);
  await assert.rejects(h.library.saveSettings({min_age_hours:2000,max_age_days:2}),/age/);await assert.rejects(h.library.saveSettings({min_relevance:2}),/setting/);
  assert.throws(()=>h.library.normalize({postContent:{url:'https://evil.test/comments/abc123'},type:'new_opportunities',redditPostId:'abc123'},'p'));
  assert.equal((await h.api('/library/abc123/queue',{request_id:'not-a-uuid'})).status,422);
});
