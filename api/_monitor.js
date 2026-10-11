const {sb,engain,event}=require('./_db.js');
const {conversation,repliesTo,identity}=require('./_reddit.js');
const {experiment,hash,remember}=require('./_workflow.js');
const enc=encodeURIComponent,now=()=>new Date().toISOString();
const DEAD=new Set(['failed','cancelled','canceled','rejected','error','removed','deleted']);
function vendorState(value){
  const s=String(value||'').toLowerCase();
  if(s.includes('remov'))return 'removed';if(s.includes('delet'))return 'deleted';
  if(['completed','published'].includes(s))return 'reported_published';
  if(DEAD.has(s))return s==='canceled'?'cancelled':s;
  return ['pending','queued','processing','in_progress','scheduled'].includes(s)?'pending':'unknown';
}
function vendorReason(c){const value=c.error||c.failureReason||c.cancelReason||c.cancellationReason||c.reason;return value==null?null:(typeof value==='string'?value:JSON.stringify(value)).slice(0,2000);}
async function record(t,type,reason,source='engain'){
  const [d]=t.draft_id?await sb('GET',`drafts?select=filing_key,thread_context&id=eq.${enc(t.draft_id)}`):[];
  await event({event_key:`task:${t.id}:${type}:${hash(reason)}`,event:type,source,task_id:t.id,draft_id:t.draft_id,thread_id:t.thread_id,
    experiment:experiment(d?.thread_context?.experiment),reason,detail:{request_id:d?.filing_key||t.draft_id||t.id,subreddit:t.subreddit}});
}
async function reconcile(){
  const rows=await sb('GET','publication_attempts?select=*&state=in.(submitting,unknown)&order=created_at.asc&limit=10');
  const results=[];
  for(const a of rows){
    if(a.task_id){
      await sb('POST','rpc/accept_publication',{p_attempt_id:a.id,p_task_id:a.task_id,p_status:a.vendor_response?.status||'pending',p_response:a.vendor_response||{}});
      results.push({attempt:a.id,state:'accepted'});
    }else if(Date.parse(a.created_at)<Date.now()-120000){
      await sb('PATCH',`publication_attempts?id=eq.${enc(a.id)}`,{state:'unknown',reason:'No confirmed provider response. Reconciliation required before another send.',updated_at:now()},'return=minimal');
      results.push({attempt:a.id,state:'unknown',action:'operator_reconciliation'});
    }
  }
  return results;
}
async function blockBranch(url,reason){
  const jobs=await sb('GET',`jobs?select=id,draft_id,status&payload->>our_comment_url=eq.${enc(url)}&limit=100`);
  for(const j of jobs){
    if(['planned','claimed'].includes(j.status))await sb('PATCH',`jobs?id=eq.${enc(j.id)}`,{status:'blocked',blocked_reason:reason,lease_until:null,finished_at:now()},'return=minimal');
    if(j.draft_id){await sb('PATCH',`engain_tasks?draft_id=eq.${enc(j.draft_id)}&cancel_requested_at=is.null&reddit_url=is.null`,{cancel_requested_at:now(),cancel_requested_by:'parent unavailable'},'return=minimal');}
    if(j.draft_id)await sb('PATCH',`drafts?id=eq.${enc(j.draft_id)}&status=in.(pending,approved,edited)`,{send_cleared_at:null,gate_failed_at:now(),gate_failure:reason},'return=minimal');
  }
}
async function poll(deadline=Infinity){
  const tasks=await sb('GET','engain_tasks?select=*&project_id=eq.accounts-beta&order=submitted_at.desc&limit=1000');
  const known=new Map(tasks.map(t=>[t.id,t])),results=[];
  for(const endpoint of ['comments','posts']){
    if(Date.now()>=deadline)break;
    const key='poll:'+endpoint;
    const [saved]=await sb('GET',`workflow_state?select=value&key=eq.${enc(key)}`);
    let cursor=saved?.value?.cursor||null;
    for(let page=0;page<2&&Date.now()<deadline;page++){
      const {status,json}=await engain('GET',`/api/v1/accounts-beta/${endpoint}`,null,cursor?{cursor}:undefined);
      if(status>=300){results.push({endpoint,error:`Engain returned ${status}`});break;}
      for(const c of json.page||[]){
        const t=known.get(c._id||c.id);if(!t)continue;
        const state=vendorState(c.status),reason=vendorReason(c),url=c.resultUrl||c.redditUrl||t.reddit_url||null;
        await sb('PATCH',`engain_tasks?id=eq.${enc(t.id)}`,{status:c.status||'unknown',last_polled:now(),error:reason,
          ...(state==='cancelled'?{cancelled_at:now(),cancel_result:reason||'Vendor confirmed cancellation'}:{}),...(url&&url!==t.reddit_url?{visibility:'unverified',next_check_at:null}:{}),reddit_url:url,reply_count:c.replyCount??t.reply_count,vendor_payload:{status:c.status,resultUrl:url,reason,replyCount:c.replyCount??null}},'return=minimal');
        if(['failed','cancelled','rejected','error','removed','deleted'].includes(state)){
          const removed=['removed','deleted'].includes(state);
          await sb('PATCH',`engain_tasks?id=eq.${enc(t.id)}`,{...(removed?{visibility:state,observed_at:now()}:{}),next_check_at:null},'return=minimal');
          if(t.draft_id)await sb('PATCH',`drafts?id=eq.${enc(t.draft_id)}&status=neq.rejected`,{status:removed?'removed':'cancelled',engain_status:c.status,engain_seen_at:now()},'return=minimal');
          await sb('PATCH',`scenario_acts?task_id=eq.${enc(t.id)}&status=neq.rejected`,{status:removed?'removed':'failed',engain_status:c.status,engain_seen_at:now()},'return=minimal');
          if(url)await blockBranch(url,`Parent ${state}: ${reason||'reason not supplied'}`);
          await record(t,state==='cancelled'?(t.cancel_requested_at?'operator_cancelled':'vendor_cancelled'):state,reason);
        }else if(t.status!==c.status||!t.last_polled)await record(t,state,reason);
        results.push({task:t.id,status:c.status,state});
      }
      cursor=json.isDone?null:json.continueCursor||null;
      await sb('POST','workflow_state?on_conflict=key',[{key,value:{cursor},updated_at:now()}],'resolution=merge-duplicates,return=minimal');
      if(!cursor)break;
    }
  }
  return {results,local_window_truncated:tasks.length===1000};
}
async function planReplies({replies,url,thread_id,account_id,our_body,sequence_run_id,step,experiment:campaign}){
  const jobs=[];
  if(!campaign){
    const [parentTask]=await sb('GET',`engain_tasks?select=draft_id&reddit_url=eq.${enc(url)}&limit=1`);
    const [parentDraft]=parentTask?.draft_id?await sb('GET',`drafts?select=thread_context&id=eq.${enc(parentTask.draft_id)}`):[];
    campaign=experiment(parentDraft?.thread_context?.experiment);
  }
  for(const r of replies){
    const key=`followup:${r.id}`;
    const [existing]=await sb('GET',`jobs?select=*&dedupe_key=eq.${enc(key)}`);
    if(existing){
      if(existing.payload?.body!==r.body){
        const payload={...existing.payload,body:r.body,author:r.author,parent_id:r.parent_id,depth:r.depth,observed_at:now()};
        await sb('PATCH',`jobs?id=eq.${enc(existing.id)}`,{payload,...(['planned','claimed'].includes(existing.status)?{status:'planned',lease_until:null,claim_token:null,due_at:now()}: {})},'return=minimal');
        if(existing.draft_id)await sb('PATCH',`drafts?id=eq.${enc(existing.draft_id)}&status=in.(pending,approved,edited)`,{status:'pending',redirect_pending:true,
          redirect_note:'The reader edited the parent. Refresh context and revise before review.',send_cleared_at:null,parent_confirmed_by:null},'return=minimal');
      }
      jobs.push((await sb('GET',`jobs?select=*&id=eq.${enc(existing.id)}`))[0]);continue;
    }
    const rows=await sb('POST','jobs?on_conflict=dedupe_key',[{kind:'draft_followup',account_id,thread_id,target_url:r.permalink,
      sequence_run_id:sequence_run_id||null,step:step??null,title:`Consider answering u/${r.author}`,created_by:'reply-monitor',dedupe_key:key,
      payload:{author:r.author,body:r.body,parent_id:r.parent_id,depth:r.depth,our_comment_url:url,our_body:our_body||'',observed_at:now(),experiment:campaign}}],
      'resolution=ignore-duplicates,return=representation');
    if(rows.length)jobs.push(rows[0]);else jobs.push((await sb('GET',`jobs?select=*&dedupe_key=eq.${enc(key)}`))[0]);
  }
  return jobs;
}
async function verifyRecent(deadline=Infinity,followups=true){
  const cutoff=new Date(Date.now()-7*86400000).toISOString();
  const tasks=await sb('GET',`engain_tasks?select=*&project_id=eq.accounts-beta&reddit_url=not.is.null&status=not.in.(failed,cancelled,canceled,rejected,error,removed,deleted)&submitted_at=gte.${enc(cutoff)}&or=(next_check_at.is.null,next_check_at.lte.${enc(now())})&order=next_check_at.asc.nullsfirst&limit=5`);
  const accounts=await sb('GET','accounts?select=id,reddit_username');const ours=new Set(accounts.map(a=>a.reddit_username?.trim().toLowerCase().replace(/^u\//,'')).filter(Boolean));
  const results=[];
  for(const t of tasks){
    if(Date.now()>=deadline)break;
    if(DEAD.has(String(t.status).toLowerCase()))continue;
    const observed=await conversation(t.reddit_url),expectedAuthor=accounts.find(a=>a.id===t.user_account_id)?.reddit_username?.trim().toLowerCase().replace(/^u\//,'');
    let visibility=observed.visibility,reason=observed.reason||null;
    const [d]=t.draft_id?await sb('GET',`drafts?select=*&id=eq.${enc(t.draft_id)}`):[];
    if(observed.ok&&visibility==='visible'){
      const actualBody=observed.target?.body??observed.thread.body,author=(observed.target?.author||observed.thread.author||'').toLowerCase();
      let expectedParent=null;
      try{expectedParent=t.task_type==='reply'?`t1_${identity(d?.parent_url).comment_id}`:t.thread_id?`t3_${t.thread_id}`:null;}catch{}
      if(!expectedAuthor||author!==expectedAuthor||actualBody.replace(/\r\n/g,'\n').trim()!==String(t.content||'').replace(/\r\n/g,'\n').trim()
        ||(t.thread_id&&observed.thread.id!==t.thread_id)||(observed.target&&expectedParent&&observed.target.parent_id!==expectedParent)){
        visibility='unknown';reason='Returned comment identity, author, parent or content does not match the approved submission';
      }
    }
    let threadId=t.thread_id;
    if(observed.ok&&t.task_type==='post'&&!threadId&&visibility==='visible'){
      threadId=observed.thread.id;
      await sb('POST','threads?on_conflict=id',[{id:threadId,url:observed.url,title:observed.thread.title,subreddit:observed.thread.subreddit,locked:observed.thread.locked,archived:observed.thread.archived}],'resolution=merge-duplicates,return=minimal');
    }
    if(threadId)await remember(threadId,observed);
    const at=now(),published=t.published_at||at;
    await sb('PATCH',`engain_tasks?id=eq.${enc(t.id)}`,{visibility,observed_at:at,next_check_at:new Date(Date.now()+30*60000).toISOString(),
      ...(visibility==='visible'?{verified_at:at,published_at:published,thread_id:threadId,reddit_comment_id:observed.target?.id||null,parent_fullname:observed.target?.parent_id||null,reply_depth:observed.target?.depth??null}: {})},'return=minimal');
    if(visibility==='visible'){
      if(t.draft_id)await sb('PATCH',`drafts?id=eq.${enc(t.draft_id)}&status=neq.rejected`,{status:'posted',posted_url:t.reddit_url,posted_at:published,engain_status:t.status,engain_seen_at:at},'return=minimal');
      if(followups)await sb('PATCH',`scenario_acts?task_id=eq.${enc(t.id)}&status=neq.rejected`,{status:'published',url:t.reddit_url,published_at:published},'return=minimal');
      const parent=observed.target?.fullname||`t3_${threadId}`;
      const replies=observed.comments.filter(r=>r.parent_id===parent&&r.visibility==='visible'&&r.author&&r.author!=='[deleted]'&&r.author.toLowerCase()!=='automoderator'&&!ours.has(r.author.toLowerCase()));
      if(followups&&!observed.thread.locked&&!observed.thread.archived&&!observed.thread.removed)await planReplies({replies,url:t.reddit_url,thread_id:threadId,account_id:t.user_account_id,our_body:t.content,experiment:experiment(d?.thread_context?.experiment)});
    }else if(['removed','deleted'].includes(visibility)){
      if(t.draft_id)await sb('PATCH',`drafts?id=eq.${enc(t.draft_id)}&status=neq.rejected`,{status:'removed'},'return=minimal');
      await blockBranch(t.reddit_url,'The watched parent is '+visibility);
    }
    await record({...t,thread_id:threadId},visibility==='visible'?'verified_published':visibility,reason,'reddit');
    results.push({task:t.id,visibility,reason});
  }
  return results;
}
async function checkJobs(deadline=Infinity){
  const actor='cron/tick',jobs=await sb('POST','rpc/claim_jobs',{p_agent:actor,p_kinds:['check_replies'],p_limit:3});
  const ours=new Set((await sb('GET','accounts?select=reddit_username')).map(a=>a.reddit_username?.trim().toLowerCase().replace(/^u\//,'')).filter(Boolean));
  const results=[];
  for(const j of jobs){
    const done=(status,result,retry)=>sb('POST','rpc/complete_job',{p_id:j.id,p_agent:actor,p_token:j.claim_token,p_status:status,p_result:result,p_retry_minutes:retry??null});
    if(Date.now()>=deadline){await done('blocked',{reason:'Tick budget exhausted'},15);continue;}
    try{
      const observed=await repliesTo(j.target_url,ours);
      if(!observed.ok){await done('blocked',{reason:observed.reason},observed.gone?null:15);continue;}
      const planned=await planReplies({replies:observed.replies,url:observed.url,thread_id:j.thread_id,account_id:j.account_id,our_body:observed.comment.body});
      await done('done',{reader_replies:observed.replies.length,followup_job_ids:planned.map(p=>p.id)});results.push({job:j.id,jobs:planned.length});
    }catch(e){await done('blocked',{reason:e.message},15);results.push({job:j.id,error:e.message});}
  }
  return results;
}
module.exports={vendorState,vendorReason,reconcile,poll,verifyRecent,checkJobs,planReplies,blockBranch};
