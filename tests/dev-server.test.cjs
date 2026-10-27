// Dev server collection, queue and agent API against the mock Engain; no network.
const test=require('node:test');
const assert=require('node:assert');
const {createApp}=require('../server/dev.cjs');
const {threadRef,rank,fromOpportunity}=require('../server/collect.cjs');

const mockId=n=>'m'+(1000+n).toString(36);
const app=(opts={})=>createApp({mock:true,dbFile:':memory:',log:()=>{},agentKey:'',cronSecret:'',...opts});
async function call(a,method,url,body,{ip='127.0.0.1',token}={}){
  let status,out;const req=(async function*(){if(body)yield JSON.stringify(body);})();
  Object.assign(req,{method,url,socket:{remoteAddress:ip},headers:token?{authorization:'Bearer '+token}:{}});
  await a.handle(req,{writeHead(s){status=s;},end(v){out=JSON.parse(v);}});
  return {status,body:out};
}
async function finished(a,id){
  for(let i=0;i<500;i++){const r=await call(a,'GET','/api/runs/'+id);if(r.status!==200)throw Error(JSON.stringify(r.body));if(r.body.finished_at)return r.body;await new Promise(x=>setTimeout(x,20));}
  throw Error('run '+id+' did not finish');
}
async function collected(opts){const a=app(opts);const r=await call(a,'POST','/api/collect',{max_pages:5});const run=await finished(a,r.body.run_id);assert.deepStrictEqual(run.summary.errors,[]);return {a,run};}
const queued=async a=>(await call(a,'GET','/api/queue')).body.items;

test('threadRef canonicalises reddit and redd.it URLs',()=>{
  assert.deepStrictEqual(threadRef('https://old.reddit.com/r/Proxies/comments/AbC12/title/xyz/?a=1'),{thread_id:'abc12',subreddit:'Proxies',url:'https://www.reddit.com/r/Proxies/comments/abc12/'});
  assert.strictEqual(threadRef('https://redd.it/abc12').thread_id,'abc12');
  assert.strictEqual(threadRef('https://example.com/r/x/comments/1/'),null);
  assert.strictEqual(threadRef('not a url'),null);
});

test('scoring: percent relevance, subreddit risk, age limit and activity',()=>{
  const day=86400;
  const t=fromOpportunity({id:'o',type:'new_opportunities',relevance:90,postContent:{url:'https://www.reddit.com/r/a/comments/x1/t/',numComments:50,createdUtc:Date.now()/1000-day}});
  assert.strictEqual(t.relevance,0.9);
  const safe=rank(t,null),risky=rank(t,{moderationLevel:95,ruleFlags:{bansSelfPromotion:true},botBouncerStatus:'installed'});
  assert.ok(risky.score<safe.score&&risky.flags.includes('Subreddit bans self-promotion'));
  const quiet=rank({...t,created_utc:Date.now()/1000-60*day,num_comments:6},null),busy=rank({...t,created_utc:Date.now()/1000-60*day,num_comments:600},null);
  assert.ok(busy.parts.activity>quiet.parts.activity);
  assert.strictEqual(rank({...t,created_utc:Date.now()/1000-130*day},null).too_old,true);
  assert.strictEqual(rank({...t,created_utc:Date.now()/1000-130*day},null,{max_age_days:180}).too_old,false);
});

test('Smart Search spends quota only when allowed',async()=>{
  const a=app();
  try{
    let r=await call(a,'POST','/api/collect',{sources:['smart_search'],keywords:['never searched']});
    assert.ok((await finished(a,r.body.run_id)).summary.notes.some(n=>n.includes('never searched')));
    r=await call(a,'POST','/api/collect',{sources:['smart_search'],keywords:['never searched'],spend_quota:true});
    const run=await finished(a,r.body.run_id);
    assert.strictEqual(run.summary.quota_remaining,42);assert.ok(run.summary.per_source.smart_search>0);
  }finally{a.close();}
});

test('queue: Geonode-mentioned, old, quiet and worked-in threads are excluded; competitor comments sit at position 5',async()=>{
  const {a,run}=await collected();
  try{
    assert.ok(run.summary.queue.queued>0,'collection refreshes the queue');
    const items=await queued(a);
    assert.deepStrictEqual(items.map(i=>i.position),items.map((_,i)=>i+1));
    assert.deepStrictEqual(items.slice(0,4).map(i=>i.kind),['thread','thread','thread','thread']);
    assert.deepStrictEqual(items.slice(4,6).map(i=>i.kind),['comment','comment']);
    assert.ok(items.slice(6).every(i=>i.kind==='thread'));
    const threads=new Set(items.map(i=>i.thread_id));
    for(const n of [3,8])assert.ok(!threads.has(mockId(n)),'Geonode is mentioned in thread '+n);
    for(const n of [0,2])assert.ok(!threads.has(mockId(n)),'we already have a task in thread '+n);
    assert.strictEqual(threads.size,items.length,'one item per thread');
    for(const n of [5,12])assert.strictEqual(items.find(i=>i.thread_id===mockId(n)).kind,'comment','reply to the competitor comment instead of a top-level comment');
    assert.ok(!items.some(i=>i.kind==='comment'&&/geonode/i.test(i.comment.brand)));
    assert.ok(!items.some(i=>i.comment?.body.includes('robot fight')),'off-topic comment excluded');
    for(const i of items.filter(i=>i.kind==='thread')){assert.ok(i.thread.age_days<=120);assert.ok(i.thread.num_comments>=3);}
    const scores=items.filter(i=>i.kind==='thread').map(i=>i.score);
    assert.deepStrictEqual(scores,[...scores].sort((x,y)=>y-x));
  }finally{a.close();}
});

