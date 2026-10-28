// Dev server collection, queue and agent API against the mock Engain; no network.
const test=require('node:test');
const assert=require('node:assert');
const {createApp}=require('../server/dev.cjs');
const {threadRef,rank,fromOpportunity}=require('../server/collect.cjs');
const mock=require('../server/mock.cjs');

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

test('queue: thread items exclude Geonode-mentioned, old, quiet and worked-in threads; our published comments sit at position 5',async()=>{
  const {a,run}=await collected();
  try{
    assert.strictEqual(run.summary.published_new,2);
    const items=await queued(a);
    assert.deepStrictEqual(items.map(i=>i.position),items.map((_,i)=>i+1));
    assert.deepStrictEqual(items.slice(0,4).map(i=>i.kind),['thread','thread','thread','thread']);
    assert.deepStrictEqual(items.slice(4,6).map(i=>i.item_id),['p_t4','p_t1'],'newest published first');
    assert.ok(items.slice(6).every(i=>i.kind==='thread'),'competitor mentions are off by default');
    const c=items[4];
    assert.strictEqual(c.status,'comment');assert.strictEqual(c.comment.type,'reply');assert.strictEqual(c.comment.parent_task_id,'t9');
    assert.ok(c.comment.reddit_url.endsWith('/ours2/')&&c.comment.thread_url&&c.comment.content&&c.comment.published_at);
    const threadItems=new Set(items.filter(i=>i.kind==='thread').map(i=>i.thread_id));
    for(const n of [3,8])assert.ok(!threadItems.has(mockId(n)),'Geonode is mentioned in thread '+n);
    for(const n of [0,2,6])assert.ok(!threadItems.has(mockId(n)),'we already have a task in thread '+n);
    for(const i of items.filter(i=>i.kind==='thread')){assert.ok(i.thread.age_days<=120);assert.ok(i.thread.num_comments>=3);}
    const scores=items.filter(i=>i.kind==='thread').map(i=>i.score);
    assert.deepStrictEqual(scores,[...scores].sort((x,y)=>y-x));
  }finally{a.close();}
});

test('a newly published comment goes in at position 5 and pushes the rest down; new threads go to the end',async()=>{
  const {a}=await collected();
  try{
    const before=await queued(a),targets=[14,15,16].map(mockId);
    targets.forEach((tid,i)=>a.store.saveTask({task_id:'new_'+i,type:'comment',status:'published',verdict:'approved',reddit_url:`https://www.reddit.com/r/proxies/comments/${tid}/x/new${i}/`,
      thread_url:`https://www.reddit.com/r/proxies/comments/${tid}/need_proxies/`,thread_id:tid,content:'Just published',subreddit:'proxies',
      published_at:new Date(Date.now()-i*60000).toISOString(),parent_task_id:null,labels:[]}));
    assert.strictEqual((await call(a,'POST','/api/queue/refresh',{})).body.added_comments,3);
    const after=await queued(a);
    assert.deepStrictEqual(after.slice(4,7).map(i=>i.item_id),['p_new_0','p_new_1','p_new_2']);
    const expected=before.filter(i=>!(i.kind==='thread'&&targets.includes(i.thread_id))).map(i=>i.item_id);
    const rest=after.map(i=>i.item_id).filter(id=>!id.startsWith('p_new_'));
    assert.deepStrictEqual(rest.slice(0,expected.length),expected,'everything else keeps its order, shifted by 3');
    assert.ok(rest.slice(expected.length).every(id=>id.startsWith('t_')),'replacement threads are added at the end');
    assert.strictEqual(after.find(i=>i.item_id===before[4].item_id).position,before[4].position+3);
    assert.strictEqual((await call(a,'POST','/api/queue/refresh',{})).body.added_comments,0,'an already-seen comment is not inserted twice');
  }finally{a.close();}
});

test('comments job records every status change and keeps the queue in step',async()=>{
  const a=app(),saved=JSON.parse(JSON.stringify(mock.tasks));
  try{
    let r=(await call(a,'POST','/api/cron/comments',{})).body;
    assert.strictEqual(r.action,'checked');assert.strictEqual(r.published_new,2);assert.strictEqual(r.added_comments,2);
    assert.deepStrictEqual(r.task_statuses,{approved:2,disapproved:1,pending:0,failed:0,cancelled:1});
    assert.strictEqual((await call(a,'POST','/api/cron/comments',{})).body.added_comments,0,'a second check adds nothing');

    // Moderators remove one of our published comments; a new one gets published.
    mock.tasks.find(t=>t._id==='t1').status='mod_removed';
    mock.tasks.push({_id:'t5',type:'comment',status:'published',threadUrl:mock.post(14).url,redditUrl:mock.post(14).url+'ours5/',content:'Fresh one',publishedAt:new Date().toISOString(),labels:[],subreddit:'proxies'});
    r=(await call(a,'POST','/api/cron/comments',{})).body;
    assert.deepStrictEqual(r.status_changes.map(c=>[c.task_id,c.from,c.to,c.verdict]),[['t1','published','mod_removed','disapproved']]);
    assert.strictEqual(r.published_new,1);assert.strictEqual(r.added_comments,1);
    const q=await queued(a);
    assert.ok(!q.some(i=>i.item_id==='p_t1'),'a removed comment leaves the queue');
    assert.ok(q.some(i=>i.item_id==='p_t5'));
    const hist=(await call(a,'GET','/api/queue?history=50')).body.recent.find(i=>i.item_id==='p_t1');
    assert.match(hist.note,/mod_removed \(disapproved\)/);

    const ours=(await call(a,'GET','/api/our-comments')).body;
    assert.deepStrictEqual(ours.counts,{approved:2,disapproved:2,cancelled:1});
    const t1=ours.items.find(i=>i.task_id==='t1');
    assert.deepStrictEqual(t1.history.map(e=>[e.from_status,e.to_status,e.to_verdict]),[[null,'published','approved'],['published','mod_removed','disapproved']]);
    assert.strictEqual((await call(a,'GET','/api/our-comments?verdict=disapproved')).body.total,2);
  }finally{mock.tasks.splice(0,mock.tasks.length,...saved);a.close();}
});

