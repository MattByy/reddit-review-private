// The work queue: an ordered list of threads to comment on and competitor-mention comments to
// reply to. Threads are ranked by score; newly found comments are inserted at comment_position,
// pushing everything from there down. An agent claims item #1, which leaves the queue for good.
const {rank,rankComment,REMOVED}=require('./collect.cjs');

const DEFAULTS={thread_target:50,comment_limit:20,comment_position:5,max_age_days:120,min_comments:3,min_thread_score:0,min_comment_score:40};
const LIMITS={thread_target:[1,500],comment_limit:[0,200],comment_position:[1,500],max_age_days:[14,3650],min_comments:[0,100000],min_thread_score:[0,100],min_comment_score:[0,100]};
const OWN=/geonode/i;
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};

const settings=store=>store.settings(DEFAULTS);
function saveSettings(store,input){
  const next={...settings(store)};
  for(const [k,v] of Object.entries(input||{})){
    if(!LIMITS[k])fail(422,'Unknown setting: '+k);
    const n=Number(v);if(!Number.isInteger(n)||n<LIMITS[k][0]||n>LIMITS[k][1])fail(422,`${k} must be an integer from ${LIMITS[k][0]} to ${LIMITS[k][1]}`);
    next[k]=n;
  }
  store.saveSettings(next);return next;
}

// Scores every collected thread and comment and lists why each one cannot be queued (if so).
function evaluate(store){
  const cfg=settings(store),subs=store.subreddits(),engaged=store.engaged(),threads=store.threads(),comments=store.comments();
  // Threads we already handed to an agent or a person decided on are never queued again.
  const handled=new Map(store.queue().filter(q=>['claimed','done','skipped'].includes(q.status)).map(q=>[q.thread_id,q.status]));
  const ownMention=new Set();
  for(const t of threads)if(t.mentions.some(m=>OWN.test(m.brand||'')))ownMention.add(t.thread_id);
  for(const c of comments)if(OWN.test(c.brand||''))ownMention.add(c.thread_id);

  const commentRows=comments.map(c=>({...c,rank:rankComment(c,cfg)}));
  const best={};for(const c of commentRows)if(!c.rank.own&&c.rank.score>(best[c.thread_id]||0))best[c.thread_id]=c.rank.score;
  const shared=id=>{
    const r=[],e=engaged[id];
    if(ownMention.has(id))r.push('Geonode is already mentioned in this thread');
    if(e?.statuses.some(s=>REMOVED.has(s)))r.push('Moderators removed our earlier task here');else if(e)r.push('We already have a task here ('+[...new Set(e.statuses)].join(', ')+')');
    if(handled.has(id))r.push('Already '+handled.get(id)+' from the queue');
    return r;
  };
  const threadById={};
  const threadRows=threads.map(t=>{
    const row={...t,best_comment_score:best[t.thread_id]||0,subreddit_stats:subs[(t.subreddit||'').toLowerCase()]||null};
    row.rank=rank(row,row.subreddit_stats,cfg);
    const r=shared(t.thread_id);
    if(!t.sources.some(s=>s.startsWith('opportunities')||s==='smart_search'))r.push('Found only through a brand mention (queued as a comment instead)');
    if(row.rank.too_old)r.push(row.rank.age_days==null?'Creation date unknown':`Older than ${cfg.max_age_days} days`);
    if(t.num_comments==null||t.num_comments<cfg.min_comments)r.push(`Fewer than ${cfg.min_comments} comments`);
    if(row.rank.off_topic)r.push('Off-topic for Geonode');
    if(row.rank.score<cfg.min_thread_score)r.push(`Score below ${cfg.min_thread_score}`);
    row.eligibility={queueable:r.length===0,reasons:r};
    return threadById[t.thread_id]=row;
  });
  const commentById={};
  for(const c of commentRows){
    const r=c.rank.own?['Mentions Geonode']:shared(c.thread_id),t=threadById[c.thread_id];
    if(c.rank.too_old)r.push(c.rank.age_days==null?'Comment date unknown':`Comment older than ${cfg.max_age_days} days`);
    if(t?.rank.age_days!=null&&t.rank.age_days>cfg.max_age_days)r.push(`Thread older than ${cfg.max_age_days} days`);
    if(c.rank.score<cfg.min_comment_score)r.push(`Score below ${cfg.min_comment_score}`);
    if(!c.permalink)r.push('No comment link');
    c.eligibility={queueable:r.length===0,reasons:[...new Set(r)]};commentById[c.id]=c;
  }
  return {cfg,threads:threadRows,comments:commentRows,threadById,commentById};
}

