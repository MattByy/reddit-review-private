// Mirror to Supabase: every minute the server copies Queue 1, Queue 2, new activity-log events and a
// status row into the tables of supabase/schema.sql, so a hosted page can follow the system.
// The copy is one-way; the only thing read back is the commands table (pending()/finish()). Off unless SUPABASE_URL and SUPABASE_SERVICE_KEY are set.
const queue=require('./queue.cjs');

const BATCH=500;
const json=s=>{try{return s==null?null:JSON.parse(s);}catch{return s;}};
const subredditOf=url=>/\/r\/([^/]+)/.exec(url||'')?.[1]??null;

function mirror({url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_KEY??process.env.SUPABASE_SECRET_SERVICE_ROLE,fetchImpl=fetch}={}){
  if(!url||!key)return null;
  const base=url.replace(/\/+$/,'')+'/rest/v1/';
  async function rest(method,path,body,prefer){
    const res=await fetchImpl(base+path,{method,headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',...(prefer?{Prefer:prefer}:{})},
      body:body==null?undefined:JSON.stringify(body)});
    if(!res.ok)throw Object.assign(Error(`Supabase ${method} ${path.split('?')[0]}: HTTP ${res.status} ${(await res.text()).slice(0,200)}`),{status:res.status});
    return method==='GET'?res.json():null;
  }
  const upsert=async(table,rows)=>{if(!rows.length)return;for(let i=0;i<rows.length;i+=BATCH)await rest('POST',table,rows.slice(i,i+BATCH),'resolution=merge-duplicates,return=minimal');};
  // Rows that left the local table leave the mirror too.
  const prune=(table,col,keys)=>rest('DELETE',`${table}?${col}=${keys.length?`not.in.(${keys.map(k=>encodeURIComponent(JSON.stringify(String(k)))).join(',')})`:'not.is.null'}`,null,'return=minimal');

  async function sync(store,status={}){
    const q1=queue.queueView(store,{history:0}).items.map(i=>({item_id:i.item_id,position:i.position,kind:i.kind,subreddit:i.thread?.subreddit??subredditOf(i.url),
      title:i.thread?.title??null,url:i.url,score:i.score??null,added_at:i.added_at??null,claimed_at:i.claimed_at??null}));
    await upsert('queue1',q1);await prune('queue1','item_id',q1.map(r=>r.item_id));

    const q2=store.db.prepare('select * from queue2').all().map(r=>({id:r.id,item_id:r.item_id,kind:r.kind,subreddit:subredditOf(r.thread_url||r.url),title:r.title,url:r.url,thread_url:r.thread_url,
      message:r.message,write_status:r.write_status,model:r.model,provider:r.provider,prompt_variant_slug:r.prompt_variant_slug,send_status:r.send_status,delivery_mode:r.delivery_mode,
      approved_by:r.approved_by,approved_at:r.approved_at,engain_task_id:r.engain_task_id,engain_status:r.engain_status,reddit_url:r.reddit_url,send_error:r.send_error,
      created_at:r.created_at,written_at:r.written_at,sent_at:r.sent_at,published_at:r.published_at,updated_at:r.updated_at}));
    await upsert('queue2',q2);await prune('queue2','id',q2.map(r=>r.id));

    // Key hashes (never the keys), so the hosted page accepts the same keys and honours revoking.
    const keys=store.db.prepare('select id,name,scope,prefix,hash,created_at,revoked_at from api_keys').all();
    await upsert('api_keys',keys);await prune('api_keys','id',keys.map(k=>k.id));

    // Events only grow: send the ones after the last id that reached Supabase.
    const state=store.kv('mirror_state')||{events_id:0};
    const ev=store.db.prepare('select * from events where id>? order by id limit 5000').all(state.events_id).map(e=>({...e,data:json(e.data)}));
    await upsert('events',ev);
    if(ev.length)store.setKv('mirror_state',{...state,events_id:ev.at(-1).id});

    const synced_at=new Date().toISOString();
    await upsert('status',[{id:'main',synced_at,data:{...status,settings:queue.settings(store),counts:{queue1:q1.length,queue2:q2.filter(r=>['ready','sending',null].includes(r.send_status)).length,
      sent:q2.filter(r=>r.engain_task_id).length}}}]);
    return {queue1:q1.length,queue2:q2.length,events:ev.length,synced_at};
  }
  // Commands from the hosted page, oldest first; finish() writes back the outcome.
  const pending=()=>rest('GET','commands?status=eq.pending&order=id.asc&limit=20&select=id,at,by,kind,payload');
  const finish=(id,status,result)=>rest('PATCH',`commands?id=eq.${Number(id)}`,{status,result:result??null,done_at:new Date().toISOString()},'return=minimal');
  return {sync,pending,finish};
}

module.exports={mirror};
