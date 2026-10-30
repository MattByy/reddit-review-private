// OpenRouter drafting, prompts and approve-to-send, with a fake OpenRouter and the mock Engain.
const test=require('node:test');
const assert=require('node:assert');
const {createApp}=require('../server/dev.cjs');
const writer=require('../server/writer.cjs'),{DEFAULT_PROMPTS}=writer;

const DRAFT='Rotating the exit IP per request usually gets past that kind of block (I work at Geonode).';
function fakeOpenRouter(reply=()=>({status:200,body:{choices:[{message:{content:DRAFT}}]}})){
  const calls=[];
  const fetchImpl=async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body),auth:opts.headers.Authorization});const r=reply(calls.length);
    return new Response(JSON.stringify(r.body),{status:r.status,headers:{'Content-Type':'application/json'}});};
  return {calls,fetchImpl};
}
// These tests are about OpenRouter, so the default prompts (MiniMax on Featherless) are switched to it.
const onOpenRouter=a=>{for(const t of ['thread','comment'])writer.updateVariant(a.store,'v_default_'+t,{provider:'openrouter'});return a;};
const app=(or,opts={})=>onOpenRouter(createApp({mock:true,dbFile:':memory:',log:()=>{},agentKey:'',cronSecret:'',openrouter:{apiKey:'test-or-key',...or},...opts}));
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
    assert.ok(q.prompt_used.includes('Thread title: '+r.thread.title));assert.ok(q.prompt_used.includes('r/'+r.thread.subreddit));
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
    assert.strictEqual(s.write_status,'skipped');assert.strictEqual(s.discarded,true);
    assert.ok(!(await call(a,'GET','/api/agent/queue2')).body.items.some(x=>x.queue2_id===s.queue2_id),'a SKIP is removed from Queue 2');
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
  off.engain.v2Accounts=async()=>{throw Object.assign(Error('Forbidden'),{status:403,body:{error:{code:'DEDICATED_ACCOUNTS_NOT_ENABLED'}}});};
  try{
    const b=(await call(off,'GET','/api/agent/beta-accounts')).body;
    assert.strictEqual(b.available,false);assert.match(b.reason,/DEDICATED_ACCOUNTS_NOT_ENABLED/);
  }finally{off.close();}
});

test('dedicated accounts (Engain v2): list, post a thread comment, once per thread, never replies',async()=>{
  const mock=require('../server/mock.cjs'),saved=mock.tasks.length;
  const or=fakeOpenRouter(),a=app({fetchImpl:or.fetchImpl});
  try{
    await ready(a);
    const b=(await call(a,'GET','/api/agent/beta-accounts')).body;
    assert.strictEqual(b.available,true);
    assert.deepStrictEqual(b.accounts.map(x=>[x.userAccountId,x.username,x.usable]),[['sn_mock_1','mockglen101',true],['sn_mock_2','mockrose202',true],['sn_mock_3',null,false],['sn_mock_4',null,false]]);

    const q=(await call(a,'POST','/api/agent/task',{write:true})).body.queue2;
    assert.strictEqual(q.status,'thread');
    let r=await call(a,'POST',`/api/agent/queue2/${q.queue2_id}/approve`,{mode:'dedicated',userAccountId:'sn_mock_1'});
    assert.strictEqual(r.status,200,JSON.stringify(r.body));
    const t=mock.tasks.at(-1);
    assert.strictEqual(t.postedFrom,'dedicated');assert.strictEqual(t.accountId,'sn_mock_1');assert.strictEqual(t.threadUrl,q.url);assert.strictEqual(t.content,q.message);
    assert.strictEqual(r.body.queue2.user_account_id,'sn_mock_1');
    assert.strictEqual((await call(a,'POST',`/api/agent/queue2/${q.queue2_id}/poll`,{})).body.engainStatus,'in_review','status comes from /api/v2/tasks/:id');

    // A second item in the same thread from the same account is refused by the v2 thread check.
    a.store.db.prepare(`insert into queue2(item_id,kind,thread_id,url,thread_url,title,message,message_source,item,created_at,updated_at)
      values('t_dup','thread',?,?,?,'dup','Disclosure: I work at Geonode. Another note.','given','{}',datetime('now'),datetime('now'))`).run(q.item.thread.id,q.url,q.thread_url);
    const dup=a.store.db.prepare("select id from queue2 where item_id='t_dup'").get().id;
    r=await call(a,'POST',`/api/agent/queue2/${dup}/approve`,{mode:'dedicated',userAccountId:'sn_mock_1'});
    assert.strictEqual(r.status,409);assert.match(r.body.error,/already has 1 comment/);
    assert.strictEqual((await call(a,'POST',`/api/agent/queue2/${dup}/retry`,{})).status,200,'the refused item goes back to Queue 2');
    r=await call(a,'POST',`/api/agent/queue2/${dup}/approve`,{mode:'dedicated',userAccountId:'sn_mock_2'});
    assert.strictEqual(r.status,200,'another account may comment');

    // Replies (comment items) cannot come from a dedicated account.
    let c;for(let i=0;i<10;i++){c=(await call(a,'POST','/api/agent/task',{write:true})).body;if(c.status==='comment')break;}
    assert.strictEqual(c.status,'comment');
    r=await call(a,'POST',`/api/agent/queue2/${c.queue2.queue2_id}/approve`,{mode:'dedicated',userAccountId:'sn_mock_1'});
    assert.strictEqual(r.status,422);assert.match(r.body.error,/cannot post replies/);
  }finally{mock.tasks.splice(saved);a.close();}
});

