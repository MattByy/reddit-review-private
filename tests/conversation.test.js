const { test } = require('node:test');
const assert = require('node:assert/strict');
const model = require('../assets/conversation-model.js');
const accounts = ['a','b','c','d','e'].map(id => ({ id, disclosed: true, disclosure_line: 'Operated by Example.' }));
const task = (id, account, minutes, overrides = {}) => ({ id, thread_id: 'abc', user_account_id: account, task_type: 'comment',
  reddit_url: `https://www.reddit.com/r/test/comments/abc/topic/${id}/`, status: 'published', content: 'A short contribution.',
  published_at: new Date(Date.UTC(2026, 9, 4, 0, minutes)).toISOString(), ...overrides });
const graph = (tasks, runs = []) => model.buildConversationGraph({ threadId: 'abc', tasks, runs, accounts });

test('graph maps five accounts, deduplicates tasks, excludes pending and unrelated activity', () => {
  const tasks = accounts.map((a, i) => task(String(i), a.id, i * 40));
  const g = graph([...tasks, tasks[0], task('pending', 'a', 0, { reddit_url: null }), task('other','a',0,{thread_id:'xyz'})]);
  assert.equal(g.accounts.length, 5); assert.equal(g.events.length, 5); assert.equal(g.edges[0].engagement_type, 'comment');
  assert.equal(model.checkCoordinationWindows(g).status, 'no_signal');
});
test('coordination is inclusive at window boundary and ignores same-account pairs', () => {
  assert.equal(model.checkCoordinationWindows(graph([task('1','a',0),task('2','b',15)])).status, 'flagged');
  assert.equal(model.checkCoordinationWindows(graph([task('1','a',0),task('2','a',1)])).status, 'insufficient_data');
  assert.throws(() => model.checkCoordinationWindows(graph([]), {windowMinutes: -1}));
});
test('missing timestamps and empty history never pass validation', () => {
  assert.equal(model.checkCoordinationWindows(graph([task('1','a',0),task('2','b',40,{published_at:null})])).status, 'insufficient_data');
  const report = model.generateLegitimacyReport('abc', graph([]));
  assert.equal(report.status, 'unverified');
  assert.ok(Object.values(report.checks).every(c => c.status === 'insufficient_data'));
  assert.throws(() => model.generateLegitimacyReport('wrong', graph([])));
});
test('voice comparison strips disclosure, flags copied substantial text, and handles short samples', () => {
  const body = 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone.';
  assert.equal(model.checkVoiceDistinctiveness(graph([task('1','a',0,{content:body}), task('2','b',60,{content:body})])).status,'flagged');
  assert.equal(model.checkVoiceDistinctiveness(graph([task('1','a',0,{content:'Operated by Example.'}),task('2','b',60,{content:'Operated by Example.'})])).status,'insufficient_data');
});
test('shared run provenance flags autonomy even when timing differs', () => {
  const g = graph([task('1','a',0),task('2','b',90)], [{id:'run',state:[{out:{task_id:'1'}},{out:{task_id:'2'}}]}]);
  assert.equal(model.checkEngagementAutonomy(g).status,'flagged');
});
test('discovery uses earliest recorded observation, and does not equate stage diversity with independence', () => {
  const d = (account_id, observed_at, lifecycle_stage) => ({out:{conversation:{thread_id:'abc',account_id,observed_at,lifecycle_stage}}});
  const g = graph([], [{id:'r',state:[d('a','2026-10-04T02:00:00Z','established_recorded_engagement'),d('a','2026-10-04T00:00:00Z','early_recorded_engagement'),d('b','2026-10-04T01:00:00Z','early_recorded_engagement')]}]);
  assert.equal(model.checkOrganicDiscovery(g).status,'flagged');
  assert.deepEqual(model.checkOrganicDiscovery(g).stages,['early_recorded_engagement']);
});
test('publication permalink supplies the thread id for a newly created post', () => {
  assert.equal(graph([task('post','a',0,{thread_id:null})]).events.length,1);
});

// Stub the database at the module boundary: no network, credentials or live mutations.
const sendPath = require.resolve('../api/_send.js');
let calls = [], responder;
require.cache[sendPath] = { id: sendPath, filename: sendPath, loaded: true, exports: { sb: async (...args) => { calls.push(args); return responder(...args); } } };
const { advance } = require('../api/_engine.js');
const ctx = {accounts:Object.fromEntries(accounts.map(a=>[a.id,{...a,active:true}]))};
const run = steps => ({ id:'run',name:'test',steps,state:steps.map(()=>({status:'waiting'})),current:0,status:'open',account_id:'a',thread_id:'abc' });

