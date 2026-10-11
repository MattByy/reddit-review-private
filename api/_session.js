const {randomBytes,createHash,createHmac,scrypt,timingSafeEqual}=require('crypto');
const {promisify}=require('util');
const {sb}=require('./_db.js');
const derive=promisify(scrypt),cookieName='__Host-reddit_admin',ttl=30*24*60*60;
const digest=value=>createHash('sha256').update(value).digest('hex');
function sameOrigin(req){
  try{const origin=new URL(req.headers.origin);return origin.protocol==='https:'&&origin.host===req.headers.host;}catch{return false;}
}
function tokenFrom(req){
  const match=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='));
  const value=match?.slice(cookieName.length+1)||'';
  return /^[A-Za-z0-9_-]{43}$/.test(value)?value:null;
}
async function currentSession(req){
  const token=tokenFrom(req);if(!token)return null;
  const [session]=await sb('GET',`dashboard_sessions?select=expires_at&token_hash=eq.${digest(token)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}`);
  return session||null;
}
function setCookie(res,token,maxAge=ttl){
  res.setHeader('Set-Cookie',`${cookieName}=${token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`);
}
async function issueSession(res){
  const token=randomBytes(32).toString('base64url'),expires_at=new Date(Date.now()+ttl*1000).toISOString();
  await sb('DELETE',`dashboard_sessions?expires_at=lte.${encodeURIComponent(new Date().toISOString())}`,undefined,'return=minimal');
  await sb('POST','dashboard_sessions',[{token_hash:digest(token),expires_at}],'return=minimal');
  setCookie(res,token);return {authenticated:true,expires_at};
}
async function logout(req,res){
  const token=tokenFrom(req);
  if(token)await sb('DELETE',`dashboard_sessions?token_hash=eq.${digest(token)}`,undefined,'return=minimal');
  setCookie(res,'',0);
}
async function passwordHash(password){
  const salt=randomBytes(16).toString('hex');
  const key=await derive(password,salt,64);
  return `scrypt:${salt}:${key.toString('hex')}`;
}
async function passwordMatches(password,encoded){
  const [kind,salt,expected]=String(encoded||'').split(':');
  if(kind!=='scrypt'||!/^[a-f0-9]{32}$/.test(salt||'')||!/^[a-f0-9]{128}$/.test(expected||''))return false;
  return timingSafeEqual(await derive(password,salt,64),Buffer.from(expected,'hex'));
}
async function allowAttempt(req){
  const ip=String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim();
  const bucket=createHmac('sha256',process.env.OPERATOR_API_KEY||process.env.SUPABASE_SERVICE_KEY||'').update(ip).digest('hex');
  return sb('POST','rpc/consume_dashboard_login',{p_bucket:bucket});
}
module.exports={sameOrigin,currentSession,issueSession,logout,passwordHash,passwordMatches,allowAttempt,digest};
