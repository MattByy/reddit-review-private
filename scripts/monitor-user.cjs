#!/usr/bin/env node
// Create or reset a sign-in for the hosted monitor (geonode-prompts.vercel.app).
//   node scripts/monitor-user.cjs <username>     then type the password (it is not echoed)
// Stores a scrypt hash in Supabase (monitor_users) and signs out that user's existing sessions.
// Needs SUPABASE_URL and SUPABASE_SECRET_SERVICE_ROLE (or SUPABASE_SERVICE_KEY) in .env.local.
const path=require('node:path'),{randomBytes,scryptSync}=require('node:crypto');
const root=path.resolve(__dirname,'..');
try{process.loadEnvFile(path.join(root,'.env.local'));}catch{}
const base=(process.env.SUPABASE_URL||'').replace(/\/+$/,''),key=process.env.SUPABASE_SERVICE_KEY??process.env.SUPABASE_SECRET_SERVICE_ROLE;
const username=String(process.argv[2]||'').trim().toLowerCase();
if(!base||!key){console.error('Set SUPABASE_URL and SUPABASE_SECRET_SERVICE_ROLE in .env.local');process.exit(1);}
if(!/^[a-z0-9._-]{2,60}$/.test(username)){console.error('Usage: node scripts/monitor-user.cjs <username>');process.exit(1);}

async function readPassword(){
  if(!process.stdin.isTTY){let s='';for await(const c of process.stdin)s+=c;return s.replace(/\r?\n$/,'');}
  process.stdout.write('Password: ');process.stdin.setRawMode(true);
  let s='';for await(const c of process.stdin){const ch=String(c);
    if(ch==='\r'||ch==='\n'){process.stdin.setRawMode(false);process.stdout.write('\n');return s;}
    if(ch==='\u0003')process.exit(1);if(ch==='\u007f'){s=s.slice(0,-1);continue;}s+=ch;}
}
(async()=>{
  const password=await readPassword();
  if(password.length<8){console.error('Use at least 8 characters');process.exit(1);}
  const salt=randomBytes(16),hash=scryptSync(password,salt,64);
  const req=(method,p,body)=>fetch(`${base}/rest/v1/${p}`,{method,headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:body&&JSON.stringify(body)})
    .then(async r=>{if(!r.ok)throw Error(`${method} ${p.split('?')[0]}: HTTP ${r.status} ${await r.text()}`);});
  await req('POST','monitor_users',{username,salt:salt.toString('hex'),hash:hash.toString('hex')});
  await req('DELETE',`monitor_sessions?username=eq.${encodeURIComponent(username)}`);
  console.log(`Sign-in "${username}" saved. Existing sessions for it were signed out.`);
})().catch(e=>{console.error(e.message);process.exit(1);});
