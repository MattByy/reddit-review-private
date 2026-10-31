// Organizations: each one its own engine (database, Engain key, prompts, queues), added from the
// hosted page through the commands table. Mock Engain, a fake key check and a fake Supabase.
const test=require('node:test');
const assert=require('node:assert');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createApp}=require('../server/dev.cjs');
const {organizations}=require('../server/orgs.cjs');
const writer=require('../server/writer.cjs');

const DRAFT='A fair point; we see the same thing (I work at Geonode).';
const fakeModels=async()=>new Response(JSON.stringify({choices:[{message:{content:DRAFT},finish_reason:'stop'}]}),{status:200});
// Supabase: commands are served once from `list`; every other write is recorded.
function fakeSupabase(){
  const writes=[],done=[];let list=[];
  const fetchImpl=async(url,o)=>{
    if(o.method==='GET'&&url.includes('/commands?')){
      // The host engine reads its own commands and every org.* one; the others only their own.
      const host=/or=\(org\.eq\.([\w-]+),kind\.like\.org\.\*\)/.exec(url),own=/[?&]org=eq\.([\w-]+)/.exec(url);
      const r=list.filter(c=>host?c.org===host[1]||c.kind.startsWith('org.'):own?c.org===own[1]:false);
      list=list.filter(c=>!r.includes(c));return new Response(JSON.stringify(r),{status:200});
    }
    const m=/commands\?id=eq\.(\d+)/.exec(url);if(o.method==='PATCH'&&m)done.push({id:Number(m[1]),...JSON.parse(o.body)});
    writes.push({url,method:o.method,body:o.body?JSON.parse(o.body):null});
    return new Response('',{status:201});
  };
  return {fetchImpl,writes,done,push:c=>list.push({at:new Date().toISOString(),by:'matas',...c})};
}
function rig(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orgs-')),sb=fakeSupabase(),checked=[];
  const make=opts=>createApp({...opts,dbFile:opts.dbFile||':memory:',agentKey:'',cronSecret:'',openrouter:{apiKey:'k',featherlessKey:'k',fetchImpl:fakeModels}});
  const checkKey=async key=>{checked.push(key);if(key==='engain-bad-key')throw Error('HTTP 401');return [{id:'p_other',name:'Something else'},{id:'p_zen',name:'zenshield.io'}];};
  const orgs=organizations({createApp:make,dir,mock:true,supabase:{url:'https://x.supabase.co',key:'k',fetchImpl:sb.fetchImpl},log:()=>{},checkKey});
  return {dir,sb,orgs,checked,close:()=>{orgs.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
async function call(orgs,method,url,body){
  let status,out;const req=(async function*(){if(body)yield JSON.stringify(body);})();
  Object.assign(req,{method,url,socket:{remoteAddress:'127.0.0.1'},headers:{}});
  await orgs.handle(req,{writeHead(s){status=s;},end(v){out=JSON.parse(v);}});
  return {status,body:out};
}
const runCommands=orgs=>Promise.all([...orgs.engines.values()].map(a=>a.handle&&call({handle:a.handle},'POST','/api/cron/commands',{})));

test('adding an organization: key checked, own engine and database, Geonode prompts with its name, key kept off Supabase',async()=>{
  const r=rig();
  try{
    r.sb.push({id:1,org:'geonode',kind:'org.create',payload:{name:'Zenshield',about:'endpoint security for small teams',engain_key:'engain-zen-key-123',topic_terms:'antivirus, malware'}});
    await runCommands(r.orgs);
    const d=r.sb.done.find(x=>x.id===1);
    assert.strictEqual(d.status,'done',JSON.stringify(d));assert.strictEqual(d.result.slug,'zenshield');assert.strictEqual(d.result.project,'zenshield.io','the project named like the organization');
    assert.deepStrictEqual(r.checked,['engain-zen-key-123']);
    // The registry keeps the key, readable by the owner only.
    const file=path.join(r.dir,'orgs.json'),reg=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.strictEqual(reg.orgs[0].engain_key,'engain-zen-key-123');assert.strictEqual(fs.statSync(file).mode&0o777,0o600);
    // Its own engine and folder; prompts are Geonode's with its name and product.
    const zen=r.orgs.engines.get('zenshield');assert.ok(zen);
    assert.ok(fs.existsSync(path.join(r.dir,'orgs-mock','zenshield','dev.db')));
    const t=writer.variants(zen.store).thread[0].text;
    assert.match(t,/Zenshield/);assert.doesNotMatch(t,/Geonode/);assert.match(t,/endpoint security for small teams/);
    assert.strictEqual(zen.store.kv('org').name,'Zenshield');
    // The key never reaches Supabase: the command's payload is cut to the name, the log leaves it out.
    const scrub=r.sb.done.find(x=>x.id===1&&x.payload);assert.deepStrictEqual(scrub.payload,{slug:null,name:'Zenshield'});
    await r.orgs.engines.get('geonode').syncMirror();await zen.syncMirror();
    assert.ok(!JSON.stringify(r.sb.writes).includes('engain-zen-key-123'),'no Engain key in anything written to Supabase');
    // One row per request (PostgREST refuses a batch whose rows have different keys).
    const listed=r.sb.writes.filter(w=>w.url.endsWith('/organizations')).slice(-2).map(w=>w.body);
    assert.ok(listed.every(b=>b.length===1));assert.deepStrictEqual(listed.map(b=>b[0].slug),['geonode','zenshield']);
    // Rows from each engine carry its organization.
    assert.ok(r.sb.writes.some(w=>w.url.endsWith('/status')&&w.body[0].org==='zenshield'&&w.body[0].id==='zenshield'));
  }finally{r.close();}
});

test('a bad key or a taken name is refused; nothing is added',async()=>{
  const r=rig();
  try{
    r.sb.push({id:1,org:'geonode',kind:'org.create',payload:{name:'Zenshield',engain_key:'engain-bad-key'}});
    r.sb.push({id:2,org:'geonode',kind:'org.create',payload:{name:'Geonode',engain_key:'engain-zen-key-123'}});
    await runCommands(r.orgs);
    assert.match(r.sb.done.find(x=>x.id===1).result.error,/did not work: HTTP 401/);
    assert.match(r.sb.done.find(x=>x.id===2).result.error,/already an organization/);
    assert.deepStrictEqual([...r.orgs.engines.keys()],['geonode']);assert.ok(!fs.existsSync(path.join(r.dir,'orgs.json')));
  }finally{r.close();}
});

test('organizations keep separate queues; /o/<slug>/ reaches one; a new key restarts its engine; a restart brings them all back',async()=>{
  const r=rig();
  try{
    await r.orgs.host['org.create']({name:'Zenshield',engain_key:'engain-zen-key-123'},'matas');
    // Collect and draft in Geonode only.
    const c=await call(r.orgs,'POST','/api/collect',{max_pages:5});
    for(;;){const x=await call(r.orgs,'GET','/api/runs/'+c.body.run_id);if(x.body.finished_at)break;await new Promise(z=>setTimeout(z,20));}
    await call(r.orgs,'POST','/api/agent/task',{message:'Hi (I work at Geonode).'});
    assert.strictEqual((await call(r.orgs,'GET','/api/agent/queue2')).body.items.length,1);
    assert.strictEqual((await call(r.orgs,'GET','/o/zenshield/api/agent/queue2')).body.items.length,0,'Zenshield has its own Queue 2');
    assert.strictEqual((await call(r.orgs,'GET','/o/nope/api/agent/queue2')).status,404);
    // A new key: checked, saved, engine restarted with it.
    const before=r.orgs.engines.get('zenshield');
    await r.orgs.host['org.update']({slug:'zenshield',engain_key:'engain-zen-key-456',topic_terms:'firewall'},'matas');
    assert.notStrictEqual(r.orgs.engines.get('zenshield'),before);
    assert.deepStrictEqual(r.orgs.engines.get('zenshield').store.kv('org').topic_terms,['firewall']);
    // A fresh process (as after a restart) starts both again from the registry.
    r.orgs.close();
    const again=organizations({createApp:o=>createApp({...o,dbFile:o.dbFile||':memory:',agentKey:'',cronSecret:''}),dir:r.dir,mock:true,log:()=>{},checkKey:async()=>[]});
    try{assert.deepStrictEqual([...again.engines.keys()],['geonode','zenshield']);
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(r.dir,'orgs.json'),'utf8')).orgs[0].engain_key,'engain-zen-key-456');}
    finally{again.close();}
  }finally{fs.rmSync(r.dir,{recursive:true,force:true});}
});

