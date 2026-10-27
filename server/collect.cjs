// Thread collection from Engain: opportunities (new + SEO), brand mentions and Smart Search,
// merged per Reddit thread, enriched with subreddit moderation stats and ranked. Mentions also
// feed a comment list (comments naming Geonode or a tracked competitor), and Engain's own task
// list marks threads we already worked in.
const SOURCES=['opportunities','mentions','smart_search','tasks'];
const DAY=86400000;
const OWN_BRAND=/geonode/i;
// Geonode's topic: a comment or thread must touch one of these to count as relevant.
const TOPIC=/\bprox(y|ies)\b|residential|rotating|\bisp\b|datacenter|data center|mobile prox|scrap(e|er|ers|ing)|crawl(er|ing)?|captcha|cloudflare|anti-?bot|\bwaf\b|blocked|ip ban|banned ip|rate.?limit|\bserp\b|unblock|fingerprint|headless|playwright|puppeteer|selenium|geo-?(target|restrict)|\bvpn\b|bandwidth|\bips?\b/gi;
// Generic words ("ip", "vpn", "blocked", "bandwidth"...) add weight but never qualify a comment alone.
const STRONG=/^(prox(y|ies)|residential|rotating|datacenter|data center|mobile prox|scrap(e|er|ers|ing)|crawl(er|ing)?|captcha|cloudflare|anti-?bot|serp|unblock|fingerprint|headless|playwright|puppeteer|selenium)$/i;
const INTENT=/\?|recommend|suggest|looking for|alternative|anyone (use|tried|know)|which (one|provider)|worth it|switch(ed|ing)? (from|to)|too expensive|pricing|cheaper|issue|problem|not working|keeps? (getting )?block/i;
const ACTIVE=new Set(['scheduled','in_review','in_queue','waiting_for_parent_comment','waiting_for_mod_approval','sent_for_posting','assigned','published']);
const REMOVED=new Set(['mod_removed','automod_removed']);

function threadRef(raw){
  let u;try{u=new URL(raw);}catch{return null;}
  if(/(^|\.)redd\.it$/.test(u.hostname)){const id=u.pathname.split('/')[1];return id?{thread_id:id.toLowerCase(),subreddit:null,url:'https://redd.it/'+id}:null;}
  if(!/(^|\.)reddit\.com$/.test(u.hostname))return null;
  const m=u.pathname.match(/^\/r\/([^/]+)\/comments\/([a-z0-9]+)/i);
  return m?{thread_id:m[2].toLowerCase(),subreddit:m[1],url:`https://www.reddit.com/r/${m[1]}/comments/${m[2].toLowerCase()}/`}:null;
}
const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const relevance=r=>(r=num(r))==null||r<0?null:r>1?Math.min(r/100,1):r;
const topicHits=text=>[...new Set((String(text||'').match(TOPIC)||[]).map(s=>s.toLowerCase()))];

