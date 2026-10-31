// Queue2 send tests with mock Engain
const {describe,it,before,after}=require('node:test');
const assert=require('node:assert');
const {open}=require('../server/store.cjs');
const {sendQueue2,pollQueue2Status,checkDisclosure}=require('../server/send-queue2.cjs');
const {client}=require('../server/engain.cjs');
const {mockFetch}=require('../server/mock.cjs');

describe('Queue2 sending',()=>{
  let store,engain;

  before(()=>{
    store=open(':memory:');
    engain=client({apiKey:'mock',fetchImpl:mockFetch,limits:false});
    
    // Insert test thread
    store.db.prepare(`insert into threads(thread_id,url,subreddit,title,created_utc,sources,keywords,reasons,mentions,ranking_keywords,first_seen,last_seen)
      values(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      't3_test1',
      'https://www.reddit.com/r/test/comments/test1/title/',
      'test',
      'Test thread',
      Math.floor(Date.now()/1000)-86400,
      '["test"]',
      '[]',
      '[]',
      '[]',
      '[]',
      new Date().toISOString(),
      new Date().toISOString()
    );
    
    // Add queue2 entries
    const now=new Date().toISOString();
    store.db.prepare(`insert into queue2(item_id,kind,thread_id,url,thread_url,title,message,message_source,item,created_at,updated_at)
      values(?,?,?,?,?,?,?,?,?,?,?)`).run(
      'i_test1','thread','t3_test1',
      'https://www.reddit.com/r/test/comments/test1/title/',
      'https://www.reddit.com/r/test/comments/test1/title/',
      'Test thread',
      'Great post! Disclosure: I work for GeoNode and wanted to share our experience.',
      'agent',
      JSON.stringify({kind:'thread',item_id:'i_test1'}),
      now,now
    );
    
    store.db.prepare(`insert into queue2(item_id,kind,thread_id,url,thread_url,title,message,message_source,item,created_at,updated_at)
      values(?,?,?,?,?,?,?,?,?,?,?)`).run(
      'i_test2','thread','t3_test1',
      'https://www.reddit.com/r/test/comments/test1/title/',
      'https://www.reddit.com/r/test/comments/test1/title/',
      'Test thread',
      'Placeholder message: to be replaced',
      'random',
      JSON.stringify({kind:'thread',item_id:'i_test2'}),
      now,now
    );
  });

  after(()=>{
    store.close();
  });

  it('checkDisclosure requires GeoNode mention',()=>{
    const r=checkDisclosure('Great post about proxies!');
    assert.strictEqual(r.ok,false);
    assert.match(r.reason,/GeoNode/i);
  });

  it('checkDisclosure requires disclosure language',()=>{
    const r=checkDisclosure('Great post! GeoNode is a proxy service.');
    assert.strictEqual(r.ok,false);
    assert.match(r.reason,/disclosure/i);
  });

  it('checkDisclosure accepts valid disclosure',()=>{
    const r=checkDisclosure('Disclosure: I work for GeoNode. Great post about proxies!');
    assert.strictEqual(r.ok,true);
  });


  it('sendQueue2 rejects placeholder message',async()=>{
    const item=store.queue2(2);
    assert.strictEqual(item.message_source,'random');
    
    await assert.rejects(
      sendQueue2({id:2,mode:'pool'},

{engain,store,projectId:'project_mock'}),
      /placeholder/i
    );
  });

  it('sendQueue2 sends without a disclosure',async()=>{
    const now=new Date().toISOString();
    store.db.prepare(`insert into queue2(item_id,kind,thread_id,url,thread_url,title,message,message_source,item,created_at,updated_at)
      values(?,?,?,?,?,?,?,?,?,?,?)`).run(
      'i_test3','thread','t3_test1',
      'https://www.reddit.com/r/test/comments/test1/title/',
      'https://www.reddit.com/r/test/comments/test1/title/',
      'Test thread',
      'No disclosure here!',
      'agent',
      JSON.stringify({kind:'thread',item_id:'i_test3'}),
      now,now
    );
    
    await assert.doesNotReject(
      sendQueue2({id:3,mode:'pool'},{engain,store,projectId:'project_mock'})
    );
  });

  it('sendQueue2 succeeds for pooled mode with valid entry',async()=>{
    // Clear pacing to allow send
    store.db.prepare('delete from queue2_pacing').run();
    
    const result=await sendQueue2({id:1,mode:'pool',posterAccount:1},
      {engain,store,projectId:'project_mock',log:()=>{}});
    
    assert.strictEqual(result.ok,true);
    assert.strictEqual(result.mode,'pool');
    assert.ok(result.taskId);
    
    // Check DB state
    const item=store.queue2(1);
    assert.strictEqual(item.send_status,'submitted');
    assert.ok(item.engain_task_id);
    assert.strictEqual(item.delivery_mode,'pool');
  });

  it('sendQueue2 succeeds for beta mode with account',async()=>{
    // Add another entry
    const now=new Date().toISOString();
    store.db.prepare(`insert into queue2(item_id,kind,thread_id,url,thread_url,title,message,message_source,item,created_at,updated_at)
      values(?,?,?,?,?,?,?,?,?,?,?)`).run(
      'i_test4','thread','t3_test1',
      'https://www.reddit.com/r/test/comments/test1/title/',
      'https://www.reddit.com/r/test/comments/test1/title/',
      'Test thread',
      'Disclosure: I work for GeoNode. Great insights!',
      'agent',
      JSON.stringify({kind:'thread',item_id:'i_test4'}),
      now,now
    );
    
    // Clear pacing and set old timestamp to allow immediate send
    store.db.prepare('delete from queue2_pacing').run();
    store.db.prepare(`insert into queue2_pacing(id,last_send_global,sends_today_utc,today_utc_date,subreddit_last_send,updated_at)
      values(1,?,0,?,?,?)`).run(new Date(Date.now()-3600000).toISOString(),'2026-10-28','{}',new Date().toISOString());
    
    const result=await sendQueue2({id:4,mode:'beta',userAccountId:'acct_mock_1'},
      {engain,store,projectId:'project_mock',log:()=>{}});
    
    assert.strictEqual(result.ok,true);
    assert.strictEqual(result.mode,'beta');
    assert.ok(result.taskId);
    
    const item=store.queue2(4);
    assert.strictEqual(item.send_status,'submitted');
    assert.strictEqual(item.delivery_mode,'beta');
    assert.strictEqual(item.user_account_id,'acct_mock_1');
  });

  it('sendQueue2 records pacing after send',async()=>{
    const pacing=store.queue2Pacing();
    assert.ok(pacing.last_send_global);
    assert.ok(pacing.subreddit_last_send.test);
    // We sent twice (pooled #1 and beta #4) but the second send reset pacing with old timestamp
    // So the count only reflects the beta send (the last one)
    assert.strictEqual(pacing.sends_today_utc,1);
  });

  it('pollQueue2Status fetches pooled task status',async()=>{
    // Mock the task as published
    const {tasks}=require('../server/mock.cjs');
    const item=store.queue2(1);
    const task=tasks.find(t=>t._id===item.engain_task_id||t.id===item.engain_task_id);
    if(task){
      task.status='published';
      task.redditUrl='https://www.reddit.com/r/test/comments/test1/title/comment1/';
    }
    
    const result=await pollQueue2Status(1,{engain,store,log:()=>{}});
    assert.strictEqual(result.status,'published');
    assert.ok(result.redditUrl);
    
    const updated=store.queue2(1);
    assert.strictEqual(updated.send_status,'published');
    assert.strictEqual(updated.reddit_url,result.redditUrl);
  });

  it('sendQueue2 rejects already-sent entry',async()=>{
    await assert.rejects(
      sendQueue2({id:1,mode:'pool'},{engain,store,projectId:'project_mock'}),
      /cannot send/i
    );
  });
});

module.exports={};

describe('reply links',()=>{
  const {commentPermalink}=require('../server/send-queue2.cjs');
  it('a Reddit share link is followed to the full comment link Engain accepts',async()=>{
    const seen=[];
    const fetchImpl=async(url,o)=>{seen.push({url,redirect:o.redirect});return new Response(null,{status:301,headers:{location:'https://www.reddit.com/r/webdev/comments/1wm7k1e/comment/19rujrmxslpmp?share_id=x&utm_source=share'}});};
    assert.strictEqual(await commentPermalink('https://www.reddit.com/r/webdev/s/moGq8UUck2',fetchImpl),'https://www.reddit.com/r/webdev/comments/1wm7k1e/comment/19rujrmxslpmp/');
    assert.deepStrictEqual(seen,[{url:'https://www.reddit.com/r/webdev/s/moGq8UUck2',redirect:'manual'}]);
  });
  it('a full comment link is kept (without its query), anything else is refused',async()=>{
    const never=async()=>{throw Error('no fetch expected');};
    assert.strictEqual(await commentPermalink('https://old.reddit.com/r/x/comments/abc12/some_title/def34/?context=3',never),'https://www.reddit.com/r/x/comments/abc12/some_title/def34/');
    await assert.rejects(commentPermalink('https://www.reddit.com/r/x/comments/abc12/',never),/Not a comment link/);
    await assert.rejects(commentPermalink('https://www.reddit.com/r/x/s/AbC',async()=>new Response(null,{status:404})),/did not lead to a comment/);
  });
});
