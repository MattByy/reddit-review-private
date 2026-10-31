// Local SQLite store (node:sqlite, no dependencies). One row per Reddit thread, merged across sources.
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {randomBytes,createHash}=require('node:crypto');
const sha256=s=>createHash('sha256').update(s).digest('hex');

// Engain statuses that are not final yet; anything else settles a sent item.
const PENDING_STATUSES=new Set(['submitted','pending','scheduled','in_review','in_queue','waiting_for_parent_comment','waiting_for_mod_approval','sent_for_posting','assigned']);
const JSON_COLS=['sources','keywords','reasons','mentions','ranking_keywords'];

function open(file){
  if(file!==':memory:')fs.mkdirSync(path.dirname(file),{recursive:true});
  // The activity log is mirrored as one JSON line per event in .data/logs/YYYY-MM-DD.jsonl.
  const logDir=file===':memory:'?null:path.join(path.dirname(file),'logs');
  const db=new DatabaseSync(file);
  db.exec(`
    create table if not exists threads(
      thread_id text primary key, url text not null, subreddit text, title text, body text, author text,
      created_utc integer, score integer, num_comments integer,
      relevance real, visits_per_month real, traffic_value real, google_position integer, reddit_views real,
      opportunity_id text, sources text not null default '[]', keywords text not null default '[]',
      reasons text not null default '[]', mentions text not null default '[]', ranking_keywords text not null default '[]',
      first_seen text not null, last_seen text not null);
    create table if not exists subreddits(name text primary key, data text not null, fetched_at text not null);
    create table if not exists runs(id integer primary key autoincrement, started_at text not null, finished_at text, input text not null, summary text);
    create table if not exists comments(
      id text primary key, thread_id text not null, subreddit text, thread_title text, brand text, sentiment text,
      body text, author text, score integer, created_utc integer, permalink text, snippet text, reasoning text,
      first_seen text not null, last_seen text not null);
    create index if not exists comments_thread on comments(thread_id);
    create table if not exists engaged(thread_id text primary key, subreddit text, statuses text not null, updated_at text not null);
    create table if not exists settings(key text primary key, value text not null);
    create table if not exists api_keys(id text primary key, name text not null, scope text not null, prefix text not null, hash text not null unique,
      created_at text not null, last_used_at text, revoked_at text);
    create table if not exists our_tasks(
      task_id text primary key, type text, status text not null, verdict text not null, reddit_url text, thread_url text, thread_id text,
      content text, subreddit text, created_at text, published_at text, parent_task_id text, labels text not null default '[]',
      first_seen text not null, last_seen text not null, status_changed_at text not null, published_seen_at text);
    create table if not exists task_events(id integer primary key autoincrement, task_id text not null, from_status text, to_status text not null,
      from_verdict text, to_verdict text not null, at text not null);
    create index if not exists task_events_task on task_events(task_id);
    create table if not exists queue2(
      id integer primary key autoincrement, item_id text not null unique, kind text not null, thread_id text,
      url text, thread_url text, title text, message text not null, message_source text not null,
      item text not null, created_by text, created_at text not null, updated_at text not null);
    create table if not exists events(id integer primary key autoincrement, at text not null, type text not null, message text,
      item_id text, queue2_id integer, data text);
    create index if not exists events_type on events(type);
    create index if not exists events_item on events(item_id);
    create index if not exists events_q2 on events(queue2_id);
  `);
  
  // Run queue2 send migration AFTER tables are created
  const {migrateQueue2,createPacingTable}=require('./migrate-queue2.cjs');
  migrateQueue2(db);
  createPacingTable(db);
  // Drafting and approval: which prompt and model wrote the message, and who approved it.
  for(const [col,type] of [['prompt_used','text'],['model','text'],['write_status','text'],['write_error','text'],['written_at','text'],['approved_at','text'],['approved_by','text'],['prompt_variant_id','text'],['prompt_variant_name','text'],['prompt_variant_slug','text'],
    ['engain_status','text'],['status_checked_at','text'],['status_changed_at','text'],['settled','integer'],['provider','text']])
    if(!db.prepare("select 1 from pragma_table_info('queue2') where name=?").get(col))db.exec(`alter table queue2 add column ${col} ${type}`);
  // Status history of everything sent from Queue 2 (the tracking list).
  db.exec(`create table if not exists queue2_events(id integer primary key autoincrement,queue2_id integer not null,from_status text,to_status text not null,at text not null);
    create index if not exists queue2_events_q on queue2_events(queue2_id);`);
  // v2 task list: where a task was posted from, and by which of our accounts.
  for(const col of ['posted_from','account_handle'])
    if(!db.prepare("select 1 from pragma_table_info('our_tasks') where name=?").get(col))db.exec(`alter table our_tasks add column ${col} text`);
  // The first published-only table is folded into our_tasks.
  if(db.prepare("select 1 from sqlite_master where name='published'").get()){
    db.exec(`insert or ignore into our_tasks(task_id,type,status,verdict,reddit_url,thread_url,thread_id,content,subreddit,published_at,parent_task_id,labels,first_seen,last_seen,status_changed_at,published_seen_at)
      select task_id,type,'published','approved',reddit_url,thread_url,thread_id,content,subreddit,published_at,parent_task_id,labels,first_seen,last_seen,first_seen,first_seen from published;
      drop table published;`);
  }
  // The first queue held threads only; the mixed thread/comment queue replaces it.
  if(db.prepare("select 1 from pragma_table_info('queue') where name='thread_id'").get()&&!db.prepare("select 1 from pragma_table_info('queue') where name='kind'").get())db.exec('drop table queue');
  db.exec(`create table if not exists queue(
    item_id text primary key, kind text not null, thread_id text not null, comment_id text,
    position integer, status text not null default 'queued', score_at_add integer,
    added_at text not null, updated_at text not null, claimed_at text, claimed_by text, note text);
    create index if not exists queue_thread on queue(thread_id);`);
  // Competitor-mention items were called "comment" before our own published comments took that name.
  db.exec("update queue set kind='mention' where kind='comment' and item_id like 'c\\_%' escape '\\'");
  // A run cannot survive a restart; close any left open so it does not look in progress.
  db.prepare('update runs set finished_at=?,summary=? where finished_at is null').run(new Date().toISOString(),JSON.stringify({errors:['Interrupted: the server stopped during this run']}));
  const parse=row=>{if(!row)return row;for(const k of JSON_COLS)row[k]=JSON.parse(row[k]);return row;};
  const union=(a,b)=>[...new Set([...(a||[]),...(b||[])])];
  const pick=(next,old)=>next??old??null;

  // Activity log for debugging: every job, queue move, model call, send and status change.
  // type is "area.what" (job.finished, llm.response, send.failed...). data.item_id and
  // data.queue2_id are also stored as columns so one item's whole journey can be listed.
  // Logging never throws: a full disk must not stop the pipeline.
  const insertEvent=db.prepare('insert into events(at,type,message,item_id,queue2_id,data) values(?,?,?,?,?,?)');
  function event(type,message,data={}){
    try{
      const at=new Date().toISOString(),item_id=data?.item_id??null,queue2_id=data?.queue2_id!=null?Number(data.queue2_id):null;
      let json=JSON.stringify(data??{});if(json.length>100000)json=JSON.stringify({truncated:true,preview:json.slice(0,100000)});
      const id=Number(insertEvent.run(at,type,message??null,item_id,queue2_id,json).lastInsertRowid);
      if(logDir){fs.mkdirSync(logDir,{recursive:true});fs.appendFileSync(path.join(logDir,at.slice(0,10)+'.jsonl'),JSON.stringify({id,at,type,message,data:JSON.parse(json)})+'\n');}
      return id;
    }catch{return null;}
  }
  // Filters: type ("llm" matches llm.*), item_id, queue2_id, q (text in message or data), since, before_id,
  // errors (only failures: types with error, failed or rejected in them).
  function events({type,item_id,queue2_id,q,since,before_id,errors,limit=200}={}){
    const where=[],args=[];
    if(errors&&errors!=='false'&&errors!=='0')where.push("(type like '%error%' or type like '%failed%' or type like '%rejected%')");
    if(type){where.push('(type=? or type like ?)');args.push(type,type+'.%');}
    if(item_id){where.push('item_id=?');args.push(item_id);}
    if(queue2_id!=null&&queue2_id!==''){where.push('queue2_id=?');args.push(Number(queue2_id));}
    if(q){where.push('(message like ? or data like ?)');args.push('%'+q+'%','%'+q+'%');}
    if(since){where.push('at>=?');args.push(since);}
    if(before_id){where.push('id<?');args.push(Number(before_id));}
    const n=Math.max(1,Math.min(Number(limit)||200,2000));
    return db.prepare(`select * from events ${where.length?'where '+where.join(' and '):''} order by id desc limit ?`).all(...args,n).map(r=>({...r,data:r.data?JSON.parse(r.data):null}));
  }
  // Drops events (and log files) older than `days`.
  function pruneEvents(days){
    const cut=new Date(Date.now()-days*86400000).toISOString();
    const n=db.prepare('delete from events where at<?').run(cut).changes;
    if(logDir&&fs.existsSync(logDir))for(const f of fs.readdirSync(logDir))if(/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)&&f.slice(0,10)<cut.slice(0,10))fs.rmSync(path.join(logDir,f));
    return n;
  }

  // Merge rule: newest non-null metric wins; list fields are unioned so a thread found by
  // several sources keeps every source, keyword and reason.
  function upsert(t){
    const old=parse(db.prepare('select * from threads where thread_id=?').get(t.thread_id));
    const now=new Date().toISOString();
    const row={
      thread_id:t.thread_id,url:pick(t.url,old?.url),subreddit:pick(t.subreddit,old?.subreddit),title:pick(t.title||null,old?.title),
      body:pick(t.body||null,old?.body),author:pick(t.author,old?.author),created_utc:pick(t.created_utc,old?.created_utc),
      score:pick(t.score,old?.score),num_comments:pick(t.num_comments,old?.num_comments),relevance:pick(t.relevance,old?.relevance),
      visits_per_month:pick(t.visits_per_month,old?.visits_per_month),traffic_value:pick(t.traffic_value,old?.traffic_value),
      google_position:pick(t.google_position,old?.google_position),reddit_views:pick(t.reddit_views,old?.reddit_views),
      opportunity_id:pick(t.opportunity_id,old?.opportunity_id),
      sources:JSON.stringify(union(old?.sources,t.sources)),keywords:JSON.stringify(union(old?.keywords,t.keywords)),
      reasons:JSON.stringify(union(old?.reasons,t.reasons)),ranking_keywords:JSON.stringify(union(old?.ranking_keywords,t.ranking_keywords)),
      mentions:JSON.stringify([...(old?.mentions||[]),...(t.mentions||[])].filter((m,i,a)=>a.findIndex(x=>x.id===m.id)===i)),
      first_seen:old?.first_seen||now,last_seen:now,
    };
    const keys=Object.keys(row);
    db.prepare(`insert or replace into threads(${keys.join(',')}) values(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));
    return old?'updated':'added';
  }

  return {
    db,upsert,event,events,pruneEvents,
    eventTypes:since=>db.prepare('select type,count(*) n,max(at) last from events where at>=? group by type order by type').all(since||'').map(r=>({...r})),
    thread:id=>parse(db.prepare('select * from threads where thread_id=?').get(id)),
    threads:()=>db.prepare('select * from threads').all().map(parse),
    subreddit(name){const r=db.prepare('select * from subreddits where name=?').get(name);return r?{...JSON.parse(r.data),fetched_at:r.fetched_at}:null;},
    subreddits(){return Object.fromEntries(db.prepare('select * from subreddits').all().map(r=>[r.name,{...JSON.parse(r.data),fetched_at:r.fetched_at}]));},
    saveSubreddit(name,data){db.prepare('insert or replace into subreddits(name,data,fetched_at) values(?,?,?)').run(name,JSON.stringify(data),new Date().toISOString());},
    startRun(input){return Number(db.prepare('insert into runs(started_at,input) values(?,?)').run(new Date().toISOString(),JSON.stringify(input)).lastInsertRowid);},
    finishRun(id,summary){db.prepare('update runs set finished_at=?,summary=? where id=?').run(new Date().toISOString(),JSON.stringify(summary),id);},
    saveComment(c){
      const now=new Date().toISOString(),old=db.prepare('select first_seen from comments where id=?').get(c.id);
      const row={...c,first_seen:old?.first_seen||now,last_seen:now},keys=Object.keys(row);
      db.prepare(`insert or replace into comments(${keys.join(',')}) values(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]??null));
      return old?'updated':'added';
    },
    comments:()=>db.prepare('select * from comments').all(),
    // Every Engain task of ours with its current status and verdict. Each status change is
    // appended to task_events. published_seen_at is when this server first saw it published,
    // which is what makes a queue refresh treat it as new.
    saveTask(t){
      const now=new Date().toISOString(),old=db.prepare('select * from our_tasks where task_id=?').get(t.task_id);
      const changed=!old||old.status!==t.status;
      const row={...t,labels:JSON.stringify(t.labels||[]),first_seen:old?.first_seen||now,last_seen:now,
        status_changed_at:changed?now:old.status_changed_at,published_seen_at:old?.published_seen_at||(t.status==='published'?now:null)},keys=Object.keys(row);
      db.exec('begin');
      try{
        db.prepare(`insert or replace into our_tasks(${keys.join(',')}) values(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]??null));
        if(changed)db.prepare('insert into task_events(task_id,from_status,to_status,from_verdict,to_verdict,at) values(?,?,?,?,?,?)').run(t.task_id,old?.status??null,t.status,old?.verdict??null,t.verdict,now);
        db.exec('commit');
      }catch(e){db.exec('rollback');throw e;}
      if(changed&&old)event('engain.task_status',`Our Engain task ${t.task_id}: ${old.status} -> ${t.status} (${t.verdict})`,{task_id:t.task_id,item_id:'p_'+t.task_id,type:t.type,from:old.status,to:t.status,verdict:t.verdict,reddit_url:t.reddit_url,subreddit:t.subreddit});
      return {added:!old,changed,from:old?.status??null,to:t.status,from_verdict:old?.verdict??null,verdict:t.verdict};
    },
    ourTasks(verdict){
      const rows=verdict?db.prepare('select * from our_tasks where verdict=? order by status_changed_at desc').all(verdict):db.prepare('select * from our_tasks order by status_changed_at desc').all();
      return rows.map(r=>({...r,labels:JSON.parse(r.labels)}));
    },
    taskEvents(taskId,limit=200){
      return taskId?db.prepare('select * from task_events where task_id=? order by id').all(taskId):db.prepare('select * from task_events order by id desc limit ?').all(limit);
    },
    published:()=>db.prepare("select * from our_tasks where status='published' and reddit_url is not null and type in ('comment','reply') order by published_at desc").all().map(r=>({...r,labels:JSON.parse(r.labels)})),
    // Replaces engagement state wholesale: Engain's task list is the source of truth.
    setEngaged(map){
      const now=new Date().toISOString();db.exec('delete from engaged');
      const ins=db.prepare('insert into engaged(thread_id,subreddit,statuses,updated_at) values(?,?,?,?)');
      for(const [id,v] of map)ins.run(id,v.subreddit,JSON.stringify(v.statuses),now);
    },
    engaged(){return Object.fromEntries(db.prepare('select * from engaged').all().map(r=>[r.thread_id,{subreddit:r.subreddit,statuses:JSON.parse(r.statuses)}]));},
    queue:()=>db.prepare("select * from queue order by status='queued' desc, position, updated_at desc").all(),
    queued:()=>db.prepare("select * from queue where status='queued' order by position").all(),
    // Writes the full ordered list of queued items (positions 1..n) and retires the given ones,
    // in one transaction. Non-queued rows are history and are never deleted.
    writeQueue(items,retired=[]){
      const now=new Date().toISOString();db.exec('begin');
      try{
        const ret=db.prepare("update queue set status='removed',note=?,position=null,updated_at=? where item_id=? and status='queued'");
        for(const r of retired)ret.run(r.reason,now,r.item_id);
        db.exec("update queue set position=null where status='queued'");
        const up=db.prepare(`insert into queue(item_id,kind,thread_id,comment_id,position,status,score_at_add,added_at,updated_at) values(?,?,?,?,?,'queued',?,?,?)
          on conflict(item_id) do update set position=excluded.position,status='queued',updated_at=excluded.updated_at`);
        items.forEach((x,i)=>up.run(x.item_id,x.kind,x.thread_id,x.comment_id??null,i+1,x.score??null,x.added_at||now,now));
        db.exec('commit');
      }catch(e){db.exec('rollback');throw e;}
    },
    resetQueue(){db.exec("delete from queue where status='queued'");},
    // Moves the first queued item to queue 2 with a message, in one transaction. build(first)
    // returns the queue 2 fields; the caller refreshes positions afterwards.
    moveFirstToQueue2(agent,build){
      const first=db.prepare("select * from queue where status='queued' order by position limit 1").get();if(!first)return null;
      const now=new Date().toISOString(),q2=build(first);
      db.exec('begin');
      try{
        const id=Number(db.prepare(`insert into queue2(item_id,kind,thread_id,url,thread_url,title,message,message_source,item,created_by,created_at,updated_at)
          values(?,?,?,?,?,?,?,?,?,?,?,?)`).run(first.item_id,first.kind,first.thread_id,q2.url??null,q2.thread_url??null,q2.title??null,q2.message,q2.message_source,JSON.stringify(q2.item),agent??null,now,now).lastInsertRowid);
        db.prepare("update queue set status='claimed',position=null,claimed_at=?,claimed_by=?,updated_at=?,note=? where item_id=? and status='queued'").run(now,agent??null,now,'Moved to queue 2 (#'+id+')',first.item_id);
        db.exec('commit');
        return {...first,status:'claimed',claimed_at:now,claimed_by:agent??null,queue2_id:id};
      }catch(e){db.exec('rollback');throw e;}
    },
    queue2(id){
      const parse=r=>r&&{...r,item:JSON.parse(r.item)};
      return id==null?db.prepare('select * from queue2 order by id desc').all().map(parse):parse(db.prepare('select * from queue2 where id=?').get(Number(id)));
    },
    // Any change to the text withdraws an earlier approval.
    // A person's edit also clears a draft's truncated/skipped mark: the text is now theirs.
    setQueue2Message(id,message,source){return db.prepare("update queue2 set message=?,message_source=?,approved_at=null,approved_by=null,write_status=case when write_status in ('truncated','skipped') then 'edited' else write_status end,write_error=null,updated_at=? where id=?").run(message,source,new Date().toISOString(),Number(id)).changes>0;},
    setQueue2Draft(id,{message,prompt_used,model,provider,write_status,write_error,prompt_variant_id,prompt_variant_slug,prompt_variant_name}){
      const now=new Date().toISOString();
      if(message!=null)db.prepare(`update queue2 set message=?,message_source='openrouter',prompt_used=?,model=?,provider=?,write_status=?,write_error=?,written_at=?,approved_at=null,approved_by=null,
          prompt_variant_id=?,prompt_variant_slug=?,prompt_variant_name=?,updated_at=? where id=?`)
        .run(message,prompt_used,model,provider??'openrouter',write_status,write_error??null,now,prompt_variant_id??null,prompt_variant_slug??null,prompt_variant_name??null,now,Number(id));
      else db.prepare('update queue2 set write_status=?,write_error=?,prompt_used=?,model=?,provider=?,updated_at=? where id=?').run(write_status,write_error??null,prompt_used??null,model??null,provider??'openrouter',now,Number(id));
    },
    // An unsent Queue 2 entry can be thrown away; its Queue 1 item stays taken.
    // Deletes an unsent Queue 2 entry and puts its Queue 1 item back above the current #1, in one transaction.
    returnToQueue1(id){
      const r=db.prepare("select item_id from queue2 where id=? and coalesce(send_status,'ready')='ready' and engain_task_id is null").get(Number(id));if(!r)return false;
      const now=new Date().toISOString();db.exec('begin');
      try{
        const top=db.prepare("select min(position) p from queue where status='queued'").get().p??1;
        const moved=db.prepare("update queue set status='queued',position=?,claimed_at=null,claimed_by=null,note=?,updated_at=? where item_id=?").run(top-1,'Sent back from Queue 2 (#'+Number(id)+')',now,r.item_id).changes;
        if(!moved){db.exec('rollback');return false;}
        db.prepare('delete from queue2 where id=?').run(Number(id));
        db.exec('commit');return true;
      }catch(e){db.exec('rollback');throw e;}
    },
    queueRow:itemId=>db.prepare('select * from queue where item_id=?').get(itemId)||null,
    discardQueue2(id){return db.prepare("delete from queue2 where id=? and coalesce(send_status,'ready')='ready' and engain_task_id is null").run(Number(id)).changes>0;},
    // Drafts per prompt variant of one item kind, for the weighted split.
    variantCounts(kind){return Object.fromEntries(db.prepare('select prompt_variant_id id,count(*) n from queue2 where kind=? and prompt_variant_id is not null group by prompt_variant_id').all(kind).map(r=>[r.id,r.n]));},
    // Outcome per prompt variant. Engain's verdict (our_tasks) wins over Queue 2's own send status.
    variantStats(){
      return db.prepare(`select q.kind,q.prompt_variant_id id,max(q.prompt_variant_name) name,max(q.prompt_variant_slug) slug,count(*) drafted,
          sum(q.engain_task_id is not null) sent,
          sum(coalesce(t.verdict,case q.send_status when 'published' then 'approved' end)='approved') published,
          sum(t.verdict='disapproved') removed,
          sum(t.verdict='failed' or (t.verdict is null and q.send_status='failed')) failed,
          sum(t.verdict='cancelled' or (t.verdict is null and q.send_status='cancelled')) cancelled,
          sum(q.engain_task_id is not null and coalesce(t.verdict,'pending')='pending' and coalesce(q.send_status,'')<>'published') pending,
          sum(q.engain_task_id is not null and q.delivery_mode='beta') sent_dedicated,sum(q.engain_task_id is not null and coalesce(q.delivery_mode,'pool')<>'beta') sent_pool,
          sum(q.engain_task_id is null and coalesce(q.send_status,'ready') in ('ready','sending')) waiting,max(q.written_at) last_written_at
        from queue2 q left join our_tasks t on t.task_id=q.engain_task_id
        where q.prompt_variant_id is not null group by q.kind,q.prompt_variant_id`).all().map(r=>({...r}));
    },
    queue2ByTask(taskId){return db.prepare('select id,send_status from queue2 where engain_task_id=?').get(taskId)||null;},
    approveQueue2(id,by){return db.prepare("update queue2 set approved_at=?,approved_by=?,updated_at=? where id=? and send_status='ready'").run(new Date().toISOString(),by??null,new Date().toISOString(),Number(id)).changes>0;},
    setQueueStatus(id,status,note){
      const r=db.prepare('update queue set status=?,note=?,updated_at=?,position=case when ?=\'queued\' then 1e9 else null end where item_id=?').run(status,note??null,new Date().toISOString(),status,id);
      return r.changes>0;
    },
    // Drafts per prompt that the model answered SKIP (those entries are deleted, so they are counted from the log).
    variantSkips(){return Object.fromEntries(db.prepare(`select json_extract(data,'$.prompt_variant_id') id,count(*) n from events
      where type='queue2.discarded' and json_extract(data,'$.reason')='skip' and json_extract(data,'$.prompt_variant_id') is not null group by 1`).all().map(r=>[r.id,r.n]));},
    // API keys for agents and remote dashboards. Only a SHA-256 of the secret is kept; the secret is shown once.
    createApiKey({name,scope}){
      const key='gnk_'+randomBytes(24).toString('base64url'),now=new Date().toISOString(),id='k_'+randomBytes(4).toString('hex');
      db.prepare('insert into api_keys(id,name,scope,prefix,hash,created_at) values(?,?,?,?,?,?)').run(id,name,scope,key.slice(0,12),sha256(key),now);
      return {...this.apiKey(id),key};
    },
    apiKey:id=>db.prepare('select id,name,scope,prefix,created_at,last_used_at,revoked_at from api_keys where id=?').get(id)||null,
    apiKeys:()=>db.prepare('select id,name,scope,prefix,created_at,last_used_at,revoked_at from api_keys order by revoked_at is not null,created_at desc').all(),
    revokeApiKey(id){return db.prepare('update api_keys set revoked_at=? where id=? and revoked_at is null').run(new Date().toISOString(),id).changes>0;},
    // The active key for a secret, marking it used; null when unknown or revoked.
    apiKeyFor(secret){
      const r=db.prepare('select id,name,scope,prefix from api_keys where hash=? and revoked_at is null').get(sha256(String(secret)));
      if(r)db.prepare('update api_keys set last_used_at=? where id=?').run(new Date().toISOString(),r.id);
      return r||null;
    },
    kv(key){const r=db.prepare('select value from settings where key=?').get(key);return r?JSON.parse(r.value):null;},
    setKv(key,value){db.prepare('insert or replace into settings(key,value) values(?,?)').run(key,JSON.stringify(value));},
    settings(defaults){const r=db.prepare("select value from settings where key='queue'").get();return {...defaults,...(r?JSON.parse(r.value):{})};},
    saveSettings(value){db.prepare("insert or replace into settings(key,value) values('queue',?)").run(JSON.stringify(value));},
    run(id){const r=id==='latest'?db.prepare('select * from runs order by id desc limit 1').get():db.prepare('select * from runs where id=?').get(Number(id));return r&&{...r,input:JSON.parse(r.input),summary:r.summary&&JSON.parse(r.summary)};},
    
    // Queue2 send methods
    reserveQueue2Send(id,mode,account){
      const now=new Date().toISOString();
      const r=db.prepare(`update queue2 set send_status='sending',delivery_mode=?,
        ${mode==='beta'?'user_account_id':'poster_account'}=?,reserved_at=?,updated_at=?
        where id=? and send_status='ready'`).run(mode,account??null,now,now,Number(id));
      if(r.changes===0)return null;
      const parse=r=>r&&{...r,item:JSON.parse(r.item)};
      return parse(db.prepare('select * from queue2 where id=?').get(Number(id)));
    },
    // A send enters the tracking list as pending with Engain's first status.
    recordQueue2Send(id,taskId,response){
      const now=new Date().toISOString(),status=String(response?.status||'submitted');
      db.exec('begin');
      try{
        db.prepare(`update queue2 set send_status='submitted',engain_task_id=?,sent_at=?,engain_status=?,status_changed_at=?,status_checked_at=?,settled=0,updated_at=?
          where id=?`).run(taskId,now,status,now,now,now,Number(id));
        db.prepare('insert into queue2_events(queue2_id,from_status,to_status,at) values(?,?,?,?)').run(Number(id),null,status,now);
        db.exec('commit');
      }catch(e){db.exec('rollback');throw e;}
    },
    // Records Engain's current status for a sent item. A change is appended to queue2_events; an
    // item leaves the "to check" set once its status is final (it keeps the status, it is not removed).
    trackStatus(id,status,redditUrl){
      const row=db.prepare('select id,item_id,engain_task_id,engain_status,status_changed_at from queue2 where id=?').get(Number(id));if(!row)return null;
      const now=new Date().toISOString(),pending=PENDING_STATUSES.has(status),changed=row.engain_status!==status;
      const send=status==='published'?'published':status==='cancelled'?'cancelled':pending?'submitted':'failed';
      db.exec('begin');
      try{
        if(changed)db.prepare('insert into queue2_events(queue2_id,from_status,to_status,at) values(?,?,?,?)').run(row.id,row.engain_status??null,status,now);
        db.prepare(`update queue2 set engain_status=?,settled=?,status_checked_at=?,status_changed_at=?,send_status=?,reddit_url=coalesce(?,reddit_url),
            send_reason=case when ? in ('failed','cancelled') then ? else send_reason end,
            published_at=case when ?='published' then coalesce(published_at,?) else published_at end,updated_at=? where id=?`)
          .run(status,pending?0:1,now,changed?now:row.status_changed_at,send,redditUrl??null,send,'Engain status: '+status,status,now,now,row.id);
        db.exec('commit');
      }catch(e){db.exec('rollback');throw e;}
      if(changed)event('sent.status',`Queue 2 #${row.id}: ${row.engain_status||'sent'} -> ${status}`,{queue2_id:row.id,item_id:row.item_id,task_id:row.engain_task_id,from:row.engain_status??null,to:status,reddit_url:redditUrl??null});
      return {changed,from:row.engain_status??null,to:status};
    },
    toCheck:()=>db.prepare("select id,engain_task_id from queue2 where engain_task_id is not null and coalesce(settled,0)=0 order by sent_at").all(),
    sentSince(since){return db.prepare('select * from queue2 where engain_task_id is not null and (? is null or sent_at>=?) order by sent_at desc').all(since,since).map(r=>({...r,item:JSON.parse(r.item)}));},
    // Our tasks in one thread that reached Reddit, oldest first: Engain's task list plus Queue 2
    // sends it has not listed yet. Cancelled and failed tasks never appeared, so they are left out.
    threadPosts(threadId){
      const never="('cancelled','canceled','error','post_url_broken','rebuilt','thread_archived_locked')";
      const tasks=db.prepare(`select task_id,coalesce(posted_from,'pool') source,coalesce(created_at,first_seen) at,status from our_tasks
        where thread_id=? and verdict not in ('cancelled','failed')`).all(String(threadId));
      const sent=db.prepare(`select engain_task_id task_id,case delivery_mode when 'beta' then 'dedicated' else 'pool' end source,sent_at at,engain_status status from queue2
        where thread_id=? and engain_task_id is not null and coalesce(engain_status,'') not in ${never}`).all(String(threadId));
      const seen=new Set(tasks.map(t=>t.task_id));
      return [...tasks,...sent.filter(t=>!seen.has(t.task_id))].sort((a,b)=>String(a.at).localeCompare(String(b.at)));
    },
    queue2Events:id=>db.prepare('select from_status,to_status,at from queue2_events where queue2_id=? order by id').all(Number(id)),
    // A send that failed before Engain made a task goes back to Queue 2 as a fresh, unapproved draft.
    retryQueue2(id){return db.prepare(`update queue2 set send_status='ready',approved_at=null,approved_by=null,send_error=null,send_reason=null,failed_at=null,
      delivery_mode=null,user_account_id=null,poster_account=null,reserved_at=null,updated_at=? where id=? and send_status='failed' and engain_task_id is null`).run(new Date().toISOString(),Number(id)).changes>0;},
    failQueue2Send(id,reason,error){
      const now=new Date().toISOString();
      db.prepare(`update queue2 set send_status='failed',send_reason=?,send_error=?,failed_at=?,updated_at=?
        where id=?`).run(reason??null,error??null,now,now,Number(id));
    },
    updateQueue2Status(id,status,redditUrl,reason){
      const now=new Date().toISOString();
      const updates=['last_status_check=?','updated_at=?'];
      const values=[now,now];
      if(status==='published'){
        updates.push('send_status=?','reddit_url=?','published_at=?');
        values.push('published',redditUrl??null,now);
      }else if(status==='failed'||status==='cancelled'){
        updates.push('send_status=?','send_reason=?');
        values.push(status,reason??null);
        if(status==='failed')updates.push('failed_at=?'),values.push(now);
      }
      values.push(Number(id));
      db.prepare(`update queue2 set ${updates.join(',')} where id=?`).run(...values);
    },
    setQueue2Override(id,field,value){
      db.prepare(`update queue2 set ${field}=?,updated_at=? where id=?`)
        .run(value?1:0,new Date().toISOString(),Number(id));
    },
    queue2Pacing(){
      let p=db.prepare('select * from queue2_pacing where id=1').get();
      if(!p)return {last_send_global:null,sends_today_utc:0,today_utc_date:null,subreddit_last_send:{}};
      return {...p,subreddit_last_send:JSON.parse(p.subreddit_last_send)};
    },
    recordQueue2Pace(subreddit){
      const now=new Date().toISOString();
      const today=now.slice(0,10);
      const p=db.prepare('select * from queue2_pacing where id=1').get();
      const subs=p?JSON.parse(p.subreddit_last_send):{};
      subs[subreddit]=now;
      const sends=(!p||p.today_utc_date!==today)?1:(p.sends_today_utc||0)+1;
      db.prepare(`insert or replace into queue2_pacing(id,last_send_global,sends_today_utc,today_utc_date,subreddit_last_send,updated_at)
        values(1,?,?,?,?,?)`).run(now,sends,today,JSON.stringify(subs),now);
    },
    
    close:()=>db.close(),
  };
}

module.exports={open};