function fromOpportunity(o){
  const p=o.postContent||{},ref=threadRef(p.url);if(!ref)return null;
  return {...ref,subreddit:o.subreddit||ref.subreddit,title:p.title,body:p.content,author:p.author,created_utc:num(p.createdUtc),
    score:num(p.score),num_comments:num(p.numComments),relevance:relevance(o.relevance),visits_per_month:num(o.estimatedMonthlyClicks),
    traffic_value:num(o.trafficValue),google_position:num(o.serpPosition),opportunity_id:o.id,
    sources:['opportunities:'+(o.type==='seo_opportunities'?'seo':'new')],reasons:Array.isArray(o.reasons)?o.reasons.map(String):[],
    ranking_keywords:Array.isArray(o.allRankingKeywords)?o.allRankingKeywords.map(k=>typeof k==='string'?k:k?.keyword).filter(Boolean):[]};
}
function fromMention(m){
  const p=m.postContent||{},ref=threadRef(p.url||m.commentContent?.permalink);if(!ref)return null;
  return {...ref,subreddit:m.subreddit||ref.subreddit,title:p.title,body:p.content,author:p.author,created_utc:num(p.createdUtc),
    score:num(p.score),num_comments:num(p.numComments),sources:['mentions'],
    mentions:[{id:m.id,type:m.type,brand:m.mentionedBrand,sentiment:m.sentiment,snippet:m.snippet,reasoning:m.reasoning,permalink:m.commentContent?.permalink||null}]};
}
function commentFromMention(m,threadId){
  const c=m.commentContent;if(m.type!=='comment'||!c?.body)return null;
  return {id:m.id,thread_id:threadId,subreddit:m.subreddit,thread_title:m.postContent?.title||null,brand:m.mentionedBrand,sentiment:m.sentiment,
    body:String(c.body).slice(0,10000),author:c.author,score:num(c.score),created_utc:num(c.createdUtc),permalink:c.permalink||null,
    snippet:m.snippet||null,reasoning:m.reasoning||null};
}
function fromSmartSearch(r,keyword){
  const ref=threadRef(r.redditUrl);if(!ref)return null;
  return {...ref,subreddit:r.subreddit||ref.subreddit,title:r.postTitle,created_utc:num(r.createdUtc),score:num(r.score),num_comments:num(r.numComments),
    visits_per_month:num(r.visitsPerMonth),traffic_value:num(r.trafficValue),google_position:r.googleRanked?num(r.googlePosition):null,
    reddit_views:num(r.estimatedRedditViews),sources:['smart_search'],keywords:[keyword]};
}

const DEFAULT_MAX_AGE=120;
// Score 0-100 with a visible breakdown. Weights are a starting point to tune, not Engain's model.
// Age past max_age_days is reported as a flag; the queue excludes those threads outright.
function rank(t,sub,{max_age_days=DEFAULT_MAX_AGE}={},now=Date.now()){
  const parts={},flags=[];
  // Engain scores opportunities; Smart Search hits matched our own keywords. A thread found only
  // through a brand mention earns relevance from an on-topic title/body or its best on-topic comment.
  let baseRel=t.relevance??(t.sources.includes('smart_search')?0.6:0);
  if(t.relevance==null&&topicHits(t.title+' '+(t.body||'')).length)baseRel=Math.max(baseRel,0.5);
  if(t.best_comment_score)baseRel=Math.max(baseRel,t.best_comment_score/100);
  const offTopic=baseRel===0;
  if(offTopic)flags.push('No proxy/scraping signal in the thread or its mention comments');
  parts.relevance=baseRel*35;
  parts.traffic=Math.min(1,Math.log10(1+(t.visits_per_month||0))/4)*20;
  parts.google=t.google_position?Math.max(0,1-(t.google_position-1)/10)*5:0;
  const age=t.created_utc?(now-t.created_utc*1000)/DAY:null;
  parts.discussion=Math.min(1,Math.log10(1+(t.num_comments||0))/2.5)*10;
  // Activity: comments per day since creation (about 30/day scores full).
  const perDay=age==null||t.num_comments==null?null:t.num_comments/Math.max(age,1);
  parts.activity=perDay==null?0:Math.min(1,Math.log10(1+perDay)/1.5)*15;
  parts.freshness=age==null?0:age<=14?15:Math.max(0,1-(age-14)/(max_age_days-14))*15;
  const tooOld=age==null||age>max_age_days;
  if(age==null)flags.push('Creation date unknown');else if(age>max_age_days)flags.push(`Older than ${max_age_days} days`);
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
  return {score,parts,flags,off_topic:offTopic,too_old:tooOld,comments_per_day:perDay==null?null:Math.round(perDay*100)/100,age_days:age==null?null:Math.round(age*10)/10};
}

function bestCommentScores(store){
  const best={};
  for(const c of store.comments()){const s=rankComment(c).score;if(s>(best[c.thread_id]||0))best[c.thread_id]=s;}
  return best;
}

