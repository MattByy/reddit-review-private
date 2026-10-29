// Forwards the Prompts page and its API to the server on the always-on computer
// (PROMPTS_SERVER_URL, e.g. its ngrok or Tailscale Funnel address). Only the prompt routes pass;
// the server checks the API key on every call, so this function holds no secrets.
const ALLOW=/^\/(prompts|docs\/prompts-api|api\/(prompts(\/[\w-]+)?|prompt-variants(\/[\w-]+(\/delete)?)?|models|keys(\/me|\/[\w-]+\/revoke)?))$/;
const PASS=['authorization','content-type','accept'];

module.exports=async(req,res)=>{
  const u=new URL(req.url,'http://x'),path=u.searchParams.get('p')||'/prompts';u.searchParams.delete('p');
  const page=!path.startsWith('/api/');
  const reply=(status,body)=>{res.statusCode=status;res.setHeader('Cache-Control','no-store');
    if(page){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prompts</title><body style="font:15px system-ui;max-width:560px;margin:60px auto;padding:0 16px;color:#1c1917"><h2>Prompts</h2><p>${body}</p></body>`);}
    else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:body}));}};
  if(!ALLOW.test(path))return reply(404,'Not found');
  const base=(process.env.PROMPTS_SERVER_URL||'').replace(/\/+$/,'');
  if(!base)return reply(503,'Not connected yet: set PROMPTS_SERVER_URL on this Vercel project to the address of the always-on computer.');
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
