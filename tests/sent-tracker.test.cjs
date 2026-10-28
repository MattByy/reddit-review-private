// The tracking list of everything sent from Queue 2, with the mock Engain.
const test=require('node:test');
const assert=require('node:assert');
const {createApp}=require('../server/dev.cjs');
const mock=require('../server/mock.cjs');

async function call(a,method,url,body){
  let status,out;const req=(async function*(){if(body)yield JSON.stringify(body);})();
  Object.assign(req,{method,url,socket:{remoteAddress:'127.0.0.1'},headers:{}});
  await a.handle(req,{writeHead(s){status=s;},end(v){out=JSON.parse(v);}});
  return {status,body:out};
}
function sendFive(a){
  const ids=[];
  for(let n=0;n<5;n++){
    a.store.db.prepare(`insert into queue2(item_id,kind,thread_id,url,thread_url,title,message,message_source,item,created_at,updated_at)
      values(?,'thread',?,?,?,?,'Disclosure: I work at Geonode. A useful note.','given','{}',datetime('now'),datetime('now'))`)
      .run('t_track'+n,'track'+n,`https://www.reddit.com/r/proxies/comments/track${n}/`,`https://www.reddit.com/r/proxies/comments/track${n}/`,'Thread '+n);
    ids.push(a.store.db.prepare('select id from queue2 where item_id=?').get('t_track'+n).id);
  }
  return ids;
}

test('sent items are tracked until their status is final, and keep it afterwards',async()=>{
  const saved=JSON.parse(JSON.stringify(mock.tasks));
  const a=createApp({mock:true,dbFile:':memory:',log:()=>{},agentKey:'',cronSecret:''});
  try{
    assert.strictEqual((await call(a,'POST','/api/cron/tracker',{})).body.action,'none','nothing sent yet');
    const ids=sendFive(a),task={};
    for(const id of ids){
      const r=await call(a,'POST',`/api/agent/queue2/${id}/approve`,{mode:'pool'});
      assert.strictEqual(r.status,200,JSON.stringify(r.body));task[id]=r.body.taskId;
    }
    let v=(await call(a,'GET','/api/sent')).body;
    assert.strictEqual(v.total,5);assert.strictEqual(v.counts.pending,5);assert.strictEqual(v.published_rate,null);
    assert.ok(v.items.every(i=>i.checking&&i.history.length===1&&i.history[0].from_status===null));

    // Engain's outcomes arrive.
    const set=(id,status,extra={})=>Object.assign(mock.tasks.find(t=>t._id===task[id]||t.id===task[id]),{status,...extra});
    set(ids[0],'published',{redditUrl:'https://www.reddit.com/r/proxies/comments/track0/x/ok1/'});
    set(ids[1],'automod_removed');set(ids[2],'mod_removed');set(ids[3],'user_deleted');set(ids[4],'in_review');
    let job=(await call(a,'POST','/api/cron/tracker',{})).body;
    assert.strictEqual(job.action,'checked');assert.strictEqual(job.checked,5);assert.strictEqual(job.still_pending,1);
    assert.deepStrictEqual(job.changed.map(c=>c.to).sort(),['automod_removed','in_review','mod_removed','published','user_deleted']);

    v=(await call(a,'GET','/api/sent')).body;
    assert.deepStrictEqual(v.counts,{pending:1,published:1,automod_removed:1,mod_removed:1,deleted:1,parent_removed:0,not_posted:0,cancelled:0,error:0});
    assert.strictEqual(v.total,5,'nothing leaves the list');assert.strictEqual(v.published_rate,25);
    const g=Object.fromEntries(v.groups.map(x=>[x.key,x]));
    assert.deepStrictEqual(v.groups.map(x=>[x.label,x.count]),[['In progress',1],['Published',1],['Removed',3],["Couldn't be posted",0],['Cancelled / error',0]]);
    assert.deepStrictEqual(g.removed.parts.map(x=>[x.label,x.count]),[['Removed by AutoModerator',1],['Removed by moderators',1],['Parent comment removed',0],['Deleted (account or Engain)',1]],'removed always lists its four kinds');
    assert.deepStrictEqual(g.in_progress.parts,[{status:'in_review',label:'Waiting to be picked up',count:1}]);
    assert.strictEqual(g.removed.detail,'always');assert.strictEqual(g.not_posted.detail,'expand');assert.strictEqual(g.other.detail,'expand');
    assert.ok(v.items.every(i=>v.groups.some(x=>x.key===i.group)));
    const pub=v.items.find(i=>i.queue2_id===ids[0]);
    assert.strictEqual(pub.bucket_label,'Published');assert.strictEqual(pub.checking,false);assert.ok(pub.reddit_url);
    assert.deepStrictEqual(pub.history.map(h=>h.to_status),[pub.history[0].to_status,'published']);
    assert.strictEqual(v.items.find(i=>i.queue2_id===ids[1]).bucket_label,'Removed by AutoModerator');
    const q2=(await call(a,'GET','/api/agent/queue2')).body.items.find(i=>i.queue2_id===ids[1]);
    assert.strictEqual(q2.send_status,'failed');assert.match(q2.send_reason,/automod_removed/);

    // Only the pending one is asked about again; it publishes later.
    set(ids[4],'published',{redditUrl:'https://www.reddit.com/r/proxies/comments/track4/x/ok5/'});
    job=(await call(a,'POST','/api/cron/tracker',{})).body;
    assert.strictEqual(job.checked,1);assert.strictEqual(job.still_pending,0);
    assert.strictEqual((await call(a,'POST','/api/cron/tracker',{})).body.action,'none');
    v=(await call(a,'GET','/api/sent')).body;
    assert.strictEqual(v.counts.published,2);assert.strictEqual(v.counts.pending,0);assert.strictEqual(v.published_rate,40);
    assert.deepStrictEqual(v.items.find(i=>i.queue2_id===ids[4]).history.map(h=>h.to_status).slice(-2),['in_review','published']);

    // The window counts by send time.
    a.store.db.prepare("update queue2 set sent_at=? where id=?").run(new Date(Date.now()-10*86400000).toISOString(),ids[0]);
    assert.strictEqual((await call(a,'GET','/api/sent?days=7')).body.total,4);
    assert.strictEqual((await call(a,'GET','/api/sent?days=30')).body.total,5);
    assert.strictEqual((await call(a,'GET','/api/sent?days=0')).body.total,5,'0 = all time');
  }finally{mock.tasks.splice(0,mock.tasks.length,...saved);a.close();}
});

