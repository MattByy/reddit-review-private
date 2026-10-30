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
const app=(supabase)=>createApp({mock:true,dbFile:':memory:',log:()=>{},agentKey:'',cronSecret:'',openrouter:{apiKey:'k',fetchImpl:fakeOpenRouter()},supabase});
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
