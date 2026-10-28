// The work queue. Every item has a type, and the type decides where it enters:
//   thread  - a thread to comment on; new threads are added at the end.
//   comment - one of our own comments Engain has published; inserted at comment_position (5),
//             pushing everything from there down.
//   mention - a competitor-mention comment to reply to (off unless mention_comments=1);
//             inserted right after the new comments.
// An agent claims item #1, which leaves the queue for good.
const {rank,rankComment,REMOVED}=require('./collect.cjs');

// queue_target counts every queued item. Threads are only added while the queue is below it;
// our published comments always go in, even past it.
const DEFAULTS={queue_target:50,comment_limit:20,comment_position:5,max_age_days:120,min_comments:3,min_thread_score:0,min_comment_score:40,mention_comments:0,
  thread_collect_minutes:60,threads_every_minutes:10,comments_every_minutes:30,tracker_every_minutes:10};
const LIMITS={queue_target:[1,500],comment_limit:[0,200],comment_position:[1,500],max_age_days:[14,3650],min_comments:[0,100000],min_thread_score:[0,100],min_comment_score:[0,100],mention_comments:[0,1],
  thread_collect_minutes:[5,1440],threads_every_minutes:[1,1440],comments_every_minutes:[1,1440],tracker_every_minutes:[1,1440]};
const OWN=/geonode/i;
const DAY=86400000;
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};

const settings=store=>{const s=store.settings(DEFAULTS);return Object.fromEntries(Object.keys(DEFAULTS).map(k=>[k,s[k]]));};
function saveSettings(store,input){
  const next={...settings(store)};
  for(const [k,v] of Object.entries(input||{})){
    if(!LIMITS[k])fail(422,'Unknown setting: '+k);
    const n=Number(v);if(!Number.isInteger(n)||n<LIMITS[k][0]||n>LIMITS[k][1])fail(422,`${k} must be an integer from ${LIMITS[k][0]} to ${LIMITS[k][1]}`);
    next[k]=n;
  }
  store.saveSettings(next);return next;
}
// "…/comments/ravq3d/bright_data_review_everything/" -> "bright data review everything"
function titleFromUrl(url){
  try{const slug=new URL(url).pathname.split('/')[5];return slug&&slug!=='_'&&slug!=='comment'?decodeURIComponent(slug).replace(/_/g,' '):null;}catch{return null;}
}

// Scores everything collected and lists why each one cannot be queued (if so).
function evaluate(store){
  const cfg=settings(store),subs=store.subreddits(),engaged=store.engaged(),threads=store.threads(),comments=store.comments(),history=store.queue();
  // Threads we already handed to an agent or a person decided on are never queued again as threads.
  const handled=new Map(history.filter(q=>q.kind!=='comment'&&['claimed','done','skipped'].includes(q.status)).map(q=>[q.thread_id,q.status]));
  const handledItems=new Map(history.filter(q=>['claimed','done','skipped'].includes(q.status)).map(q=>[q.item_id,q.status]));
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
    if(!t.sources.some(s=>s.startsWith('opportunities')||s==='smart_search'))r.push('Found only through a brand mention');
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
    if(!cfg.mention_comments)r.push('Competitor comments are turned off (mention_comments=0)');
    if(c.rank.too_old)r.push(c.rank.age_days==null?'Comment date unknown':`Comment older than ${cfg.max_age_days} days`);
    if(t?.rank.age_days!=null&&t.rank.age_days>cfg.max_age_days)r.push(`Thread older than ${cfg.max_age_days} days`);
    if(c.rank.score<cfg.min_comment_score)r.push(`Score below ${cfg.min_comment_score}`);
    if(!c.permalink)r.push('No comment link');
    c.eligibility={queueable:r.length===0,reasons:[...new Set(r)]};commentById[c.id]=c;
  }
  // Every task of ours is evaluated, so a queued comment that is later removed drops out.
  const publishedById={};
  const publishedRows=store.ourTasks().filter(p=>['comment','reply'].includes(p.type)&&p.reddit_url).map(p=>{
    const r=[],age=p.published_at?(Date.now()-Date.parse(p.published_at))/DAY:null;
    if(p.status!=='published')r.push(`Engain status is now ${p.status} (${p.verdict})`);
    if(age==null)r.push('Publish date unknown');else if(age>cfg.max_age_days)r.push(`Published more than ${cfg.max_age_days} days ago`);
    if(handledItems.has('p_'+p.task_id))r.push('Already '+handledItems.get('p_'+p.task_id)+' from the queue');
    const row={...p,first_seen:p.published_seen_at,age_days:age==null?null:Math.round(age*10)/10,eligibility:{queueable:r.length===0,reasons:r}};
    return publishedById[p.task_id]=row;
  });
  return {cfg,threads:threadRows,comments:commentRows,published:publishedRows,threadById,commentById,publishedById};
}

