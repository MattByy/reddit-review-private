// Driving the system by API only: prompts one at a time, percentages, models, trying a prompt,
// Queue 2 items, and remote access with AGENT_API_KEY. Fake model API and mock Engain.
const test=require('node:test');
const assert=require('node:assert');
const {createApp}=require('../server/dev.cjs');

function fakeModels(){
  const calls=[];
  const fetchImpl=async(url,opts)=>{const body=JSON.parse(opts.body);calls.push({url,body});
    return new Response(JSON.stringify({choices:[{message:{content:'Sticky sessions help with logins, I work at Geonode.'},finish_reason:'stop'}]}),{status:200,headers:{'Content-Type':'application/json'}});};
  return {calls,fetchImpl};
}
const app=(fm,opts={})=>createApp({mock:true,dbFile:':memory:',log:()=>{},agentKey:'',cronSecret:'',openrouter:{apiKey:'or-key',featherlessKey:'fl-key',fetchImpl:fm.fetchImpl},...opts});
async function call(a,method,url,body,{remote,token}={}){
  let status,out;const req=(async function*(){if(body)yield JSON.stringify(body);})();
  Object.assign(req,{method,url,socket:{remoteAddress:remote?'203.0.113.9':'127.0.0.1'},headers:token?{authorization:'Bearer '+token}:{}});
  await a.handle(req,{writeHead(s){status=s;},end(v){out=JSON.parse(v);}});
  return {status,body:out};
}
async function ready(a){
  const r=await call(a,'POST','/api/collect',{max_pages:5});
  for(;;){const x=await call(a,'GET','/api/runs/'+r.body.run_id);if(x.body.finished_at)return;await new Promise(z=>setTimeout(z,20));}
}

test('prompts by API: add, edit, set percentages, delete; models; try and preview without saving',async()=>{
  const fm=fakeModels(),a=app(fm);
  try{
    await ready(a);
    const idx=(await call(a,'GET','/api')).body;
    assert.ok(idx.routes.includes('POST /api/prompts/try')&&idx.routes.includes('POST /api/agent/queue2/:id/approve'));

    let r=await call(a,'POST','/api/prompt-variants',{type:'thread',name:'Casual Kimi',style:'natural',provider:'featherless',model:'moonshotai/Kimi-K2.6',temperature:0.9});
    assert.strictEqual(r.status,200,JSON.stringify(r.body));
    const v=r.body.variant;assert.strictEqual(v.weight,0,'a new prompt starts paused');assert.match(v.text,/style_examples/);
    assert.strictEqual((await call(a,'GET','/api/prompt-variants/'+v.id)).body.variant.model,'moonshotai/Kimi-K2.6');

    r=await call(a,'POST','/api/prompt-variants/'+v.id,{model:'MiniMaxAI/MiniMax-M3',name:'Casual MiniMax'});
    assert.strictEqual(r.body.variant.model,'MiniMaxAI/MiniMax-M3');assert.strictEqual(r.body.variant.name,'Casual MiniMax');assert.strictEqual(r.body.variant.provider,'featherless');
    assert.strictEqual((await call(a,'POST','/api/prompt-variants/'+v.id,{weight:50})).status,422,'percentages go through /weights');
    assert.strictEqual((await call(a,'POST','/api/prompt-variants/'+v.id,{provider:'featherless',model:''})).status,422,'Featherless needs a model');

    assert.strictEqual((await call(a,'POST','/api/prompts/weights',{type:'thread',weights:{Default:50,Nope:50}})).status,422);
    assert.strictEqual((await call(a,'POST','/api/prompts/weights',{type:'thread',weights:{Default:50,'Casual MiniMax':40}})).status,422,'must add up to 100');
    r=await call(a,'POST','/api/prompts/weights',{type:'thread',weights:{Default:50,[v.id]:50}});
    assert.deepStrictEqual(r.body.variants.map(x=>[x.name,x.weight]),[['Default',50],['Casual MiniMax',50]]);
    assert.strictEqual((await call(a,'POST',`/api/prompt-variants/${v.id}/delete`,{})).status,409,'cannot delete a prompt that is still in use');

    const m=(await call(a,'GET','/api/models')).body;
    assert.ok(m.shortlist.length>5);assert.deepStrictEqual(m.keys,{openrouter:true,featherless:true});

    const pv=(await call(a,'POST','/api/prompts/preview',{variant_id:v.id})).body;
    assert.strictEqual(pv.type,'thread');assert.ok(pv.prompt.includes(pv.item.title));assert.ok(!pv.prompt.includes('{{'));
    const before=(await call(a,'GET','/api/agent/queue2')).body.count;
    const t=(await call(a,'POST','/api/prompts/try',{variant_id:v.id,temperature:0.5})).body;
    assert.strictEqual(t.provider,'featherless');assert.strictEqual(t.model,'MiniMaxAI/MiniMax-M3');assert.strictEqual(t.temperature,0.5);
    assert.strictEqual(fm.calls.at(-1).url,'https://api.featherless.ai/v1/chat/completions');
    assert.strictEqual(t.disclosure.ok,true);assert.deepStrictEqual(t.flags,[]);
    const t2=(await call(a,'POST','/api/prompts/try',{type:'comment',text:'Say hi about {{title}}',provider:'openrouter'})).body;
    assert.strictEqual(t2.type,'comment');assert.strictEqual(t2.model,'anthropic/claude-sonnet-5.5');assert.match(t2.prompt,/^Say hi about /);
    assert.strictEqual((await call(a,'GET','/api/agent/queue2')).body.count,before,'trying saves nothing');

    await call(a,'POST','/api/prompts/weights',{type:'thread',weights:{Default:100}});
    r=await call(a,'POST',`/api/prompt-variants/${v.id}/delete`,{});
    assert.strictEqual(r.status,200);assert.deepStrictEqual(r.body.variants.map(x=>x.name),['Default']);
    assert.strictEqual((await call(a,'POST','/api/prompt-variants/v_default_thread/delete',{})).status,409,'the last prompt stays');
  }finally{a.close();}
});

