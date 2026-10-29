// The activity log: every step of an item's journey is recorded and can be read back per item.
const test=require('node:test');
const assert=require('node:assert');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createApp}=require('../server/dev.cjs');

const DRAFT='Rotating the exit IP per request usually gets past that kind of block (I work at Geonode).';
const fakeOpenRouter=(status=200)=>async()=>new Response(JSON.stringify(status===200?{choices:[{message:{content:DRAFT},finish_reason:'stop'}],usage:{total_tokens:42}}:{error:{message:'upstream down'}}),
  {status,headers:{'Content-Type':'application/json'}});
const app=(opts={})=>createApp({mock:true,dbFile:':memory:',log:()=>{},agentKey:'',cronSecret:'',openrouter:{apiKey:'k',fetchImpl:fakeOpenRouter()},...opts});
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
const types=items=>items.map(e=>e.type).reverse();

test('one item: queued, moved to Queue 2, drafted, approved and sent, all in the log',async()=>{
  const a=app();
  try{
    await ready(a);
    const r=(await call(a,'POST','/api/agent/task',{write:true,agent:'tester'})).body,id=r.queue2.queue2_id;
    const sent=await call(a,'POST',`/api/agent/queue2/${id}/approve`,{});
    assert.strictEqual(sent.status,200,JSON.stringify(sent.body));
    const log=(await call(a,'GET','/api/logs?item_id='+r.task_id)).body.items;
    const seq=types(log);
    for(const t of ['queue.added','queue.moved','llm.request','llm.response','account.picked','queue2.approved','send.request','send.ok'])assert.ok(seq.includes(t),t+' missing: '+seq);
    assert.ok(seq.indexOf('queue.moved')<seq.indexOf('llm.request')&&seq.indexOf('llm.response')<seq.indexOf('send.ok'),'in order: '+seq);
    const req=log.find(e=>e.type==='llm.request'),res=log.find(e=>e.type==='llm.response');
    assert.ok(req.data.prompt.includes(r.thread.title),'the exact prompt is kept');
    assert.strictEqual(res.data.text,DRAFT);assert.strictEqual(res.data.usage.total_tokens,42);assert.strictEqual(res.queue2_id,id);
    assert.ok(log.find(e=>e.type==='send.ok').data.task_id);
    // By Queue 2 number and by area.
    assert.ok((await call(a,'GET','/api/logs?queue2_id='+id)).body.items.some(e=>e.type==='send.ok'));
    assert.ok((await call(a,'GET','/api/logs?type=llm')).body.items.every(e=>e.type.startsWith('llm.')));
    assert.ok((await call(a,'GET','/api/logs?type=collect')).body.items.some(e=>e.type==='collect.finished'));
    assert.ok((await call(a,'GET','/api/logs/types')).body.types.some(t=>t.type==='http.request'));
  }finally{a.close();}
});

test('failures are logged: a model error and a refused send',async()=>{
  const a=app({openrouter:{apiKey:'k',fetchImpl:fakeOpenRouter(500)}});
  try{
    await ready(a);
    const r=(await call(a,'POST','/api/agent/task',{write:true})).body,id=r.queue2.queue2_id;
    assert.ok(r.write_error);
    await call(a,'POST',`/api/agent/queue2/${id}/send`,{mode:'pool'});
    const seq=types((await call(a,'GET','/api/logs?queue2_id='+id)).body.items);
    assert.ok(seq.includes('llm.error')&&seq.includes('send.rejected')&&seq.includes('http.error'),seq);
    assert.ok((await call(a,'GET','/api/logs?q=upstream%20down')).body.count>0,'text search finds the error');
  }finally{a.close();}
});

test('events are also written to a daily JSON-lines file next to the database',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'logs-'));
  const a=app({dbFile:path.join(dir,'dev.db')});
  try{
    await call(a,'POST','/api/queue/refresh',{});
    const file=path.join(dir,'logs',new Date().toISOString().slice(0,10)+'.jsonl');
    const lines=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(lines.some(l=>l.type==='server.started')&&lines.some(l=>l.type==='http.request'));
  }finally{a.close();fs.rmSync(dir,{recursive:true,force:true});}
});