const itemFor={
  thread:t=>({item_id:'t_'+t.thread_id,kind:'thread',thread_id:t.thread_id,score:t.rank.score}),
  comment:p=>({item_id:'p_'+p.task_id,kind:'comment',thread_id:p.thread_id,comment_id:p.task_id,score:null}),
  mention:c=>({item_id:'c_'+c.id,kind:'mention',thread_id:c.thread_id,comment_id:c.id,score:c.rank.score}),
};
const rowFor=(q,ev)=>q.kind==='thread'?ev.threadById[q.thread_id]:q.kind==='comment'?ev.publishedById[q.comment_id]:ev.commentById[q.comment_id];

// Brings the queue up to date:
//  1. drops items that stopped qualifying (the reason stays in the history);
//  2. (addComments) inserts what arrived since the last refresh at comment_position: our newly
//     published comments (newest first), then competitor comments if enabled, at most comment_limit;
//  3. (addThreads) adds threads at the end while the queue holds fewer than queue_target items.
// A first build or a reset draws comments from everything collected. Safe to run any time.
function refreshQueue(store,{reset=false,addThreads=true,addComments=true}={}){
  if(reset)store.resetQueue();
  const now=new Date().toISOString(),since=reset?null:store.kv('queue_state')?.comments_seen_until??null;
  const ev=evaluate(store),cfg=ev.cfg,isNew=x=>!!x.first_seen&&(!since||x.first_seen>since);
  const retired=[],kept=[];
  for(const q of store.queued()){
    const row=rowFor(q,ev);
    if(row?.eligibility.queueable)kept.push(q);
    else retired.push({item_id:q.item_id,reason:row?.eligibility.reasons[0]||'No longer in collected data'});
  }
  const seen=new Set(kept.map(q=>q.item_id)),incoming=[];
  for(const p of !addComments?[]:ev.published.filter(p=>p.eligibility.queueable&&isNew(p)&&!seen.has('p_'+p.task_id)).sort((a,b)=>String(b.published_at).localeCompare(String(a.published_at)))){
    if(incoming.length>=cfg.comment_limit)break;incoming.push(itemFor.comment(p));
  }
  const mentionThreads=new Set(kept.filter(q=>q.kind==='mention').map(q=>q.thread_id));
  for(const c of !addComments?[]:ev.comments.filter(c=>c.eligibility.queueable&&isNew(c)).sort((a,b)=>b.rank.score-a.rank.score)){
    if(incoming.length>=cfg.comment_limit)break;
    if(mentionThreads.has(c.thread_id)||seen.has('c_'+c.id))continue;
    mentionThreads.add(c.thread_id);incoming.push(itemFor.mention(c));
  }
  // A thread item gives way to a comment or mention item in the same thread.
  const busy=new Set([...incoming,...kept.filter(q=>q.kind!=='thread')].map(q=>q.thread_id));
  let list=kept.filter(q=>{
    if(q.kind==='thread'&&busy.has(q.thread_id)){retired.push({item_id:q.item_id,reason:'Replaced by a comment item in the same thread'});return false;}
    return true;
  });
  const inList=new Set(list.map(q=>q.thread_id));
  // Threads only fill the gap below queue_target, counting every item including new comments.
  const need=addThreads?cfg.queue_target-list.length-incoming.length:0;
  const newThreads=need<=0?[]:ev.threads.filter(t=>t.eligibility.queueable&&!inList.has(t.thread_id)&&!busy.has(t.thread_id))
    .sort((a,b)=>b.rank.score-a.rank.score).slice(0,need).map(itemFor.thread);
  list=[...list,...newThreads];
  list.splice(Math.min(cfg.comment_position-1,list.length),0,...incoming);
  store.writeQueue(list,retired);
  // Only a refresh that may insert comments moves the "seen until" mark, so none are skipped.
  if(addComments)store.setKv('queue_state',{comments_seen_until:now});
  const count=k=>list.filter(q=>q.kind===k).length;
  return {ev,summary:{queued:list.length,threads:count('thread'),comments:count('comment'),mentions:count('mention'),added_threads:newThreads.length,
    added_comments:incoming.filter(q=>q.kind==='comment').length,added_mentions:incoming.filter(q=>q.kind==='mention').length,removed:retired.length}};
}

