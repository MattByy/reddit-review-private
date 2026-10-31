// Supabase mirror: Queue 1, Queue 2, new events and a status row are copied; nothing without keys.
const test=require('node:test');
const assert=require('node:assert');
const {createApp}=require('../server/dev.cjs');

const DRAFT='Rotating the exit IP per request usually gets past that kind of block (I work at Geonode).';
const fakeOpenRouter=()=>async()=>new Response(JSON.stringify({choices:[{message:{content:DRAFT},finish_reason:'stop'}]}),{status:200,headers:{'Content-Type':'application/json'}});
function fakeSupabase(status=201){
  const calls=[];
  const fetchImpl=async(url,opts)=>{calls.push({url,method:opts.method,headers:opts.headers,body:opts.body&&JSON.parse(opts.body)});return new Response(status<300?'':'{"message":"relation \\"queue1\\" does not exist"}',{status});};
  return {calls,fetchImpl};
}
const app=(supabase)=>createApp({mock:true,dbFile:':memory:',log:()=>{},agentKey:'',cronSecret:'',openrouter:{apiKey:'k',featherlessKey:'k',fetchImpl:fakeOpenRouter()},supabase});
async function call(a,method,url,body){
  let status,out;const req=(async function*(){if(body)yield JSON.stringify(body);})();
  Object.assign(req,{method,url,socket:{remoteAddress:'127.0.0.1'},headers:{}});
  await a.handle(req,{writeHead(s){status=s;},end(v){out=JSON.parse(v);}});
  return {status,body:out};
}
async function ready(a){
  const r=await call(a,'POST','/api/collect',{max_pages:5});
  for(;;){const x=await call(a,'GET','/api/runs/'+r.body.run_id);if(x.body.finished_at)return;await new Promise(z=>setTimeout(z,20));}
}

test('off without keys',async()=>{
  const a=app({url:'',key:''});
  try{assert.strictEqual((await call(a,'POST','/api/cron/mirror',{})).body.action,'off');assert.strictEqual((await call(a,'GET','/api/mirror')).body.configured,false);}
  finally{a.close();}
});

test('copies the queues, new events only, and a status row, with the service key',async()=>{
  const sb=fakeSupabase(),a=app({url:'https://x.supabase.co/',key:'service-key',fetchImpl:sb.fetchImpl});
  try{
    await ready(a);
    await call(a,'POST','/api/cron/writer',{});
    const r=(await call(a,'POST','/api/cron/mirror',{})).body;
    assert.strictEqual(r.action,'synced',JSON.stringify(r));
    assert.ok(sb.calls.every(c=>c.headers.apikey==='service-key'&&c.headers.Authorization==='Bearer service-key'&&c.url.startsWith('https://x.supabase.co/rest/v1/')));
    const posts=t=>sb.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/'+t)).flatMap(c=>c.body);
    assert.ok(posts('queue1').length>0);assert.strictEqual(posts('queue1').length,r.queue1);
    const q2=posts('queue2');assert.strictEqual(q2.length,1);assert.strictEqual(q2[0].message,DRAFT);assert.strictEqual(q2[0].send_status,'ready');
    assert.ok(posts('events').length>0);assert.strictEqual(posts('status')[0].id,'main');
    assert.ok(sb.calls.some(c=>c.method==='DELETE'&&c.url.includes('queue1?item_id=not.in.')));
    // The next sync sends only events that are new since.
    const before=sb.calls.length;
    await call(a,'POST','/api/cron/mirror',{});
    const again=sb.calls.slice(before).filter(c=>c.method==='POST'&&c.url.endsWith('/events')).flatMap(c=>c.body);
    assert.ok(again.length<=3,'only the few events logged in between: '+again.length);
    assert.strictEqual((await call(a,'GET','/api/mirror')).body.last.ok,true);
  }finally{a.close();}
});