test('approve routes automatically: pool and our accounts take turns in a thread',async()=>{
  const mock=require('../server/mock.cjs'),saved=mock.tasks.length;
  const a=app({fetchImpl:fakeOpenRouter().fetchImpl});
  const add=(kind,n,k=kind[0])=>{a.store.db.prepare(`insert into queue2(item_id,kind,thread_id,url,thread_url,title,message,message_source,item,created_at,updated_at)
      values(?,?,?,?,?,'t','Disclosure: I work at Geonode. A useful note.','given','{}',datetime('now'),datetime('now'))`)
      .run(k+'_auto'+n,kind,'auto'+n,`https://www.reddit.com/r/proxies/comments/auto${n}/`+(kind==='thread'?'':`x/c${n}/`),`https://www.reddit.com/r/proxies/comments/auto${n}/`);
    return a.store.db.prepare('select id from queue2 where item_id=?').get(k+'_auto'+n).id;};
  // Our earlier post in thread autoN, as Engain's task list has it.
  const had=(n,from,verdict='approved',status='published')=>a.store.saveTask({task_id:`had_${n}_${from}_${verdict}`,type:'comment',status,verdict,thread_id:'auto'+n,
    thread_url:`https://www.reddit.com/r/proxies/comments/auto${n}/`,posted_from:from,created_at:'2026-01-01T00:00:00Z'});
  const waiting=async id=>(await call(a,'GET','/api/agent/queue2?status=all')).body.items.find(x=>x.queue2_id===id);
  try{
    // Nothing of ours in the thread: the first post comes from one of our accounts.
    let q=add('thread',1);
    assert.deepStrictEqual((await waiting(q)).next_delivery,{first:null,next:'dedicated',posts:0});
    let r=await call(a,'POST',`/api/agent/queue2/${q}/approve`,{});
    assert.strictEqual(r.status,200,JSON.stringify(r.body));
    assert.ok(['sn_mock_1','sn_mock_2'].includes(r.body.account.id));assert.strictEqual(r.body.queue2.delivery_mode,'beta');
    const chosen=(await call(a,'GET','/api/logs?queue2_id='+q)).body.items.find(e=>e.type==='delivery.chosen');
    assert.match(chosen.message,/nothing of ours in this thread yet, so this one goes via our accounts/);

    // That send counts before Engain's task list has it: the follow-up reply goes through the pool.
    q=add('comment',1);
    assert.deepStrictEqual((await waiting(q)).next_delivery,{first:'dedicated',next:'pool',posts:1});
    r=await call(a,'POST',`/api/agent/queue2/${q}/approve`,{});
    assert.strictEqual(r.status,200,JSON.stringify(r.body));assert.strictEqual(r.body.queue2.delivery_mode,'pool');assert.strictEqual(mock.tasks.at(-1).type,'reply');

    // Started from the pool: a random ready account of ours.
    const used=new Set();
    for(let n=10;n<30;n++){
      had(n,'pool');
      r=await call(a,'POST',`/api/agent/queue2/${add('thread',n)}/approve`,{});
      assert.strictEqual(r.status,200,JSON.stringify(r.body));
      assert.ok(['sn_mock_1','sn_mock_2'].includes(r.body.account.id),'only ready accounts');
      assert.strictEqual(mock.tasks.at(-1).postedFrom,'dedicated');assert.strictEqual(mock.tasks.at(-1).accountId,r.body.account.id);
      assert.strictEqual(r.body.queue2.delivery_mode,'beta');assert.strictEqual(r.body.queue2.user_account_id,r.body.account.id);
      used.add(r.body.account.id);
    }
    assert.strictEqual(used.size,2,'the account is chosen at random');

    // Started from our accounts: the pool.
    had(40,'dedicated');
    r=await call(a,'POST',`/api/agent/queue2/${add('thread',40)}/approve`,{});
    assert.strictEqual(r.body.account,null);assert.strictEqual(r.body.queue2.delivery_mode,'pool');
    // A cancelled or failed task never reached Reddit, so it does not count; a removed one does.
    had(41,'dedicated','cancelled','cancelled');had(41,'pool','approved');
    assert.strictEqual((await waiting(add('thread',41))).next_delivery.first,'pool');
    had(42,'dedicated','disapproved','mod_removed');
    assert.strictEqual((await waiting(add('thread',42))).next_delivery.next,'pool');

    // A reply in a thread our accounts started goes through the pool.
    had(50,'dedicated');
    r=await call(a,'POST',`/api/agent/queue2/${add('comment',50)}/approve`,{});
    assert.strictEqual(r.status,200,JSON.stringify(r.body));
    assert.strictEqual(r.body.account,null);assert.strictEqual(r.body.queue2.delivery_mode,'pool');assert.strictEqual(mock.tasks.at(-1).type,'reply');
    // A reply in a thread the pool started is our accounts' turn, and they cannot reply: nothing is sent.
    had(51,'pool');const sentBefore=mock.tasks.length,c=add('comment',51);
    r=await call(a,'POST',`/api/agent/queue2/${c}/approve`,{});
    assert.strictEqual(r.status,409);assert.match(r.body.error,/does not let your own accounts post replies/);
    assert.strictEqual(mock.tasks.length,sentBefore,'nothing reached Engain');
    let e=await waiting(c);assert.strictEqual(e.send_status,'failed','moved to the send log');assert.strictEqual(e.approved_at,null);

    // In a thread where sn_mock_1 already commented, only sn_mock_2 can be picked; when both have, nothing is sent.
    had(100,'pool');const t1=add('thread',100);
    mock.tasks.push({_id:'pre1',accountId:'sn_mock_1',threadUrl:'https://www.reddit.com/r/proxies/comments/auto100/',status:'published'});
    for(let i=0;i<5;i++){
      if(i){a.store.db.prepare("update queue2 set send_status='ready',approved_at=null,engain_task_id=null where id=?").run(t1);mock.tasks.splice(mock.tasks.findIndex(t=>t.postedFrom==='dedicated'&&t.threadUrl.includes('auto100')),1);}
      r=await call(a,'POST',`/api/agent/queue2/${t1}/approve`,{});
      assert.strictEqual(r.body.account.id,'sn_mock_2');
    }
    had(200,'pool');const t2=add('thread',200);
    for(const id of ['sn_mock_1','sn_mock_2'])mock.tasks.push({_id:'pre_'+id,accountId:id,threadUrl:'https://www.reddit.com/r/proxies/comments/auto200/',status:'published'});
    r=await call(a,'POST',`/api/agent/queue2/${t2}/approve`,{});
    assert.strictEqual(r.status,409);assert.match(r.body.error,/All 2 of your ready accounts already commented/);
    e=await waiting(t2);
    assert.strictEqual(e.send_status,'failed','moved to the send log');assert.strictEqual(e.approved_at,null,'not marked approved when nothing was sent');

    // No accounts available: nothing is sent.
    a.engain.v2Accounts=async()=>{throw Object.assign(Error('Forbidden'),{status:403});};
    had(400,'pool');const t3=add('thread',400);
    r=await call(a,'POST',`/api/agent/queue2/${t3}/approve`,{});
    assert.strictEqual(r.status,409);assert.match(r.body.error,/not available/);
    e=await waiting(t3);
    assert.strictEqual(e.send_status,'failed');assert.strictEqual(e.approved_at,null);
  }finally{mock.tasks.splice(saved);a.close();}
});