function threadInfo(t){
  return t&&{id:t.thread_id,url:t.url,title:t.title,body:t.body,subreddit:t.subreddit,author:t.author,
    created_at:t.created_utc?new Date(t.created_utc*1000).toISOString():null,age_days:t.rank.age_days,
    num_comments:t.num_comments,comments_per_day:t.rank.comments_per_day,score:t.score,visits_per_month:t.visits_per_month,
    google_position:t.google_position,keywords:t.keywords,engain_reasons:t.reasons,
    subreddit_rules:t.subreddit_stats&&{moderation_level:t.subreddit_stats.moderationLevel??null,flags:t.subreddit_stats.ruleFlags||null,bot_bouncer:t.subreddit_stats.botBouncerStatus??null}};
}
// Every item carries `url` (exactly where the message goes: the thread, our comment or the
// competitor comment) and `thread_url`, in both queues.
function describe(q,ev){
  const d=describeKind(q,ev);
  const url=q.kind==='comment'?d.comment?.reddit_url:q.kind==='mention'?d.mention?.permalink:d.thread?.url;
  const thread_url=q.kind==='comment'?d.comment?.thread_url||d.thread?.url:d.thread?.url;
  return {url:url??null,thread_url:thread_url??null,...d};
}
function describeKind(q,ev){
  const t=ev.threadById[q.thread_id];
  if(q.kind==='comment'){
    const p=ev.publishedById[q.comment_id];
    return {status:'comment',action:'follow_up_on_our_comment',
      comment:p&&{task_id:p.task_id,type:p.type,reddit_url:p.reddit_url,thread_url:p.thread_url,content:p.content,subreddit:p.subreddit,
        published_at:p.published_at,age_days:p.age_days,parent_task_id:p.parent_task_id,labels:p.labels},
      thread:t?threadInfo(t):p&&{id:p.thread_id,url:p.thread_url,title:titleFromUrl(p.thread_url),subreddit:p.subreddit}};
  }
  if(q.kind==='mention'){
    const c=ev.commentById[q.comment_id];
    return {status:'mention',action:'reply_to_comment',score:c?.rank.score??q.score_at_add,why:c&&{parts:c.rank.parts,reasons:c.rank.reasons},
      mention:c&&{id:c.id,permalink:c.permalink,body:c.body,author:c.author,brand:c.brand,sentiment:c.sentiment,
        created_at:c.created_utc?new Date(c.created_utc*1000).toISOString():null,age_days:c.rank.age_days},
      thread:t?threadInfo(t):{id:q.thread_id,title:c?.thread_title,subreddit:c?.subreddit}};
  }
  return {status:'thread',action:'comment_on_thread',score:t?.rank.score??q.score_at_add,why:t&&{parts:t.rank.parts,flags:t.rank.flags},thread:threadInfo(t)};
}