test('a failure is reported and kept, not thrown',async()=>{
  const sb=fakeSupabase(404),a=app({url:'https://x.supabase.co',key:'k',fetchImpl:sb.fetchImpl});
  try{
    const r=(await call(a,'POST','/api/cron/mirror',{})).body;
    assert.strictEqual(r.action,'failed');assert.match(r.reason,/HTTP 404/);
    assert.strictEqual((await call(a,'GET','/api/mirror')).body.last.ok,false);
  }finally{a.close();}
});

test('commands from the hosted page: settings, run now and fast mode are applied and reported back; old ones expire',async()=>{
  const now=new Date().toISOString(),old=new Date(Date.now()-20*60000).toISOString();
  const cmds=[{id:1,at:now,by:'Matas',kind:'settings',payload:{send_per_day:35,write_every_minutes:10}},
    {id:2,at:now,by:'Matas',kind:'run',payload:{job:'writer'}},
    {id:3,at:now,by:'Matas',kind:'fast',payload:{minutes:15}},
    {id:4,at:now,by:'Matas',kind:'settings',payload:{queue_target:5}},
    {id:5,at:old,by:'Matas',kind:'run',payload:{job:'sender'}}];
  const done=[];
  const fetchImpl=async(url,opts)=>{
    if(opts.method==='GET'&&url.includes('/commands?'))return new Response(JSON.stringify(done.length?[]:cmds),{status:200});
    const m=/commands\?id=eq\.(\d+)/.exec(url);if(opts.method==='PATCH'&&m)done.push({id:Number(m[1]),...JSON.parse(opts.body)});
    return new Response('',{status:201});
  };
  const a=app({url:'https://x.supabase.co',key:'k',fetchImpl});
  try{
    await ready(a);
    const r=(await call(a,'POST','/api/cron/commands',{})).body;
    assert.strictEqual(r.commands,5,JSON.stringify(r));
    const by=id=>done.find(d=>d.id===id);
    assert.strictEqual(by(1).status,'done');assert.deepStrictEqual(by(1).result.changed.send_per_day,[0,35]);
    const cfg=(await call(a,'GET','/api/settings')).body;assert.strictEqual(cfg.send_per_day,35);assert.strictEqual(cfg.write_every_minutes,10);
    assert.strictEqual(by(2).status,'done');assert.strictEqual(by(2).result.action,'written');
    assert.strictEqual(by(3).status,'done');assert.ok(Date.parse(by(3).result.fast_until)>Date.now()+14*60000);
    assert.strictEqual(by(4).status,'failed');assert.match(by(4).result.error,/Not changeable/);
    assert.strictEqual(by(5).status,'expired');
    const log=(await call(a,'GET','/api/logs?type=settings')).body.items;
    assert.ok(log.some(e=>e.message.includes('send_per_day 0 -> 35')&&e.message.includes('Matas')));
  }finally{a.close();}
});