test('prompt variants: visible per type, editable, validated to 100%',async()=>{
  const a=app({fetchImpl:fakeOpenRouter().fetchImpl});
  try{
    const p=(await call(a,'GET','/api/prompts')).body;
    assert.deepStrictEqual(Object.keys(p.variants),['thread','comment','mention']);
    for(const k of ['thread','comment','mention']){
      assert.deepStrictEqual(p.variants[k].map(v=>[v.name,v.weight]),[['Default',100]]);
      assert.strictEqual(p.variants[k][0].text,DEFAULT_PROMPTS[k]);
      // Replies recommend Geonode, so they say so; the comment only asks which tools people use.
      if(k!=='thread')assert.ok(/I work (at|for) Geonode/.test(p.variants[k][0].text));
    }
    assert.strictEqual(p.openrouter_key,true);assert.ok(p.variables.comment.includes('our_comment'));
    const bad=async(v,re)=>{const r=await call(a,'POST','/api/prompts',v);assert.strictEqual(r.status,422,JSON.stringify(r.body));assert.match(r.body.error,re);};
    await bad({type:'thread',variants:[{name:'A',text:'x',weight:60},{name:'B',text:'y',weight:30}]},/add up to 90%/);
    await bad({type:'nope',variants:[{text:'x',weight:100}]},/type must be/);
    await bad({type:'thread',variants:[]},/at least one/);
    await bad({type:'thread',variants:[{name:'A',text:'  ',weight:100}]},/text is required/);
    await bad({type:'thread',variants:[{name:'A',text:'x',weight:50.5},{text:'y',weight:49.5}]},/whole number/);
    const r=(await call(a,'POST','/api/prompts',{type:'comment',variants:[{name:'Short',text:'S {{our_comment}}',weight:20},{name:'Detail',text:'D {{our_comment}}',weight:20},{name:'Question',text:'Q',weight:60}]})).body;
    assert.deepStrictEqual(r.variants.map(v=>[v.name,v.weight]),[['Short',20],['Detail',20],['Question',60]]);
    assert.ok(r.variants.every(v=>/^v_/.test(v.id)));
    const after=(await call(a,'GET','/api/prompts')).body.variants;
    assert.strictEqual(after.comment.length,3);assert.strictEqual(after.thread[0].name,'Default','other types untouched');
  }finally{a.close();}
});

