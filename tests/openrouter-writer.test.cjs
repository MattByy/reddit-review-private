// OpenRouter drafting, prompts and approve-to-send, with a fake OpenRouter and the mock Engain.
const test=require('node:test');
const assert=require('node:assert');
const {createApp}=require('../server/dev.cjs');
const {DEFAULT_PROMPTS}=require('../server/writer.cjs');

const DRAFT='Rotating the exit IP per request usually gets past that kind of block (I work at Geonode).';
function fakeOpenRouter(reply=()=>({status:200,body:{choices:[{message:{content:DRAFT}}]}})){
  const calls=[];
  const fetchImpl=async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body),auth:opts.headers.Authorization});const r=reply(calls.length);
    return new Response(JSON.stringify(r.body),{status:r.status,headers:{'Content-Type':'application/json'}});};
  return {calls,fetchImpl};
}
const app=(or,opts={})=>createApp({mock:true,dbFile:':memory:',log:()=>{},agentKey:'',cronSecret:'',openrouter:{apiKey:'test-or-key',...or},...opts});
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

test('get next item with write: OpenRouter drafts from the thread prompt, nothing is sent',async()=>{
  const or=fakeOpenRouter(),a=app({fetchImpl:or.fetchImpl});
  try{
    await ready(a);
    const r=(await call(a,'POST','/api/agent/task',{write:true})).body;
    const q=r.queue2;
    assert.strictEqual(q.status,'thread');assert.strictEqual(q.write_status,'written');assert.strictEqual(q.message_source,'openrouter');
    assert.strictEqual(q.message,DRAFT);assert.strictEqual(q.disclosure.ok,true);
    assert.strictEqual(q.model,'anthropic/claude-sonnet-5.5');assert.strictEqual(or.calls[0].body.model,'anthropic/claude-sonnet-5.5');
    assert.strictEqual(or.calls[0].auth,'Bearer test-or-key');
    assert.strictEqual(q.prompt_used,or.calls[0].body.messages[0].content,'the saved prompt is exactly what the model received');
    assert.ok(q.prompt_used.includes('Thread title: '+r.thread.title));assert.ok(q.prompt_used.includes('I work at Geonode'));
    assert.ok(!/\{\{\w+\}\}/.test(q.prompt_used),'every variable is filled');
    assert.strictEqual(or.calls[0].body.messages.length,1,'no hidden system prompt');
    assert.strictEqual(q.send_status,'ready');assert.strictEqual(q.approved_at,null);assert.strictEqual(q.engain_task_id,null);
  }finally{a.close();}
});

test('a comment item is drafted with the comment prompt, including our earlier comment',async()=>{
  const or=fakeOpenRouter(),a=app({fetchImpl:or.fetchImpl});
  try{
    await ready(a);
    let r;for(let i=0;i<10;i++){r=(await call(a,'POST','/api/agent/task',{})).body;if(r.status==='comment')break;}
    assert.strictEqual(r.status,'comment');
    const q=(await call(a,'POST','/api/agent/queue2/'+r.queue2.queue2_id+'/write',{})).body;
    assert.ok(q.prompt_used.startsWith('You are writing a short follow-up for Geonode'));
    assert.ok(q.prompt_used.includes("Geonode's earlier comment:\n"+r.comment.content));
    assert.ok(!q.prompt_used.includes('Write one comment that'),'not the thread prompt');
  }finally{a.close();}
});

