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
  `);
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
    run(id){const r=id==='latest'?db.prepare('select * from runs order by id desc limit 1').get():db.prepare('select * from runs where id=?').get(Number(id));return r&&{...r,input:JSON.parse(r.input),summary:r.summary&&JSON.parse(r.summary)};},
    close:()=>db.close(),
  };
}

module.exports={open};
