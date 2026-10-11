const {sb}=require('./_db.js');
const {check}=require('./_rules.js');
const {context,playbookContext}=require('./_workflow.js');
const enc=encodeURIComponent;
async function enabled(){
  const [setting]=await sb('GET','workflow_state?select=value&key=eq.publishing');
  return setting?.value?.automatic===true;
}
async function prepareDraft(id){
  const [draft]=await sb('GET',`drafts?select=*&id=eq.${enc(id)}`);
  if(!draft||!['pending','edited','approved'].includes(draft.status)||draft.redirect_pending||draft.gate_failed_at||draft.pullback_requested_at||draft.mode==='scenario')return {ready:false,reason:'Draft is stopped or awaiting a rewrite'};
  if(draft.status==='approved'&&draft.send_cleared_at&&draft.account_id)return {ready:true,draft};
  const [account]=await sb('POST','rpc/choose_draft_account',{p_draft_id:id});
  if(!account)return {ready:false,reason:'No account is currently available'};
  const line=String(account.disclosure_line||'').trim();
  const body=line&&!draft.body.includes(line)?draft.body.trim()+'\n\n'+line:draft.body;
  const verdict=check(body,{kind:draft.kind,disclosure_line:line});
  if(!verdict.ok){
    await sb('PATCH',`drafts?id=eq.${enc(id)}&body=eq.${enc(draft.body)}&status=in.(pending,edited,approved)`,{
      status:'pending',send_cleared_at:null,redirect_pending:true,redirect_note:'Automatic checks require a rewrite: '+verdict.fails.join(' | ')
    },'return=minimal');
    return {ready:false,reason:verdict.fails.join(' | ')};
  }
  let snapshot=draft.thread_context||{};
  if(draft.kind!=='post'){
    const latest=await context(draft.thread_id,draft.kind==='reply'?draft.parent_url:null),o=latest.observation;
    if(!o.ok||o.visibility!=='visible'||o.thread.locked||o.thread.archived||o.thread.removed)return {ready:false,reason:o.reason||'Thread or parent unavailable'};
    if(draft.kind==='reply'&&snapshot.parent?.body&&snapshot.parent.body!==o.target?.body){
      await sb('PATCH',`drafts?id=eq.${enc(id)}&body=eq.${enc(draft.body)}&status=in.(pending,edited,approved)`,{status:'pending',send_cleared_at:null,redirect_pending:true,redirect_note:'Parent changed. Read current context and revise the reply.'},'return=minimal');
      return {ready:false,reason:'Parent changed; the writer will refresh the draft'};
    }
    snapshot={...snapshot,version:latest.version,observed_at:o.observed_at,parent:o.target||null,thread:o.thread,title:o.thread.title,url:latest.thread.url,subreddit:o.thread.subreddit};
  }
  const play=await playbookContext(draft.origin_job_id,account.id,draft.parent_url);
  if(play.playbook&&!play.ready)return {ready:false,reason:play.reason};
  if(draft.kind==='reply'&&!play.self_reply&&await sb('POST','rpc/is_our_url',{p_url:draft.parent_url}))return {ready:false,reason:'Reply needs an assigned playbook parent'};
  const result=await sb('POST','rpc/prepare_automatic_draft',{p_draft_id:id,p_expected_body:draft.body,p_account_id:account.id,p_body:body,p_context:snapshot});
  return {ready:!!result,draft:result};
}
async function prepareQueue(deadline=Infinity){
  if(!await enabled())return [];
  const rows=await sb('GET','drafts?select=id&status=in.(pending,edited,approved)&or=(send_cleared_at.is.null,account_id.is.null)&redirect_pending=eq.false&gate_failed_at=is.null&pullback_requested_at=is.null&mode=neq.scenario&order=automatic_checked_at.asc.nullsfirst,created_at.asc&limit=20');
  const results=[];
  for(const row of rows){
    if(Date.now()>=deadline)break;
    let result;
    try{result=await prepareDraft(row.id);}catch(e){result={ready:false,reason:e.message};}
    results.push({id:row.id,...result});
    if(!result.ready)await sb('PATCH',`drafts?id=eq.${enc(row.id)}&status=in.(pending,edited,approved)`,{automatic_note:result.reason,automatic_checked_at:new Date().toISOString()},'return=minimal');
  }
  return results.map(({id,ready,reason})=>({id,ready,reason}));
}
module.exports={enabled,prepareDraft,prepareQueue};
