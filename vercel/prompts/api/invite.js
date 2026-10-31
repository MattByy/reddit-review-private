// Accepting an invite link (/invite?t=<token>, made by an organization's admin in /api/orgs).
// GET  /api/invite?t=<token>   which organization and role it is for, and whether you are signed in
// POST /api/invite {"t"}                        signed in: join with your account
// POST /api/invite {"t","username","password"}  not signed in: make an account, join, and sign in
// A link works once and only until it expires. Someone with an account signs in on the monitor first
// (where wrong passwords are locked out) and then opens the link; this never checks a password.
const {randomBytes,scryptSync}=require('node:crypto');
const {sha256,ipOf,cookie,SESSION,ROLES,supabase,readJson,reply:send}=require('../lib/auth.js');

const SESSION_DAYS=30,USERNAME=/^[a-z0-9][a-z0-9_.-]{2,31}$/;
const iso=ms=>new Date(ms).toISOString();

module.exports=async(req,res)=>{
  const reply=(status,body,headers)=>send(res,status,body,headers);
  const db=supabase();
  if(!db)return reply(503,{error:'Not connected yet: set SUPABASE_URL and SUPABASE_SERVICE_KEY on this Vercel project.'});
  try{
    const body=req.method==='POST'?await readJson(req):{};
    const t=String(req.method==='POST'?body.t||'':new URL(req.url,'http://x').searchParams.get('t')||'').trim();
    if(!/^[\w-]{20,64}$/.test(t))return reply(404,{error:'This invite link is not valid'});
    const hash=sha256(t),now=new Date().toISOString(),open=`token_hash=eq.${hash}&used_at=is.null&revoked_at=is.null&expires_at=gt.${now}`;
    const [inv]=await db(`invites?${open}&select=org,role,created_by,expires_at`);
    if(!inv)return reply(404,{error:'This invite link was already used, was withdrawn or has expired. Ask for a new one.'});
    const [org]=await db(`organizations?slug=eq.${encodeURIComponent(inv.org)}&select=slug,name`);
    if(!org)return reply(404,{error:'This organization no longer exists'});
    const s=cookie(req,SESSION);
    const [session]=s?await db(`monitor_sessions?token_hash=eq.${sha256(s)}&expires_at=gt.${now}&select=username`):[];
    if(req.method==='GET')return reply(200,{org,role:inv.role,invited_by:inv.created_by,expires_at:inv.expires_at,signed_in_as:session?.username||null});
    if(req.method!=='POST')return reply(405,{error:'GET or POST'});

    let username=session?.username,created=false;
    if(!username){
      username=String(body.username||'').trim().toLowerCase();const password=String(body.password||'');
      if(!USERNAME.test(username))return reply(422,{error:'Username: 3 to 32 characters, lowercase letters, digits, dots, dashes or underscores'});
      if(password.length<10||password.length>200)return reply(422,{error:'Password: at least 10 characters'});
      const [taken]=await db(`monitor_users?username=eq.${encodeURIComponent(username)}&select=username`);
      if(taken)return reply(409,{error:'That username is taken. If it is yours, sign in on the monitor first, then open this link again.'});
      // Claim the link before making the account, so it cannot be used twice at the same moment.
      const claimed=await db(`invites?${open}`,{method:'PATCH',body:{used_at:now,used_by:username}});
      if(!claimed.length)return reply(404,{error:'This invite link was just used. Ask for a new one.'});
      const salt=randomBytes(16);
      try{await db('monitor_users',{body:{username,salt:salt.toString('hex'),hash:scryptSync(password,salt,64).toString('hex')}});}
      catch(e){await db(`invites?token_hash=eq.${hash}`,{method:'PATCH',body:{used_at:null,used_by:null}});throw e;}
      created=true;
    }else{
      const claimed=await db(`invites?${open}`,{method:'PATCH',body:{used_at:now,used_by:username}});
      if(!claimed.length)return reply(404,{error:'This invite link was just used. Ask for a new one.'});
    }
    // Joining keeps the higher role if they were already a member.
    const q=`org_members?org=eq.${encodeURIComponent(org.slug)}&username=eq.${encodeURIComponent(username)}`;
    const [was]=await db(q+'&select=role');
    if(!was)await db('org_members',{body:{org:org.slug,username,role:inv.role,added_by:inv.created_by}});
    else if(ROLES.indexOf(inv.role)>ROLES.indexOf(was.role))await db(q,{method:'PATCH',body:{role:inv.role}});
    const role=was&&ROLES.indexOf(was.role)>ROLES.indexOf(inv.role)?was.role:inv.role;
    if(!created)return reply(200,{ok:true,org,role,username});
    const token=randomBytes(32).toString('base64url'),secure=String(req.headers['x-forwarded-proto']||'https')==='https'?'; Secure':'';
    await db('monitor_sessions',{body:{token_hash:sha256(token),username,expires_at:iso(Date.now()+SESSION_DAYS*86400e3),ip:ipOf(req)}});
    reply(200,{ok:true,org,role,username,created:true},{'Set-Cookie':`${SESSION}=${token}; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=${SESSION_DAYS*86400}`});
  }catch(e){reply(e.status||502,{error:e.message});}
};
