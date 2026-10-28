// The tracking list: everything sent from Queue 2, with Engain's latest status. The checker asks
// Engain about items that are not final yet (GET /api/v2/tasks/bulk, 100 ids per call); final
// items keep their status and stop being checked.
const BUCKETS={
  pending:'Pending',
  published:'Published',
  automod_removed:'Removed by AutoModerator',
  mod_removed:'Removed by moderators',
  deleted:'Deleted (account or Engain)',
  parent_removed:'Parent comment removed',
  not_posted:'Not posted (thread or subreddit problem)',
  cancelled:'Cancelled',
  error:'Error / other',
};
const FINAL={published:'published',automod_removed:'automod_removed',mod_removed:'mod_removed',user_deleted:'deleted',
  main_comment_removed_deleted:'parent_removed',cancelled:'cancelled',canceled:'cancelled',
  post_url_broken:'not_posted',thread_archived_locked:'not_posted',subreddit_private_banned:'not_posted',incorrect_missing_flair:'not_posted'};
// Anything else final (error, rebuilt, or a status Engain adds later) counts as Error / other.
function bucket(row){
  if(!row.engain_status||!row.settled)return row.send_status==='published'?'published':row.send_status==='cancelled'?'cancelled':
    row.send_status==='failed'&&row.engain_status?FINAL[row.engain_status]||'error':'pending';
  return FINAL[row.engain_status]||'error';
}

async function checkSent(store,engain,projectId,{log=()=>{}}={}){
  const open=store.toCheck();
  const summary={checked:0,changed:[],not_found:0,still_pending:0,errors:[]};
  for(let i=0;i<open.length;i+=100){
    const chunk=open.slice(i,i+100);
    let tasks;
    try{tasks=(await engain.v2TasksBulk(projectId,chunk.map(r=>r.engain_task_id))).page||[];}
    catch(e){summary.errors.push(e.message);log('tracker: bulk check failed: '+e.message);continue;}
    const byId=new Map(tasks.map(t=>[t._id||t.id,t]));
    for(const r of chunk){
      const t=byId.get(r.engain_task_id);
      if(!t){summary.not_found++;continue;}
      const res=store.trackStatus(r.id,String(t.status||'unknown').toLowerCase(),t.redditUrl||null);
      summary.checked++;
      if(res.changed)summary.changed.push({queue2_id:r.id,task_id:r.engain_task_id,from:res.from,to:res.to});
    }
  }
  summary.still_pending=store.toCheck().length;
  return summary;
}

// Everything sent in the last `days` days (0 = all time), with counts per outcome.
function sentView(store,{days=7}={}){
  days=Math.max(0,Math.min(Number.isFinite(Number(days))?Number(days):7,3650));
  const since=days?new Date(Date.now()-days*86400000).toISOString():null;
  const rows=store.sentSince(since);
  const counts=Object.fromEntries(Object.keys(BUCKETS).map(k=>[k,0]));
  const items=rows.map(r=>{const b=bucket(r);counts[b]++;
    return {queue2_id:r.id,kind:r.kind,title:r.title,url:r.url,thread_url:r.thread_url,message:r.message,prompt_variant_name:r.prompt_variant_name??null,
      delivery_mode:r.delivery_mode,user_account_id:r.user_account_id,engain_task_id:r.engain_task_id,engain_status:r.engain_status??null,
      bucket:b,bucket_label:BUCKETS[b],reddit_url:r.reddit_url??null,sent_at:r.sent_at,status_checked_at:r.status_checked_at??null,
      status_changed_at:r.status_changed_at??null,checking:!r.settled,history:store.queue2Events(r.id)};});
  const settled=items.length-counts.pending;
  return {days,since,total:items.length,counts,labels:BUCKETS,
    published_rate:settled?Math.round(counts.published/settled*1000)/10:null,items};
}

module.exports={BUCKETS,bucket,checkSent,sentView};
