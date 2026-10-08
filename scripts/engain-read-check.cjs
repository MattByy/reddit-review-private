// Read-only contract check. Never sends content, changes accounts or cancels tasks.
const fs=require('node:fs');
function envFile(file){const result={};for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){const m=line.match(/^\s*(?:export\s+)?([A-Z_][A-Z_0-9]*)=(.*)$/);if(m)result[m[1]]=m[2].trim().replace(/^(['"])(.*)\1$/,'$2');}return result;}
const config={...envFile('.env.local'),...(process.argv[2]?envFile(process.argv[2]):{}),...process.env};
async function main(){
  const results=[];
  for(const endpoint of ['me','accounts-beta/accounts','accounts-beta/comments','accounts-beta/posts']){
    const response=await fetch('https://api.engain.io/api/v1/'+endpoint,{method:'GET',headers:{'X-API-Key':config.ENGAIN_API_KEY},signal:AbortSignal.timeout(15000)});
    const data=await response.json();
    results.push({endpoint,status:response.status,keys:Object.keys(data),
      ...(endpoint==='me'?{projects:data.projects?.length}:{}),
      ...(data.accounts?{accounts:data.accounts.length,usable:data.accounts.filter(a=>a.usable).length}:{}),
      ...(data.page?{count:data.page.length,isDone:data.isDone,items:data.page.map(t=>({status:t.status,keys:Object.keys(t),has_url:!!(t.resultUrl||t.redditUrl),reason:t.error||t.failureReason||t.cancelReason||t.cancellationReason||t.reason||null}))}:{}),
    });
  }
  console.log(JSON.stringify({at:new Date().toISOString(),mode:'read-only',results},null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
