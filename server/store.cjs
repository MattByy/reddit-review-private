// Local SQLite store (node:sqlite, no dependencies). One row per Reddit thread, merged across sources.
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');

const JSON_COLS=['sources','keywords','reasons','mentions','ranking_keywords'];

function open(file){
  if(file!==':memory:')fs.mkdirSync(path.dirname(file),{recursive:true});
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
  `);
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
    db,upsert,
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
    setQueue2Message(id,message,source){return db.prepare('update queue2 set message=?,message_source=?,updated_at=? where id=?').run(message,source,new Date().toISOString(),Number(id)).changes>0;},
    setQueueStatus(id,status,note){
      const r=db.prepare('update queue set status=?,note=?,updated_at=?,position=case when ?=\'queued\' then 1e9 else null end where item_id=?').run(status,note??null,new Date().toISOString(),status,id);
      return r.changes>0;
    },
    kv(key){const r=db.prepare('select value from settings where key=?').get(key);return r?JSON.parse(r.value):null;},
    setKv(key,value){db.prepare('insert or replace into settings(key,value) values(?,?)').run(key,JSON.stringify(value));},
    settings(defaults){const r=db.prepare("select value from settings where key='queue'").get();return {...defaults,...(r?JSON.parse(r.value):{})};},
    saveSettings(value){db.prepare("insert or replace into settings(key,value) values('queue',?)").run(JSON.stringify(value));},
    run(id){const r=id==='latest'?db.prepare('select * from runs order by id desc limit 1').get():db.prepare('select * from runs where id=?').get(Number(id));return r&&{...r,input:JSON.parse(r.input),summary:r.summary&&JSON.parse(r.summary)};},
    close:()=>db.close(),
  };
}

module.exports={open};
