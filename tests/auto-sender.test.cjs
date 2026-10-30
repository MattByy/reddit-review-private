// Auto-send: send_per_day items spread over Warsaw working hours, one per run of the sender job.
const test=require('node:test');
const assert=require('node:assert');
const {createApp}=require('../server/dev.cjs');
const queue=require('../server/queue.cjs');

const DRAFT='Rotating the exit IP per request usually gets past that kind of block (I work at Geonode).';
const fakeOpenRouter=()=>async()=>new Response(JSON.stringify({choices:[{message:{content:DRAFT},finish_reason:'stop'}],usage:{total_tokens:42}}),
  {status:200,headers:{'Content-Type':'application/json'}});
const app=()=>createApp({mock:true,dbFile:':memory:',log:()=>{},agentKey:'',cronSecret:'',openrouter:{apiKey:'k',fetchImpl:fakeOpenRouter()}});
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
const cfg=o=>({...queue.DEFAULTS,send_per_day:40,...o});
// 2026-10-30 is CET (UTC+1): 10:00 UTC is 11:00 in Warsaw.
const at=h=>new Date(Date.UTC(2026,9,30,h-1,0,0));

test('the window is Warsaw time and 40 a day over 9-17 means one every 12 minutes',()=>{
  const open=queue.sendWindow(cfg(),at(11));
  assert.strictEqual(open.open,true);assert.strictEqual(open.gap_min,12);
  assert.strictEqual(open.day_start,'2026-10-29T23:00:00.000Z');
  assert.strictEqual(queue.sendWindow(cfg(),at(8)).opens_in_min,60);
  assert.strictEqual(queue.sendWindow(cfg(),at(18)).opens_in_min,15*60);
  assert.strictEqual(queue.sendWindow(cfg(),at(17)).open,false);
});

test('the sender waits one gap give or take 30%, or until the window opens, at most an hour',()=>{
  const min=ms=>ms/60000;
  assert.strictEqual(min(queue.senderDelay(cfg(),at(11),()=>0)),8.4);
  assert.strictEqual(min(queue.senderDelay(cfg(),at(11),()=>1)),15.6);
  assert.strictEqual(min(queue.senderDelay(cfg(),at(8),()=>0)),60);
  assert.strictEqual(min(queue.senderDelay(cfg(),new Date(at(9)-20*60000),()=>0)),20);
  assert.strictEqual(min(queue.senderDelay(cfg({send_per_day:0}),at(11))),10);
});

test('off by default; when on it drafts and sends one item per run, up to the daily maximum',async()=>{
  const a=app();
  try{
    await ready(a);
    assert.strictEqual((await call(a,'POST','/api/cron/sender',{})).body.action,'off');
    queue.saveSettings(a.store,{send_per_day:2,send_from_hour:0,send_to_hour:24});
    const first=(await call(a,'POST','/api/cron/sender',{})).body;
    assert.strictEqual(first.action,'sent',JSON.stringify(first));
    const item=(await call(a,'GET','/api/agent/queue2/'+first.queue2_id)).body;
    assert.strictEqual(item.approved_by,'auto-sender');assert.ok(item.engain_task_id);assert.strictEqual(item.message,DRAFT);
    const second=(await call(a,'POST','/api/cron/sender',{})).body;
    assert.strictEqual(second.action,'sent',JSON.stringify(second));assert.strictEqual(second.sent_today,2);
    const third=(await call(a,'POST','/api/cron/sender',{})).body;
    assert.strictEqual(third.action,'none');assert.match(third.reason,/Sent 2 today \(max 2\)/);
  }finally{a.close();}
});

test('outside the hours it sends nothing',async()=>{
  const a=app();
  try{
    const now=queue.sendWindow({...queue.DEFAULTS,send_from_hour:0,send_to_hour:24});
    const h=new Date(Date.now()-Date.parse(now.day_start)).getUTCHours();
    // A one-hour window that is not the current Warsaw hour.
    const from=(h+2)%23;
    queue.saveSettings(a.store,{send_per_day:40,send_from_hour:from,send_to_hour:from+1});
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