// Stand-in messages until a writer supplies real ones. They are marked message_source 'random'
// and say they are placeholders, so nothing downstream mistakes one for a reply to post.
const PLACEHOLDERS=[
  'Placeholder message: thanks for sharing this, useful thread.',
  'Placeholder message: interesting point, worth testing before deciding.',
  'Placeholder message: we ran into the same thing and solved it a different way.',
  'Placeholder message: good question, the answer depends on volume.',
  'Placeholder message: agreed on the main point, one detail to add.',
  'Placeholder message: this matches what we have seen in practice.',
];
const randomMessage=()=>PLACEHOLDERS[Math.floor(Math.random()*PLACEHOLDERS.length)];
function cleanMessage(m){
  if(m==null||m==='')return null;
  if(typeof m!=='string')fail(422,'message must be a string');
  const s=m.trim();if(!s)return null;if(s.length>10000)fail(422,'message is longer than 10000 characters');
  return s;
}
// Queue 2 entry as the API and dashboard see it: the item, its message and how it was written,
// approval, and delivery state. `disclosure` is the same check the send step enforces.
const queue2Entry=r=>r&&{queue2_id:r.id,item_id:r.item_id,status:r.kind,url:r.url,thread_url:r.thread_url,title:r.title,
  message:r.message,message_source:r.message_source,disclosure:require('./send-queue2.cjs').checkDisclosure(r.message),
  write_status:r.write_status??null,write_error:r.write_error??null,model:r.model??null,provider:r.provider??null,prompt_used:r.prompt_used??null,written_at:r.written_at??null,
  prompt_variant_id:r.prompt_variant_id??null,prompt_variant_name:r.prompt_variant_name??null,
  approved_at:r.approved_at??null,approved_by:r.approved_by??null,
  send_status:r.send_status??'ready',delivery_mode:r.delivery_mode??null,poster_account:r.poster_account??null,user_account_id:r.user_account_id??null,
  engain_task_id:r.engain_task_id??null,reddit_url:r.reddit_url??null,send_error:r.send_error??null,send_reason:r.send_reason??null,sent_at:r.sent_at??null,
  created_by:r.created_by,created_at:r.created_at,updated_at:r.updated_at,item:r.item};

// "Get next item": drop stale items, then move #1 from queue 1 to queue 2 with a message
// (the one given, or a random placeholder). Nothing is added to queue 1 here; the jobs refill it.
function claimNext(store,agent,{message}={}){
  const given=cleanMessage(message);
  const {ev}=refreshQueue(store,{addThreads:false,addComments:false});
  let described;
  const item=store.moveFirstToQueue2(agent,first=>{
    described=describe(first,ev);
    return {url:described.url,thread_url:described.thread_url,title:described.thread?.title??null,
      message:given??randomMessage(),message_source:given?'given':'random',item:{item_id:first.item_id,...described}};
  });
  store.writeQueue(store.queued());
  if(!item)return {status:'empty',remaining:0,message:'Queue 1 is empty. The threads and comments jobs refill it.'};
  return {task_id:item.item_id,...described,claimed_at:item.claimed_at,claimed_by:item.claimed_by,remaining:store.queued().length,
    queue2:queue2Entry(store.queue2(item.queue2_id))};
}
const queue2List=store=>{const rows=store.queue2();return {count:rows.length,items:rows.map(queue2Entry)};};
function setQueue2Message(store,id,message){
  const m=cleanMessage(message);if(!m)fail(422,'message is required');
  if(!store.setQueue2Message(id,m,'given'))fail(404,'No such queue 2 entry');
  return queue2Entry(store.queue2(id));
}

function queueView(store,{history=30}={}){
  const ev=evaluate(store),rows=store.queue();
  const queued=rows.filter(q=>q.status==='queued'),recent=rows.filter(q=>q.status!=='queued').slice(0,Math.max(0,Math.min(Number(history)||0,500)));
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
const publishedList=store=>evaluate(store).published;

const queue2Item=(store,id)=>queue2Entry(store.queue2(id));
module.exports={DEFAULTS,settings,saveSettings,evaluate,refreshQueue,claimNext,queue2List,queue2Item,setQueue2Message,queueView,setStatus,threadList,commentList,publishedList,titleFromUrl};
