const SB_URL=(process.env.SUPABASE_URL||process.env.NEXT_PUBLIC_SUPABASE_URL||'').replace(/\/$/,'');
const SB_KEY=process.env.SUPABASE_SERVICE_KEY||'';
async function request(url,options){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
  try{
    const response=await fetch(url,{...options,signal:controller.signal});
    const data=await response.arrayBuffer();
    return new Response([204,205,304].includes(response.status)?null:data,{status:response.status,statusText:response.statusText,headers:response.headers});
  }finally{clearTimeout(timer);}
}
async function sb(method,path,body,prefer){
  if(!SB_URL||!SB_KEY)throw Error('Database service is not configured');
  const headers={apikey:SB_KEY,Authorization:`Bearer ${SB_KEY}`,'Content-Type':'application/json'};
  if(prefer)headers.Prefer=prefer;
  const r=await request(`${SB_URL}/rest/v1/${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const text=await r.text();let data;try{data=text.trim()?JSON.parse(text):null;}catch{data=null;}
  if(!r.ok){const e=Error(data?.message||`Database ${r.status} on ${path.split('?')[0]}`);e.status=r.status;e.code=data?.code;throw e;}
  return data;
}
async function engain(method,path,body,params){
  if(!process.env.ENGAIN_API_KEY)throw Error('Engain is not configured');
  const r=await request('https://api.engain.io'+path+(params?'?'+new URLSearchParams(params):''),{
    method,headers:{'X-API-Key':process.env.ENGAIN_API_KEY,'Content-Type':'application/json','User-Agent':'geonode-workflow/2.0'},
    body:body==null?undefined:JSON.stringify(body),
  });
  const text=await r.text();let json;try{json=JSON.parse(text);}catch{json={error:'Non-JSON vendor response'};}
  return {status:r.status,json,retry_after:r.headers?.get('retry-after')||null};
}
const logger=actor=>async(action,detail)=>{try{await sb('POST','activity_log',[{actor,action,detail}],'return=minimal');}catch{}};
async function event(row){return sb('POST','workflow_events?on_conflict=event_key',[row],'resolution=ignore-duplicates,return=minimal');}
module.exports={sb,engain,logger,event,request};