// Comment relevance 0-100. A comment with no Geonode-topic term in it or its thread title scores 0.
function rankComment(c,{max_age_days=DEFAULT_MAX_AGE}={},now=Date.now()){
  const parts={},reasons=[],own=OWN_BRAND.test(c.brand||'');
  // Strip the brand's own name so "firecrawl" or "serpapi" does not count as a topic word.
  const name=String(c.brand||'').split('.')[0];
  const hits=topicHits((c.body+' '+(c.thread_title||'')).replace(name?new RegExp(name.replace(/[^a-z0-9]/gi,''),'gi'):/$^/,' '));
  // The comment itself must name the topic; the thread title only adds weight.
  const own_words=topicHits(String(c.body||'').replace(name?new RegExp(name.replace(/[^a-z0-9]/gi,''),'gi'):/$^/,' '));
  if(!own_words.some(h=>STRONG.test(h)))return {score:0,parts:{},reasons:['No proxy/scraping topic in the comment or thread title'],own,too_old:false,topics:hits};
  parts.topic=Math.min(hits.length,4)/4*35;
  if(INTENT.test(c.body)){parts.intent=20;reasons.push('Asks, compares or reports a problem');}
  if(own){parts.brand=c.sentiment==='negative'?25:15;reasons.push(c.sentiment==='negative'?'Negative about Geonode: needs a support answer':'Mentions Geonode');}
  else{parts.brand=c.sentiment==='negative'?25:c.sentiment==='neutral'?15:10;reasons.push(`Mentions ${c.brand}${c.sentiment==='negative'?' negatively':''}`);}
  const age=c.created_utc?(now-c.created_utc*1000)/DAY:null;
  parts.freshness=age==null?0:age<=7?20:Math.max(0,1-(age-7)/(max_age_days-7))*20;
  const tooOld=age==null||age>max_age_days;
  if(age==null)reasons.push('Comment date unknown');else if(age>max_age_days)reasons.push(`Older than ${max_age_days} days`);
  const score=Math.round(Math.max(0,Math.min(100,Object.values(parts).reduce((a,b)=>a+b,0))));
  for(const k in parts)parts[k]=Math.round(parts[k]*10)/10;
  return {score,parts,reasons,own,too_old:tooOld,topics:hits,age_days:age==null?null:Math.round(age*10)/10};
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
  const sources=(input.sources||['opportunities','mentions','smart_search','tasks']).filter(s=>SOURCES.includes(s));
  let keywords=[...new Set((input.keywords||[]).map(k=>String(k).trim()).filter(Boolean))].slice(0,50);
  const maxPages=Math.max(1,Math.min(Number(input.max_pages)||3,20));
  const summary={project_id:projectId,sources,keywords,added:0,updated:0,per_source:{},comments_added:0,comments_updated:0,engaged_threads:0,
    skipped_urls:0,errors:[],notes:[],subreddits_enriched:0,quota_remaining:null};
  const touched=new Set();
  const save=(t,label)=>{
    if(!t){summary.skipped_urls++;return;}
    summary[store.upsert(t)]++;touched.add(t.thread_id);
    summary.per_source[label]=(summary.per_source[label]||0)+1;
  };
  const step=async(label,fn)=>{onProgress({step:label,...summary});try{await fn();}catch(e){summary.errors.push(`${label}: ${e.message}`);}};

  if(sources.includes('tasks'))
    await step('tasks',async()=>{
      // Every thread with a live, published or moderator-removed task is ours already.
      const tasks=await paginate(cursor=>engain.tasks({projectId,numItems:100,cursor}).then(r=>({...r,continueCursor:r.continueCursor||r.cursor})),Math.max(maxPages,20),'page');
      const map=new Map();
      for(const t of tasks){
        if(!ACTIVE.has(t.status)&&!REMOVED.has(t.status))continue;
        const ref=threadRef(t.threadUrl||t.redditUrl);if(!ref)continue;
        const e=map.get(ref.thread_id)||{subreddit:t.subreddit||ref.subreddit,statuses:[]};e.statuses.push(t.status);map.set(ref.thread_id,e);
      }
      store.setEngaged(map);summary.engaged_threads=map.size;summary.per_source.tasks_read=tasks.length;
    });
  if(sources.includes('opportunities'))for(const type of ['new_opportunities','seo_opportunities'])
    await step(type,async()=>{
      const items=await paginate(cursor=>engain.opportunities({projectId,type,sortBy:'relevance',numItems:200,cursor}),maxPages,'opportunities');
      for(const o of items)save(fromOpportunity(o),type);
    });
  if(sources.includes('mentions')){
    let brands=[];
    await step('mention_brands',async()=>{brands=((await engain.mentionBrands({projectId})).brands||[]).map(b=>b.brand).filter(Boolean);});
    for(const brand of brands.length?brands:[undefined])
      await step('mentions:'+(brand||'project'),async()=>{
        const items=await paginate(cursor=>engain.mentions({projectId,brand,sortBy:'date_newest',numItems:100,cursor}),maxPages,'mentions');
        for(const m of items){
          const t=fromMention(m);save(t,'mentions');
          const c=t&&commentFromMention(m,t.thread_id);if(c)summary[store.saveComment(c)==='added'?'comments_added':'comments_updated']++;
        }
      });
  }
  if(sources.includes('smart_search')){
    if(!keywords.length)await step('smart_search_history',async()=>{
      keywords=[...new Set(((await engain.smartSearchHistory({projectId,limit:100})).history||[]).map(h=>h.keyword))];
      summary.keywords=keywords;if(keywords.length)summary.notes.push(`Re-read ${keywords.length} previously searched keywords (free)`);
    });
    for(const keyword of keywords)
      await step('smart_search:'+keyword,async()=>{
        // Stored results are free; a new search spends one keyword of Smart Search quota.
        let r=null;
        try{r=await engain.smartSearchResults({projectId,keyword});}catch(e){if(e.status!==404)throw e;}
        if((!r||r.isStale)&&input.spend_quota){r=await engain.smartSearch({projectId,keyword});summary.quota_remaining=r.quotaRemaining??summary.quota_remaining;}
        else if(!r){summary.notes.push(`"${keyword}" has no stored Smart Search results; enable "spend quota" to run it (1 keyword of quota)`);return;}
        else if(r.isStale)summary.notes.push(`"${keyword}" results are from ${String(r.fetchedAt).slice(0,10)} (stale); enable "spend quota" to refresh`);
        for(const x of r.results||[])save(fromSmartSearch(x,keyword),'smart_search');
      });
  }

  if(input.enrich!==false){
    // Subreddit stats cost one request each (30/min), so only look up the subreddits of the
    // strongest candidates and relevant comments, best first, up to enrich_limit.
    const limit=Math.max(0,Math.min(Number(input.enrich_limit??100),1000)),engaged=store.engaged(),best=bestCommentScores(store);
    const candidates=[];
    for(const t of store.threads()){
      if(engaged[t.thread_id])continue;
      const r=rank({...t,best_comment_score:best[t.thread_id]},null);
      if(!r.off_topic)candidates.push({sub:t.subreddit,score:r.score});
    }
    for(const c of store.comments()){const r=rankComment(c);if(r.score>=40)candidates.push({sub:c.subreddit,score:r.score});}
    const subs=[...new Set(candidates.filter(c=>c.sub).sort((a,b)=>b.score-a.score).map(c=>c.sub.toLowerCase()))];
    const stale=subs.filter(s=>{const c=store.subreddit(s);return !c||Date.now()-Date.parse(c.fetched_at)>DAY;}).slice(0,limit);
    for(const s of stale)await step('subreddit_stats:'+s,async()=>{store.saveSubreddit(s,await engain.subredditStats(s));summary.subreddits_enriched++;});
  }
  onProgress({step:'done',...summary});
  return summary;
}

module.exports={collect,rank,rankComment,topicHits,threadRef,fromOpportunity,fromMention,fromSmartSearch,commentFromMention,SOURCES,REMOVED,DEFAULT_MAX_AGE};
