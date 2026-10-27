// Thread collection from Engain: opportunities (new + SEO), brand mentions and Smart Search,
// merged per Reddit thread, enriched with subreddit moderation stats and ranked.
const SOURCES=['opportunities','mentions','smart_search'];
const DAY=86400000;

function threadRef(raw){
  let u;try{u=new URL(raw);}catch{return null;}
  if(/(^|\.)redd\.it$/.test(u.hostname)){const id=u.pathname.split('/')[1];return id?{thread_id:id.toLowerCase(),subreddit:null,url:'https://redd.it/'+id}:null;}
  if(!/(^|\.)reddit\.com$/.test(u.hostname))return null;
  const m=u.pathname.match(/^\/r\/([^/]+)\/comments\/([a-z0-9]+)/i);
  return m?{thread_id:m[2].toLowerCase(),subreddit:m[1],url:`https://www.reddit.com/r/${m[1]}/comments/${m[2].toLowerCase()}/`}:null;
}
const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const relevance=r=>(r=num(r))==null||r<0?null:r>1?Math.min(r/100,1):r;

function fromOpportunity(o){
  const p=o.postContent||{},ref=threadRef(p.url);if(!ref)return null;
  return {...ref,subreddit:o.subreddit||ref.subreddit,title:p.title,body:p.content,author:p.author,created_utc:num(p.createdUtc),
    score:num(p.score),num_comments:num(p.numComments),relevance:relevance(o.relevance),visits_per_month:num(o.estimatedMonthlyClicks),
    traffic_value:num(o.trafficValue),google_position:num(o.serpPosition),opportunity_id:o.id,
    sources:['opportunities:'+(o.type==='seo_opportunities'?'seo':'new')],reasons:Array.isArray(o.reasons)?o.reasons.map(String):[],
    ranking_keywords:Array.isArray(o.allRankingKeywords)?o.allRankingKeywords.map(k=>typeof k==='string'?k:k?.keyword).filter(Boolean):[]};
}
function fromMention(m){
  const p=m.postContent||{},ref=threadRef(p.url);if(!ref)return null;
  return {...ref,subreddit:m.subreddit||ref.subreddit,title:p.title,body:p.content,author:p.author,created_utc:num(p.createdUtc),
    score:num(p.score),num_comments:num(p.numComments),sources:['mentions'],
    mentions:[{id:m.id,type:m.type,brand:m.mentionedBrand,sentiment:m.sentiment,snippet:m.snippet,reasoning:m.reasoning,permalink:m.commentContent?.permalink||null}]};
}
function fromSmartSearch(r,keyword){
  const ref=threadRef(r.redditUrl);if(!ref)return null;
  return {...ref,subreddit:r.subreddit||ref.subreddit,title:r.postTitle,created_utc:num(r.createdUtc),score:num(r.score),num_comments:num(r.numComments),
    visits_per_month:num(r.visitsPerMonth),traffic_value:num(r.trafficValue),google_position:r.googleRanked?num(r.googlePosition):null,
    reddit_views:num(r.estimatedRedditViews),sources:['smart_search'],keywords:[keyword]};
}

// Score 0-100 with a visible breakdown. Weights are a starting point to tune, not Engain's model.
function rank(t,sub,now=Date.now()){
  const parts={},flags=[];
  const baseRel=t.relevance??(t.sources.includes('mentions')?0.8:t.sources.includes('smart_search')?0.6:0.5);
  parts.relevance=baseRel*35;
  parts.traffic=Math.min(1,Math.log10(1+(t.visits_per_month||0))/4)*25;
  parts.discussion=Math.min(1,Math.log10(1+(t.num_comments||0))/2.5)*15;
  parts.google=t.google_position?Math.max(0,1-(t.google_position-1)/10)*10:0;
  const age=t.created_utc?(now-t.created_utc*1000)/DAY:null;
  parts.freshness=age==null?5:age<=30?15:Math.max(0,1-(age-30)/150)*15;
  if(age!=null&&age>180&&!t.sources.includes('smart_search')){parts.archived=-20;flags.push('Older than 6 months: may be archived (Reddit default)');}
  if(sub){
    const commentRate=(sub.buckets||[]).find(b=>b.contentType==='comment'&&num(b.removalRate)!=null)?.removalRate;
    const risk=Math.max((sub.moderationLevel??0)/95,commentRate??0);
    if(risk)parts.subreddit_risk=-risk*25;
    if(sub.ruleFlags?.bansSelfPromotion){parts.self_promo_ban=-10;flags.push('Subreddit bans self-promotion');}
    if(sub.ruleFlags?.hasKarmaOrAgeGate)flags.push('Karma or account-age gate');
    if(sub.botBouncerStatus==='installed'){parts.bot_bouncer=-8;flags.push('BotBouncer installed');}
  }
  const score=Math.round(Math.max(0,Math.min(100,Object.values(parts).reduce((a,b)=>a+b,0))));
  for(const k in parts)parts[k]=Math.round(parts[k]*10)/10;
  return {score,parts,flags,age_days:age==null?null:Math.round(age*10)/10};
}

