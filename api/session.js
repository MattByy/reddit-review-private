const {sb}=require('./_db.js');
const auth=require('./_session.js');
module.exports=async(req,res)=>{
  const out=(status,body)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('Vary','Cookie');res.end(JSON.stringify(body));};
  try{
    if(req.method==='GET'){
      const session=await auth.currentSession(req);
      if(session)return out(200,{authenticated:true,expires_at:session.expires_at});
      const [admin]=await sb('GET','dashboard_admin?select=password_hash&singleton=eq.true');
      return out(200,{authenticated:false,setup_required:!admin?.password_hash});
    }
    if(req.method!=='POST')return out(405,{error:'POST required'});
    if(!auth.sameOrigin(req))return out(403,{error:'Sign in from this dashboard.'});
    if(!String(req.headers['content-type']||'').startsWith('application/json'))return out(415,{error:'JSON required'});
    const input=typeof req.body==='string'?JSON.parse(req.body):req.body||{};
    if(input.action==='logout'){await auth.logout(req,res);return out(200,{authenticated:false});}
    if(!['login','setup'].includes(input.action))return out(422,{error:'Unknown sign-in action'});
    if(!await auth.allowAttempt(req)){res.setHeader('Retry-After','900');return out(429,{error:'Too many attempts. Try again in 15 minutes.'});}
    const password=input.password;
    if(typeof password!=='string'||!password.length||password.length>256)return out(422,{error:'Enter a password of up to 256 characters.'});
    if(input.action==='setup'){
      if(password.length<12)return out(422,{error:'Use at least 12 characters for your password.'});
      const token=String(input.setup_token||'');
      if(!/^[A-Za-z0-9_-]{43}$/.test(token))return out(401,{error:'This setup link is invalid or has already been used.'});
      const [admin]=await sb('GET','dashboard_admin?select=setup_token_hash,setup_expires_at,password_hash&singleton=eq.true');
      const setupHash=auth.digest(token);
      if(!admin||admin.password_hash||admin.setup_token_hash!==setupHash||!(Date.parse(admin.setup_expires_at)>Date.now()))return out(401,{error:'This setup link is invalid or has already been used.'});
      const saved=await sb('POST','rpc/setup_dashboard_admin',{p_setup_hash:setupHash,p_password_hash:await auth.passwordHash(password)});
      if(!saved)return out(409,{error:'This setup link has expired or has already been used. Sign in with your password.'});
    }else{
      const [admin]=await sb('GET','dashboard_admin?select=password_hash&singleton=eq.true');
      if(!admin?.password_hash)return out(409,{error:'Open your private setup link to choose your password first.'});
      if(!await auth.passwordMatches(password,admin.password_hash))return out(401,{error:'Incorrect password.'});
    }
    return out(200,await auth.issueSession(res));
  }catch(e){console.error('session failed:',e.status||'',e.code||'',e.message);return out(503,{error:'Sign-in is temporarily unavailable. Try again shortly.'});}
};
