// Queue2 sending with safety guards for both pooled and accounts-beta delivery
const fail=(status,msg)=>{throw Object.assign(Error(msg),{status});};

// Production transparency check (reuse from api/_rules.js concepts)
const DISCLOSURE_PATTERNS=[
  /geonode/i,
  /\b(disclosure|disclaimer|affiliated|affiliation|work\s+for|work\s+at|employed\s+by|employed\s+at|represent|associated\s+with)\b/i
];

function checkDisclosure(body){
  if(!body||typeof body!=='string')return {ok:false,reason:'Empty message body'};
  const text=body.toLowerCase();
  
  // Must mention GeoNode
  if(!DISCLOSURE_PATTERNS[0].test(text))
    return {ok:false,reason:'Must mention GeoNode (transparency requirement)'};
  
  // Must have disclosure language
  if(!DISCLOSURE_PATTERNS[1].test(text))
    return {ok:false,reason:'Must include disclosure language (e.g. "disclosure: I work for GeoNode")'};
  
  return {ok:true};
}

// No sending limits: no spacing between sends, none per subreddit, no daily cap (owner's call).
// Sends are still recorded in queue2_pacing for visibility.

// Extract subreddit from URL
function subredditFromUrl(url){
  const match=url?.match(/\/r\/([^/]+)\//);
  return match?match[1]:null;
}

// Send one queue2 entry
async function sendQueue2({id,mode,userAccountId,posterAccount,override},

{engain,store,projectId,log=console.log}){
  const item=store.queue2(id);
  if(!item)fail(404,'Queue2 entry not found');
  
  // Guard: already sent
  if(item.send_status!=='ready'){
    fail(409,`Cannot send: status is ${item.send_status} (must be ready)`);
  }
  
  // Guard: placeholder message
  if(item.message_source==='random'){
    fail(422,'Cannot send placeholder message (message_source is random). Replace with real message first.');
  }
  if(/^placeholder message:/i.test(item.message)){
    fail(422,'Cannot send: message starts with "Placeholder message:". Replace with real message first.');
  }
  
  // Guard: an OpenRouter draft goes out only after a person approves it (editing withdraws approval).
  if(item.write_status==='skipped')fail(422,'The writer skipped this item; there is no message to send.');
  if(item.write_status==='truncated')fail(422,'This message was cut off at the length limit. Rewrite or edit it first.');
  if(item.message_source==='openrouter'&&!item.approved_at)fail(409,'Approve this message before sending it.');

  // Guard: disclosure
  const disclosure=checkDisclosure(item.message);
  if(!disclosure.ok){
    fail(422,`Transparency violation: ${disclosure.reason}`);
  }
  
  // Delivery: 'pool' (Engain's posters) or 'dedicated' (one of our accounts, Engain API v2).
  // 'beta' is accepted as the old name and stored as 'beta' (the column's CHECK predates v2).
  if(mode==='dedicated')mode='beta';
  if(!['pool','beta'].includes(mode))fail(422,'mode must be pool or dedicated');
  const accountId=userAccountId;
  if(mode==='beta'){
    if(!accountId)fail(422,'accountId (userAccountId) is required to post from a dedicated account');
    // Engain v2: dedicated accounts post comments on threads, not replies to comments.
    if(item.kind!=='thread')fail(422,'Dedicated accounts cannot post replies (Engain API v2). Send this one through the pool.');
  }
  if(mode==='pool'&&posterAccount&&(typeof posterAccount!=='number'||posterAccount<1||posterAccount>40)){
    fail(422,'posterAccount must be 1-40');
  }

  // Extract subreddit
  const subreddit=subredditFromUrl(item.url||item.thread_url);
  if(!subreddit)fail(422,'Cannot extract subreddit from URL');

  // Guard: a dedicated account comments on a thread at most once (unless overridden).
  if(mode==='beta'&&!override?.thread_check){
    let check=null;
    try{check=await engain.v2ThreadCheck(accountId,{projectId,threadUrl:item.thread_url||item.url});}
    catch(e){log(`Thread check failed (non-fatal): ${e.message}`);}
    if(check?.exists)fail(409,`This account already has ${check.count||1} comment(s) on this thread. Pick another account or set override.thread_check.`);
  }

  // Reserve for sending (idempotency)
  const reserved=store.reserveQueue2Send(id,mode,mode==='beta'?accountId:posterAccount);
  if(!reserved){
    fail(409,'Failed to reserve entry (already sending or not ready)');
  }

  try{
    let response,taskId;

    if(mode==='pool'){
      // Pooled: comment vs reply endpoint
      const payload={projectId,url:item.url,content:item.message};
      if(posterAccount)payload.posterAccount=posterAccount;

      if(item.kind==='thread'){
        response=await engain.createCommentTask(payload);
      }else{
        // kind=comment or mention -> reply
        response=await engain.createReplyTask(payload);
      }

      taskId=response.id||response._id||response.taskId;
    }else{
      // Dedicated account: POST /api/v2/tasks/comment with accountId
      response=await engain.v2CreateComment({projectId,url:item.url,content:item.message,accountId});
      taskId=response._id||response.id;
    }

    if(!taskId){
      store.failQueue2Send(id,'No task ID in response',JSON.stringify(response).slice(0,500));
      return {ok:false,status:'unknown',reason:'No task ID in Engain response',response};
    }
    
    // Record success
    store.recordQueue2Send(id,taskId,response);
    store.recordQueue2Pace(subreddit);
    
    log(`✓ Sent queue2 #${id} via ${mode}: task ${taskId}`);
    
    return {ok:true,status:'submitted',taskId,mode,queue2_id:id,item_id:item.item_id,response};
    
  }catch(e){
    const reason=e.status===429?'Rate limited':e.status===403?'Forbidden':e.status>=500?'Server error':`Engain ${e.status||'error'}`;
    store.failQueue2Send(id,reason,e.message);
    throw e;
  }
}

// Poll status for one queue2 entry
async function pollQueue2Status(id,{engain,store,log=console.log}){
  const item=store.queue2(id);
  if(!item)fail(404,'Queue2 entry not found');
  if(!item.engain_task_id)fail(409,'No Engain task ID (not sent yet)');
  if(!item.delivery_mode)fail(409,'No delivery mode recorded');
  
  try{
    // GET /api/v2/tasks/{id} serves pool and dedicated-account tasks alike.
    const task=await engain.v2GetTask(item.engain_task_id);

    const status=String(task.status||'unknown').toLowerCase();
    const redditUrl=task.redditUrl||task.resultUrl||null;
    
    // Map to our status
    if(status==='published'&&redditUrl){
      store.updateQueue2Status(id,'published',redditUrl,null);
      log(`✓ Queue2 #${id} published: ${redditUrl}`);
      return {status:'published',redditUrl,engainStatus:status};
    }
    
    const failed=['automod_removed','mod_removed','user_deleted','main_comment_removed_deleted',
      'error','failed','cancelled','canceled','rejected','post_url_broken','thread_archived_locked','subreddit_private_banned'];
    
    if(failed.includes(status)){
      store.updateQueue2Status(id,'failed',null,`Engain status: ${status}`);
      log(`✗ Queue2 #${id} failed: ${status}`);
      return {status:'failed',reason:status,engainStatus:status};
    }
    
    // Still pending
    store.updateQueue2Status(id,'submitted',null,null);
    return {status:'pending',engainStatus:status};
    
  }catch(e){
    log(`Poll error for queue2 #${id}: ${e.message}`);
    return {status:'error',reason:e.message};
  }
}

module.exports={sendQueue2,pollQueue2Status,checkDisclosure,subredditFromUrl};