test('approve sends; nothing is sent without approval, and editing withdraws approval',async()=>{
  const or=fakeOpenRouter(),a=app({fetchImpl:or.fetchImpl});
  try{
    await ready(a);
    const q=(await call(a,'POST','/api/agent/task',{write:true})).body.queue2,id=q.queue2_id;
    let r=await call(a,'POST',`/api/agent/queue2/${id}/send`,{mode:'pool'});
    assert.strictEqual(r.status,409);assert.match(r.body.error,/Approve this message/);

    await call(a,'POST','/api/agent/queue2/'+id,{message:DRAFT+' Edited.'});
    const e=(await call(a,'GET','/api/agent/queue2')).body.items.find(x=>x.queue2_id===id);
    assert.strictEqual(e.message_source,'given');assert.strictEqual(e.approved_at,null);

    r=await call(a,'POST',`/api/agent/queue2/${id}/approve`,{mode:'pool'});
    assert.strictEqual(r.status,200,JSON.stringify(r.body));
    assert.strictEqual(r.body.ok,true);assert.ok(r.body.taskId);
    assert.strictEqual(r.body.queue2.send_status,'submitted');assert.ok(r.body.queue2.approved_at);assert.strictEqual(r.body.queue2.approved_by,'dashboard');
    assert.strictEqual(r.body.queue2.engain_task_id,r.body.taskId);
    assert.strictEqual((await call(a,'POST',`/api/agent/queue2/${id}/approve`,{mode:'pool'})).status,409,'cannot send twice');
    assert.strictEqual((await call(a,'POST',`/api/agent/queue2/${id}/write`,{})).status,409,'cannot rewrite after sending');
    assert.strictEqual((await call(a,'POST',`/api/agent/queue2/${id}/poll`,{})).status,200,'status route reachable');
  }finally{a.close();}
});

test('placeholders, skips and failed drafts cannot be approved',async()=>{
  let mode='skip';
  const or=fakeOpenRouter(()=>mode==='skip'?{status:200,body:{choices:[{message:{content:'SKIP'}}]}}:{status:500,body:{error:{message:'upstream down'}}});
  const a=app({fetchImpl:or.fetchImpl});
  try{
    await ready(a);
    const p=(await call(a,'POST','/api/agent/task',{})).body.queue2;
    assert.strictEqual((await call(a,'POST',`/api/agent/queue2/${p.queue2_id}/approve`,{mode:'pool'})).status,422,'placeholder');
    const s=(await call(a,'POST','/api/agent/task',{write:true})).body.queue2;
    assert.strictEqual(s.write_status,'skipped');
    assert.strictEqual((await call(a,'POST',`/api/agent/queue2/${s.queue2_id}/approve`,{mode:'pool'})).status,422,'skipped');
    mode='error';
    const r=await call(a,'POST',`/api/agent/queue2/${p.queue2_id}/write`,{});
    assert.strictEqual(r.status,502);
    const e=(await call(a,'GET','/api/agent/queue2')).body.items.find(x=>x.queue2_id===p.queue2_id);
    assert.strictEqual(e.write_status,'failed');assert.match(e.write_error,/upstream down/);assert.match(e.message,/^Placeholder message:/,'message unchanged');
  }finally{a.close();}
});

test('a draft cut off at the length limit cannot be approved until it is rewritten or edited',async()=>{
  const or=fakeOpenRouter(()=>({status:200,body:{choices:[{message:{content:'Disclosure: I work at Geonode. This answer stops mid'},finish_reason:'length'}]}}));
  const a=app({fetchImpl:or.fetchImpl});
  try{
    await ready(a);
    const q=(await call(a,'POST','/api/agent/task',{write:true})).body.queue2;
    assert.strictEqual(q.write_status,'truncated');assert.match(q.write_error,/cut off/);assert.strictEqual(q.message_source,'openrouter');
    assert.strictEqual(or.calls[0].body.max_tokens,1500);
    let r=await call(a,'POST',`/api/agent/queue2/${q.queue2_id}/approve`,{mode:'pool'});
    assert.strictEqual(r.status,422);assert.match(r.body.error,/cut off/);
    await call(a,'POST','/api/agent/queue2/'+q.queue2_id,{message:'Disclosure: I work at Geonode. This answer is now complete.'});
    r=await call(a,'POST',`/api/agent/queue2/${q.queue2_id}/approve`,{mode:'pool'});
    assert.strictEqual(r.status,200,JSON.stringify(r.body));assert.strictEqual(r.body.queue2.write_status,'edited');
  }finally{a.close();}
});

