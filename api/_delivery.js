// Task API: provider chooses the account. Private accounts use the existing accounts-beta transport.
const {engain,sb}=require('./_db.js');
const enc=encodeURIComponent;
async function capabilities(){
  const me=await engain('GET','/api/v1/me');
  if(me.status>=300)throw Error('Engain identity unavailable ('+me.status+')');
  const projects=me.json.projects||[];
  const project=process.env.ENGAIN_PROJECT_ID||projects.find(p=>/^(geonode|geonode\.com)$/i.test(p.name))?.id||(projects.length===1?projects[0].id:null);
  const requested=process.env.ENGAIN_DELIVERY||'auto';let accounts=[];
  if((!project&&requested==='auto')||requested==='private'){
    const result=await engain('GET','/api/v1/accounts-beta/accounts');
    if(result.status<300)accounts=(result.json.accounts||[]).filter(a=>a.usable===true);
  }
  return {project_id:project||null,accounts,requested,
    available:requested==='pool'?!!project:requested==='private'?accounts.length>0:!!project||accounts.length>0,
    mode:requested==='pool'?'pool':requested==='private'||!project?'private':'pool',reason:!project&&!accounts.length?(requested==='pool'?'Pooled delivery requires an accessible project. Private fallback is disabled.':'Engain has no accessible project or available private posting account.'):null};
}
async function choose(caps,parentTransport){
  if(!caps.available)throw Error(caps.reason||'Engain delivery is unavailable');
  if(caps.mode==='pool')return {mode:'pool',project_id:caps.project_id};
  const recent=await sb('GET','message_publications?select=transport&state=neq.failed&order=created_at.desc&limit=100');
  const count=id=>recent.filter(r=>r.transport?.account_id===id).length;let accounts=caps.accounts;
  if(process.env.ENGAIN_PRIVATE_ACCOUNT_ID)accounts=accounts.filter(a=>a.userAccountId===process.env.ENGAIN_PRIVATE_ACCOUNT_ID);
  else if(accounts.length>1&&parentTransport?.account_id)accounts=accounts.filter(a=>a.userAccountId!==parentTransport.account_id);
  const a=accounts.sort((a,b)=>count(a.userAccountId)-count(b.userAccountId)||a.userAccountId.localeCompare(b.userAccountId))[0];
  if(!a)throw Error('The configured delivery account is unavailable');
  return {mode:'private',account_id:a.userAccountId,username:String(a.profileUsername||'').replace(/^u\//i,'')||null,project_id:caps.project_id};
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
  if(transport.mode==='private')return engain('POST','/api/v1/accounts-beta/comments',{userAccountId:transport.account_id,targetUrl:message.target_url,body:message.body});
  return engain('POST','/api/v1/tasks/'+message.kind,{projectId:transport.project_id,url:message.target_url,content:message.body,
    labels:['experiment:'+message.experiment_id,'message:'+message.id]});
}
async function privateTasks(cursor){return engain('GET','/api/v1/accounts-beta/comments',undefined,cursor?{cursor}:{});}
async function task(message,privateIndex){
  if(message.transport?.mode==='private')return {status:200,json:privateIndex.get(message.task_id)||null};
  return engain('GET','/api/v1/tasks/'+enc(message.task_id));
}
function canonical(value){return String(value||'').replace(/\/+$/,'');}
async function findAttempt(attempt,privateIndex){
  if(attempt.transport.mode==='private')return [...privateIndex.values()].filter(t=>(Number(t._creationTime)||Date.parse(t.creationDate||t.createdAt))>=Date.parse(attempt.created_at)-60000&&t.userAccountId===attempt.transport.account_id&&t.body===attempt.body&&canonical(t.targetUrl)===canonical(attempt.target_url));
  const result=await engain('GET','/api/v1/tasks',undefined,{projectId:attempt.transport.project_id,numItems:100,createdAfter:attempt.created_at});
  if(result.status>=300)return [];
  return (result.json.page||[]).filter(t=>(t.labels||[]).includes('message:'+attempt.message_id)&&t.content===attempt.body&&canonical(t.threadUrl)===canonical(attempt.target_url));
}
function reason(task){const v=task.removalReason||task.statusMessage||task.lastSendError||task.error||task.failureReason||task.cancelReason||task.cancellationReason||task.reason;return v==null?null:(typeof v==='string'?v:JSON.stringify(v)).slice(0,2000);}
function state(task){
  const status=String(task.status||'unknown').toLowerCase();
  if(['automod_removed','mod_removed','main_comment_removed_deleted','user_deleted','removed','deleted'].includes(status))return {state:'removed',removal:({automod_removed:'automod',mod_removed:'moderator',main_comment_removed_deleted:'parent',user_deleted:'author',deleted:'author'})[status]||'unknown'};
  if(['failed','cancelled','canceled','error','rejected','post_url_broken','subreddit_private_banned','incorrect_missing_flair','thread_archived_locked'].includes(status))return {state:'failed',reason:reason(task)||status};
  return {state:'waiting',reason:reason(task)};
}
async function cancel(message){const endpoint=message.transport?.mode==='private'?'/api/v1/accounts-beta/comments/':'/api/v1/tasks/';return engain('POST',endpoint+enc(message.task_id)+'/cancel',null);}
module.exports={capabilities,choose,check,submit,privateTasks,task,findAttempt,canonical,state,reason,cancel};
