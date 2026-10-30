// Username + password sign-in for the hosted monitor.
// POST /api/login {"username","password"} sets an HttpOnly session cookie for 30 days.
// POST /api/login?logout=1 ends the session.
// Guessing is locked out: 5 failures from one IP lock that IP for 24 hours, and 20 failures from
// anywhere within an hour close the login for an hour. While locked, the password is not checked.
const {randomBytes,scryptSync,timingSafeEqual}=require('node:crypto');
const {sha256,ipOf,cookie,SESSION,supabase,readJson,reply}=require('../lib/auth.js');

const IP_FAILS=5,IP_LOCK=24*3600e3,ALL_FAILS=20,ALL_WINDOW=3600e3,SESSION_DAYS=30;
const iso=ms=>new Date(ms).toISOString();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const DUMMY={salt:'00',hash:'00'.repeat(64)};
const check=(password,u)=>{const h=scryptSync(String(password),Buffer.from(u.salt,'hex'),64),want=Buffer.from(u.hash,'hex');return want.length===64&&timingSafeEqual(h,want);};

module.exports=async(req,res)=>{
  if(req.method!=='POST')return reply(res,405,{error:'POST only'});
  const db=supabase();if(!db)return reply(res,503,{error:'Not connected yet: set SUPABASE_URL and SUPABASE_SERVICE_KEY on this Vercel project.'});
  const secure=String(req.headers['x-forwarded-proto']||'https')==='https'?'; Secure':'';
  try{
    if(new URL(req.url,'http://x').searchParams.get('logout')){
      const s=cookie(req,SESSION);if(s)await db(`monitor_sessions?token_hash=eq.${sha256(s)}`,{method:'DELETE'});
      return reply(res,200,{ok:true},{'Set-Cookie':`${SESSION}=; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=0`});
    }
    const ip=ipOf(req),now=Date.now(),body=await readJson(req);
    const username=String(body.username||'').trim().toLowerCase().slice(0,60),password=String(body.password||'').slice(0,200);

    // Failures from this IP since its last success, within the lock window.
    const [last]=await db(`login_attempts?ip=eq.${encodeURIComponent(ip)}&ok=is.true&select=at&order=at.desc&limit=1`);
    const since=Math.max(now-IP_LOCK,last?Date.parse(last.at):0);
    const fails=await db(`login_attempts?ip=eq.${encodeURIComponent(ip)}&ok=is.false&at=gt.${iso(since)}&select=at&order=at.desc&limit=${IP_FAILS}`);
    if(fails.length>=IP_FAILS){
      const until=Date.parse(fails[IP_FAILS-1].at)+IP_LOCK;
      return reply(res,429,{error:`Too many wrong attempts from your connection. Locked for ${Math.ceil((until-now)/3600e3)} more hour(s).`,locked_until:iso(until)});
    }
    const all=await db(`login_attempts?ok=is.false&at=gt.${iso(now-ALL_WINDOW)}&select=at&order=at.asc&limit=${ALL_FAILS}`);
    if(all.length>=ALL_FAILS){
      const until=Date.parse(all[0].at)+ALL_WINDOW;
      return reply(res,429,{error:`Sign-in is closed for ${Math.ceil((until-now)/60000)} min after too many wrong attempts.`,locked_until:iso(until)});
    }

    const [u]=username?await db(`monitor_users?username=eq.${encodeURIComponent(username)}&select=username,salt,hash`):[];
    const ok=check(password,u||DUMMY)&&!!u;
    await db('login_attempts',{body:{ip,username:username||null,ok}});
    if(!ok){
      await sleep(400);
      const left=IP_FAILS-fails.length-1;
      return reply(res,401,{error:left>0?`Wrong username or password. ${left} attempt${left===1?'':'s'} left before a 24-hour lock.`:'Wrong username or password. Locked for 24 hours.',attempts_left:left});
    }
    const token=randomBytes(32).toString('base64url');
    await db('monitor_sessions',{body:{token_hash:sha256(token),username:u.username,expires_at:iso(now+SESSION_DAYS*86400e3),ip}});
    reply(res,200,{ok:true,user:u.username},{'Set-Cookie':`${SESSION}=${token}; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=${SESSION_DAYS*86400}`});
  }catch(e){reply(res,e.status||502,{error:e.message});}
};
