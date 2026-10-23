const {sb}=require('./_db.js');
const workflow=require('./_workflow.js');
const messages=require('./_messages.js');
const library=require('./_library.js');
const {createHash}=require('node:crypto');
const enc=encodeURIComponent;
const fail=(status,message)=>{const e=Error(message);e.status=status;throw e;};
function agentName(input){const name=String(input.agent||'').trim();if(!name||name.length>80)fail(422,'Supply a stable agent name of 1–80 characters.');return name;}
function queueItem(m){
  const state=m.status==='visible'?(m.verified_at?'verified_on_reddit':m.provider_published_at?'published_by_engain':'publication_unknown'):
    m.status==='submitted'?(m.provider_status||'with_engain'):
    m.status==='queued'&&m.reason?'waiting':m.status;
  return {id:m.id,task_id:m.job_id,type:m.kind==='reply'?'write_reply':'write_comment',state,
    mode:m.content_action||m.suggested_action,placement:m.reply_mode,body:m.body,target_url:m.target_url,
    approved_at:m.approved_at,approved_by:m.approved_by,engain_task_id:m.task_id,
    engain_status:m.provider_status,engain_check:m.rule_check,reddit_url:m.reddit_url,
    provider_published_at:m.provider_published_at,reddit_verified_at:m.verified_at,
    reason:m.reason,next_check_at:m.next_check_at,due_at:m.decision_due_at,
    next_action:m.status==='awaiting_draft'?'write':m.status==='held'?'revise_or_skip':
      ['queued','submitting','submitted','unknown','visible'].includes(m.status)?'server_handles_delivery_and_followups':'none'};
}
function task(j){
  return {id:j.id,type:j.message?.kind==='reply'?'write_reply':'write_comment',message_id:j.message?.id,
    lease_token:j.claim_token,lease_expires_at:j.lease_until,checkpoint:j.checkpoint,
    can_write:j.actionable===true,reason:j.context_error||j.library_selection?.reasons?.join('; ')||(!j.actionable?j.context?.observation?.reason||'This task is not currently writable.':null),
    mode:j.message?.suggested_action,assignment:j.writer_environment?.assignment,prompt:j.writer_environment?.prompt,brand:j.decision_context?.brand,
    context:j.context,history:j.history,source_message:j.source_message,targets:j.parent_options,
    limits:j.decision_context?.limits,strategies:j.decision_context?.content_actions,
    submit:{method:'POST',path:'/api/agent/work/'+j.id,required:['agent','lease_token','body'],
      optional:['placement (required when there are multiple targets)','mode','mode_reason','rationale','draft_body','humanization'],
      note:'Use the assigned mode by default. Submission records automatic approval and queues Engain delivery. Then request the next task.'}};
}
async function next(input){
  const agent=agentName(input);
  const deferred=[];
  async function available(j){
    if(j.message?.step===1&&j.context?.observation?.code==='engain_opportunity_missing'){
      // Old manual targets must not starve current Engain writing work.
      const reason=j.context.observation.reason;
      await sb('POST','rpc/finish_writing_task',{p_id:j.id,p_agent:agent,p_token:j.claim_token,p_outcome:'defer',p_reason:reason,p_retry_minutes:60});
      deferred.push({task_id:j.id,reason});return false;
    }
    return true;
  }
  // A lost response must return the owned task, not silently consume another.
  const [owned]=await sb('GET','jobs?select=*&kind=eq.write&queue_lane=eq.work&status=eq.claimed&claimed_by=eq.'+enc(agent)+'&lease_until=gt.'+enc(new Date().toISOString())+'&order=claimed_at&limit=1');
  if(owned?.payload?.message_id){const j=await workflow.jobContext(owned);if(await available(j))return {task:task(j),source:'owned_task',deferred};}
  let claimed;
  for(let i=0;i<5;i++){
    claimed=await workflow.claim({agent,kinds:['write'],limit:1});
    if(!claimed.jobs.length)break;
    if(await available(claimed.jobs[0]))return {task:task(claimed.jobs[0]),source:'writing_queue',deferred};
  }
  if(input.discover===false)return {task:null,deferred,next_action:'No writing task is due. Server delivery continues automatically.'};
  let candidates=await library.list({limit:5});
  if(!candidates.items.length){await library.collect(Date.now()+20000);candidates=await library.list({limit:5});}
  const skipped=[];
  for(const candidate of candidates.items.slice(0,3)){
    const hex=createHash('sha256').update('live-writing:'+candidate.thread_id).digest('hex');
    const request_id=hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-8'+hex.slice(17,20)+'-'+hex.slice(20,32);
    try{
      const flow=await library.queue(candidate.thread_id,{request_id,queue_lane:'work'});
      claimed=await workflow.claim({agent,kinds:['write'],limit:1,experiment_id:flow.id});
      if(claimed.jobs.length)return {task:task(claimed.jobs[0]),source:'engain_opportunity',deferred};
    }catch(e){skipped.push({thread_id:candidate.thread_id,reason:e.message});}
  }
  return {task:null,skipped,deferred,next_action:'No eligible Engain thread is available now. Try again later; delivery and collection continue automatically.'};
}
async function submit(id,input){
  const agent=agentName(input);
  if(!input.lease_token)fail(422,'Return the lease_token supplied with this task.');
  const [j]=await sb('GET','jobs?select=*&id=eq.'+enc(id));
  if(!j?.payload?.message_id||j.queue_lane!=='work')fail(404,'Writing task not found.');
  if(input.outcome){
    if(!['skip','defer','blocked'].includes(input.outcome)||!String(input.reason||'').trim())fail(422,'Use skip, defer or blocked with a reason.');
    await workflow.ownedJob(id,agent,input.lease_token);
    const job=await sb('POST','rpc/finish_writing_task',{p_id:id,p_agent:agent,p_token:input.lease_token,
      p_outcome:input.outcome,p_reason:String(input.reason),p_retry_minutes:Math.max(1,Math.min(Math.round(Number(input.retry_minutes)||30),1440))});
    return {task_id:id,state:job.status,next_call:'POST /api/agent/work/next'};
  }
  const m=await messages.getMessage(j.payload.message_id);
  let placement=input.placement||m.reply_mode||(m.step===1?'opening':m.step===2?'reply':null);
  if(!placement)fail(422,'Choose chain or sibling from the task targets.');
  const saved=await messages.file(m.id,{agent,claim_token:input.lease_token,body:input.body,
    reply_mode:placement,content_action:input.mode||m.content_action||m.suggested_action,
    action_override_reason:input.mode_reason,rationale:input.rationale,draft_body:input.draft_body,humanization:input.humanization});
  return {queued:true,item:queueItem(saved),next_call:'POST /api/agent/work/next',
    next_action:'Write the next task. The server runs Engain checks, submits this comment, records status and queues eligible follow-up work.'};
}
async function queue(input={}){
  const limit=Math.max(1,Math.min(Number(input.limit)||50,100)),offset=Math.max(0,Number(input.offset)||0);
  if(!Number.isInteger(limit)||!Number.isInteger(offset))fail(422,'Use integer limit and offset.');
  const rows=await sb('GET','experiment_messages?select=*&order=created_at.desc,id&limit='+(limit+1)+'&offset='+offset);
  return {items:rows.slice(0,limit).map(queueItem),next_offset:rows.length>limit?offset+limit:null,
    delivery:'automatic',status_source:'Engain publication and independent Reddit verification are reported separately.'};
}
module.exports={next,submit,queue,queueItem};