const itemFor={
  thread:t=>({item_id:'t_'+t.thread_id,kind:'thread',thread_id:t.thread_id,score:t.rank.score}),
  comment:c=>({item_id:'c_'+c.id,kind:'comment',thread_id:c.thread_id,comment_id:c.id,score:c.rank.score}),
};

// Brings the queue up to date: drops items that stopped qualifying, tops threads up to
// thread_target at the end, and inserts comments first seen since the last refresh (best
// first, one per thread, at most comment_limit) at comment_position. A first build or a reset
// draws comments from everything collected. Safe to run as often as you like.
function refreshQueue(store,{reset=false}={}){
  if(reset)store.resetQueue();
  const now=new Date().toISOString(),since=reset?null:store.kv('queue_state')?.comments_seen_until??null;
  const ev=evaluate(store),cfg=ev.cfg;
  const okThread=t=>t?.eligibility.queueable,okComment=c=>c?.eligibility.queueable;
  const retired=[],kept=[];
  for(const q of store.queued()){
    const row=q.kind==='thread'?ev.threadById[q.thread_id]:ev.commentById[q.comment_id];
    if(q.kind==='thread'?okThread(row):okComment(row))kept.push(q);
    else retired.push({item_id:q.item_id,reason:row?.eligibility.reasons[0]||'No longer in collected data'});
  }
  const queuedComment=new Set(kept.filter(q=>q.kind==='comment').map(q=>q.thread_id));
  const seen=new Set(kept.map(q=>q.item_id));
  const newComments=[],commentThreads=new Set(queuedComment);
  for(const c of ev.comments.filter(okComment).sort((a,b)=>b.rank.score-a.rank.score)){
    if(newComments.length>=cfg.comment_limit)break;
    if(commentThreads.has(c.thread_id)||seen.has('c_'+c.id)||(since&&c.first_seen<=since))continue;
    commentThreads.add(c.thread_id);newComments.push(itemFor.comment(c));
  }
  // One item per thread: a comment to reply to replaces a queued top-level thread item.
  let list=kept.filter(q=>{
    if(q.kind==='thread'&&commentThreads.has(q.thread_id)){retired.push({item_id:q.item_id,reason:'Replaced by a comment to reply to in the same thread'});return false;}
    return true;
  });
  const inList=new Set(list.map(q=>q.thread_id));
  const need=cfg.thread_target-list.filter(q=>q.kind==='thread').length;
  const newThreads=need<=0?[]:ev.threads.filter(t=>okThread(t)&&!inList.has(t.thread_id)&&!commentThreads.has(t.thread_id))
    .sort((a,b)=>b.rank.score-a.rank.score).slice(0,need).map(itemFor.thread);
  list=[...list,...newThreads];
  list.splice(Math.min(cfg.comment_position-1,list.length),0,...newComments);
  store.writeQueue(list,retired);
  store.setKv('queue_state',{comments_seen_until:now});
  return {ev,summary:{queued:list.length,threads:list.filter(q=>q.kind==='thread').length,comments:list.filter(q=>q.kind==='comment').length,
    added_threads:newThreads.length,added_comments:newComments.length,removed:retired.length}};
}

