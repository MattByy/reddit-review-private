// The hosted page's sign-in, organizations, roles and invites (vercel/prompts/api), against an
// in-memory stand-in for Supabase's REST API.
const test=require('node:test');
const assert=require('node:assert');
const {createHash,randomBytes,scryptSync}=require('node:crypto');

process.env.SUPABASE_URL='https://fake.supabase.co';process.env.SUPABASE_SERVICE_KEY='service';
const sha256=s=>createHash('sha256').update(String(s)).digest('hex');

// Enough of PostgREST for these functions: eq, gt, lt, is.null, like (*), select, order, limit;
// POST inserts (with defaults), PATCH and DELETE return the rows they touched.
function fakeDb(tables){
  let nextId=1;
  const match=(row,k,v)=>{
    const [op,...rest]=v.split('.'),val=decodeURIComponent(rest.join('.'));
    if(op==='eq')return String(row[k])===val;
    if(op==='gt')return row[k]!=null&&String(row[k])>val;
    if(op==='lt')return row[k]!=null&&Number(row[k])<Number(val);
    if(op==='is')return val==='null'?row[k]==null:String(row[k])===val;
    if(op==='like')return new RegExp('^'+val.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*')+'$').test(String(row[k]??''));
    throw Error('fake db: no operator '+op);
  };
  global.fetch=async(url,o={})=>{
    const u=new URL(url),table=u.pathname.replace('/rest/v1/','');const rows=tables[table]||(tables[table]=[]);
    const filters=[...u.searchParams].filter(([k])=>!['select','order','limit'].includes(k));
    const hit=r=>filters.every(([k,v])=>match(r,k,v));
    const json=b=>new Response(JSON.stringify(b),{status:200,headers:{'Content-Type':'application/json'}});
    if(o.method==='GET'||!o.method){
      let out=rows.filter(hit);const order=u.searchParams.get('order');
      if(order){const [c,d]=order.split('.');out=[...out].sort((a,b)=>(String(a[c])>String(b[c])?1:-1)*(d==='desc'?-1:1));}
      const lim=Number(u.searchParams.get('limit'));if(lim)out=out.slice(0,lim);
      return json(out.map(r=>({...r})));
    }
    if(o.method==='POST'){
      const add=[].concat(JSON.parse(o.body)).map(r=>({...(table==='commands'?{id:nextId++,status:'pending',at:new Date().toISOString(),org:'geonode'}:{}),...r}));
      if(table==='monitor_users'&&add.some(a=>rows.some(r=>r.username===a.username)))return new Response('{"message":"duplicate"}',{status:409});
      rows.push(...add);return json(add);
    }
    if(o.method==='PATCH'){const b=JSON.parse(o.body),out=rows.filter(hit);for(const r of out)Object.assign(r,b);return json(out);}
    if(o.method==='DELETE'){const out=rows.filter(hit);tables[table]=rows.filter(r=>!out.includes(r));return json(out);}
  };
  return tables;
}
const fns={monitor:require('../vercel/prompts/api/monitor.js'),orgs:require('../vercel/prompts/api/orgs.js'),invite:require('../vercel/prompts/api/invite.js'),forward:require('../vercel/prompts/api/forward.js')};
async function call(fn,method,url,{body,session,key,org}={}){
  const cookies=[session&&'gn_session='+session,org&&'gn_org='+org].filter(Boolean).join('; ');
  const req={method,url,body,headers:{host:'monitor.test','x-forwarded-proto':'https',...(cookies?{cookie:cookies}:{}),...(key?{authorization:'Bearer '+key}:{})}};
  let status,headers={},out='';
  const res={set statusCode(s){status=s;},get statusCode(){return status;},setHeader(k,v){headers[k.toLowerCase()]=v;},end(v){out=String(v??'');}};
  await fns[fn](req,res);
  let json=null;try{json=JSON.parse(out);}catch{}
  return {status,body:json??out,headers};
}
function world(){
  const later=new Date(Date.now()+86400e3).toISOString(),salt=randomBytes(16);
  const user=(username,is_owner=false)=>({username,salt:salt.toString('hex'),hash:scryptSync('password-'+username,salt,64).toString('hex'),is_owner});
  const t=fakeDb({
    organizations:[{slug:'geonode',name:'Geonode',ready:true,created_at:'2026-01-01'},{slug:'zenshield',name:'Zenshield',about:'endpoint security',ready:true,created_at:'2026-02-01'}],
    monitor_users:[user('matas',true),user('ana'),user('vik')],
    monitor_sessions:[{token_hash:sha256('s-matas'),username:'matas',expires_at:later},{token_hash:sha256('s-ana'),username:'ana',expires_at:later},{token_hash:sha256('s-vik'),username:'vik',expires_at:later}],
    org_members:[{org:'zenshield',username:'ana',role:'editor',added_at:'2026-02-02'},{org:'zenshield',username:'vik',role:'viewer',added_at:'2026-02-03'}],
    queue2:[{org:'geonode',id:1,message:'geo draft',send_status:'ready'},{org:'zenshield',id:1,message:'zen draft',send_status:'ready'}],
    queue1:[],events:[],commands:[],invites:[],status:[{id:'zenshield',org:'zenshield',synced_at:new Date().toISOString(),data:{}}],
    api_keys:[{id:'k1',name:'zen agent',scope:'full',prefix:'gnk_ab',hash:sha256('gnk_zen_full'),org:'zenshield',revoked_at:null},
      {id:'k2',name:'zen prompts',scope:'prompts',prefix:'gnk_cd',hash:sha256('gnk_zen_prompts'),org:'zenshield',revoked_at:null}],
    snapshots:[{org:'zenshield',key:'GET /api/prompts',type:'application/json',body:'{"who":"zen"}'},{org:'geonode',key:'GET /api/prompts',type:'application/json',body:'{"who":"geo"}'}],
  });
  return t;
}

test('each person sees only their organizations; the owner sees all',async()=>{
  world();
  let r=await call('monitor','GET','/api/monitor',{session:'s-matas'});
  assert.deepStrictEqual(r.body.you.orgs.map(o=>[o.slug,o.role]),[['geonode','admin'],['zenshield','admin']]);assert.strictEqual(r.body.org.slug,'geonode');
  assert.deepStrictEqual(r.body.queue2.map(q=>q.message),['geo draft']);
  r=await call('monitor','GET','/api/monitor?org=zenshield',{session:'s-matas'});assert.deepStrictEqual(r.body.queue2.map(q=>q.message),['zen draft']);
  r=await call('monitor','GET','/api/monitor',{session:'s-ana'});
  assert.deepStrictEqual(r.body.you.orgs.map(o=>o.slug),['zenshield']);assert.deepStrictEqual(r.body.queue2.map(q=>q.message),['zen draft'],'defaults to their only organization');
  assert.strictEqual((await call('monitor','GET','/api/monitor?org=geonode',{session:'s-ana'})).status,403);
  assert.strictEqual((await call('monitor','GET','/api/monitor',{session:'s-ana',org:'geonode'})).status,403,'the cookie cannot reach another organization either');
  assert.strictEqual((await call('monitor','GET','/api/monitor')).status,401);
  // An API key reaches only its own organization; a "Prompts only" key not the monitor at all.
  r=await call('monitor','GET','/api/monitor',{key:'gnk_zen_full'});assert.deepStrictEqual(r.body.you.orgs.map(o=>o.slug),['zenshield']);
  assert.strictEqual((await call('monitor','GET','/api/monitor?org=geonode',{key:'gnk_zen_full'})).status,403);
  assert.strictEqual((await call('monitor','GET','/api/monitor',{key:'gnk_zen_prompts'})).status,403);
});

test('commands need the right role and are tagged with the organization',async()=>{
  const t=world();
  const post=(who,kind,payload,org='zenshield')=>call('monitor','POST','/api/monitor?org='+org,{session:who,body:{kind,payload}});
  assert.strictEqual((await post('s-vik','batch',{action:'discard',queue2_ids:[1]})).status,403,'viewer: read only');
  assert.strictEqual((await post('s-ana','batch',{action:'discard',queue2_ids:[1]})).status,200,'editor: drafts');
  assert.strictEqual((await post('s-ana','edit',{queue2_id:1,message:'better words'})).status,200);
  const s=await post('s-ana','settings',{send_per_day:5});assert.strictEqual(s.status,403);assert.match(s.body.error,/admin role/);
  assert.strictEqual((await post('s-ana','update',{})).status,403,'only an owner updates the server');
  assert.strictEqual((await post('s-matas','settings',{send_per_day:5})).status,200);
  assert.strictEqual((await post('s-matas','update',{},'geonode')).status,200);
  assert.deepStrictEqual(t.commands.map(c=>[c.kind,c.org,c.by]),[['batch','zenshield','ana'],['edit','zenshield','ana'],['settings','zenshield','matas'],['update','geonode','matas']]);
});

test('invites: an admin makes a link; it makes an account and a membership once; withdrawn links stop working',async()=>{
  const t=world();
  assert.strictEqual((await call('orgs','POST','/api/orgs',{session:'s-ana',body:{action:'invite',org:'zenshield',role:'editor'}})).status,403,'an editor cannot invite');
  const inv=await call('orgs','POST','/api/orgs',{session:'s-matas',body:{action:'invite',org:'zenshield',role:'editor'}});
  assert.strictEqual(inv.status,200);assert.match(inv.body.link,/^https:\/\/monitor\.test\/invite\?t=[\w-]{20,}$/);
  const tok=new URL(inv.body.link).searchParams.get('t');
  assert.ok(!JSON.stringify(t.invites).includes(tok),'only the hash is stored');
  let r=await call('invite','GET','/api/invite?t='+tok);
  assert.deepStrictEqual([r.body.org.name,r.body.role,r.body.signed_in_as],['Zenshield','editor',null]);
  assert.strictEqual((await call('invite','POST','/api/invite',{body:{t:tok,username:'ana',password:'0123456789'}})).status,409,'a taken username is refused, nothing used');
  assert.strictEqual((await call('invite','POST','/api/invite',{body:{t:tok,username:'newbie',password:'short'}})).status,422);
  r=await call('invite','POST','/api/invite',{body:{t:tok,username:'Newbie',password:'a-long-password'}});
  assert.strictEqual(r.status,200,JSON.stringify(r.body));assert.strictEqual(r.body.username,'newbie');assert.match(r.headers['set-cookie'],/^gn_session=[\w-]+; Path=\/; HttpOnly; Secure; SameSite=Strict/);
  assert.ok(t.org_members.some(m=>m.org==='zenshield'&&m.username==='newbie'&&m.role==='editor'));
  const session=/gn_session=([\w-]+)/.exec(r.headers['set-cookie'])[1];
  assert.deepStrictEqual((await call('monitor','GET','/api/monitor',{session})).body.you.orgs.map(o=>o.slug),['zenshield'],'signed in, in their organization');
  assert.strictEqual((await call('invite','POST','/api/invite',{body:{t:tok,username:'other',password:'a-long-password'}})).status,404,'a link works once');
  // Someone signed in joins with their account; a lower role never replaces a higher one.
  const inv2=await call('orgs','POST','/api/orgs',{session:'s-matas',body:{action:'invite',org:'zenshield',role:'viewer'}});
  r=await call('invite','POST','/api/invite',{session:'s-ana',body:{t:new URL(inv2.body.link).searchParams.get('t')}});
  assert.strictEqual(r.body.role,'editor');assert.strictEqual(t.org_members.find(m=>m.username==='ana').role,'editor');
  // Withdrawn.
  const inv3=await call('orgs','POST','/api/orgs',{session:'s-matas',body:{action:'invite',org:'zenshield',role:'admin'}});
  const listed=(await call('orgs','GET','/api/orgs?org=zenshield',{session:'s-matas'})).body.invites;assert.strictEqual(listed.length,1);
  await call('orgs','POST','/api/orgs',{session:'s-matas',body:{action:'revoke_invite',org:'zenshield',id:listed[0].id}});
  assert.strictEqual((await call('invite','GET','/api/invite?t='+new URL(inv3.body.link).searchParams.get('t'))).status,404);
});

test('members: an admin changes roles and removes people; adding an organization is for owners, and its key is never shown back',async()=>{
  const t=world();
  t.org_members.push({org:'zenshield',username:'matas2',role:'admin'});t.monitor_users.push({username:'matas2'});
  t.monitor_sessions.push({token_hash:sha256('s-adm'),username:'matas2',expires_at:new Date(Date.now()+86400e3).toISOString()});
  assert.strictEqual((await call('orgs','POST','/api/orgs',{session:'s-adm',body:{action:'set_role',org:'zenshield',username:'vik',role:'editor'}})).status,200);
  assert.strictEqual(t.org_members.find(m=>m.username==='vik').role,'editor');
  assert.strictEqual((await call('orgs','POST','/api/orgs',{session:'s-adm',body:{action:'remove_member',org:'zenshield',username:'vik'}})).status,200);
  assert.ok(!t.org_members.some(m=>m.username==='vik'));
  assert.strictEqual((await call('orgs','POST','/api/orgs',{session:'s-adm',body:{action:'set_role',org:'geonode',username:'ana',role:'admin'}})).status,403,'not their organization');
  assert.strictEqual((await call('orgs','POST','/api/orgs',{session:'s-adm',body:{action:'create_org',name:'Acme',engain_key:'engain-acme-key'}})).status,403,'admins cannot add organizations');
  const c=await call('orgs','POST','/api/orgs',{session:'s-matas',body:{action:'create_org',name:'Acme',engain_key:'engain-acme-key',topic_terms:'anvils, rockets'}});
  assert.strictEqual(c.status,200);assert.deepStrictEqual(t.commands.at(-1).payload,{name:'Acme',engain_key:'engain-acme-key',about:'',topic_terms:'anvils, rockets',brand_terms:''});
  const g=await call('orgs','GET','/api/orgs?org=geonode',{session:'s-matas'});
  assert.ok(!JSON.stringify(g.body).includes('engain-acme-key'),'the key is not sent back to the page');
  assert.strictEqual((await call('orgs','POST','/api/orgs',{session:'s-adm',body:{action:'update_org',org:'zenshield',topic_terms:'malware'}})).status,200);
  assert.deepStrictEqual(t.commands.at(-1).payload,{slug:'zenshield',topic_terms:'malware'});
});

test('the Prompts page follows the chosen organization and the roles',async()=>{
  const t=world();
  let r=await call('forward','GET','/api/forward?p=/api/prompts',{session:'s-vik'});
  assert.deepStrictEqual(r.body,{who:'zen'});
  r=await call('forward','GET','/api/forward?p=/api/prompts',{session:'s-matas',org:'zenshield'});assert.deepStrictEqual(r.body,{who:'zen'});
  r=await call('forward','GET','/api/forward?p=/api/prompts',{session:'s-matas'});assert.deepStrictEqual(r.body,{who:'geo'});
  assert.strictEqual((await call('forward','POST','/api/forward?p=/api/prompt-variants',{session:'s-vik',body:{}})).status,403,'a viewer cannot change prompts');
  assert.strictEqual((await call('forward','GET','/api/forward?p=/api/keys',{session:'s-ana'})).status,403,'API keys need admin');
  assert.strictEqual((await call('forward','GET','/api/forward?p=/api/prompts',{key:'gnk_zen_prompts'})).body.who,'zen','a prompts key works for its organization');
  assert.strictEqual(t.commands.length,0);
});
