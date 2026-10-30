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

// {name, via} or null. A "Prompts only" key is refused with forbidden:true.
async function who(req,db){
  const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim();
  if(token){
    const [k]=await db(`api_keys?hash=eq.${sha256(token)}&revoked_at=is.null&select=name,scope`);
    if(!k)return null;
    return k.scope==='full'?{name:k.name,via:'key'}:{forbidden:true};
  }
  const s=cookie(req,SESSION);
  if(!s)return null;
  const [row]=await db(`monitor_sessions?token_hash=eq.${sha256(s)}&expires_at=gt.${new Date().toISOString()}&select=username`);
  return row?{name:row.username,via:'login'}:null;
}

async function readJson(req){
  let body=req.body;
  if(body!=null&&typeof body==='object')return body;
  let raw=typeof body==='string'?body:'';
  if(!raw)for await(const c of req){raw+=c;if(raw.length>1e4)throw Object.assign(Error('Body too large'),{status:413});}
  try{return JSON.parse(raw||'{}');}catch{throw Object.assign(Error('Invalid JSON'),{status:400});}
}
const reply=(res,status,body,headers={})=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
  for(const [k,v] of Object.entries(headers))res.setHeader(k,v);res.end(JSON.stringify(body));};

module.exports={sha256,ipOf,cookie,SESSION,supabase,who,readJson,reply};