test('Queue 2 by API: get one entry, discard an unsent one',async()=>{
  const fm=fakeModels(),a=app(fm);
  try{
    await ready(a);
    const q=(await call(a,'POST','/api/agent/task',{message:'Disclosure: I work at Geonode. Hi.'})).body.queue2;
    assert.strictEqual((await call(a,'GET','/api/agent/queue2/'+q.queue2_id)).body.message,'Disclosure: I work at Geonode. Hi.');
    assert.strictEqual((await call(a,'POST',`/api/agent/queue2/${q.queue2_id}/discard`,{})).status,200);
    assert.strictEqual((await call(a,'GET','/api/agent/queue2/'+q.queue2_id)).status,404);
    const s=(await call(a,'POST','/api/agent/task',{message:'Disclosure: I work at Geonode. Hi.'})).body.queue2;
    assert.strictEqual((await call(a,'POST',`/api/agent/queue2/${s.queue2_id}/approve`,{mode:'pool'})).status,200);
    assert.strictEqual((await call(a,'POST',`/api/agent/queue2/${s.queue2_id}/discard`,{})).status,409,'a sent entry stays');
  }finally{a.close();}
});

test('another machine reaches every API route with AGENT_API_KEY, and nothing without it',async()=>{
  const fm=fakeModels();
  const open=app(fm);
  try{
    assert.strictEqual((await call(open,'GET','/api/prompts',null,{remote:true})).status,403,'no key set: this machine only');
  }finally{open.close();}
  const a=app(fm,{agentKey:'secret-key'});
  try{
    assert.strictEqual((await call(a,'GET','/api/prompts',null,{remote:true})).status,401);
    assert.strictEqual((await call(a,'GET','/api/prompts',null,{remote:true,token:'wrong'})).status,401);
    assert.strictEqual((await call(a,'GET','/api/prompts',null,{remote:true,token:'secret-key'})).status,200);
    assert.strictEqual((await call(a,'GET','/api/sent',null,{remote:true,token:'secret-key'})).status,200);
    assert.strictEqual((await call(a,'GET','/api/prompts')).status,200,'this machine needs no token for dashboard routes');
  }finally{a.close();}
});
