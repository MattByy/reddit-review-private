// Shared by the monitor functions: Supabase access and who is calling.
// A caller is signed in with the session cookie from /api/login, or sends an "Everything" API key
// of the always-on computer as a bearer token (its sha256 hash is mirrored to Supabase).
const {createHash}=require('node:crypto');

const sha256=s=>createHash('sha256').update(String(s)).digest('hex');
const ipOf=req=>String(req.headers['x-real-ip']||String(req.headers['x-forwarded-for']||'').split(',')[0]||'unknown').trim().slice(0,64);
const cookie=(req,name)=>{for(const p of String(req.headers.cookie||'').split(';')){const [k,...v]=p.trim().split('=');if(k===name)return decodeURIComponent(v.join('='));}return null;};
const SESSION='gn_session';

function supabase(){
  const base=(process.env.SUPABASE_URL||'').replace(/\/+$/,''),key=process.env.SUPABASE_SERVICE_KEY;
  if(!base||!key)return null;
  // db(path) reads; db(path,{method,body}) writes and returns the rows.
  return async(path,{method,body}={})=>{
    method=method||(body?'POST':'GET');
    const r=await fetch(`${base}/rest/v1/${path}`,{method,headers:{apikey:key,Authorization:'Bearer '+key,...(body?{'Content-Type':'application/json'}:{}),...(method!=='GET'?{Prefer:'return=representation'}:{})},
      body:body&&JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw Error(`Supabase ${method} ${path.split('?')[0]}: HTTP ${r.status}`);
    const text=await r.text();return text?JSON.parse(text):null;
  };
}

// Roles in an organization, lowest first. An owner (monitor_users.is_owner) is admin everywhere and
// may also add organizations and update or restart the server.
const ROLES=['viewer','editor','admin'];
const rank=r=>ROLES.indexOf(r);
// The least role each command needs. Anything not listed is refused.
const NEEDS={run:'editor',discard:'editor',requeue:'editor',batch:'editor',edit:'editor',fast:'editor',api:'viewer',
  settings:'admin','org.update':'admin',update:'owner',restart:'owner','org.create':'owner'};
const ORG_COOKIE='gn_org';
const SLUG=/^[a-z0-9][a-z0-9-]{0,39}$/;

// Who is calling and what they may use: {name, via, owner, scope, orgs:[{slug,name,role}]}, or null.
// - Signed in (session cookie): an owner gets every organization as admin; anyone else their memberships.
// - API key (mirrored from the computer): only the key's own organization, as admin for an "Everything"
//   key; a "Prompts only" key has scope 'prompts' and is good for the Prompts page only.
async function who(req,db){
  const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim();
  const all=async()=>(await db('organizations?select=slug,name,about,brand_terms,topic_terms,ready&order=created_at.asc')).filter(o=>o.ready!==false);
  if(token){
    const [k]=await db(`api_keys?hash=eq.${sha256(token)}&revoked_at=is.null&select=id,name,scope,prefix,org`);
    if(!k)return null;
    const org=(await all()).find(o=>o.slug===(k.org||'geonode'));
    return {name:'key:'+k.name,via:'key',key:k,owner:false,scope:k.scope==='full'?'full':'prompts',orgs:org?[{...org,role:'admin'}]:[]};
  }
  const s=cookie(req,SESSION);
  if(!s)return null;
  const [row]=await db(`monitor_sessions?token_hash=eq.${sha256(s)}&expires_at=gt.${new Date().toISOString()}&select=username`);
  if(!row)return null;
  const [u]=await db(`monitor_users?username=eq.${encodeURIComponent(row.username)}&select=username,is_owner`);
  const orgs=await all();
  if(u?.is_owner)return {name:row.username,via:'login',owner:true,scope:'full',orgs:orgs.map(o=>({...o,role:'admin'}))};
  const mine=new Map((await db(`org_members?username=eq.${encodeURIComponent(row.username)}&select=org,role`)).map(m=>[m.org,m.role]));
  return {name:row.username,via:'login',owner:false,scope:'full',orgs:orgs.filter(o=>mine.has(o.slug)).map(o=>({...o,role:mine.get(o.slug)}))};
}
// The organization a request is about: ?org=, else the gn_org cookie the monitor sets, else the first
// one this caller may use. Null when they may use none (or asked for one they may not).
function pickOrg(req,me){
  const asked=new URL(req.url,'http://x').searchParams.get('org')||cookie(req,ORG_COOKIE);
  if(asked&&SLUG.test(asked))return me.orgs.find(o=>o.slug===asked)||null;
  return me.orgs[0]||null;
}
// May this caller do `need` (a role, or 'owner') in this organization?
const allowed=(me,org,need)=>need==='owner'?!!me.owner:!!org&&rank(org.role)>=rank(need);

async function readJson(req){
  let body=req.body;
  if(body!=null&&typeof body==='object')return body;
  let raw=typeof body==='string'?body:'';
  if(!raw)for await(const c of req){raw+=c;if(raw.length>1e4)throw Object.assign(Error('Body too large'),{status:413});}
  try{return JSON.parse(raw||'{}');}catch{throw Object.assign(Error('Invalid JSON'),{status:400});}
}
const reply=(res,status,body,headers={})=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
  for(const [k,v] of Object.entries(headers))res.setHeader(k,v);res.end(JSON.stringify(body));};

module.exports={sha256,ipOf,cookie,SESSION,ORG_COOKIE,ROLES,NEEDS,SLUG,supabase,who,pickOrg,allowed,readJson,reply};