test('drafts follow the percentages exactly: 60/40 over 10 threads is 6 and 4, rewrites keep their prompt',async()=>{
  const a=app({fetchImpl:fakeOpenRouter().fetchImpl});
  const add=n=>{a.store.db.prepare(`insert into queue2(item_id,kind,thread_id,url,thread_url,title,message,message_source,item,created_at,updated_at)
      values(?,'thread',?,?,?,'t','Placeholder message: x','random','{}',datetime('now'),datetime('now'))`).run('t_split'+n,'split'+n,`https://www.reddit.com/r/x/comments/split${n}/`,`https://www.reddit.com/r/x/comments/split${n}/`);
    return a.store.db.prepare('select id from queue2 where item_id=?').get('t_split'+n).id;};
  try{
    await call(a,'POST','/api/prompts',{type:'thread',variants:[{name:'Helpful',text:'H {{title}} I work at Geonode',weight:60},{name:'Brief',text:'B {{title}} I work at Geonode',weight:40}]});
    const ids=[];for(let n=0;n<10;n++){ids.push(add(n));await call(a,'POST',`/api/agent/queue2/${ids.at(-1)}/write`,{});}
    const names=(await call(a,'GET','/api/agent/queue2')).body.items.map(x=>x.prompt_variant_name);
    assert.deepStrictEqual({Helpful:names.filter(n=>n==='Helpful').length,Brief:names.filter(n=>n==='Brief').length},{Helpful:6,Brief:4});
    const e=(await call(a,'GET','/api/agent/queue2')).body.items.find(x=>x.queue2_id===ids[0]);
    assert.match(e.prompt_used,/^H /);
    for(let i=0;i<3;i++)await call(a,'POST',`/api/agent/queue2/${ids[0]}/write`,{});
    const again=(await call(a,'GET','/api/prompts')).body.stats.thread;
    assert.deepStrictEqual(again.prompts.map(p=>[p.name,p.weight,p.drafted,p.share_of_drafts]),[['Helpful',60,6,60],['Brief',40,4,40]],'rewrites did not change the split');

    // Changing the weights steers new drafts toward the new target.
    await call(a,'POST','/api/prompts',{type:'thread',variants:[{id:again.prompts[0].id,name:'Helpful',text:'H {{title}} I work at Geonode',weight:20},{id:again.prompts[1].id,name:'Brief',text:'B {{title}} I work at Geonode',weight:80}]});
    for(let n=10;n<20;n++)await call(a,'POST',`/api/agent/queue2/${add(n)}/write`,{});
    const s2=(await call(a,'GET','/api/prompts')).body.stats.thread.prompts;
    assert.deepStrictEqual(s2.map(p=>p.drafted),[6,14],'20 drafts at 20/80 overall gives 4/16; the 6 already done stay, so new ones all went to Brief until it caught up');
  }finally{a.close();}
});