test('a declined conversation skips writing and the full publication chain without database side effects', async () => {
  calls=[]; responder=(method,path) => method==='GET' && path.startsWith('jobs?') ? [{status:'done',result:{participate:false,reason:'Nothing useful to add'},payload:{observed_at:'2026-10-04T00:00:00Z'}}] : [];
  const result = await advance(run(['conversation_aware','write','approve','send','wait_live','check_replies','answer_replies'].map(type=>({type,kind:'comment'}))),ctx);
  assert.equal(result.status,'done');
  assert.equal(calls.filter(([method])=>method==='POST').length,0);
  assert.ok(calls.filter(([method])=>method==='PATCH').every(([,path])=>path.startsWith('sequence_runs?')));
  assert.ok(calls.at(-1)[2].state.slice(1).every(st=>st.out.skipped));
});
test('depth guidance and conversation decision are scoped to each account', async () => {
  calls=[]; responder=(method,path) => method==='GET' && path.startsWith('jobs?') ? [] : [];
  const r=run([{type:'depth_variation',depth:'brief',account_id:'a'}, {type:'write',kind:'comment',account_id:'b'}]);
  await advance(r,ctx);
  const payload=calls.find(([method,path])=>method==='POST' && path.startsWith('jobs?'))[2][0].payload;
  assert.equal(payload.depth_variation,null);
});
test('unknown step fails visibly instead of throwing on every tick', async () => {
  calls=[]; responder=()=>[];
  assert.equal((await advance(run([{type:'nonexistent'}]),ctx)).status,'failed');
});
test('malformed completed decisions fail without writing', async () => {
  calls=[]; responder=(method,path)=>method==='GET' && path.startsWith('jobs?') ? [{status:'done',result:{participate:'yes'}}] : [];
  assert.equal((await advance(run([{type:'conversation_aware'}]),ctx)).status,'failed');
});
test('retry reuses the durable conversation job and its observation timestamp', async () => {
  calls=[]; responder=(method,path)=>method==='GET' && path.startsWith('jobs?') ? [{status:'done',result:{participate:true,reason:'Relevant expertise'},payload:{observed_at:'2026-10-01T00:00:00Z',lifecycle_stage:'early_recorded_engagement'}}] : [];
  const r=run([{type:'conversation_aware'}]); r.state[0].status='active';
  await advance(r,ctx);
  assert.equal(calls.filter(([method])=>method==='POST').length,0);
  assert.equal(calls.at(-1)[2].state[0].out.conversation.observed_at,'2026-10-01T00:00:00Z');
});

test('participation limit prevents a second contribution even when agent opted in', async () => {
  calls=[]; responder=(method,path)=>{
    if (path.startsWith('engain_tasks?')) return [task('published','a',0)];
    if (path.startsWith('sequence_runs?') && method==='GET') return [];
    return [];
  };
  const r=run([{type:'conversation_aware'},{type:'asymmetric_participation',max_engagements:1},{type:'write',kind:'comment'},{type:'send'}]);
  r.current=1; r.state[0]={status:'done',out:{conversation:{account_id:'a',thread_id:'abc',participate:true,reason:'Useful context'}}};
  await advance(r,ctx);
  assert.equal(calls.filter(([method])=>method==='POST').length,0);
  assert.equal(calls.at(-1)[2].state[1].out.conversation.participate,false);
});
test('depth choice reaches the same account writer', async () => {
  calls=[]; responder=()=>[];
  await advance(run([{type:'depth_variation',depth:'detailed',voice:'Technical and precise'},{type:'write',kind:'comment'}]),ctx);
  const payload=calls.find(([method,path])=>method==='POST' && path.startsWith('jobs?'))[2][0].payload;
  assert.deepEqual(payload.depth_variation.word_range,[121,200]);
  assert.equal(payload.depth_variation.voice,'Technical and precise');
});
test('snapshot loader paginates deterministically and rejects failed pages', async () => {
  const {loadConversationGraph}=require('../api/_conversation_graph.js');
  const requested=[];
  const sb=async(method,path)=>{
    requested.push(path);
    if(path.startsWith('engain_tasks?')) return path.includes('offset=0') ? Array.from({length:100},(_,i)=>task(String(i),'a',i)) : [task('last','b',200)];
    return [];
  };
  const g=await loadConversationGraph('abc',{sb,accounts});
  assert.equal(g.events.length,101);
  assert.ok(requested.some(p=>p.startsWith('engain_tasks?')&&p.includes('offset=100')));
  await assert.rejects(loadConversationGraph('abc',{sb:async()=>null,accounts}),/Invalid/);
  await assert.rejects(loadConversationGraph('abc,thread_id.eq.xyz',{sb,accounts}),/thread id/);
});
