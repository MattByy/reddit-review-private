// Data for the hosted monitor page, read from the Supabase mirror (server/mirror.cjs).
// Needs an "Everything" (full) API key of the always-on computer; Supabase holds only their sha256
// hashes, mirrored every minute, so a key revoked there stops working here within a minute.
// GET /api/monitor             status, Queue 1, Queue 2 and the latest events
// GET /api/monitor?events=1&before=<id>&type=<prefix>   older events (100 per page)
const {createHash}=require('node:crypto');

module.exports=async(req,res)=>{
  const reply=(status,body)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(body));};
  const base=(process.env.SUPABASE_URL||'').replace(/\/+$/,''),key=process.env.SUPABASE_SERVICE_KEY;
  if(!base||!key)return reply(503,{error:'Not connected yet: set SUPABASE_URL and SUPABASE_SERVICE_KEY on this Vercel project.'});
  const db=async path=>{
    const r=await fetch(`${base}/rest/v1/${path}`,{headers:{apikey:key,Authorization:'Bearer '+key},signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw Error(`Supabase ${path.split('?')[0]}: HTTP ${r.status}`);
    return r.json();
  };
  try{
    const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim();
    if(!token)return reply(401,{error:'Sign in with an API key'});
    const hash=createHash('sha256').update(token).digest('hex');
    const [k]=await db(`api_keys?hash=eq.${hash}&revoked_at=is.null&select=name,scope`);
    if(!k)return reply(401,{error:'Unknown or revoked key'});
    if(k.scope!=='full')return reply(403,{error:'This page needs an "Everything" key; this one is "Prompts only"'});

    const q=new URL(req.url,'http://x').searchParams;
    const before=Number(q.get('before'))||null,type=(q.get('type')||'').replace(/[^\w.]/g,'');
    const eventsPath=`events?select=id,at,type,message,item_id,queue2_id&order=id.desc&limit=100${before?`&id=lt.${before}`:''}${type?`&type=like.${type}*`:''}`;
    if(q.get('events'))return reply(200,{events:await db(eventsPath)});
    const [status,queue1,queue2,events]=await Promise.all([
      db('status?id=eq.main&select=synced_at,data'),
      db('queue1?select=*&order=position.asc&limit=200'),
      db('queue2?select=*&order=id.desc&limit=300'),
      db(eventsPath),
    ]);
    reply(200,{by:k.name,status:status[0]||null,queue1,queue2,events});
  }catch(e){reply(502,{error:e.message});}
};