test('without a key an organization uses Geonode\'s, on the project named like it; never Geonode\'s own project',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orgs-')),used=[];
  const projects=[{id:'p_geo',name:'geonode.com'},{id:'p_zen',name:'zenshield.com'},{id:'p_exp',name:'expedify.com'}];
  const orgs=organizations({createApp:o=>{used.push(o.apiKey);return createApp({...o,dbFile:o.dbFile||':memory:',agentKey:'',cronSecret:''});},dir,mock:true,log:()=>{},
    sharedKey:'engain-geonode-key',checkKey:async k=>{assert.strictEqual(k,'engain-geonode-key');return projects;}});
  try{
    const r=await orgs.host['org.create']({name:'Zenshield',engain_key:''},'matas');
    assert.strictEqual(r.project,'zenshield.com');assert.strictEqual(r.key,"Geonode's");
    const o=JSON.parse(fs.readFileSync(path.join(dir,'orgs.json'),'utf8')).orgs[0];
    assert.strictEqual(o.engain_key,null,'no copy of the shared key');assert.strictEqual(o.project_id,'p_zen');
    assert.strictEqual(used.at(-1),'engain-geonode-key','its engine uses Geonode\'s key');
    await assert.rejects(orgs.host['org.create']({name:'Acme'},'matas'),/no project named like Acme \(it has: geonode.com, zenshield.com, expedify.com\)/);
  }finally{orgs.close();fs.rmSync(dir,{recursive:true,force:true});}
});
