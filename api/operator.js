const {sb,engain,event}=require('./_db.js');
const {authorized}=require('./_operator-auth.js');
const RPC=new Set(['review_draft','redirect_draft','request_pullback','approve_draft_batch','review_script_segment',
  'review_scenario_run','set_account_disclosed','save_sequence','start_sequence_run','start_playbook_run','cancel_sequence_run','update_queued_draft']);
module.exports=async(req,res)=>{
  const out=(status,value)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value));};
  if(req.method!=='POST')return out(405,{error:'POST required'});
  try{
    if(!await authorized(req))return out(401,{error:'Sign in to manage this dashboard.'});
    const input=typeof req.body==='string'?JSON.parse(req.body):req.body||{};
    if(['start_playbook_run','start_sequence_run'].includes(input.rpc)&&await require('./_messages.js').enabled())
      return out(410,{error:'Start a message experiment from the Experiments page.'});
    if(input.retry_job){
      if(!String(input.note||'').trim())return out(422,{error:'Explain why this job is safe to retry'});
      const id=encodeURIComponent(input.retry_job);
      const rows=await sb('PATCH',`jobs?id=eq.${id}&status=in.(blocked,failed)&draft_id=is.null`,{status:'planned',attempts:0,claim_token:null,lease_until:null,finished_at:null,
        due_at:new Date().toISOString(),blocked_reason:null,result:{operator_retry:input.note}},'return=representation');
      if(!rows.length)return out(409,{error:'Retry only blocked/failed jobs without a filed draft. Revise existing drafts through review.'});
      await event({event_key:'job-retry:'+input.retry_job+':'+Date.now(),event:'job_requeued',source:'operator',reason:input.note,detail:{job_id:input.retry_job}});
      return out(200,{job:rows[0]});
    }
    if(input.reconcile_attempt&&input.task_id){
      const [attempt]=await sb('GET',`publication_attempts?select=*&id=eq.${encodeURIComponent(input.reconcile_attempt)}`);
      if(!attempt)return out(404,{error:'Attempt not found'});
      const endpoint='/api/v1/accounts-beta/'+(attempt.task_type==='post'?'posts':'comments');
      let cursor=null,task=null;
      for(let page=0;page<4;page++){
        const response=await engain('GET',endpoint,null,cursor?{cursor}:undefined);
        if(response.status>=300)return out(503,{error:'Engain reconciliation unavailable'});
        task=(response.json.page||[]).find(t=>(t._id||t.id)===input.task_id);
        if(task||response.json.isDone)break;
        cursor=response.json.continueCursor;if(!cursor)break;
      }
      if(!task)return out(409,{error:'Task not found in the inspected vendor pages. Attempt remains held.'});
      const expectedTarget=attempt.parent_url||attempt.thread_url;
      const canonical=x=>String(x||'').replace(/\/+$/,'');
      if(task.userAccountId!==attempt.account_id||task.body!==attempt.body||
        (attempt.task_type==='post'?task.subreddit!==attempt.subreddit:canonical(task.targetUrl)!==canonical(expectedTarget)))
        return out(409,{error:'Vendor task does not match the saved account, content and target'});
      const accepted=await sb('POST','rpc/accept_publication',{p_attempt_id:attempt.id,p_task_id:input.task_id,p_status:task.status,p_response:{status:task.status,reconciled_by:'operator'}});
      await event({event_key:'reconciled:'+attempt.id,event:'submission_reconciled',source:'operator',draft_id:attempt.draft_id,task_id:input.task_id,thread_id:attempt.thread_id});
      return out(200,{task:accepted});
    }
    if(input.rpc&&RPC.has(input.rpc))return out(200,await sb('POST','rpc/'+input.rpc,{...input.args,p_editor:'operator'}));
    if(input.draft_id&&/^[0-9a-f-]{36}$/i.test(input.draft_id)){
      const requested=input.patch||{},patch={},at=new Date().toISOString();
      if(Object.hasOwn(requested,'account_id'))patch.account_id=requested.account_id;
      if(requested.parent_confirmed_by){patch.parent_confirmed_by='operator';patch.parent_confirmed_at=at;}
      if(requested.send_cleared_at){patch.send_cleared_at=at;patch.pullback_requested_at=null;}
      if(!Object.keys(patch).length)return out(422,{error:'Unsupported draft change'});
      const [d]=await sb('GET',`drafts?select=status,origin_job_id,parent_url&id=eq.${input.draft_id}`);
      if(!d||!['pending','edited','approved'].includes(d.status))return out(409,{error:'Draft is no longer editable'});
      if(Object.hasOwn(patch,'account_id')){
        const play=await require('./_workflow.js').playbookContext(d.origin_job_id,patch.account_id,d.parent_url);
        if(play.playbook&&!play.ready)return out(409,{error:play.reason});
      }
      if(patch.send_cleared_at&&d.status!=='approved')return out(409,{error:'Approve this draft before releasing it'});
      return out(200,await sb('PATCH',`drafts?id=eq.${input.draft_id}&status=eq.${d.status}`,patch,'return=representation'));
    }
    return out(422,{error:'Unsupported operator action'});
  }catch(e){return out(e.status||400,{error:e.message});}
};