async function paginate(fetchPage,maxPages,key){
  const items=[];let cursor;
  for(let page=0;page<maxPages;page++){
    const r=await fetchPage(cursor);
    items.push(...(Array.isArray(r?.[key])?r[key]:[]));
    if(r?.isDone||!r?.continueCursor)break;cursor=r.continueCursor;
  }
  return items;
}

async function collect(input,{engain,store,projectId,onProgress=()=>{}}){
  const sources=(input.sources||['opportunities','mentions']).filter(s=>SOURCES.includes(s));
  const keywords=[...new Set((input.keywords||[]).map(k=>String(k).trim()).filter(Boolean))].slice(0,25);
  const maxPages=Math.max(1,Math.min(Number(input.max_pages)||3,20));
  const summary={project_id:projectId,sources,keywords,added:0,updated:0,per_source:{},skipped_urls:0,errors:[],notes:[],subreddits_enriched:0,quota_remaining:null};
  const touched=new Set();
  const save=(t,label)=>{
    if(!t){summary.skipped_urls++;return;}
    summary[store.upsert(t)]++;touched.add(t.thread_id);
    summary.per_source[label]=(summary.per_source[label]||0)+1;
  };
  const step=async(label,fn)=>{onProgress({step:label,...summary});try{await fn();}catch(e){summary.errors.push(`${label}: ${e.message}`);}};

  if(sources.includes('opportunities'))for(const type of ['new_opportunities','seo_opportunities'])
    await step(type,async()=>{
      const items=await paginate(cursor=>engain.opportunities({projectId,type,sortBy:'relevance',numItems:100,cursor}),maxPages,'opportunities');
      for(const o of items)save(fromOpportunity(o),type);
    });
  if(sources.includes('mentions'))
    await step('mentions',async()=>{
      const items=await paginate(cursor=>engain.mentions({projectId,sortBy:'relevance',numItems:100,cursor}),maxPages,'mentions');
      for(const m of items)save(fromMention(m),'mentions');
    });
  if(sources.includes('smart_search'))for(const keyword of keywords)
    await step('smart_search:'+keyword,async()=>{
      // Stored results are free; a new search spends one keyword of Smart Search quota.
      let r=null;
      try{r=await engain.smartSearchResults({projectId,keyword});}catch(e){if(e.status!==404)throw e;}
      if((!r||r.isStale)&&input.spend_quota){r=await engain.smartSearch({projectId,keyword});summary.quota_remaining=r.quotaRemaining??summary.quota_remaining;}
      else if(!r){summary.notes.push(`"${keyword}" has no stored Smart Search results; enable "spend quota" to run it (1 keyword of quota)`);return;}
      else if(r.isStale)summary.notes.push(`"${keyword}" results are over 30 days old; enable "spend quota" to refresh`);
      for(const x of r.results||[])save(fromSmartSearch(x,keyword),'smart_search');
    });

  if(input.enrich!==false){
    const subs=[...new Set([...touched].map(id=>store.thread(id).subreddit).filter(Boolean).map(s=>s.toLowerCase()))];
    const stale=subs.filter(s=>{const c=store.subreddit(s);return !c||Date.now()-Date.parse(c.fetched_at)>DAY;});
    for(const s of stale)await step('subreddit_stats:'+s,async()=>{store.saveSubreddit(s,await engain.subredditStats(s));summary.subreddits_enriched++;});
  }
  onProgress({step:'done',...summary});
  return summary;
}

function ranked(store,{q,subreddit,source,min_score,limit=100,offset=0}={}){
  const subs=store.subreddits(),needle=String(q||'').toLowerCase();
  const rows=store.threads().map(t=>({...t,body:t.body?String(t.body).slice(0,400):t.body,rank:rank(t,subs[(t.subreddit||'').toLowerCase()]),subreddit_stats:subs[(t.subreddit||'').toLowerCase()]||null}))
    .filter(t=>!needle||`${t.title} ${t.subreddit} ${t.keywords.join(' ')}`.toLowerCase().includes(needle))
    .filter(t=>!subreddit||String(t.subreddit).toLowerCase()===String(subreddit).toLowerCase())
    .filter(t=>!source||t.sources.some(s=>s.startsWith(source)))
    .filter(t=>min_score==null||t.rank.score>=Number(min_score))
    .sort((a,b)=>b.rank.score-a.rank.score||(b.visits_per_month||0)-(a.visits_per_month||0));
  return {total:rows.length,items:rows.slice(Number(offset),Number(offset)+Math.min(Number(limit)||100,500))};
}

module.exports={collect,ranked,rank,threadRef,fromOpportunity,fromMention,fromSmartSearch,SOURCES};