test('threads job does nothing at the target, and refills below it',async()=>{
  const a=app();
  try{
    await call(a,'POST','/api/settings',{queue_target:10});
    let r=(await call(a,'POST','/api/cron/threads',{})).body;
    assert.strictEqual(r.action,'filled');assert.ok(r.collected,'first run collects from Engain');
    assert.strictEqual(r.queued,10);
    const runs=a.store.run('latest').id;
    r=(await call(a,'POST','/api/cron/threads',{})).body;
    assert.strictEqual(r.action,'none');assert.strictEqual(a.store.run('latest').id,runs,'a full queue makes no Engain calls');

    for(let i=0;i<3;i++)await call(a,'POST','/api/agent/task',{});
    assert.strictEqual((await queued(a)).length,7,'claiming does not refill');
    r=(await call(a,'POST','/api/cron/threads',{})).body;
    assert.strictEqual(r.action,'filled');assert.strictEqual(r.collected,null,'stored threads are fresh, so no new collection');
    assert.strictEqual(r.added_threads,3);assert.strictEqual(r.queued,10);
    const q=await queued(a);assert.ok(q.slice(-3).every(i=>i.kind==='thread'),'new threads go at the end');

    await call(a,'POST','/api/settings',{thread_collect_minutes:5});
    a.store.setKv('last_thread_collection',new Date(Date.now()-3600000).toISOString());
    await call(a,'POST','/api/agent/task',{});
    r=(await call(a,'POST','/api/cron/threads',{})).body;
    assert.ok(r.collected,'stale stored threads trigger a new collection');
    assert.strictEqual(a.store.run(r.collected.run_id).input.mention_brands,'own','only our own mentions are read while competitor mentions are off');
  }finally{a.close();}
});

test('our published comments still go in when the queue is full',async()=>{
  const a=app(),saved=JSON.parse(JSON.stringify(mock.tasks));
  try{
    await call(a,'POST','/api/settings',{queue_target:5});
    await call(a,'POST','/api/cron/threads',{});
    assert.strictEqual((await queued(a)).length,5);
    mock.tasks.push({_id:'t6',type:'comment',status:'published',threadUrl:mock.post(15).url,redditUrl:mock.post(15).url+'ours6/',content:'Another',publishedAt:new Date().toISOString(),labels:[],subreddit:'proxies'});
    const r=(await call(a,'POST','/api/cron/comments',{})).body;
    assert.strictEqual(r.added_comments,1);
    const q=await queued(a);
    assert.strictEqual(q.length,6);assert.strictEqual(q[4].item_id,'p_t6');
  }finally{mock.tasks.splice(0,mock.tasks.length,...saved);a.close();}
});

test('competitor mentions can be switched on and come right after our comments',async()=>{
  const {a}=await collected();
  try{
    await call(a,'POST','/api/settings',{mention_comments:1});
    await call(a,'POST','/api/queue/refresh',{reset:true});
    const items=await queued(a);
    assert.deepStrictEqual(items.slice(4,8).map(i=>i.kind),['comment','comment','mention','mention']);
    for(const n of [5,12])assert.strictEqual(items.find(i=>i.thread_id===mockId(n)).kind,'mention');
    assert.ok(!items.some(i=>i.mention&&/geonode/i.test(i.mention.brand)));
    assert.ok(!items.some(i=>i.mention?.body.includes('robot fight')));
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
    assert.strictEqual(r.body.status,'comment');assert.strictEqual(r.body.action,'follow_up_on_our_comment');
    assert.ok(r.body.comment.reddit_url&&r.body.comment.thread_url&&r.body.comment.content&&r.body.thread.id);
    await call(a,'POST','/api/queue/refresh',{reset:true});
    assert.ok(!(await queued(a)).some(i=>i.item_id===r.body.task_id),'a claimed comment is never queued again');

    assert.strictEqual((await call(a,'POST','/api/settings',{min_thread_score:100,max_age_days:14})).status,200);
    a.store.db.exec("update our_tasks set published_at='2020-01-01T00:00:00Z'");
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
