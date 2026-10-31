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

// Engain wants a reply's target as a full comment link (.../comments/POST_ID/title/COMMENT_ID/), but the
// links it gives for our own comments are often Reddit share links (/r/sub/s/CODE). Those redirect to the
// full link; follow that one hop. Any other comment link is returned in the full shape, without its query.
const COMMENT_LINK=/^https?:\/\/(?:www\.|old\.|new\.)?reddit\.com\/r\/([^/]+)\/comments\/([a-z0-9]+)\/([^/?#]+)\/([a-z0-9]+)/i;
async function commentPermalink(url,fetchImpl=fetch){
  const full=u=>{const m=COMMENT_LINK.exec(u||'');return m&&`https://www.reddit.com/r/${m[1]}/comments/${m[2]}/${m[3]}/${m[4]}/`;};
  if(full(url))return full(url);
  if(!/reddit\.com\/r\/[^/]+\/s\/\w+/i.test(url||''))fail(422,`Not a comment link: ${url}`);
  let r;
  try{r=await fetchImpl(url,{method:'GET',redirect:'manual',headers:{'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) geonode-collector'},signal:AbortSignal.timeout(15000)});}
  catch(e){fail(502,`Could not open the Reddit share link ${url}: ${e.message}`);}
  const to=r.headers.get('location');
  if(!full(to))fail(422,`The Reddit share link ${url} did not lead to a comment (HTTP ${r.status}${to?' -> '+to:''})`);
  return full(to);
}

// Send one queue2 entry. Every attempt lands in the activity log: a refusal before anything
// reaches Engain is send.rejected; a call to Engain is send.request then send.ok or send.failed.
async function sendQueue2(args,ctx){
  try{return await send(args,ctx);}
  catch(e){
    if(!e.logged){const item=ctx.store.queue2(args.id);
      ctx.store.event('send.rejected',`Queue 2 #${args.id}: not sent: ${e.message}`,{queue2_id:args.id,item_id:item?.item_id??null,mode:args.mode??null,error:e.message,status:e.status??null});}
    throw e;
  }
}
async function send({id,mode,userAccountId,posterAccount,override},{engain,store,projectId,log=console.log,fetchImpl=fetch}){
  const item=store.queue2(id);
  if(!item)fail(404,'Queue2 entry not found');
  // A reply goes under a comment: make sure its link is the full comment link Engain accepts.
  if(item.kind!=='thread'&&item.send_status==='ready'){
    const link=await commentPermalink(item.url,fetchImpl);
    if(link!==item.url){
      store.db.prepare('update queue2 set url=?,updated_at=? where id=?').run(link,new Date().toISOString(),Number(id));
      store.event('send.link_resolved',`Queue 2 #${id}: reply link ${item.url} -> ${link}`,{queue2_id:Number(id),item_id:item.item_id,from:item.url,to:link});
      item.url=link;
    }
  }
  
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

  const ref={queue2_id:Number(id),item_id:item.item_id,kind:item.kind,mode,account:mode==='beta'?accountId:posterAccount??null,url:item.url};
  try{
    let response,taskId;
    store.event('send.request',`Queue 2 #${id}: sending to Engain via ${mode==='beta'?'dedicated account '+accountId:'pool'}`,{...ref,message:item.message});

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
      store.event('send.failed',`Queue 2 #${id}: Engain answered without a task ID`,{...ref,response});
      store.failQueue2Send(id,'No task ID in response',JSON.stringify(response).slice(0,500));
      return {ok:false,status:'unknown',reason:'No task ID in Engain response',response};
    }
    
    // Record success
    store.recordQueue2Send(id,taskId,response);
    store.recordQueue2Pace(subreddit);
    
    store.event('send.ok',`Queue 2 #${id}: Engain task ${taskId} created (${response?.status||'submitted'})`,{...ref,task_id:taskId,response});
    log(`✓ Sent queue2 #${id} via ${mode}: task ${taskId}`);
    
    return {ok:true,status:'submitted',taskId,mode,queue2_id:id,item_id:item.item_id,response};
    
  }catch(e){
    const reason=e.status===429?'Rate limited':e.status===403?'Forbidden':e.status>=500?'Server error':`Engain ${e.status||'error'}`;
    store.failQueue2Send(id,reason,e.message);
    store.event('send.failed',`Queue 2 #${id}: Engain call failed: ${e.message}`,{...ref,reason,error:e.message,status:e.status??null,engain:e.body??null});
    e.logged=true;
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
    const c=store.trackStatus(id,status,redditUrl);
    if(c?.changed)log(`Queue2 #${id}: ${c.from||'sent'} -> ${status}`);
    return {status:status==='published'?'published':['cancelled','canceled'].includes(status)?'cancelled':
      ['scheduled','in_review','in_queue','waiting_for_parent_comment','waiting_for_mod_approval','sent_for_posting','assigned','pending'].includes(status)?'pending':'failed',
      engainStatus:status,redditUrl,reason:status};

  }catch(e){
    log(`Poll error for queue2 #${id}: ${e.message}`);
    store.event('sent.poll_error',`Queue 2 #${id}: status check failed: ${e.message}`,{queue2_id:Number(id),item_id:item.item_id,task_id:item.engain_task_id,error:e.message});
    return {status:'error',reason:e.message};
  }
}

module.exports={commentPermalink,sendQueue2,pollQueue2Status,checkDisclosure,subredditFromUrl};
