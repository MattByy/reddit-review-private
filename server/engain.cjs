// Engain API client for the local dev server.
// Limits follow docs.engain.io: 30 req/min general, 5 req/min Smart Search (own bucket).
const BASE='https://api.engain.io';

class Bucket{
  constructor(perMinute){this.perMinute=perMinute;this.stamps=[];}
  async take(){
    for(;;){
      const now=Date.now();this.stamps=this.stamps.filter(t=>now-t<60000);
      if(this.stamps.length<this.perMinute){this.stamps.push(now);return;}
      await new Promise(r=>setTimeout(r,60000-(now-this.stamps[0])+50));
    }
  }
}

function client({apiKey,fetchImpl=fetch,limits=true,log=()=>{}}={}){
  const buckets={general:new Bucket(30),smart:new Bucket(5)};
  async function call(method,path,{query,body,bucket='general'}={}){
    if(!apiKey)throw Object.assign(Error('ENGAIN_API_KEY is not set (put it in .env.local, or run npm run dev:mock)'),{status:503});
    const url=BASE+path+(query?'?'+new URLSearchParams(Object.entries(query).filter(([,v])=>v!=null&&v!=='')):'');
    for(let attempt=0;;attempt++){
      if(limits)await buckets[bucket].take();
      const r=await fetchImpl(url,{method,headers:{'X-API-Key':apiKey,'Content-Type':'application/json','User-Agent':'geonode-dev-server/1.0'},body:body==null?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
      const text=await r.text();let json;try{json=text?JSON.parse(text):null;}catch{json={error:'Non-JSON response'};}
      if(r.status===429&&attempt<3){
        const wait=Math.min(Number(r.headers.get('retry-after'))||60,120)*1000;
        log(`engain 429 on ${path}, waiting ${wait/1000}s`);await new Promise(res=>setTimeout(res,limits?wait:0));continue;
      }
      if(!r.ok){const e=Error(json?.error?.message||json?.message||json?.error||`Engain ${r.status} on ${path}`);e.status=r.status;e.body=json;throw e;}
      return json;
    }
  }
  return {
    call,
    me:()=>call('GET','/api/v1/me'),
    balance:()=>call('GET','/api/v1/balance'),
    opportunities:q=>call('GET','/api/v1/opportunities',{query:q}),
    mentions:q=>call('GET','/api/v1/mentions',{query:q}),
    mentionBrands:q=>call('GET','/api/v1/mentions/brands',{query:q}),
    tasks:q=>call('GET','/api/v1/tasks',{query:q}),
    smartSearch:body=>call('POST','/api/v1/smart-search',{body,bucket:'smart'}),
    smartSearchResults:q=>call('GET','/api/v1/smart-search/results',{query:q}),
    smartSearchHistory:q=>call('GET','/api/v1/smart-search/history',{query:q}),
    subredditStats:subreddit=>call('GET','/api/v1/subreddit-stats',{query:{subreddit}}),
    
    // Pooled delivery (main API)
    createCommentTask:body=>call('POST','/api/v1/tasks/comment',{body}),
    createReplyTask:body=>call('POST','/api/v1/tasks/reply',{body}),
    getTask:taskId=>call('GET',`/api/v1/tasks/${taskId}`),
    cancelTask:taskId=>call('POST',`/api/v1/tasks/${taskId}/cancel`),
    
    // API v2: dedicated accounts and one tasks API for pool and dedicated tasks.
    // (/api/v1/accounts-beta/* was removed by Engain in favour of these.)
    v2Accounts:projectId=>call('GET','/api/v2/accounts',{query:{projectId}}),
    v2CreateComment:body=>call('POST','/api/v2/tasks/comment',{body}),
    v2ThreadCheck:(accountId,q)=>call('GET',`/api/v2/accounts/${encodeURIComponent(accountId)}/thread-check`,{query:q}),
    v2GetTask:taskId=>call('GET',`/api/v2/tasks/${encodeURIComponent(taskId)}`),
  };
}

module.exports={client,Bucket};