test('the comments job and the status button update the same tracking entry',async()=>{
  const saved=JSON.parse(JSON.stringify(mock.tasks));
  const a=createApp({mock:true,dbFile:':memory:',log:()=>{},agentKey:'',cronSecret:''});
  try{
    const [id]=sendFive(a);
    const t=(await call(a,'POST',`/api/agent/queue2/${id}/approve`,{mode:'pool'})).body.taskId;
    Object.assign(mock.tasks.find(x=>x.id===t||x._id===t),{status:'in_queue'});
    assert.strictEqual((await call(a,'POST',`/api/agent/queue2/${id}/poll`,{})).body.status,'pending');
    Object.assign(mock.tasks.find(x=>x.id===t||x._id===t),{status:'mod_removed'});
    await call(a,'POST','/api/cron/comments',{});
    const v=(await call(a,'GET','/api/sent')).body,i=v.items.find(x=>x.queue2_id===id);
    assert.strictEqual(i.bucket,'mod_removed');assert.strictEqual(i.checking,false);
    assert.deepStrictEqual(i.history.map(h=>h.to_status).slice(1),['in_queue','mod_removed']);
  }finally{mock.tasks.splice(0,mock.tasks.length,...saved);a.close();}
});

test('every Engain task status lands in the right bucket',()=>{
  const {bucket}=require('../server/tracker.cjs');
  const final=s=>bucket({engain_status:s,settled:1,send_status:'failed'});
  const expect={published:'published',automod_removed:'automod_removed',mod_removed:'mod_removed',user_deleted:'deleted',
    main_comment_removed_deleted:'parent_removed',post_url_broken:'not_posted',thread_archived_locked:'not_posted',
    subreddit_private_banned:'not_posted',incorrect_missing_flair:'not_posted',cancelled:'cancelled',error:'error',rebuilt:'error',something_new:'error'};
  for(const [s,b] of Object.entries(expect))assert.strictEqual(final(s),b,s);
  for(const s of ['scheduled','in_review','in_queue','waiting_for_parent_comment','waiting_for_mod_approval','sent_for_posting','assigned'])
    assert.strictEqual(bucket({engain_status:s,settled:0,send_status:'submitted'}),'pending',s);
});

test("couldn't-be-posted and cancelled/error groups keep their individual statuses",async()=>{
  const {sentView}=require('../server/tracker.cjs');
  const rows=['post_url_broken','thread_archived_locked','thread_archived_locked','cancelled','error','rebuilt'].map((st,i)=>({id:i+1,kind:'thread',
    engain_task_id:'t'+i,engain_status:st,settled:1,send_status:st==='cancelled'?'cancelled':'failed',sent_at:new Date().toISOString(),item:{}}));
  const v=sentView({sentSince:()=>rows,queue2Events:()=>[]},{days:7});
  const g=Object.fromEntries(v.groups.map(x=>[x.key,x]));
  assert.strictEqual(g.not_posted.count,3);
  assert.deepStrictEqual(g.not_posted.parts.map(x=>[x.label,x.count]),[['Thread archived or locked',2],['Thread link broken',1]]);
  assert.strictEqual(g.other.count,3);
  assert.deepStrictEqual(g.other.parts.map(x=>x.label).sort(),['Cancelled','Error','Rebuilt']);
  assert.strictEqual(g.removed.count,0);assert.strictEqual(g.removed.parts.length,4);
});