test('no sending limits: back-to-back sends to the same subreddit both go through',async()=>{
  const or=fakeOpenRouter(),a=app({fetchImpl:or.fetchImpl});
  try{
    await ready(a);
    const sent=[];
    for(let i=0;i<3;i++){
      const q=(await call(a,'POST','/api/agent/task',{write:true})).body.queue2;
      const r=await call(a,'POST',`/api/agent/queue2/${q.queue2_id}/approve`,{mode:'pool'});
      assert.strictEqual(r.status,200,JSON.stringify(r.body));sent.push(r.body.queue2.url.split('/')[4]);
    }
    a.store.db.prepare("update queue2_pacing set sends_today_utc=500,subreddit_last_send=? where id=1").run(JSON.stringify({[sent[0]]:new Date().toISOString()}));
    const q=(await call(a,'POST','/api/agent/task',{write:true})).body.queue2;
    a.store.db.prepare('update queue2 set url=? where id=?').run(`https://www.reddit.com/r/${sent[0]}/comments/zz1/x/`,q.queue2_id);
    const r=await call(a,'POST',`/api/agent/queue2/${q.queue2_id}/approve`,{mode:'pool'});
    assert.strictEqual(r.status,200,'same subreddit straight after, with 500 sends today: '+JSON.stringify(r.body));
  }finally{a.close();}
});

test('a pooled send can pick the poster account; own accounts are reported when unavailable',async()=>{
  const mock=require('../server/mock.cjs'),saved=mock.tasks.length;
  const or=fakeOpenRouter(),a=app({fetchImpl:or.fetchImpl});
  try{
    await ready(a);
    const q=(await call(a,'POST','/api/agent/task',{write:true})).body.queue2;
    const r=await call(a,'POST',`/api/agent/queue2/${q.queue2_id}/approve`,{mode:'pool',posterAccount:7});
    assert.strictEqual(r.status,200,JSON.stringify(r.body));
    assert.strictEqual(r.body.queue2.poster_account,7);
    assert.strictEqual(mock.tasks.at(-1).posterAccount,7,'Engain received posterAccount 7');
    const b=(await call(a,'GET','/api/agent/beta-accounts')).body;
    assert.strictEqual(b.available,true);assert.ok(b.accounts.length>0);
  }finally{mock.tasks.splice(saved);a.close();}
  const off=createApp({dbFile:':memory:',log:()=>{},apiKey:'k',projectId:'p',agentKey:'',cronSecret:''});
  off.engain.betaAccounts=async()=>{throw Object.assign(Error('Non-JSON response'),{status:404});};
  try{
    const b=(await call(off,'GET','/api/agent/beta-accounts')).body;
    assert.strictEqual(b.available,false);assert.match(b.reason,/not enabled/);
  }finally{off.close();}
});

test('prompts are visible and editable per type, and the edited one is used',async()=>{
  const or=fakeOpenRouter(),a=app({fetchImpl:or.fetchImpl});
  try{
    const p=(await call(a,'GET','/api/prompts')).body;
    assert.deepStrictEqual(Object.keys(p.prompts),['thread','comment','mention']);
    assert.notStrictEqual(p.prompts.thread,p.prompts.comment);
    for(const k of ['thread','comment','mention'])assert.ok(/I work (at|for) Geonode/.test(p.prompts[k]),k+' prompt asks for the disclosure');
    assert.strictEqual(p.openrouter_key,true);assert.ok(p.variables.comment.includes('our_comment'));

    await call(a,'POST','/api/prompts',{thread:'Custom prompt for r/{{subreddit}} about "{{title}}". Disclose: I work at Geonode.'});
    await ready(a);
    const q=(await call(a,'POST','/api/agent/task',{write:true})).body.queue2;
    assert.match(q.prompt_used,/^Custom prompt for r\/\w+ about "/);
    await call(a,'POST','/api/prompts',{thread:null});
    assert.strictEqual((await call(a,'GET','/api/prompts')).body.prompts.thread,DEFAULT_PROMPTS.thread,'null resets to the default');
    assert.strictEqual((await call(a,'POST','/api/prompts',{nope:'x'})).status,422);
    assert.strictEqual((await call(a,'POST','/api/prompts',{thread:'  '})).status,422);
  }finally{a.close();}
});

test('writing without an OpenRouter key fails clearly',async()=>{
  const a=createApp({mock:true,dbFile:':memory:',log:()=>{},agentKey:'',cronSecret:'',openrouter:{apiKey:''}});
  try{
    await ready(a);
    const id=(await call(a,'POST','/api/agent/task',{})).body.queue2.queue2_id;
    const r=await call(a,'POST',`/api/agent/queue2/${id}/write`,{});
    assert.strictEqual(r.status,503);assert.match(r.body.error,/OPENROUTER_API_KEY/);
  }finally{a.close();}
});