test('new comments are inserted from position 5 and push the rest down',async()=>{
  const {a}=await collected();
  try{
    const before=await queued(a),targets=[14,15,16].map(mockId);
    targets.forEach((tid,i)=>a.store.saveComment({id:'new_'+i,thread_id:tid,subreddit:'proxies',thread_title:'Need proxies',brand:'oxylabs.io',sentiment:'negative',
      body:'Oxylabs residential proxies keep getting blocked by Cloudflare, any alternative?',author:'u'+i,score:3,created_utc:Math.round(Date.now()/1000)-60,permalink:`https://www.reddit.com/r/proxies/comments/${tid}/x/new${i}/`}));
    assert.strictEqual((await call(a,'POST','/api/queue/refresh',{})).body.added_comments,3);
    const after=await queued(a);
    const expected=before.filter(i=>!(i.kind==='thread'&&targets.includes(i.thread_id))).map(i=>i.item_id);
    assert.deepStrictEqual(new Set(after.slice(4,7).map(i=>i.item_id)),new Set(['c_new_0','c_new_1','c_new_2']));
    const rest=after.map(i=>i.item_id).filter(id=>!id.startsWith('c_new_'));
    assert.deepStrictEqual(rest.slice(0,expected.length),expected,'everything else keeps its order, shifted by 3');
    const old5=before[4];
    if(!targets.includes(old5.thread_id))assert.strictEqual(after.find(i=>i.item_id===old5.item_id).position,old5.position+3);
  }finally{a.close();}
});

test('agent task: each call returns item #1 and removes it for good',async()=>{
  const {a}=await collected();
  try{
    let items=await queued(a);
    const first=items[0];
    let r=await call(a,'POST','/api/agent/task',{agent:'writer-1'});
    assert.strictEqual(r.status,200);
    assert.strictEqual(r.body.task_id,first.item_id);
    assert.strictEqual(r.body.status,'thread');assert.strictEqual(r.body.action,'comment_on_thread');
    assert.ok(r.body.thread.url&&r.body.thread.title);
    assert.strictEqual(r.body.remaining,items.length-1);
    items=await queued(a);
    assert.ok(!items.some(i=>i.thread_id===first.thread_id));assert.strictEqual(items[0].position,1);
    await call(a,'POST','/api/queue/refresh',{reset:true});
    assert.ok(!(await queued(a)).some(i=>i.thread_id===first.thread_id),'a claimed thread is never queued again');

    for(let i=0;i<10&&r.body.status!=='comment';i++)r=await call(a,'POST','/api/agent/task',{agent:'writer-1'});
    assert.strictEqual(r.body.status,'comment');assert.strictEqual(r.body.action,'reply_to_comment');
    assert.ok(r.body.comment.permalink&&r.body.comment.body&&r.body.thread.id);

    assert.strictEqual((await call(a,'POST','/api/settings',{min_thread_score:100,min_comment_score:100})).status,200);
    r=await call(a,'POST','/api/agent/task',{});
    assert.strictEqual(r.body.status,'empty');
    assert.strictEqual((await call(a,'POST','/api/settings',{max_age_days:1})).status,422);
    assert.strictEqual((await call(a,'POST','/api/settings',{bogus:1})).status,422);
  }finally{a.close();}
});

test('claims and refreshes never pull older backlog comments into the queue',async()=>{
  const {a}=await collected();
  try{
    await call(a,'POST','/api/settings',{comment_limit:1});
    await call(a,'POST','/api/queue/refresh',{reset:true});
    let items=await queued(a);
    assert.strictEqual(items.filter(i=>i.kind==='comment').length,1,'one comment left in the backlog');
    for(let n=0;n<3;n++){
      const r=await call(a,'POST','/api/agent/task',{});
      assert.strictEqual(r.body.remaining,items.length-1,'each claim removes exactly one item');
      items=await queued(a);
    }
    assert.ok(items.filter(i=>i.kind==='comment').length<=1);
    assert.strictEqual((await call(a,'POST','/api/queue/refresh',{})).body.added_comments,0);
  }finally{a.close();}
});

test('auth: agent and cron need their secrets; the dashboard is local only',async()=>{
  const a=app({agentKey:'agent-secret',cronSecret:'cron-secret'});
  try{
    assert.strictEqual((await call(a,'POST','/api/agent/task',{})).status,401);
    assert.strictEqual((await call(a,'POST','/api/agent/task',{},{token:'wrong'})).status,401);
    assert.strictEqual((await call(a,'POST','/api/agent/task',{},{token:'agent-secret',ip:'10.0.0.9'})).status,200);
    assert.strictEqual((await call(a,'POST','/api/cron/refresh',{collect:false},{token:'agent-secret'})).status,401);
    assert.strictEqual((await call(a,'POST','/api/cron/refresh',{collect:false},{token:'cron-secret',ip:'10.0.0.9'})).status,200);
    assert.strictEqual((await call(a,'GET','/api/queue',null,{ip:'10.0.0.9'})).status,403);
    const open=app();
    assert.strictEqual((await call(open,'POST','/api/agent/task',{},{ip:'10.0.0.9'})).status,401,'no key configured: remote calls refused');
    assert.strictEqual((await call(open,'POST','/api/agent/task',{})).status,200,'no key configured: local calls allowed');
    open.close();
  }finally{a.close();}
});

test('cron refresh starts a collection and refuses to overlap',async()=>{
  const a=app();
  try{
    const r=await call(a,'POST','/api/cron/refresh',{});
    assert.strictEqual(r.body.started,true);
    assert.strictEqual((await call(a,'POST','/api/cron/refresh',{})).body.started,false);
    const run=await finished(a,r.body.run_id);
    assert.ok(run.summary.queue.queued>0);
  }finally{a.close();}
});