test('the hosted Prompts page: snapshots of the page and its data, and changes arriving as api commands',async()=>{
  const now=new Date().toISOString(),done=[],snaps={};let served=false;
  const cmds=[{id:7,at:now,by:'login:matas',kind:'api',payload:{method:'POST',path:'/api/prompt-variants/thread-default',body:{model:'moonshotai/Kimi-K2.6'}}},
    {id:8,at:now,by:'login:matas',kind:'api',payload:{method:'POST',path:'/api/agent/queue2/1/approve',body:{}}},
    {id:9,at:now,by:'login:matas',kind:'api',payload:{method:'POST',path:'/api/keys',body:{name:'agent'}}}];
  const fetchImpl=async(url,opts)=>{
    if(opts.method==='GET'&&url.includes('/commands?')){const r=served?[]:cmds;served=true;return new Response(JSON.stringify(r),{status:200});}
    if(opts.method==='POST'&&url.endsWith('/snapshots'))for(const r of JSON.parse(opts.body))snaps[r.key]=r;
    const m=/commands\?id=eq\.(\d+)/.exec(url);if(opts.method==='PATCH'&&m)done.push({id:Number(m[1]),...JSON.parse(opts.body)});
    return new Response('',{status:201});
  };
  const a=app({url:'https://x.supabase.co',key:'k',fetchImpl});
  try{
    await call(a,'POST','/api/cron/mirror',{});
    assert.match(snaps['GET /prompts'].body,/<title>Prompts/);assert.ok(snaps['GET /docs/prompts-api']);
    assert.strictEqual(JSON.parse(snaps['GET /api/prompts'].body).variants.thread[0].model,'MiniMaxAI/MiniMax-M3');
    await call(a,'POST','/api/cron/commands',{});
    const by=id=>done.find(d=>d.id===id);
    assert.strictEqual(by(7).status,'done');assert.strictEqual(by(7).result.status,200);
    assert.strictEqual(JSON.parse(snaps['GET /api/prompts'].body).variants.thread[0].model,'moonshotai/Kimi-K2.6','the snapshot already shows the change');
    assert.strictEqual(by(8).status,'failed');assert.match(by(8).result.error,/Not reachable from the hosted page/);
    assert.strictEqual(by(9).status,'done');assert.match(JSON.parse(by(9).result.body).key,/^gnk_/);
    const log=JSON.stringify((await call(a,'GET','/api/logs?type=command')).body.items);
    assert.ok(!/gnk_[A-Za-z0-9_-]{20,}/.test(log),'the activity log never holds the new key');
  }finally{a.close();}
});

test('removing a Queue 2 draft from the hosted page',async()=>{
  const done=[];let list=[];
  const fetchImpl=async(url,opts)=>{
    if(opts.method==='GET'&&url.includes('/commands?')){const r=list;list=[];return new Response(JSON.stringify(r),{status:200});}
    const m=/commands\?id=eq\.(\d+)/.exec(url);if(opts.method==='PATCH'&&m)done.push({id:Number(m[1]),...JSON.parse(opts.body)});
    return new Response('',{status:201});
  };
  const a=app({url:'https://x.supabase.co',key:'k',fetchImpl});
  try{
    await ready(a);
    const id=(await call(a,'POST','/api/cron/writer',{})).body.queue2_id;
    const now=new Date().toISOString();
    list=[{id:1,at:now,by:'matas',kind:'discard',payload:{queue2_id:id}},{id:2,at:now,by:'matas',kind:'discard',payload:{queue2_id:id}}];
    await call(a,'POST','/api/cron/commands',{});
    assert.strictEqual(done.find(d=>d.id===1).status,'done');
    assert.strictEqual((await call(a,'GET','/api/agent/queue2/'+id)).status,404,'gone from Queue 2');
    assert.strictEqual(done.find(d=>d.id===2).status,'failed','removing it twice is reported, not hidden');
  }finally{a.close();}
});

// Hosted-page commands against a fake Supabase; createApp options can swap git and restart for fakes.
function commandRig(opts={}){
  const done=[],status=[];let list=[];
  const fetchImpl=async(url,o)=>{
    if(o.method==='GET'&&url.includes('/commands?')){const r=list;list=[];return new Response(JSON.stringify(r),{status:200});}
    const m=/commands\?id=eq\.(\d+)/.exec(url);if(o.method==='PATCH'&&m)done.push({id:Number(m[1]),...JSON.parse(o.body)});
    if(o.method==='POST'&&url.endsWith('/status'))status.push(...JSON.parse(o.body));
    return new Response('',{status:201});
  };
  const a=createApp({mock:true,dbFile:':memory:',log:()=>{},agentKey:'',cronSecret:'',openrouter:{apiKey:'k',featherlessKey:'k',fetchImpl:fakeOpenRouter()},supabase:{url:'https://x.supabase.co',key:'k',fetchImpl},...opts});
  let n=0;
  const run=async(kind,payload)=>{list=[{id:++n,at:new Date().toISOString(),by:'matas',kind,payload}];await call(a,'POST','/api/cron/commands',{});return done.find(d=>d.id===n);};
  return {a,run,status};
}