test('per-prompt stats count what was sent, published and removed, including deleted prompts',async()=>{
  const mock=require('../server/mock.cjs'),saved=JSON.parse(JSON.stringify(mock.tasks));
  const a=app({fetchImpl:fakeOpenRouter().fetchImpl});
  try{
    await call(a,'POST','/api/prompts',{type:'thread',variants:[{name:'A',text:'A {{title}} I work at Geonode',weight:50},{name:'B',text:'B {{title}} I work at Geonode',weight:50}]});
    await ready(a);
    const sent=[];
    for(let i=0;i<4;i++){
      const q=(await call(a,'POST','/api/agent/task',{write:true})).body.queue2;
      const r=await call(a,'POST',`/api/agent/queue2/${q.queue2_id}/approve`,{mode:'dedicated',userAccountId:'sn_mock_1'});
      assert.strictEqual(r.status,200,JSON.stringify(r.body));sent.push({task:r.body.taskId,name:q.prompt_variant_name});
    }
    // Engain publishes the A messages and moderators remove one B message.
    for(const s of sent){const t=mock.tasks.find(t=>t._id===s.task);
      if(s.name==='A'){t.status='published';t.redditUrl='https://www.reddit.com/r/x/comments/1/x/'+s.task+'/';}
      else if(!sent.some(o=>o.name==='B'&&o.removed)){t.status='mod_removed';s.removed=true;}}
    const job=(await call(a,'POST','/api/cron/comments',{})).body;
    assert.strictEqual(job.action,'checked');
    const st=(await call(a,'GET','/api/prompts')).body.stats.thread;
    assert.deepStrictEqual(st.prompts.map(p=>[p.name,p.drafted,p.sent,p.published,p.removed,p.failed,p.cancelled,p.pending]),[['A',2,2,2,0,0,0,0],['B',2,2,0,1,0,0,1]]);
    assert.strictEqual(st.prompts[0].share_of_published,100);assert.strictEqual(st.prompts[0].publish_rate,100);assert.strictEqual(st.prompts[1].publish_rate,0);
    const q2=(await call(a,'GET','/api/agent/queue2')).body.items.filter(x=>x.prompt_variant_name==='A');
    assert.ok(q2.every(x=>x.send_status==='published'&&x.reddit_url),'Queue 2 items follow Engain');

    await call(a,'POST','/api/prompts',{type:'thread',variants:[{name:'C',text:'C I work at Geonode',weight:100}]});
    const after=(await call(a,'GET','/api/prompts')).body.stats.thread.prompts;
    assert.deepStrictEqual(after.map(p=>[p.name,p.deleted,p.drafted]),[['C',false,0],['A',true,2],['B',true,2]]);
  }finally{mock.tasks.splice(0,mock.tasks.length,...saved);a.close();}
});

