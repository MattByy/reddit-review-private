// Engain is the production source for discovery and conversation evidence.
// Provider snapshots/publication reports are never presented as independent
// Reddit visibility checks. The direct reader remains available for diagnostics.
const {sb,engain}=require('./_db.js');
const reddit=require('./_reddit.js');
const enc=encodeURIComponent;
const providerMode=()=>process.env.MESSAGE_CONTEXT_SOURCE!=='reddit';
const readable=o=>!!o?.ok&&['visible','provider_reported'].includes(o.visibility)&&!o.thread?.removed&&!o.thread?.locked&&!o.thread?.archived;

function fromOpportunity(row){
  return {ok:true,source:'engain',visibility:'provider_reported',observed_at:row.last_collected_at,url:row.url,partial:true,
    thread:{id:row.thread_id,url:row.url,title:row.title,body:row.body||'',subreddit:row.subreddit,
      score:row.score,num_comments:row.num_comments,created_utc:row.posted_at?Date.parse(row.posted_at)/1000:null},
    comments:[],target:null,opportunity_id:row.opportunity_id,
    limitations:'Engain supplies the post and engagement snapshot, not a complete comment tree. Engain checks target availability during delivery. Do not invent reader replies or treat this as independent Reddit verification.'};
}

async function conversation(value){
  if(!providerMode())return reddit.conversation(value);
  try{
    const id=reddit.identity(value);
    let [row]=await sb('GET','thread_library?select=*&thread_id=eq.'+enc(id.thread_id));
    if(!row?.opportunity_id)return {ok:false,source:'engain',visibility:'unknown',code:'engain_opportunity_missing',reason:'No Engain opportunity is saved for this thread. Select a thread from the Engain library.',url:value};
    // Reuse only a recent provider read; a refresh cannot recursively call us.
    if(!Number.isFinite(Date.parse(row.last_collected_at))||Date.now()-Date.parse(row.last_collected_at)>5*60000){
      const r=await engain('GET','/api/v1/opportunities/'+enc(row.opportunity_id));
      if(r.status>=300)throw Error('Engain context unavailable ('+r.status+')');
      const current=require('./_library.js').normalize(r.json.opportunity||r.json,row.project_id);
      if(current.thread_id!==id.thread_id)throw Error('Engain returned a different thread');
      await sb('POST','thread_library?on_conflict=thread_id',[current],'resolution=merge-duplicates,return=minimal');row={...row,...current};
    }
    if(!row.title?.trim())throw Error('Engain has not supplied the thread text yet.');
    const observation=fromOpportunity(row);
    if(!id.comment_id)return observation;
    const [message]=await sb('GET','experiment_messages?select=*&reddit_url=eq.'+enc(value));
    if(!message?.task_id||message.transport?.mode!=='pool')throw Error('This reply target has no saved Engain publication. Record the exact parent text before requesting a separate reply.');
    const r=await engain('GET','/api/v1/tasks/'+enc(message.task_id)),task=r.json;
    if(r.status>=300)throw Error('Engain parent lookup unavailable ('+r.status+')');
    if((task._id||task.id)!==message.task_id||task.status!=='published'||task.content!==message.body||String(task.threadUrl||'').replace(/\/$/,'')!==message.target_url.replace(/\/$/,''))throw Error('Engain no longer confirms this parent with the saved text and target.');
    const published=reddit.identity(task.redditUrl);
    if(published.thread_id!==id.thread_id||published.comment_id!==id.comment_id)throw Error('Engain returned a different published parent');
    const parent=reddit.identity(message.target_url);
    const target={id:id.comment_id,fullname:'t1_'+id.comment_id,thread_id:id.thread_id,
      parent_id:parent.comment_id?'t1_'+parent.comment_id:'t3_'+id.thread_id,body:task.content,
      author:null,permalink:task.redditUrl,depth:message.depth-1,visibility:'provider_reported'};
    return {...observation,url:value,target,comments:[target],provider_task_id:message.task_id};
  }catch(e){return {ok:false,source:'engain',visibility:'unknown',url:value,reason:String(e.message).slice(0,300)};}
}
module.exports={providerMode,readable,fromOpportunity,conversation};
