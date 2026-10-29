// Model per prompt (OpenRouter or Featherless) and the blind model test, with fake model APIs
// and the mock Engain. Nothing is posted.
const test=require('node:test');
const assert=require('node:assert');
const {createApp}=require('../server/dev.cjs');
const {flags}=require('../server/bench.cjs');
const {cleanText,NATURAL_PROMPTS}=require('../server/writer.cjs');

// Answers per model, so the test can tell who wrote what.
function fakeModels(reply=m=>`Could be TLS fingerprinting rather than the IPs (I work at Geonode, fwiw). ${m}`){
  const calls=[];
  const fetchImpl=async(url,opts)=>{const body=JSON.parse(opts.body);calls.push({url,body,auth:opts.headers.Authorization});
    const out=reply(body.model,calls.length);
    if(out instanceof Response)return out;
    return new Response(JSON.stringify({choices:[{message:{content:out},finish_reason:'stop'}]}),{status:200,headers:{'Content-Type':'application/json'}});};
  return {calls,fetchImpl};
}
const app=fm=>createApp({mock:true,dbFile:':memory:',log:()=>{},agentKey:'',cronSecret:'',openrouter:{apiKey:'or-key',featherlessKey:'fl-key',fetchImpl:fm.fetchImpl}});
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
async function until(a,id,ok){
  for(let i=0;i<300;i++){const v=(await call(a,'GET','/api/bench/'+id)).body;if(ok(v))return v;await new Promise(z=>setTimeout(z,20));}
  throw Error('timed out');
}

