const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');
function load(name, names, sb, extra = '') {
  const file = path.resolve('api', name);
  const context = { module: { exports: {} }, process, console, URL, URLSearchParams, Buffer,
    require: createRequire(file), testSb: sb };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `\nsb = testSb; module.exports = {${names}};\n` + extra, context);
  return context.module.exports;
}
const accounts = {
  a: { id: 'a', active: true, disclosed: true, disclosure_line: '(Operated by Alpha)' },
  b: { id: 'b', active: true, disclosed: true, disclosure_line: '(Operated by Beta)' },
};
const url = 'https://www.reddit.com/r/testing/comments/abc123/topic/def456/';
function engine(sb) {
  const file = path.resolve('api/_engine.js');
  const context = { module: { exports: {} }, require: name => name === './_send.js' ? { sb } : { repliesTo: async () => ({ ok: true, replies: [] }) } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports.advance = advance;', context);
  return context.module.exports;
}
function run(steps, extra = {}) {
  return { id: 'run', name: 'conversation', steps, state: steps.map(() => ({ status: 'waiting' })), current: 0,
    status: 'open', account_id: 'a', thread_id: 'abc123', thread_url: url, subreddit: 'testing', ...extra };
}
test('A publishes, B receives the published parent and its own disclosure; repeated ticks do not duplicate jobs', async () => {
  const jobs = [], patches = [];
  const steps = [{ type: 'write', kind: 'comment' }, { type: 'approve' }, { type: 'send' }, { type: 'wait_live' },
    { type: 'write', kind: 'reply', account_id: 'b', reply_to_step: 4 }];
  const r = run(steps);
  const e = engine(async (method, route, body) => {
    if (route.startsWith('jobs?on_conflict')) { if (!jobs.some(j => j.dedupe_key === body[0].dedupe_key)) jobs.push({ ...body[0], id: 'j'+jobs.length, status: 'planned' }); return []; }
    if (route.startsWith('jobs?')) return jobs.filter(j => route.includes(encodeURIComponent(j.dedupe_key)));
    if (route.startsWith('drafts?')) return [{ status: 'approved', send_cleared_at: 'now' }];
    if (route.startsWith('engain_tasks?select=id')) return [{ id: 'task-a' }];
    if (route.startsWith('engain_tasks?')) return [{ status: 'published', reddit_url: url }];
    if (route.startsWith('sequence_runs?')) { patches.push(body); Object.assign(r, body); return []; }
    if (route.startsWith('threads?')) return [];
    throw Error(route);
  });
  await e.advance(r, { accounts });
  assert.equal(jobs[0].account_id, 'a');
  jobs[0].status = 'done'; jobs[0].draft_id = 'draft-a';
  await e.advance(r, { accounts });
  assert.equal(jobs[1].account_id, 'b'); assert.equal(jobs[1].target_url, url);
  assert.equal(jobs[1].payload.disclosure_line, accounts.b.disclosure_line);
  assert.equal(jobs[1].thread_id, 'abc123');
  await e.advance(r, { accounts }); assert.equal(jobs.length, 2);
});
test('missing publication and inactive step accounts fail without creating a job', async () => {
  for (const steps of [[{ type:'write',kind:'reply',account_id:'b',reply_to_step:1 }], [{ type:'write',kind:'comment',account_id:'missing' }]]) {
    const calls = [];
    const e = engine(async (m,p,b) => { calls.push(p); return []; });
    const result = await e.advance(run(steps), { accounts });
    assert.equal(result.status, 'failed'); assert.ok(calls.every(p => p.startsWith('sequence_runs?')));
  }
});
test('literal reply target and default account remain compatible', async () => {
  let job;
  const e = engine(async (m,p,b) => {
    if (m === 'POST') { job = b[0]; return []; }
    if (p.startsWith('jobs?')) return [{ status:'planned' }];
    return [];
  });
  await e.advance(run([{type:'write',kind:'reply',target_url:url}]), {accounts});
  assert.equal(job.account_id, 'a'); assert.equal(job.target_url,url);
});
test('a newly published post supplies the thread for the next account', async () => {
  let job;
  const e = engine(async (m,p,b) => {
    if (p.startsWith('engain_tasks?')) return [{ reddit_url:url.replace('def456/','') }];
    if (p.startsWith('jobs?on_conflict')) { job=b[0]; return []; }
    if (p.startsWith('jobs?')) return [{status:'planned'}];
    return [];
  });
  const r = run([{type:'send'},{type:'wait_live'},{type:'write',kind:'comment',account_id:'b'}], {
    current:1,thread_id:null,thread_url:null,subreddit:null,state:[{status:'done',out:{task_id:'post'}},{status:'waiting'},{status:'waiting'}] });
  await e.advance(r,{accounts});
  assert.equal(job.thread_id,'abc123'); assert.equal(job.payload.subreddit,'testing');
  assert.equal(job.target_url,url.replace('def456/',''));
});
test('sender accepts a reviewed cross-account reply while retaining confirmation, disclosure, hold and dedupe gates', async () => {
  for (const variant of ['allowed','unconfirmed','wrong-disclosure','held','duplicate','inactive']) {
    const body = 'A separate observation about this thread. (Operated by Beta)';
    const cur = {status:'approved',send_cleared_at:'now',account_id:'b',parent_url:url,parent_confirmed_by:variant === 'unconfirmed' ? null : 'reviewer',body: variant === 'wrong-disclosure' ? 'No disclosure.' : body, sequence_hold:variant === 'held'};
    let sent=0;
    const sb = async (m,p,b) => {
      if (p.startsWith('drafts?')) return [cur];
      if (p === 'rpc/scenario_context') return {ready:true,self_reply:false};
      if (p.startsWith('scenario_acts?')) return [];
      if (p.startsWith('accounts?')) return [{...accounts.b,active:variant !== 'inactive'}];
      if (p.startsWith('engain_tasks?')) return variant === 'duplicate' ? [{id:'old'}] : [];
      if (p.includes('is_our_url') || p.includes('user_account_id=neq')) throw Error('obsolete multi-account gate');
      return [];
    };
    const sender=load('_send.js','dispatchOne',sb,'engain = async () => ({status:200,json:{id:"new-task"}});');
    const result=await sender.dispatchOne({draft_id:'d',kind:'reply',thread_id:'abc123',subreddit:'testing'},null,async action=>{ if(action==='engain_reply_submitted')sent++; });
    assert.equal(result.outcome, {allowed:'sent',unconfirmed:'skipped','wrong-disclosure':'refused',held:'queued',duplicate:'refused',inactive:'refused'}[variant]);
    assert.equal(sent,variant === 'allowed' ? 1 : 0);
  }
});
test('filing a sequence reply keeps its assigned account, parent and hold', async () => {
  let row;
  const sb = async (m,p,b) => {
    if (p.startsWith('jobs?')) return [{id:'job',kind:'write',status:'claimed',account_id:'b',thread_id:'abc123',target_url:url,sequence_run_id:'run',payload:{kind:'reply'}}];
    if (p.startsWith('accounts?')) return [accounts.b];
    if (p.startsWith('threads?')) return [{id:'abc123',subreddit:'testing'}];
    if (p.startsWith('drafts?')) { row=b[0];return [{id:'draft',...row}]; }
    if (p.includes('is_our_url')) throw Error('obsolete parent gate');
    return [];
  };
  const agent=load('_agent.js','postDraft',sb,'vendorCheck = async () => ({verdict:"pass", removal_risk:0});');
  await agent.postDraft({job_id:'job',kind:'reply',account_id:'a',body:'A different observation. (Operated by Beta)'});
  assert.equal(row.account_id,'b'); assert.equal(row.parent_url,url); assert.equal(row.sequence_hold,true);
});
test('follow-up tracking is per account when both accounts answer the same incoming reply', async () => {
  let created;
  const e = engine(async (m,p,b) => {
    if (p.startsWith('jobs?on_conflict')) { created=b[0]; return []; }
    if (p.startsWith('jobs?')) return [{status:'planned'}];
    return [];
  });
  const steps=[{type:'check_replies'},{type:'answer_replies'},{type:'answer_replies',account_id:'b'}];
  const r=run(steps,{current:2,state:[{status:'done',out:{replies:[{id:'r1',author:'reader',permalink:url,body:'A question'}]}},{status:'done',out:{replied_to:['r1']}},{status:'waiting'}]});
  await e.advance(r,{accounts});
  assert.equal(created.account_id,'b'); assert.equal(created.dedupe_key,'seqreply:run:b:r1');
});
