// TRANSPARENCY ENFORCEMENT: Only owned accounts (accounts-beta) may post.
// Pooled accounts are permanently disabled per GeoNode's transparency requirements.
const {engain,sb}=require('./_db.js');
const enc=encodeURIComponent;
async function capabilities(){
  // HARD REQUIREMENT: We only use owned/beta accounts for transparency.
  // Pooled accounts where Engain chooses the account are NOT permitted.
  const requested=process.env.ENGAIN_DELIVERY||'owned';
  
  // Block pooled mode explicitly
  if(requested==='pool'||requested==='pooled'){
    throw Error('TRANSPARENCY VIOLATION: Pooled accounts are disabled. GeoNode only posts from owned accounts with clear disclosure. Set ENGAIN_DELIVERY=owned or remove it.');
  }
  
  const me=await engain('GET','/api/v1/me');
  if(me.status>=300)throw Error('Engain identity unavailable ('+me.status+')');
  const projects=me.json.projects||[];
  const project=process.env.ENGAIN_PROJECT_ID||projects.find(p=>/^(geonode|geonode\.com)$/i.test(p.name))?.id||(projects.length===1?projects[0].id:null);
  
  // Fetch owned accounts from accounts-beta
  let accounts=[];
  const result=await engain('GET','/api/v1/accounts-beta/accounts');
  if(result.status<300)accounts=(result.json.accounts||[]).filter(a=>a.usable===true);
  
  if(accounts.length===0){
    throw Error('No owned accounts available. GeoNode requires owned/beta accounts with clear disclosure for all posting. Configure accounts via Engain accounts-beta API.');
  }
  
  return {project_id:project||null,accounts,requested:'owned',
    available:accounts.length>0,
    mode:'owned',reason:null};
}
async function choose(caps,parentTransport){
  if(!caps.available)throw Error(caps.reason||'Engain delivery is unavailable');
  
  // TRANSPARENCY ENFORCEMENT: Never return pool mode
  if(caps.mode==='pool'){
    throw Error('TRANSPARENCY VIOLATION: Pool mode disabled. Only owned accounts permitted.');
  }
  
  const recent=await sb('GET','message_publications?select=transport&state=neq.failed&order=created_at.desc&limit=100');
  const count=id=>recent.filter(r=>r.transport?.account_id===id).length;let accounts=caps.accounts;
  
  // Prefer configured account if specified
  if(process.env.ENGAIN_PRIVATE_ACCOUNT_ID)accounts=accounts.filter(a=>a.userAccountId===process.env.ENGAIN_PRIVATE_ACCOUNT_ID);
  // For thread replies, avoid same account (but transparency module will block staged conversations)
  else if(accounts.length>1&&parentTransport?.account_id)accounts=accounts.filter(a=>a.userAccountId!==parentTransport.account_id);
  
  const a=accounts.sort((a,b)=>count(a.userAccountId)-count(b.userAccountId)||a.userAccountId.localeCompare(b.userAccountId))[0];
  if(!a)throw Error('The configured delivery account is unavailable');
  
  return {mode:'owned',account_id:a.userAccountId,username:String(a.profileUsername||'').replace(/^u\//i,'')||null,project_id:caps.project_id};
}
async function check(message,thread,observation,projectId){
  if(!projectId)return {verdict:'skipped',summary:'Engain rule check needs a project; this workspace uses private-account delivery.',source:'no_project'};
  const result=await engain('POST','/api/v1/rule-check',{projectId,subreddit:thread.subreddit,taskType:message.kind,content:message.body,mediaKind:'text',
    context:{postUrl:thread.url,postTitle:observation.thread.title,postBody:observation.thread.body,
      ...(message.kind==='reply'?{parentCommentUrl:message.target_url,parentComment:observation.target?.body}:{})}});
  if(result.status>=300)return {verdict:'unavailable',http_status:result.status,summary:result.status===429?'Engain rule check is rate limited. It will retry.':'Engain rule check unavailable ('+result.status+')'};
  return {...result.json,checked_at:new Date().toISOString(),source:'engain'};
}
async function submit(message,transport){
  // TRANSPARENCY ENFORCEMENT: Only accounts-beta (owned accounts) submissions permitted
  if(transport.mode!=='owned'&&transport.mode!=='private'){
    throw Error('TRANSPARENCY VIOLATION: Can only submit via owned accounts (accounts-beta). Pool mode is disabled.');
  }
  return engain('POST','/api/v1/accounts-beta/comments',{userAccountId:transport.account_id,targetUrl:message.target_url,body:message.body});
}
async function privateTasks(cursor){return engain('GET','/api/v1/accounts-beta/comments',undefined,cursor?{cursor}:{});}
async function task(message,privateIndex){
  // TRANSPARENCY ENFORCEMENT: Only owned account tasks
  if(message.transport?.mode==='owned'||message.transport?.mode==='private')return {status:200,json:privateIndex.get(message.task_id)||null};
  throw Error('TRANSPARENCY VIOLATION: Only owned account tasks are supported.');
}
function canonical(value){return String(value||'').replace(/\/+$/,'');}
async function findAttempt(attempt,privateIndex){
  // TRANSPARENCY ENFORCEMENT: Only owned account lookups
  if(attempt.transport.mode==='owned'||attempt.transport.mode==='private'){
    return [...privateIndex.values()].filter(t=>(Number(t._creationTime)||Date.parse(t.creationDate||t.createdAt))>=Date.parse(attempt.created_at)-60000&&t.userAccountId===attempt.transport.account_id&&t.body===attempt.body&&canonical(t.targetUrl)===canonical(attempt.target_url));
  }
  throw Error('TRANSPARENCY VIOLATION: Only owned account tasks are supported.');
}
function reason(task){const v=task.removalReason||task.statusMessage||task.lastSendError||task.error||task.failureReason||task.cancelReason||task.cancellationReason||task.reason;return v==null?null:(typeof v==='string'?v:JSON.stringify(v)).slice(0,2000);}
function state(task){
  const status=String(task.status||'unknown').toLowerCase();
  if(['automod_removed','mod_removed','main_comment_removed_deleted','user_deleted','removed','deleted'].includes(status))return {state:'removed',removal:({automod_removed:'automod',mod_removed:'moderator',main_comment_removed_deleted:'parent',user_deleted:'author',deleted:'author'})[status]||'unknown'};
  if(['failed','cancelled','canceled','error','rejected','post_url_broken','subreddit_private_banned','incorrect_missing_flair','thread_archived_locked'].includes(status))return {state:'failed',reason:reason(task)||status};
  return {state:'waiting',reason:reason(task)};
}
async function cancel(message){
  // TRANSPARENCY ENFORCEMENT: Only owned account cancellations
  if(message.transport?.mode!=='owned'&&message.transport?.mode!=='private'){
    throw Error('TRANSPARENCY VIOLATION: Can only cancel owned account tasks.');
  }
  return engain('POST','/api/v1/accounts-beta/comments/'+enc(message.task_id)+'/cancel',null);
}
module.exports={capabilities,choose,check,submit,privateTasks,task,findAttempt,canonical,state,reason,cancel};