function threadInfo(t){
  if(!t)return null;
  return {id:t.thread_id,url:t.url,title:t.title,body:t.body,subreddit:t.subreddit,author:t.author,
    created_at:t.created_utc?new Date(t.created_utc*1000).toISOString():null,age_days:t.rank.age_days,
    num_comments:t.num_comments,comments_per_day:t.rank.comments_per_day,score:t.score,visits_per_month:t.visits_per_month,
    google_position:t.google_position,keywords:t.keywords,engain_reasons:t.reasons,
    subreddit_rules:t.subreddit_stats&&{moderation_level:t.subreddit_stats.moderationLevel??null,flags:t.subreddit_stats.ruleFlags||null,bot_bouncer:t.subreddit_stats.botBouncerStatus??null}};
}
function commentInfo(c){
  return c&&{id:c.id,permalink:c.permalink,body:c.body,author:c.author,brand:c.brand,sentiment:c.sentiment,
    created_at:c.created_utc?new Date(c.created_utc*1000).toISOString():null,age_days:c.rank.age_days};
}
function describe(q,ev){
  const t=ev.threadById[q.thread_id];
  if(q.kind==='comment'){const c=ev.commentById[q.comment_id];
    return {status:'comment',action:'reply_to_comment',score:c?.rank.score??q.score_at_add,why:c&&{parts:c.rank.parts,reasons:c.rank.reasons},comment:commentInfo(c),
      thread:t?threadInfo(t):{id:q.thread_id,title:c?.thread_title,subreddit:c?.subreddit}};}
  return {status:'thread',action:'comment_on_thread',score:t?.rank.score??q.score_at_add,why:t&&{parts:t.rank.parts,flags:t.rank.flags},thread:threadInfo(t)};
}

// Agent entry point: refresh, take item #1 off the queue and describe it.
function claimNext(store,agent){
  const {ev}=refreshQueue(store);
  const item=store.claimFirst(agent);
  store.writeQueue(store.queued());
  if(!item)return {status:'empty',remaining:0,message:'The queue is empty. Run a collection or loosen the queue settings.'};
  return {task_id:item.item_id,...describe(item,ev),claimed_at:item.claimed_at,claimed_by:item.claimed_by,remaining:store.queued().length};
}

function queueView(store,{history=30}={}){
  const ev=evaluate(store),rows=store.queue();
  const queued=rows.filter(q=>q.status==='queued'),recent=rows.filter(q=>q.status!=='queued').slice(0,Math.max(0,Math.min(Number(history)||30,500)));
  return {settings:ev.cfg,count:queued.length,items:queued.map(q=>({...q,...describe(q,ev)})),recent:recent.map(q=>({...q,...describe(q,ev)}))};
}

function setStatus(store,id,status,note){
  if(!['skipped','done'].includes(status))fail(422,'status must be skipped or done');
  if(!store.setQueueStatus(id,status,note))fail(404,'Item is not in the queue');
  store.writeQueue(store.queued());return {ok:true};
}

function threadList(store,{q,subreddit,source,min_score,available,limit=100,offset=0}={}){
  const needle=String(q||'').toLowerCase();
  const rows=evaluate(store).threads
    .filter(t=>!needle||`${t.title} ${t.subreddit} ${t.keywords.join(' ')}`.toLowerCase().includes(needle))
    .filter(t=>!subreddit||String(t.subreddit).toLowerCase()===String(subreddit).toLowerCase())
    .filter(t=>!source||t.sources.some(s=>s.startsWith(source)))
    .filter(t=>min_score==null||min_score===''||t.rank.score>=Number(min_score))
    .filter(t=>available!=='true'||t.eligibility.queueable)
    .sort((a,b)=>b.rank.score-a.rank.score||(b.visits_per_month||0)-(a.visits_per_month||0));
  return {total:rows.length,items:rows.slice(Number(offset),Number(offset)+Math.min(Number(limit)||100,500)).map(t=>({...t,body:t.body&&String(t.body).slice(0,400)}))};
}
function commentList(store,{q,brand,own,min_score=40,available,limit=100,offset=0}={}){
  const needle=String(q||'').toLowerCase(),ev=evaluate(store);
  const rows=ev.comments
    .filter(c=>c.rank.score>=Number(min_score||0))
    .filter(c=>!brand||c.brand===brand)
    .filter(c=>own==null||own===''||String(c.rank.own)===String(own))
    .filter(c=>available!=='true'||c.eligibility.queueable)
    .filter(c=>!needle||`${c.body} ${c.thread_title} ${c.subreddit}`.toLowerCase().includes(needle))
    .sort((a,b)=>b.rank.score-a.rank.score||(b.created_utc||0)-(a.created_utc||0));
  const brands={};for(const c of ev.comments)brands[c.brand]=(brands[c.brand]||0)+1;
  return {total:rows.length,brands,items:rows.slice(Number(offset),Number(offset)+Math.min(Number(limit)||100,500))};
}

module.exports={DEFAULTS,settings,saveSettings,evaluate,refreshQueue,claimNext,queueView,setStatus,threadList,commentList};