test('a prompt can use a Featherless model; the draft records provider and model',async()=>{
  const fm=fakeModels(),a=app(fm);
  try{
    await ready(a);
    const p=(await call(a,'GET','/api/prompts')).body;
    assert.strictEqual(p.featherless_key,true);assert.ok(p.natural.thread.includes('{{style_examples}}'));
    let r=await call(a,'POST','/api/prompts',{type:'thread',variants:[{name:'Humanlike',text:p.natural.thread,weight:100,provider:'featherless'}]});
    assert.strictEqual(r.status,422,'a Featherless prompt needs a model');assert.match(r.body.error,/Featherless model/);
    r=await call(a,'POST','/api/prompts',{type:'thread',variants:[{name:'Humanlike',text:p.natural.thread,weight:100,provider:'featherless',model:'LessThanThreeAI/Qwen3.8-27B-Humanlike-Chat-2.0',temperature:1}]});
    assert.strictEqual(r.status,200,JSON.stringify(r.body));
    assert.deepStrictEqual(Object.keys(r.body.variants[0]).sort(),['id','model','name','provider','slug','temperature','text','weight']);
    const q=(await call(a,'POST','/api/agent/task',{write:true})).body.queue2;
    assert.strictEqual(fm.calls[0].url,'https://api.featherless.ai/v1/chat/completions');assert.strictEqual(fm.calls[0].auth,'Bearer fl-key');
    assert.strictEqual(fm.calls[0].body.model,'LessThanThreeAI/Qwen3.8-27B-Humanlike-Chat-2.0');assert.strictEqual(fm.calls[0].body.temperature,1);
    assert.deepStrictEqual(fm.calls[0].body.chat_template_kwargs,{enable_thinking:false});
    assert.strictEqual(fm.calls[0].body.messages.length,1);assert.strictEqual(fm.calls[0].body.messages[0].role,'user');
    assert.strictEqual(q.provider,'featherless');assert.strictEqual(q.model,'LessThanThreeAI/Qwen3.8-27B-Humanlike-Chat-2.0');
    assert.strictEqual(q.prompt_variant_name,'Humanlike');assert.strictEqual(q.write_status,'written');
    assert.ok(!q.prompt_used.includes('{{style_examples}}'),'style examples are filled in');
    assert.match(q.prompt_used,/- "/,'real collected comments are pasted as examples');
    assert.ok(!/geonode/i.test(q.prompt_used.split('How people in these threads write')[1].split('Write one comment')[0]),'examples never mention Geonode');
  }finally{a.close();}
});

test('cleanText drops reasoning tags and wrapping quotes; flags spot the usual tells',()=>{
  assert.strictEqual(cleanText('<think>hmm</think>\n"Try sticky sessions (I work at Geonode)."'),'Try sticky sessions (I work at Geonode).');
  assert.deepStrictEqual(flags('I work at Geonode, fwiw. Try sticky sessions.').list,['opens with disclosure']);
  assert.deepStrictEqual(flags("Sounds really frustrating — I'm seeing that too 😊").list.sort(),['em-dash','emoji','no disclosure','possible invented claim','stock opener']);
  assert.deepStrictEqual(flags("Try sticky sessions, rotating per request looks odd. (I work at Geonode)").list,[]);
  assert.ok(flags('The user wants a Reddit comment. I work at Geonode.').list.includes('reasoning instead of a comment'));
  assert.ok(NATURAL_PROMPTS.comment.includes('same person'));
});

test('model test: drafts every item with every model, hides names until a pick, scores and ranks',async()=>{
  const fm=fakeModels((m,n)=>m==='bad/model'?new Response('{"error":{"message":"model not found"}}',{status:404}):
    m==='skip/model'?'SKIP':`Rotating per request can look odd, try sticky sessions (I work at Geonode). ${m} ${n}`),a=app(fm);
  try{
    await ready(a);
    let r=await call(a,'POST','/api/bench',{contestants:[]});
    assert.strictEqual(r.status,422);
    r=await call(a,'POST','/api/bench',{name:'First test',threads:3,comments:1,contestants:[
      {provider:'featherless',model:'good/model',prompt:'natural'},
      {provider:'openrouter',model:'anthropic/claude-sonnet-5.5',prompt:'default',temperature:0.7},
      {provider:'featherless',model:'skip/model'},{provider:'featherless',model:'bad/model'}]});
    assert.strictEqual(r.status,200,JSON.stringify(r.body));
    const id=r.body.id,items=r.body.items;
    assert.ok(items>=2&&items<=4);assert.strictEqual(r.body.progress.total,items*4);
    const v=await until(a,id,v=>v.status==='done');
    assert.strictEqual(v.progress.counts.written,items*2);assert.strictEqual(v.progress.counts.skipped,items);assert.strictEqual(v.progress.counts.failed,items);
    assert.ok(fm.calls.some(c=>c.url.startsWith('https://openrouter.ai/')&&c.auth==='Bearer or-key'));
    assert.strictEqual((await call(a,'GET','/api/queue')).body.count>0,true,'Queue 1 items stay where they are');

    // Blind: letters only, no model names, until the item is picked.
    let c=(await call(a,'GET',`/api/bench/${id}/compare`)).body;
    assert.strictEqual(c.items.length,items);
    const first=c.items[0];
    assert.deepStrictEqual(first.drafts.map(d=>d.label),['A','B','C','D']);
    assert.ok(first.drafts.every(d=>!('model' in d)&&!('provider' in d)&&!('prompt' in d)));
    assert.ok(!JSON.stringify(first.drafts).includes('good/model')||first.drafts.some(d=>d.text?.includes('good/model')),'names only appear inside the fake text');
    const good=first.drafts.find(d=>d.text?.includes('good/model'));
    assert.strictEqual((await call(a,'POST',`/api/bench/${id}/pick`,{item_key:first.key,draft_id:999999})).status,422);
    assert.strictEqual((await call(a,'POST',`/api/bench/${id}/pick`,{item_key:first.key,draft_id:good.id})).status,200);
    assert.strictEqual((await call(a,'POST',`/api/bench/${id}/pick`,{item_key:c.items[1].key,draft_id:null})).status,200,'"none is good" is a pick too');
    c=(await call(a,'GET',`/api/bench/${id}/compare`)).body;
    assert.ok(c.items[0].picked&&c.items[0].drafts.every(d=>d.model),'names revealed after the pick');
    assert.strictEqual(c.items[0].pick,good.id);

    // Engain rule-check scores (mock), then the leaderboard.
    assert.strictEqual((await call(a,'POST',`/api/bench/${id}/score`,{})).body.started,true);
    const s=await until(a,id,v=>v.score_status&&v.score_status!=='running');
    assert.strictEqual(s.score_status,'done',s.score_error);assert.strictEqual(s.scored,items*2,'only written drafts are scored');
    const lb=Object.fromEntries(s.leaderboard.map(x=>[x.model,x]));
    assert.strictEqual(lb['good/model'].picked,1);assert.strictEqual(lb['good/model'].judged,2);assert.strictEqual(lb['good/model'].pick_rate,50);
    assert.strictEqual(lb['anthropic/claude-sonnet-5.5'].picked,0);assert.strictEqual(lb['anthropic/claude-sonnet-5.5'].prompt,'Default (built-in)');
    assert.strictEqual(lb['good/model'].prompt,'Natural (built-in)');assert.strictEqual(lb['good/model'].disclosure_kept,100);
    assert.ok(lb['good/model'].authenticity_risk!=null&&lb['good/model'].human_pct>=0&&lb['good/model'].human_pct<=100);
    assert.strictEqual(lb['skip/model'].skipped,items);assert.strictEqual(lb['bad/model'].failed,items);
    assert.strictEqual(s.leaderboard[0].model,'good/model','most picked first');

    // A failed model can be retried.
    const again=(await call(a,'POST',`/api/bench/${id}/resume`,{})).body;
    assert.strictEqual(again.status,'running');
    await until(a,id,v=>v.status==='done');
    assert.strictEqual((await call(a,'GET','/api/bench')).body.runs[0].name,'First test');
  }finally{a.close();}
});