test('batch from the hosted page: back to Queue 1 keeps the order, send skips drafts that are not real, remove',async()=>{
  const {a,run}=commandRig();
  try{
    await ready(a);
    const ids=[];for(let i=0;i<4;i++)ids.push((await call(a,'POST','/api/cron/writer',{})).body.queue2_id);
    const back=await run('batch',{action:'requeue',queue2_ids:[ids[2],ids[1]]});
    assert.strictEqual(back.status,'done');assert.strictEqual(back.result.done,2);
    // A placeholder in the list is skipped with the reason; the real drafts are sent.
    const p=(await call(a,'POST','/api/agent/task',{})).body.queue2.queue2_id;
    const sent=await run('batch',{action:'send',queue2_ids:[ids[0],p]});
    assert.strictEqual(sent.result.done,1);assert.deepStrictEqual(sent.result.skipped,[{queue2_id:p,reason:'No draft yet'}]);
    assert.ok(a.store.queue2(ids[0]).engain_task_id,'sent to (mock) Engain');
    const all=await run('batch',{action:'send',all:true});
    assert.strictEqual(all.result.done,1,'only the one ready draft left');assert.ok(a.store.queue2(ids[3]).engain_task_id);
    const rm=await run('batch',{action:'discard',queue2_ids:[p]});
    assert.strictEqual(rm.result.done,1);assert.strictEqual(a.store.queue2(p),undefined);
    assert.strictEqual((await run('batch',{action:'discard',all:true})).status,'failed');
  }finally{a.close();}
});

test('batch back to Queue 1: the first in the list ends up #1',async()=>{
  const {a,run}=commandRig();
  try{
    await ready(a);
    const ids=[];for(let i=0;i<3;i++)ids.push((await call(a,'POST','/api/cron/writer',{})).body.queue2_id);
    const items=ids.map(id=>a.store.queue2(id).item_id);
    await run('batch',{action:'requeue',queue2_ids:[ids[2],ids[0],ids[1]]});
    assert.deepStrictEqual(a.store.queued().slice(0,3).map(q=>q.item_id),[items[2],items[0],items[1]]);
  }finally{a.close();}
});

test('update pulls only a clean fast-forward, after the command is marked done; restart needs watch mode',async()=>{
  const gitCalls=[];let head='aaa1111',restarts=0,dirty='';
  const git=args=>{gitCalls.push(args.join(' '));const c=args.join(' ');
    if(c==='rev-parse --short HEAD')return head;if(c==='rev-parse --short origin/main')return 'bbb2222';
    if(c==='status --porcelain --untracked-files=no')return dirty;if(c==='rev-list --count HEAD..origin/main')return '2';
    if(c==='diff --name-only HEAD origin/main')return 'server/writer.cjs\nvercel/prompts/monitor.html';
    if(c==='merge --ff-only origin/main'){head='bbb2222';return '';}return '';};
  const {a,run,status}=commandRig({git,canRestart:true,restart:()=>restarts++});
  try{
    dirty=' M server/dev.cjs';
    const blocked=await run('update',{});
    assert.strictEqual(blocked.status,'failed');assert.match(blocked.result.error,/uncommitted/);assert.ok(!gitCalls.includes('merge --ff-only origin/main'));
    dirty='';
    const u=await run('update',{});
    assert.strictEqual(u.status,'done');assert.strictEqual(u.result.commits,2);assert.strictEqual(u.result.restarts,true);
    assert.ok(gitCalls.includes('merge --ff-only origin/main'),'merged after the command was marked done');
    assert.strictEqual(status.at(-1).data.server.commit,'aaa1111');assert.strictEqual(status.at(-1).data.server.can_restart,true);
    const r=await run('restart',{});
    assert.strictEqual(r.status,'done');assert.strictEqual(restarts,1);
  }finally{a.close();}
  const plain=commandRig({git,canRestart:false,restart:()=>restarts++});
  try{assert.strictEqual((await plain.run('restart',{})).status,'failed');assert.strictEqual(restarts,1);}finally{plain.a.close();}
});
