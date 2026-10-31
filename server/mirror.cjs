// Mirror to Supabase: every minute the server copies Queue 1, Queue 2, new activity-log events and a
// status row into the tables of supabase/schema.sql, so a hosted page can follow the system.
// The copy is one-way; the only thing read back is the commands table (pending()/finish()). Off unless SUPABASE_URL and SUPABASE_SERVICE_KEY are set.
const queue=require('./queue.cjs');

const BATCH=500;
const json=s=>{try{return s==null?null:JSON.parse(s);}catch{return s;}};
const subredditOf=url=>/\/r\/([^/]+)/.exec(url||'')?.[1]??null;

// org: the organization this engine serves. Every row it writes carries it, it deletes only its own
// rows, and it reads only its own commands (plus the organization-level ones, kind 'org.*', when host is set).
function mirror({url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_KEY??process.env.SUPABASE_SECRET_SERVICE_ROLE,fetchImpl=fetch,org='geonode',host=false}={}){
  if(!url||!key)return null;
  const mine='org=eq.'+encodeURIComponent(org),tag=rows=>rows.map(r=>({...r,org}));
  const base=url.replace(/\/+$/,'')+'/rest/v1/';
  async function rest(method,path,body,prefer){
    const res=await fetchImpl(base+path,{method,headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',...(prefer?{Prefer:prefer}:{})},
      body:body==null?undefined:JSON.stringify(body)});
    if(!res.ok)throw Object.assign(Error(`Supabase ${method} ${path.split('?')[0]}: HTTP ${res.status} ${(await res.text()).slice(0,200)}`),{status:res.status});
    return method==='GET'?res.json():null;
  }
  const upsert=async(table,rows)=>{if(!rows.length)return;rows=tag(rows);for(let i=0;i<rows.length;i+=BATCH)await rest('POST',table,rows.slice(i,i+BATCH),'resolution=merge-duplicates,return=minimal');};
  // Rows that left the local table leave the mirror too.
  const prune=(table,col,keys)=>rest('DELETE',`${table}?${mine}&${col}=${keys.length?`not.in.(${keys.map(k=>encodeURIComponent(JSON.stringify(String(k)))).join(',')})`:'not.is.null'}`,null,'return=minimal');

  async function sync(store,status={}){
    const q1=queue.queueView(store,{history:0}).items.map(i=>({item_id:i.item_id,position:i.position,kind:i.kind,subreddit:i.thread?.subreddit??subredditOf(i.url),
      title:i.thread?.title??null,url:i.url,score:i.score??null,added_at:i.added_at??null,claimed_at:i.claimed_at??null}));
    await upsert('queue1',q1);await prune('queue1','item_id',q1.map(r=>r.item_id));

    const q2=store.db.prepare('select * from queue2').all().map(r=>({id:r.id,item_id:r.item_id,kind:r.kind,subreddit:subredditOf(r.thread_url||r.url),title:r.title,url:r.url,thread_url:r.thread_url,
      message:r.message,message_source:r.message_source,write_status:r.write_status,write_error:r.write_error,model:r.model,provider:r.provider,prompt_variant_slug:r.prompt_variant_slug,send_status:r.send_status,delivery_mode:r.delivery_mode,
      approved_by:r.approved_by,approved_at:r.approved_at,engain_task_id:r.engain_task_id,engain_status:r.engain_status,reddit_url:r.reddit_url,send_error:r.send_error,
      created_at:r.created_at,written_at:r.written_at,sent_at:r.sent_at,published_at:r.published_at,updated_at:r.updated_at}));
    // Older Supabase projects lack queue2.write_error (supabase/schema.sql adds it); sync without it there.
    try{await upsert('queue2',q2);}
    catch(e){if(!/write_error/.test(e.message))throw e;await upsert('queue2',q2.map(({write_error,...r})=>r));}
    await prune('queue2','id',q2.map(r=>r.id));

    // Key hashes (never the keys), so the hosted page accepts the same keys and honours revoking.
    const keys=store.db.prepare('select id,name,scope,prefix,hash,created_at,revoked_at from api_keys').all();
    await upsert('api_keys',keys);await prune('api_keys','id',keys.map(k=>k.id));

    // Events only grow: send the ones after the last id that reached Supabase.
    const state=store.kv('mirror_state')||{events_id:0};
    const ev=store.db.prepare('select * from events where id>? order by id limit 5000').all(state.events_id).map(e=>({...e,data:json(e.data)}));
    await upsert('events',ev);
    if(ev.length)store.setKv('mirror_state',{...state,events_id:ev.at(-1).id});

    const synced_at=new Date().toISOString();
    await upsert('status',[{id:org,synced_at,data:{...status,settings:queue.settings(store),counts:{queue1:q1.length,queue2:q2.filter(r=>['ready','sending',null].includes(r.send_status)).length,
      sent:q2.filter(r=>r.engain_task_id).length}}}]);
    return {queue1:q1.length,queue2:q2.length,events:ev.length,synced_at};
  }
  // Commands from the hosted page, oldest first; finish() writes back the outcome.
  const pending=()=>rest('GET',`commands?status=eq.pending&${host?`or=(org.eq.${encodeURIComponent(org)},kind.like.org.*)`:mine}&order=id.asc&limit=20&select=id,at,by,kind,payload,org`);
  const finish=(id,status,result)=>rest('PATCH',`commands?id=eq.${Number(id)}`,{status,result:result??null,done_at:new Date().toISOString()},'return=minimal');
  // Pages and API answers for the hosted Prompts page: [{key:'GET /api/prompts',type,body}].
  // Answers to the Prompts page's commands can hold a new key's secret; wipe any left after 2 minutes.
  // An organization-level command can carry an Engain key: once done, its payload is cut to the name.
  const scrubPayload=(id,payload)=>rest('PATCH',`commands?id=eq.${Number(id)}`,{payload},'return=minimal');
  const scrub=()=>rest('PATCH',`commands?kind=eq.api&done_at=lt.${new Date(Date.now()-120000).toISOString()}&result->>body=not.is.null`,{result:null},'return=minimal');
  const putSnapshots=rows=>upsert('snapshots',rows.map(r=>({...r,synced_at:new Date().toISOString()})));
  // The organizations this computer runs, for the hosted page's list (never their Engain keys).
  const putOrganizations=rows=>rest('POST','organizations',rows,'resolution=merge-duplicates,return=minimal');
  return {sync,pending,finish,putSnapshots,scrub,scrubPayload,putOrganizations,org};
}

module.exports={mirror};
