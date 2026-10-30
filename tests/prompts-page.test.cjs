// The Prompts page, API keys for agents, and per-prompt results.
const test=require('node:test');
const assert=require('node:assert');
const {createApp}=require('../server/dev.cjs');

const app=()=>createApp({mock:true,dbFile:':memory:',log:()=>{},agentKey:'',cronSecret:'',openrouter:{apiKey:'k',featherlessKey:'k',fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'A useful note (I work at Geonode).'}}]}),{status:200,headers:{'Content-Type':'application/json'}})}});
// remote: called from another machine; key: bearer token.
async function call(a,method,url,body,{remote=false,key}={}){
  let status,out,type;const req=(async function*(){if(body)yield JSON.stringify(body);})();
  Object.assign(req,{method,url,socket:{remoteAddress:remote?'203.0.113.9':'127.0.0.1'},headers:key?{authorization:'Bearer '+key}:{}});
  await a.handle(req,{writeHead(s,h){status=s;type=h['Content-Type'];},end(v){out=String(type).startsWith('application/json')?JSON.parse(v):String(v);}});
  return {status,body:out,type};
}

test('the Prompts page and the agent docs are served to anyone; the data needs a key from elsewhere',async()=>{
  const a=app();
  try{
    let r=await call(a,'GET','/prompts',null,{remote:true});
    assert.strictEqual(r.status,200);assert.match(r.body,/<title>Prompts<\/title>/);
    r=await call(a,'GET','/docs/prompts-api',null,{remote:true});
    assert.strictEqual(r.status,200);assert.match(r.type,/markdown/);assert.match(r.body,/POST \$API\/api\/prompt-variants/);
    assert.strictEqual((await call(a,'GET','/api/prompts',null,{remote:true})).status,403);
    assert.strictEqual((await call(a,'GET','/',null,{remote:true})).status,403,'the dashboard stays on this machine');
    // A tunnel or the Vercel proxy connects from this machine but forwards someone else's request.
    for(const h of ['x-forwarded-for','cf-connecting-ip','forwarded']){
      const req=(async function*(){})();let st;Object.assign(req,{method:'GET',url:'/api/prompts',socket:{remoteAddress:'127.0.0.1'},headers:{[h]:'203.0.113.9'}});
      await a.handle(req,{writeHead(s){st=s;},end(){}});assert.strictEqual(st,403,h+' counts as remote');
    }
  }finally{a.close();}
});

test('API keys: created on this machine, shown once, scoped, logged by name, revocable',async()=>{
  const a=app();
  try{
    assert.strictEqual((await call(a,'POST','/api/keys',{name:''})).status,422);
    const k=(await call(a,'POST','/api/keys',{name:'prompt agent'})).body;
    assert.match(k.key,/^gnk_/);assert.strictEqual(k.scope,'prompts');
    const listed=(await call(a,'GET','/api/keys')).body.keys;
    assert.strictEqual(listed.length,1);assert.strictEqual(listed[0].key,undefined,'the secret is never listed');assert.ok(!('hash' in listed[0]));
    // Another machine cannot make keys without one.
    assert.strictEqual((await call(a,'POST','/api/keys',{name:'x'},{remote:true})).status,401);
    // The prompts key reaches the prompt routes from anywhere, and nothing else.
    const opt={remote:true,key:k.key};
    assert.strictEqual((await call(a,'GET','/api/keys/me',null,opt)).body.key.name,'prompt agent');
    let r=await call(a,'POST','/api/prompt-variants',{type:'thread',name:'Agent one',text:'Reply to {{title}} (I work at Geonode). Or SKIP.'},opt);
    assert.strictEqual(r.status,200,JSON.stringify(r.body));assert.strictEqual(r.body.variant.weight,0);assert.strictEqual(r.body.variant.slug,'thread-agent-one');
    r=await call(a,'POST','/api/prompts/weights',{type:'thread',weights:{'thread-default':70,'thread-agent-one':30}},opt);
    assert.strictEqual(r.status,200,JSON.stringify(r.body));
    assert.strictEqual((await call(a,'GET','/api/agent/queue2',null,opt)).status,403);
    assert.strictEqual((await call(a,'POST','/api/keys',{name:'x'},opt)).status,403);
    assert.strictEqual((await call(a,'POST','/api/cron/threads',{},opt)).status,403);
    const ev=(await call(a,'GET','/api/logs?type=http')).body.items.find(e=>e.data?.path==='/api/prompts/weights');
    assert.strictEqual(ev.data.by,'key:prompt agent');
    assert.ok((await call(a,'GET','/api/keys')).body.keys[0].last_used_at);
    // A full key reaches the rest too.
    const full=(await call(a,'POST','/api/keys',{name:'ops',scope:'full'})).body;
    assert.strictEqual((await call(a,'GET','/api/agent/queue2',null,{remote:true,key:full.key})).status,200);
    assert.strictEqual((await call(a,'POST','/api/cron/threads',{},{remote:true,key:full.key})).status,403);
    // Revoked keys stop at once.
    assert.strictEqual((await call(a,'POST',`/api/keys/${k.id}/revoke`,{})).status,200);
    r=await call(a,'GET','/api/prompts',null,opt);
    assert.strictEqual(r.status,401);assert.match(r.body.error,/revoked/);
    assert.strictEqual((await call(a,'POST',`/api/keys/${k.id}/revoke`,{})).status,409);
  }finally{a.close();}
});

test('at most 5 prompts per kind, and every prompt reports its full results',async()=>{
  const a=app();
  try{
    for(let n=2;n<=5;n++)assert.strictEqual((await call(a,'POST','/api/prompt-variants',{type:'comment',name:'P'+n,style:'natural'})).status,200);
    const r=await call(a,'POST','/api/prompt-variants',{type:'comment',name:'P6',style:'natural'});
    assert.strictEqual(r.status,422);assert.match(r.body.error,/At most 5/);
    const p=(await call(a,'GET','/api/prompts')).body;
    assert.strictEqual(p.max_prompts,5);assert.strictEqual(p.variants.comment.length,5);
    const s=p.stats.thread.prompts[0];
    for(const k of ['drafted','skipped','waiting','not_sent','sent','sent_pool','sent_dedicated','published','pending','not_published','removed','failed','cancelled','publish_rate','removal_rate','share_of_drafts'])
      assert.ok(k in s,k+' missing');
  }finally{a.close();}
});
