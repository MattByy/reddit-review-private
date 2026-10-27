// Invented Engain responses shaped like docs.engain.io, for running the dev server without a key or credits.
const SUBS=['webscraping','proxies','datascience','Python','sysadmin','SEO','selfhosted','learnprogramming'];
const TOPICS=['Best residential proxies for scraping in 2026?','Getting blocked by Cloudflare after 50 requests','How do you rotate IPs with Playwright?',
  'Scraping Google SERPs without getting banned','Datacenter vs residential proxies, real difference?','Python requests keeps timing out behind proxy',
  'Cheapest way to monitor competitor prices','Is web scraping legal for public data?','Proxy pool for a small SEO rank tracker',
  'Headless Chrome fingerprinting tips','Sticky sessions vs rotating proxies','Rate limiting strategy for a polite crawler'];
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});
const id=n=>'m'+(1000+n).toString(36);
const now=Date.now()/1000;

function post(n){
  const sub=SUBS[n%SUBS.length],tid=id(n);
  return {title:TOPICS[n%TOPICS.length]+(n>=TOPICS.length?` (#${n})`:''),content:'Example post body for local testing.',
    url:`https://www.reddit.com/r/${sub}/comments/${tid}/example_${n}/`,author:'reader'+n,createdUtc:Math.round(now-((n*7)%200+1)*86400),
    score:(n*37)%400,upvotes:(n*37)%400,downvotes:0,numComments:(n*13)%220};
}
function opportunity(n,type){
  const p=post(n);
  return {id:'opp_'+n,type,subreddit:p.url.split('/')[4],redditPostId:'t3_'+id(n),postContent:p,relevance:(97-(n*11)%60),reasons:['Asks about '+p.title.split(' ').slice(0,3).join(' ').toLowerCase()],
    trafficValue:type==='seo_opportunities'?(n*29)%300:0,serpPosition:type==='seo_opportunities'?1+n%9:null,
    estimatedMonthlyClicks:type==='seo_opportunities'?(n*311)%9000:null,allRankingKeywords:type==='seo_opportunities'?['proxy for scraping','rotating proxies']:[],discoveredVia:['mock'],createdAt:Date.now()};
}
const searched=new Set(['residential proxies']);

async function mockFetch(url,options={}){
  const u=new URL(url),q=u.searchParams,method=options.method||'GET';
  await new Promise(r=>setTimeout(r,30));
  if(u.pathname==='/api/v1/me')return json({userId:'mock-user',projects:[{id:'project_mock',name:'geonode.com (mock)'}]});
  if(u.pathname==='/api/v1/balance')return json({credits:1000,freeComments:0});
  if(u.pathname==='/api/v1/opportunities'){
    const type=q.get('type'),start=Number(q.get('cursor')||0),size=Math.min(Number(q.get('numItems')||100),10),total=type==='seo_opportunities'?18:24;
    const items=[];for(let n=start;n<Math.min(start+size,total);n++)items.push(opportunity(type==='seo_opportunities'?n+30:n,type));
    const done=start+size>=total;return json({opportunities:items,isDone:done,...(done?{}:{continueCursor:String(start+size)})});
  }
  if(u.pathname==='/api/v1/mentions')return json({mentions:[3,8,41].map((n,i)=>({id:'men_'+n,type:i?'comment':'post',mentionedBrand:'Geonode',subreddit:post(n).url.split('/')[4],redditPostId:'t3_'+id(n),
    postContent:post(n),commentContent:i?{body:'I tried Geonode for this',author:'someone',score:4,createdUtc:now-3600,permalink:post(n).url+'c'+n+'/'}:undefined,
    sentiment:['neutral','positive','negative'][i],reasoning:'Mock mention',snippet:'…Geonode…',createdAt:Date.now()})),isDone:true});
  if(u.pathname==='/api/v1/smart-search'||u.pathname==='/api/v1/smart-search/results'){
    const body=method==='POST'?JSON.parse(options.body):{},keyword=body.keyword||q.get('keyword');
    if(method==='GET'&&!searched.has(keyword))return json({error:'Keyword not searched'},404);
    searched.add(keyword);
    const seed=[...keyword].reduce((a,c)=>a+c.charCodeAt(0),0),results=[];
    for(let i=0;i<8;i++){const p=post(60+(seed+i)%40);results.push({id:'ss_'+i,redditUrl:p.url,subreddit:p.url.split('/')[4],postTitle:p.title,score:p.score,upvotes:p.upvotes,numComments:p.numComments,
      createdUtc:p.createdUtc,visitsPerMonth:i<5?(seed*(i+3))%6000:undefined,estimatedRedditViews:p.upvotes*50,trafficValue:i<5?(seed*i)%250:undefined,googleRanked:i<5,googlePosition:i<5?i+1:undefined});}
    return json({keyword,searchMode:'web_ranking',totalResults:results.length,totalTraffic:0,googleTraffic:0,redditTraffic:0,results,
      ...(method==='POST'?{quotaRemaining:42}:{fetchedAt:new Date().toISOString(),isStale:false})});
  }
  if(u.pathname==='/api/v1/subreddit-stats'){
    const s=q.get('subreddit'),h=[...s].reduce((a,c)=>a+c.charCodeAt(0),0);
    return json({subreddit:s,buckets:[{contentType:'comment',mediaType:'link',sampleCount:h%40,...(h%40>=10?{removalRate:(h%30)/100}:{}),windowEnd:new Date().toISOString()}],
      moderationLevel:(h%20)*5,moderationReasons:['Mock moderation level'],ruleFlags:{bansSelfPromotion:h%3===0,bansLinks:h%4===0,hasKarmaOrAgeGate:h%5===0,holdsPostsForApproval:false},
      botBouncerStatus:h%7===0?'installed':'not_installed'});
  }
  return json({error:'Not mocked: '+u.pathname},404);
}

module.exports={mockFetch};
