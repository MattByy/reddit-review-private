// Dev server thread collection against the mock Engain; no network.
const test=require('node:test');
const assert=require('node:assert');
const {createApp}=require('../server/dev.cjs');
const {threadRef,rank,fromOpportunity}=require('../server/collect.cjs');

async function call(app,method,url,body){
  let status,out;const req=(async function*(){if(body)yield JSON.stringify(body);})();
  Object.assign(req,{method,url});
  await app.handle(req,{writeHead(s){status=s;},end(v){out=JSON.parse(v);}});
  return {status,body:out};
}
async function finished(app,id){for(;;){const r=await call(app,'GET','/api/runs/'+id);if(r.body.finished_at)return r.body;await new Promise(x=>setTimeout(x,20));}}

test('threadRef canonicalises reddit and redd.it URLs',()=>{
  assert.deepStrictEqual(threadRef('https://old.reddit.com/r/Proxies/comments/AbC12/title/xyz/?a=1'),{thread_id:'abc12',subreddit:'Proxies',url:'https://www.reddit.com/r/Proxies/comments/abc12/'});
  assert.strictEqual(threadRef('https://redd.it/abc12').thread_id,'abc12');
  assert.strictEqual(threadRef('https://example.com/r/x/comments/1/'),null);
  assert.strictEqual(threadRef('not a url'),null);
});

test('relevance given as a percentage is normalised and risky subreddits rank lower',()=>{
  const t=fromOpportunity({id:'o',type:'new_opportunities',relevance:90,postContent:{url:'https://www.reddit.com/r/a/comments/x1/t/',numComments:50,createdUtc:Date.now()/1000-86400}});
  assert.strictEqual(t.relevance,0.9);
  const safe=rank(t,null),risky=rank(t,{moderationLevel:95,ruleFlags:{bansSelfPromotion:true},botBouncerStatus:'installed'});
  assert.ok(risky.score<safe.score);
  assert.ok(risky.flags.includes('Subreddit bans self-promotion'));
});

test('collect merges sources per thread and skips unsearched keywords unless quota is allowed',async()=>{
  const app=createApp({mock:true,dbFile:':memory:',log:()=>{}});
  try{
    let r=await call(app,'POST','/api/collect',{sources:['opportunities','mentions','smart_search'],keywords:['residential proxies','never searched'],max_pages:5});
    assert.strictEqual(r.status,200);
    const run=await finished(app,r.body.run_id);
    assert.deepStrictEqual(run.summary.errors,[]);
    assert.ok(run.summary.notes.some(n=>n.includes('never searched')));
    assert.strictEqual(run.summary.per_source.new_opportunities,24);
    assert.ok(run.summary.subreddits_enriched>0);
    const list=(await call(app,'GET','/api/threads?limit=500')).body;
    assert.strictEqual(new Set(list.items.map(t=>t.thread_id)).size,list.total);
    assert.ok(list.items.some(t=>t.sources.includes('mentions')&&t.sources.length>1),'mention threads also found as opportunities are merged');
    for(let i=1;i<list.items.length;i++)assert.ok(list.items[i-1].rank.score>=list.items[i].rank.score);

    r=await call(app,'POST','/api/collect',{sources:['smart_search'],keywords:['never searched'],spend_quota:true});
    const spent=await finished(app,r.body.run_id);
    assert.strictEqual(spent.summary.quota_remaining,42);
    assert.ok(spent.summary.per_source.smart_search>0);
    assert.strictEqual((await call(app,'GET','/api/threads/nope')).status,404);
  }finally{app.close();}
});
