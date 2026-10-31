// Auto-send: send_per_hour items an hour, any time or within chosen Warsaw hours, one per run of the sender job.
const test=require('node:test');
const assert=require('node:assert');
const {createApp}=require('../server/dev.cjs');
const queue=require('../server/queue.cjs');

const DRAFT='Rotating the exit IP per request usually gets past that kind of block (I work at Geonode).';
const fakeOpenRouter=()=>async()=>new Response(JSON.stringify({choices:[{message:{content:DRAFT},finish_reason:'stop'}],usage:{total_tokens:42}}),
  {status:200,headers:{'Content-Type':'application/json'}});
const app=()=>createApp({mock:true,dbFile:':memory:',log:()=>{},agentKey:'',cronSecret:'',openrouter:{apiKey:'k',featherlessKey:'k',fetchImpl:fakeOpenRouter()}});
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
const cfg=o=>({...queue.DEFAULTS,send_per_hour:5,...o});
// 2026-10-30 is CET (UTC+1): 10:00 UTC is 11:00 in Warsaw.
const at=h=>new Date(Date.UTC(2026,9,30,h-1,0,0));

test('all day by default; 5 an hour means one every 12 minutes; hours are Warsaw time and may run overnight',()=>{
  assert.strictEqual(queue.DEFAULTS.send_from_hour,0);assert.strictEqual(queue.DEFAULTS.send_to_hour,24);
  for(const h of [1,11,23])assert.strictEqual(queue.sendWindow(cfg(),at(h)).open,true);
  assert.strictEqual(queue.sendWindow(cfg(),at(11)).gap_min,12);
  const work=cfg({send_from_hour:9,send_to_hour:17});
  assert.strictEqual(queue.sendWindow(work,at(11)).open,true);
  assert.strictEqual(queue.sendWindow(work,at(8)).opens_in_min,60);
  assert.strictEqual(queue.sendWindow(work,at(18)).opens_in_min,15*60);
  assert.strictEqual(queue.sendWindow(work,at(17)).open,false);
  const night=cfg({send_from_hour:22,send_to_hour:6});
  assert.strictEqual(queue.sendWindow(night,at(23)).open,true);assert.strictEqual(queue.sendWindow(night,at(3)).open,true);
  assert.strictEqual(queue.sendWindow(night,at(12)).opens_in_min,10*60);
});

test('the sender waits one gap give or take 30%, or until the hours open, at most an hour',()=>{
  const min=ms=>ms/60000;
  assert.strictEqual(min(queue.senderDelay(cfg(),at(11),()=>0)),8.4);
  assert.strictEqual(min(queue.senderDelay(cfg(),at(11),()=>1)),15.6);
  assert.strictEqual(min(queue.senderDelay(cfg({send_from_hour:9,send_to_hour:17}),at(8),()=>0)),60);
  assert.strictEqual(min(queue.senderDelay(cfg({send_from_hour:9,send_to_hour:17}),new Date(at(9)-20*60000),()=>0)),20);
  assert.strictEqual(min(queue.senderDelay(cfg({send_per_hour:0}),at(11))),10);
});

test('the old per-day setting moves over once: off becomes all day, on keeps its hours at the same pace',()=>{
  const a=app();
  try{
    a.store.saveSettings({...queue.DEFAULTS,send_per_hour:undefined,send_per_day:0,send_from_hour:9,send_to_hour:17});
    let s=queue.settings(a.store);assert.deepStrictEqual([s.send_per_hour,s.send_from_hour,s.send_to_hour],[0,0,24]);assert.strictEqual('send_per_day' in s,false);
    a.store.saveSettings({...queue.DEFAULTS,send_per_hour:undefined,send_per_day:35,send_from_hour:9,send_to_hour:17});
    s=queue.settings(a.store);assert.deepStrictEqual([s.send_per_hour,s.send_from_hour,s.send_to_hour],[5,9,17]);
  }finally{a.close();}
});

test('off by default; when on it drafts and sends one item per run, up to the hourly maximum',async()=>{
  const a=app();
  try{
    await ready(a);
    assert.strictEqual((await call(a,'POST','/api/cron/sender',{})).body.action,'off');
    queue.saveSettings(a.store,{send_per_hour:2});
    const first=(await call(a,'POST','/api/cron/sender',{})).body;
    assert.strictEqual(first.action,'sent',JSON.stringify(first));
    const item=(await call(a,'GET','/api/agent/queue2/'+first.queue2_id)).body;
    assert.strictEqual(item.approved_by,'auto-sender');assert.ok(item.engain_task_id);assert.strictEqual(item.message,DRAFT);
    const second=(await call(a,'POST','/api/cron/sender',{})).body;
    assert.strictEqual(second.action,'sent',JSON.stringify(second));assert.strictEqual(second.sent_last_hour,2);
    const third=(await call(a,'POST','/api/cron/sender',{})).body;
    assert.strictEqual(third.action,'none');assert.match(third.reason,/Sent 2 in the last hour \(max 2\)/);
  }finally{a.close();}
});

test('outside the hours it sends nothing',async()=>{
  const a=app();
  try{
    const now=queue.sendWindow(queue.DEFAULTS);
    const h=new Date(Date.now()-Date.parse(now.day_start)).getUTCHours();
    // A one-hour window that is not the current Warsaw hour.
    const from=(h+2)%23;
    queue.saveSettings(a.store,{send_per_hour:5,send_from_hour:from,send_to_hour:from+1});
    assert.strictEqual((await call(a,'POST','/api/cron/sender',{})).body.action,'waiting');
  }finally{a.close();}
});

test('the writer drafts one Queue 1 item into Queue 2 per run, sends nothing, and rests when Queue 2 is full',async()=>{
  const a=app();
  try{
    await ready(a);
    queue.saveSettings(a.store,{queue2_target:2});
    const one=(await call(a,'POST','/api/cron/writer',{})).body;
    assert.strictEqual(one.action,'written',JSON.stringify(one));
    const item=(await call(a,'GET','/api/agent/queue2/'+one.queue2_id)).body;
    assert.strictEqual(item.message,DRAFT);assert.strictEqual(item.approved_at,null);assert.strictEqual(item.engain_task_id??null,null);
    assert.strictEqual((await call(a,'POST','/api/cron/writer',{})).body.action,'written');
    const full=(await call(a,'POST','/api/cron/writer',{})).body;
    assert.strictEqual(full.action,'none');assert.match(full.reason,/2 drafts ready/);
    queue.saveSettings(a.store,{write_every_minutes:0});
    assert.strictEqual((await call(a,'POST','/api/cron/writer',{})).body.action,'off');
  }finally{a.close();}
});
