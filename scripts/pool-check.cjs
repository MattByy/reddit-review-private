// Read-only agent API probe. Never claims jobs, files content or calls Engain directly.
const DEFAULT_BASE='https://site-phi-two-38.vercel.app/api/agent';

async function checkPool({env=process.env,fetchImpl=global.fetch}={}){
  const report={ok:false,posting_performed:false,checks:[]};
  const fail=(name,detail)=>{report.checks.push({name,ok:false,detail});return report;};
  if(!env.AGENT_API_KEY?.trim())return fail('agent_key','Set AGENT_API_KEY in the runner or ignored .env.local. No operator or Engain key is needed.');
  if(/\[SENSITIVE\]|<.*>|REPLACE[_ -]?ME/i.test(env.AGENT_API_KEY))return fail('agent_key','AGENT_API_KEY is a placeholder, not a credential. Vercel secret downloads contain [SENSITIVE]; use the existing working agent secret from the runner secret store.');
  let base;
  try{base=new URL(env.AGENT_BASE_URL||DEFAULT_BASE);}catch{return fail('base_url','AGENT_BASE_URL must be a valid agent API URL.');}
  const local=['localhost','127.0.0.1','[::1]'].includes(base.hostname);
  if((base.protocol!=='https:'&&!(base.protocol==='http:'&&local))||base.username||base.password||base.search||base.hash||base.pathname.replace(/\/+$/,'')!=='/api/agent'){
    return fail('base_url','Use HTTPS ending in /api/agent, without credentials, query or fragment. Local HTTP is allowed only on loopback.');
  }
  const root=base.href.replace(/\/+$/,'');report.base_url=root;
  async function read(path){
    let response;
    try{response=await fetchImpl(root+path,{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+env.AGENT_API_KEY},signal:AbortSignal.timeout(15000)});}
    catch{throw Error('Cannot read '+path+'; check connectivity, TLS and the configured URL. Redirects are not followed.');}
    if(!response.ok)throw Error(path+' returned HTTP '+response.status+(response.status===401?'; check AGENT_API_KEY.':'.'));
    let body;try{body=await response.json();}catch{throw Error(path+' did not return valid JSON.');}
    if(!body||typeof body!=='object'||Array.isArray(body))throw Error(path+' returned an invalid response.');
    return body;
  }
  let bootstrap;
  try{bootstrap=await read('/bootstrap');}catch(e){return fail('bootstrap',e.message);}
  if(bootstrap.protocol_version!==5||bootstrap.workflow!=='message_experiments')return fail('bootstrap','Expected protocol 5 and message_experiments; update the configured backend before using this worker.');
  report.checks.push({name:'bootstrap',ok:true,protocol_version:5,workflow:'message_experiments'});
  let delivery;
  try{delivery=await read('/delivery');}catch(e){return fail('pooled_delivery',e.message);}
  if(delivery.available!==true||delivery.mode!=='pool'||delivery.has_project!==true){
    return fail('pooled_delivery','Pooled delivery is not available. Configure server ENGAIN_DELIVERY=pool and an accessible ENGAIN_PROJECT_ID. Do not switch to Accounts Beta.');
  }
  report.checks.push({name:'pooled_delivery',ok:true,mode:'pool',has_project:true});
  if(delivery.requested_mode!=='pool'||delivery.pooled_only!==true)return fail('pool_lock','The server has not confirmed ENGAIN_DELIVERY=pool. Deploy the current backend with that production setting.');
  report.checks.push({name:'pool_lock',ok:true,requested_mode:'pool'});
  report.ok=true;
  report.scope='Current API connectivity and pooled capability only; no Reddit visibility, disclosure, rule check or publication was tested.';
  report.configuration_note='The deployed server confirms ENGAIN_DELIVERY=pool; private fallback is disabled for new messages.';
  report.next='Read docs/pooled-accounts.md. Use the designated one-message test or an authorized queued writing job.';
  return report;
}

if(require.main===module){
  (async()=>{
    if(require('node:fs').existsSync('.env.local')){
      if(typeof process.loadEnvFile!=='function')throw Error('Use Node.js 22 or newer to load .env.local, or supply environment variables directly.');
      process.loadEnvFile('.env.local');
    }
    const result=await checkPool();console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1;
  })().catch(()=>{console.error('Pooled check could not start. Check the Node.js version and .env.local configuration. No posting request was made.');process.exitCode=1;});
}
module.exports={checkPool};