test('an edited prompt is exactly what the model receives',async()=>{
  const or=fakeOpenRouter(),a=app({fetchImpl:or.fetchImpl});
  try{
    await call(a,'POST','/api/prompts',{type:'thread',variants:[{name:'Custom',text:'Custom prompt for r/{{subreddit}} about "{{title}}". Disclose: I work at Geonode.',weight:100}]});
    await ready(a);
    const q=(await call(a,'POST','/api/agent/task',{write:true})).body.queue2;
    assert.match(q.prompt_used,/^Custom prompt for r\/\w+ about "/);
    assert.strictEqual(or.calls.at(-1).body.messages[0].content,q.prompt_used);
    assert.strictEqual(q.prompt_variant_name,'Custom');
  }finally{a.close();}
});

test('writing without an OpenRouter key fails clearly',async()=>{
  const a=onOpenRouter(createApp({mock:true,dbFile:':memory:',log:()=>{},agentKey:'',cronSecret:'',openrouter:{apiKey:''}}));
  try{
    await ready(a);
    const id=(await call(a,'POST','/api/agent/task',{})).body.queue2.queue2_id;
    const r=await call(a,'POST',`/api/agent/queue2/${id}/write`,{});
    assert.strictEqual(r.status,503);assert.match(r.body.error,/OPENROUTER_API_KEY/);
  }finally{a.close();}
});

test('a send leaves Queue 2: OK ones go to Sent, failures to the send log, and Retry brings them back',async()=>{
  const or=fakeOpenRouter(),a=app({fetchImpl:or.fetchImpl});
  try{
    await ready(a);
    const accts=(await call(a,'GET','/api/agent/beta-accounts')).body.accounts;
    assert.strictEqual(accts.find(x=>x.userAccountId==='sn_mock_4').usable,false,'a refunded account is not usable');
    const waiting=async()=>(await call(a,'GET','/api/agent/queue2')).body.items.map(x=>x.queue2_id);
    let t;do{t=(await call(a,'POST','/api/agent/task',{write:true})).body;}while(t.status!=='thread');
    const bad=t.queue2.queue2_id;
    let r=await call(a,'POST',`/api/agent/queue2/${bad}/approve`,{mode:'dedicated',userAccountId:'sn_mock_4'});
    assert.strictEqual(r.status,400);assert.match(r.body.error,/not ready for commenting/);
    assert.ok(!(await waiting()).includes(bad),'a failed send leaves Queue 2');
    let log=(await call(a,'GET','/api/send-log?result=failed')).body;
    const f=log.items.find(x=>x.queue2_id===bad);
    assert.strictEqual(f.http_status,400);assert.strictEqual(f.response.code,'VALIDATION_ERROR');assert.strictEqual(f.now,'failed');assert.strictEqual(f.can_retry,true);
    assert.strictEqual(f.request.account,'sn_mock_4');assert.ok(f.message);

    const back=(await call(a,'POST',`/api/agent/queue2/${bad}/retry`,{})).body;
    assert.strictEqual(back.send_status,'ready');assert.strictEqual(back.approved_at,null);
    assert.ok((await waiting()).includes(bad),'Retry puts it back in Queue 2');

    // The pool already posted in this thread, so the automatic choice is one of our accounts.
    const tid=a.store.queue2(bad).thread_id;
    a.store.saveTask({task_id:'pool_'+tid,type:'comment',status:'published',verdict:'approved',thread_id:tid,posted_from:'pool',created_at:'2026-01-01T00:00:00Z'});
    r=await call(a,'POST',`/api/agent/queue2/${bad}/approve`,{});
    assert.strictEqual(r.status,200,JSON.stringify(r.body));assert.notStrictEqual(r.body.account.id,'sn_mock_4','the picker never uses a refunded account');
    assert.ok(!(await waiting()).includes(bad),'a submitted item leaves Queue 2');
    assert.ok((await call(a,'GET','/api/sent?days=0')).body.items.some(x=>x.queue2_id===bad),'and is tracked on the Sent list');
    log=(await call(a,'GET','/api/send-log')).body;
    assert.strictEqual(log.items[0].queue2_id,bad);assert.strictEqual(log.items[0].result,'ok');assert.ok(log.items[0].task_id);
    assert.ok((await call(a,'GET','/api/agent/queue2?status=all')).body.items.some(x=>x.queue2_id===bad),'status=all still lists it');
  }finally{a.close();}
});

test('prompts have unique, editable slugs that every draft records',async()=>{
  const or=fakeOpenRouter(),a=app({fetchImpl:or.fetchImpl});
  try{
    let p=(await call(a,'GET','/api/prompts')).body.variants;
    assert.deepStrictEqual([p.thread[0].slug,p.comment[0].slug,p.mention[0].slug],['thread-default','comment-default','mention-default']);
    const n=(await call(a,'POST','/api/prompt-variants',{type:'thread',name:'Natural 2',style:'natural'})).body.variant;
    assert.strictEqual(n.slug,'thread-natural-2','made from the type and name');
    const same=(await call(a,'POST','/api/prompt-variants',{type:'thread',name:'Natural 2'})).body.variant;
    assert.strictEqual(same.slug,'thread-natural-2-2','unique');
    const renamed=(await call(a,'POST','/api/prompt-variants/'+n.id,{name:'Casual'})).body.variant;
    assert.strictEqual(renamed.slug,'thread-natural-2','kept through a rename');
    assert.strictEqual((await call(a,'POST','/api/prompt-variants/'+n.id,{slug:'Bad Slug!'})).status,422);
    assert.strictEqual((await call(a,'POST','/api/prompt-variants/'+n.id,{slug:'comment-default'})).status,422,'unique across types');
    assert.strictEqual((await call(a,'POST','/api/prompt-variants/'+n.id,{slug:'thread-casual'})).body.variant.slug,'thread-casual');
    assert.strictEqual((await call(a,'GET','/api/prompt-variants/thread-casual')).body.variant.id,n.id,'found by slug');
    await call(a,'POST','/api/prompts/weights',{type:'thread',weights:{'thread-casual':100}});

    await ready(a);
    const q=(await call(a,'POST','/api/agent/task',{write:true})).body.queue2;
    assert.strictEqual(q.prompt_variant_slug,'thread-casual');assert.strictEqual(q.prompt_variant_name,'Casual');
    const st=(await call(a,'GET','/api/prompts')).body.stats.thread.prompts.find(r=>r.id===n.id);
    assert.strictEqual(st.slug,'thread-casual');assert.strictEqual(st.drafted,1);
  }finally{a.close();}
});

test('a published comment comes back into Queue 1 with where it came from',async()=>{
  const mock=require('../server/mock.cjs'),saved=JSON.parse(JSON.stringify(mock.tasks));
  const or=fakeOpenRouter(),a=app({fetchImpl:or.fetchImpl});
  try{
    await ready(a);
    let t;do{t=(await call(a,'POST','/api/agent/task',{write:true})).body;}while(t.status!=='thread');
    const id=t.queue2.queue2_id;
    const sent=(await call(a,'POST',`/api/agent/queue2/${id}/approve`,{})).body;
    assert.ok(sent.taskId);
    let o=(await call(a,'GET','/api/agent/origin/'+sent.taskId)).body;
    assert.strictEqual(o.queue2_id,id);assert.strictEqual(o.item_id,t.task_id);assert.strictEqual(o.prompt.slug,'thread-default');
    assert.strictEqual(o.model,'anthropic/claude-sonnet-5.5');assert.strictEqual(o.delivery,'dedicated');assert.ok(o.sent_at);assert.strictEqual(o.thread_url,t.queue2.thread_url);
    assert.strictEqual((await call(a,'GET','/api/agent/origin/nope')).status,404);

    // Engain publishes it; the comments job brings it back into Queue 1 carrying its origin.
    Object.assign(mock.tasks.find(x=>(x._id||x.id)===sent.taskId),{status:'published',redditUrl:t.queue2.url+'ours_origin/',publishedAt:new Date().toISOString(),parentTaskId:null,labels:[]});
    await call(a,'POST','/api/cron/comments',{});
    const pub=(await call(a,'GET','/api/published')).body.find(x=>x.task_id===sent.taskId);
    assert.ok(pub,'collected as our published comment');assert.strictEqual(pub.origin.queue2_id,id);assert.strictEqual(pub.origin.prompt.slug,'thread-default');
    const item=(await call(a,'GET','/api/queue')).body.items.find(x=>x.kind==='comment'&&x.comment_id===sent.taskId);
    assert.ok(item,'back in Queue 1');assert.strictEqual(item.comment.origin.prompt.slug,'thread-default');assert.strictEqual(item.comment.origin.item_id,t.task_id);
    assert.ok(item.comment.origin.history.length>=1);
  }finally{mock.tasks.splice(0,mock.tasks.length,...saved);a.close();}
});

test('follow-ups only under comments from our own accounts',async()=>{
  const queue=require('../server/queue.cjs'),a=app({fetchImpl:fakeOpenRouter().fetchImpl});
  try{
    const now=new Date().toISOString();
    for(const from of ['pool','dedicated'])a.store.saveTask({task_id:'fu_'+from,type:'comment',status:'published',verdict:'approved',posted_from:from,thread_id:'fu'+from,
      reddit_url:`https://www.reddit.com/r/proxies/comments/fu${from}/x/c/`,thread_url:`https://www.reddit.com/r/proxies/comments/fu${from}/x/`,published_at:now,created_at:now,labels:[]});
    const ev=queue.evaluate(a.store);
    assert.deepStrictEqual(ev.publishedById.fu_dedicated.eligibility,{queueable:true,reasons:[]});
    assert.strictEqual(ev.publishedById.fu_pool.eligibility.queueable,false);
    assert.match(ev.publishedById.fu_pool.eligibility.reasons.join(),/only comments from your own accounts get a follow-up/);
    // Our accounts' tasks come without publishedAt: created after the fresh start counts, created before does not.
    queue.setCommentsSince(a.store,new Date(Date.now()-3600000).toISOString());
    for(const [id,created] of [['fu_new',now],['fu_old','2026-09-27T15:26:46Z']])a.store.saveTask({task_id:id,type:'comment',status:'published',verdict:'approved',posted_from:'dedicated',thread_id:id,
      reddit_url:`https://www.reddit.com/r/proxies/comments/${id}/x/c/`,published_at:null,created_at:created,labels:[]});
    const ev2=queue.evaluate(a.store);
    assert.deepStrictEqual(ev2.publishedById.fu_new.eligibility,{queueable:true,reasons:[]});
    assert.match(ev2.publishedById.fu_old.eligibility.reasons.join(),/before the fresh start/);
  }finally{a.close();}
});
