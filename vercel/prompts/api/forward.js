// The Prompts page and its API on Vercel. Only the prompt routes pass.
// With PROMPTS_SERVER_URL set (a tunnel to the always-on computer), calls are forwarded there and the
// server checks the API key. Without it, everything goes through Supabase: pages and reads come from
// the snapshots the computer uploads, and changes become "api" commands that the computer applies
// within a few seconds (server/dev.cjs applyCommand). Then the caller must be signed in on the monitor
// (session cookie) or send an API key; "Prompts only" keys are enough here. It is about the organization
// the monitor has chosen (gn_org cookie) or ?org=; reading needs viewer, changing prompts editor, and
// managing API keys admin (lib/auth.js).
const {supabase,who,pickOrg,allowed,readJson}=require('../lib/auth.js');
const ALLOW=/^\/(prompts|docs\/prompts-api|api\/(prompts(\/[\w-]+)?|prompt-variants(\/[\w-]+(\/delete)?)?|models|keys(\/me|\/[\w-]+\/revoke)?))$/;
const PASS=['authorization','content-type','accept'];
const PAGES=new Set(['/prompts','/docs/prompts-api']),SNAPSHOT=new Set(['/api/prompts','/api/keys','/api/models']);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

module.exports=async(req,res)=>{
  const u=new URL(req.url,'http://x'),path=u.searchParams.get('p')||'/prompts';u.searchParams.delete('p');
  const page=!path.startsWith('/api/');
  const reply=(status,body)=>{res.statusCode=status;res.setHeader('Cache-Control','no-store');
    if(page){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prompts</title><body style="font:15px system-ui;max-width:560px;margin:60px auto;padding:0 16px;color:#1c1917"><h2>Prompts</h2><p>${body}</p><p><a href="/">← Monitor</a></p></body>`);}
    else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:body}));}};
  if(!ALLOW.test(path))return reply(404,'Not found');
  const base=(process.env.PROMPTS_SERVER_URL||'').replace(/\/+$/,'');
  if(!base)return viaSupabase(req,res,path,u,page,reply);
  const headers={'x-forwarded-for':String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'vercel'),'ngrok-skip-browser-warning':'1'};
  for(const h of PASS)if(req.headers[h])headers[h]=req.headers[h];
  let body;
  if(req.method==='POST'){const chunks=[];for await(const c of req)chunks.push(c);body=Buffer.concat(chunks);if(body.length>1e5)return reply(413,'Body too large');}
  try{
    const r=await fetch(base+path+(u.search||''),{method:req.method,headers,body,redirect:'manual',signal:AbortSignal.timeout(110000)});
    res.statusCode=r.status;res.setHeader('Cache-Control','no-store');
    const type=r.headers.get('content-type');if(type)res.setHeader('Content-Type',type);
    res.end(Buffer.from(await r.arrayBuffer()));
  }catch(e){reply(502,`The always-on computer did not answer (${e.name==='TimeoutError'?'timed out':e.message}). Is the server and its tunnel running?`);}
};

async function viaSupabase(req,res,path,u,page,reply){
  const db=supabase();
  if(!db)return reply(503,'Not connected yet: set SUPABASE_URL and SUPABASE_SERVICE_KEY on this Vercel project.');
  const send=(status,type,body)=>{res.statusCode=status;res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',type||'application/json');res.end(body);};
  try{
    // The page itself holds no data, so it is served to anyone (as on the computer).
    if(PAGES.has(path)){
      const [s]=await db(`snapshots?org=eq.geonode&key=eq.${encodeURIComponent('GET '+path)}&select=type,body`);
      return s?send(200,s.type,s.body):reply(503,'The always-on computer has not uploaded this page yet. Is it running with the Supabase keys?');
    }
    // Who is calling (the monitor's session, or an API key of any scope) and about which organization.
    const me=await who(req,db);
    if(!me)return reply(401,'Sign in on the monitor first, or send an API key');
    const org=pickOrg(req,me);
    if(!org)return reply(403,'You are not a member of that organization');
    const by=me.via==='login'?'login:'+me.name:me.name,mine='org=eq.'+encodeURIComponent(org.slug);
    if(path==='/api/keys/me')return send(200,null,JSON.stringify({by,org:org.slug,org_name:org.name,role:org.role,orgs:me.orgs.map(o=>({slug:o.slug,name:o.name,role:o.role})),key:me.key&&{id:me.key.id,name:me.key.name,scope:me.key.scope,prefix:me.key.prefix}}));
    if(/^\/api\/keys(\/|$)/.test(path)&&(me.scope!=='full'||!allowed(me,org,'admin')))return reply(403,me.scope!=='full'?'Managing keys needs an "Everything" key':`Managing API keys needs the admin role in ${org.name}`);
    if(req.method==='POST'&&!/^\/api\/(prompts\/preview|keys(\/|$))/.test(path)&&!allowed(me,org,'editor'))return reply(403,`Changing prompts needs the editor role in ${org.name}; you are ${org.role}`);
    if(req.method==='GET'&&SNAPSHOT.has(path)&&!u.search){
      const [s]=await db(`snapshots?${mine}&key=eq.${encodeURIComponent('GET '+path)}&select=type,body`);
      if(s)return send(200,s.type,s.body);
    }
    // Anything else (a change, a preview, a model search) is done by that organization's engine.
    const body=req.method==='POST'?await readJson(req):null;
    const [c]=await db('commands',{body:{by,kind:'api',payload:{method:req.method,path:path+(u.search||''),body},org:org.slug}});
    for(const end=Date.now()+50000;Date.now()<end;){
      await sleep(800);
      const [d]=await db(`commands?id=eq.${c.id}&select=status,result`);
      if(d.status==='pending')continue;
      // The answer can hold a new key's secret: it is wiped from Supabase once read.
      await db(`commands?id=eq.${c.id}`,{method:'PATCH',body:{result:d.status==='done'?{status:d.result?.status}:d.result}});
      if(d.status!=='done')return reply(d.status==='expired'?504:422,d.result?.error||d.result?.reason||'The computer could not do this');
      return send(d.result.status,d.result.type,d.result.body);
    }
    return reply(504,'The always-on computer did not answer within 50 seconds. Is it running?');
  }catch(e){reply(e.status||502,e.message);}
}
