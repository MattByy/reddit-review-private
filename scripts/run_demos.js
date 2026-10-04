#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { buildConversationGraph } = require('../api/_conversation_graph');
const { generateLegitimacyReport } = require('../api/_pattern_validator');

const SITE = 'https://site-phi-two-38.vercel.app';
const voices = [
  'Concise technical explanations; explain assumptions and avoid invented experience.',
  'Careful questions about measurement and reproducibility.',
  'Practical implementation details with explicit limitations.',
  'Accessibility and usability perspective in plain language.',
  'Summarize evidence and unresolved questions without endorsing other managed accounts.',
];

function scenarios(ids, subreddit) {
  const names = ['Single account post with personality', 'Two-account staged conversation',
    'Three-account thread with cross-monitoring', 'Five-account coordinated discussion'];
  return [1, 2, 3, 5].map((count, index) => {
    const steps = [];
    let parent;
    for (let i = 0; i < count; i++) {
      steps.push({ type: 'depth_variation', account_id: ids[i], depth: i % 2 ? 'detailed' : 'brief', voice: voices[i] });
      steps.push({ type: 'write', account_id: ids[i], kind: index === 0 ? 'post' : i === 0 ? 'comment' : 'reply',
        ...(index === 0 ? { subreddit, title: 'Disclosed sequence demonstration' } : {}),
        ...(i ? { reply_to_step: parent } : {}),
        brief: `DEMO: ${voices[i]} Explain this is an operator-controlled demonstration. Include the configured disclosure. Do not invent personal experiences or imply independent discovery.` });
      steps.push({ type: 'approve' }, { type: 'send' }, { type: 'wait_live' });
      parent = steps.length;
    }
    if (index === 2) for (const id of ids.slice(0, count)) steps.push({ type: 'agent_task', account_id: id,
      instruction: `Read this run's published thread and monitor contributions from all three managed accounts (${ids.slice(0, count).join(', ')}). Record reply URLs, unanswered questions and shared operator provenance. Read only; do not draft or send.` });
    return { scenario: String.fromCharCode(65 + index), name: names[index], account_ids: ids.slice(0, count), steps };
  });
}

function timingAnalysis(events) {
  const valid = events.map(e => e.published_at == null ? NaN : Date.parse(e.published_at)).filter(Number.isFinite).sort((a, b) => a - b);
  const intervals = valid.slice(1).map((t, i) => (t - valid[i]) / 60000);
  const mean = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : null;
  const variance = mean === null ? null : intervals.reduce((sum, n) => sum + (n - mean) ** 2, 0) / intervals.length;
  return { samples: valid.length, unknown_timestamps: events.length - valid.length, intervals_minutes: intervals,
    mean_minutes: mean, coefficient_of_variation: intervals.length >= 2 && mean > 0 ? Math.sqrt(variance) / mean : null,
    limitation: 'Descriptive intervals only. Variable timing does not establish independent participation.' };
}

async function fixtureReports() {
  const ids = ['demo-a', 'demo-b', 'demo-c', 'demo-d', 'demo-e'];
  const bodies = [
    'Measure the baseline before changing configuration. Record request latency throughput failures queue capacity memory processor utilization network overhead retry limits connection reuse cache behavior and database query duration during a repeatable benchmark.',
    'Which observations would disprove this explanation? Please describe sampling choices confidence intervals control groups missing values selection bias replication procedures study limitations alternative hypotheses measurement uncertainty and the original question motivating the experiment.',
    'Implementation starts with a bounded worker pool. Configure explicit deadlines graceful shutdown structured logs durable checkpoints schema validation versioned migrations recovery procedures deployment rollback dependency pinning integration coverage and operational ownership for each component.',
    'Readers need understandable navigation keyboard shortcuts visible focus readable typography sufficient contrast descriptive headings helpful labels accessible forms translated instructions predictable interactions screen reader announcements reduced motion options and useful error messages throughout the interface.',
    'The discussion leaves several decisions unresolved. Document responsible owners agreed milestones budget constraints maintenance obligations evaluation criteria evidence sources competing proposals review dates escalation paths stakeholder feedback acceptance conditions and remaining questions before choosing an approach.',
  ];
  const reports = [];
  for (const count of [1, 2, 3, 5]) {
    const threadId = 'demofixture';
    const tasks = ids.slice(0, count).map((id, i) => ({ id: `fixture-${i}`, thread_id: threadId,
      user_account_id: id, task_type: i ? 'reply' : 'comment', status: 'published', content: bodies[i],
      reddit_url: `https://www.reddit.com/r/testing/comments/${threadId}/fixture/comment${i}/`,
      published_at: new Date(Date.UTC(2026, 0, 1) + [0, 3, 20, 24, 75][i] * 60000).toISOString() }));
    const graph = buildConversationGraph({ threadId, tasks,
      accounts: ids.slice(0, count).map(id => ({ id, disclosed: true, disclosure_line: '(Operator-controlled demonstration)' })),
      runs: [{ id: 'fixture-shared-run', state: tasks.map(t => ({ out: { task_id: t.id } })) }] });
    reports.push({ source: 'synthetic fixture; never sent to database or Reddit', account_count: count,
      participation_data: graph, timing: timingAnalysis(graph.events), report: await generateLegitimacyReport(threadId, { graph }) });
  }
  const duplicateGraph = structuredClone(reports[3].participation_data);
  duplicateGraph.events[1].body = duplicateGraph.events[0].body;
  return { scenarios: reports, duplicate_voice_control: { source: 'synthetic duplicate-text control',
    report: await generateLegitimacyReport(duplicateGraph.thread_id, { graph: duplicateGraph }) } };
}

function redact(value, secrets) {
  let text = JSON.stringify(value);
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
  return JSON.parse(text);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(a => !['--analysis-only', '--help'].includes(a))) throw new Error('Unknown option. Use --help.');
  if (args.includes('--help')) {
    console.log('node scripts/run_demos.js [--analysis-only]\nLive: SUPABASE_URL, SUPABASE_SERVICE_KEY, DEMO_ACCOUNT_IDS (five comma-separated IDs), DEMO_THREAD_URL, DEMO_SUBREDDIT.\nOptional: DEMO_OUTPUT_DIR, DEMO_RESUME_FILE (previous results.json). Uses scoped engine advancement; never calls the global sending cron.');
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve(process.env.DEMO_OUTPUT_DIR || path.join(__dirname, '../demo-results', stamp));
  fs.mkdirSync(dir, { recursive: true });
  const secrets = [process.env.SUPABASE_SERVICE_KEY, process.env.AGENT_API_KEY, process.env.CRON_SECRET];
  const save = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(redact(data, secrets), null, 2) + '\n');
  const results = { started_at: new Date().toISOString(), mode: args.includes('--analysis-only') ? 'analysis_only' : 'live',
    status: 'running', scenarios: [], blockers: [], endpoint_calls: 0 };
  const fixture = await fixtureReports();
  save('fixture-reports.json', fixture);
  const nativeFetch = global.fetch;
  // Capture both RPC traffic and the engine's real database requests. Never log headers.
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    const entry = { at: new Date().toISOString(), method: init.method || 'GET', url,
      ...(init.body ? { request_body: JSON.parse(init.body) } : {}) };
    const began = Date.now();
    try {
      const response = await nativeFetch(input, { ...init, signal: init.signal || AbortSignal.timeout(15000) });
      entry.status = response.status;
      const raw = await response.clone().text();
      // Public config contains credentials; do not preserve its body.
      if (url.endsWith('/assets/config.js')) entry.response_body = '[configuration response omitted]';
      else { try { entry.response_body = JSON.parse(raw); } catch { entry.response_body = raw; } }
      return response;
    } catch (error) {
      entry.transport_error = { message: error.message, code: error.cause?.code || error.code || null };
      throw error;
    } finally {
      entry.elapsed_ms = Date.now() - began;
      fs.appendFileSync(path.join(dir, 'endpoint-responses.jsonl'), JSON.stringify(redact(entry, secrets)) + '\n');
      results.endpoint_calls++;
      console.log(`${entry.method} ${url.split('?')[0]} -> ${entry.status || entry.transport_error?.code || 'transport error'}`);
    }
  };
  try {
    if (results.mode === 'analysis_only') { results.status = 'analysis_only'; return; }
    const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'DEMO_ACCOUNT_IDS', 'DEMO_THREAD_URL', 'DEMO_SUBREDDIT'];
    const missing = required.filter(k => !process.env[k]);
    if (missing.length) {
      results.blockers.push(`Missing configuration: ${missing.join(', ')}`);
      try {
        const response = await fetch(`${SITE}/assets/config.js`);
        if (!response.ok) results.blockers.push(`Public deployment probe returned HTTP ${response.status}`);
      } catch (e) { results.blockers.push(`Public deployment probe failed: ${e.cause?.code || e.message}`); }
      results.status = 'blocked'; process.exitCode = 1; return;
    }
    const ids = process.env.DEMO_ACCOUNT_IDS.split(',').map(s => s.trim());
    if (ids.length !== 5 || new Set(ids).size !== 5 || ids.some(id => !/^[\w-]+$/.test(id))) throw new Error('DEMO_ACCOUNT_IDS must contain five distinct account IDs');
    const threadURL = process.env.DEMO_THREAD_URL;
    if (!/^https:\/\/(?:www\.|old\.)?reddit\.com\/r\/\w+\/comments\/[a-z0-9]+\//i.test(threadURL)) throw new Error('DEMO_THREAD_URL must be a Reddit thread permalink');
    if (!/^\w+$/.test(process.env.DEMO_SUBREDDIT)) throw new Error('Invalid DEMO_SUBREDDIT');
    const { sb } = require('../api/_send');
    const { advance } = require('../api/_engine');
    const accounts = await sb('GET', `accounts?select=id,label,reddit_username,active,disclosed,disclosure_line&id=in.(${ids.join(',')})`);
    for (const id of ids) {
      const a = accounts.find(a => a.id === id);
      if (!a?.active || !a.disclosed || !a.disclosure_line?.trim()) throw new Error(`Account ${id} must already be active and disclosed with a disclosure line`);
    }
    const allNames = await sb('GET', 'accounts?select=reddit_username&reddit_username=not.is.null');
    const ctx = { accounts: Object.fromEntries(accounts.map(a => [a.id, a])), ours: new Set(allNames.map(a => a.reddit_username.toLowerCase())) };
    const resume = process.env.DEMO_RESUME_FILE ? JSON.parse(fs.readFileSync(process.env.DEMO_RESUME_FILE, 'utf8')) : null;
    if (resume && resume.mode !== 'live') throw new Error('Resume requires a live results.json');
    for (const demo of scenarios(ids, process.env.DEMO_SUBREDDIT)) {
      const record = { ...demo, status: 'starting' };
      results.scenarios.push(record);
      save('results.json', results);
      try {
        const previous = resume?.scenarios.find(s => s.scenario === demo.scenario);
        if (resume && !previous?.run_id) throw new Error('No recorded run to resume for this scenario');
        if (resume) {
          if (!/^[a-f0-9-]{36}$/i.test(previous.run_id)) throw new Error('Invalid resume run ID');
          record.run_id = previous.run_id;
          record.sequence_id = previous.sequence_id;
        } else {
          const sequence = await sb('POST', 'rpc/save_sequence', { p_id: null, p_name: `DEMO ${stamp} ${demo.scenario}: ${demo.name}`,
            p_description: 'Operator-controlled demonstration. Human review and disclosure required.', p_steps: demo.steps, p_enabled: true, p_editor: 'demo-runner' });
          if (!sequence?.id) throw new Error('save_sequence returned no ID; inspect response before retrying');
          record.sequence_id = sequence.id;
          save('results.json', results);
          const run = await sb('POST', 'rpc/start_sequence_run', { p_sequence_id: sequence.id,
            p_thread_url: demo.scenario === 'A' ? null : threadURL, p_account_id: ids[0],
            p_note: 'DEMO: disclosed shared operator; retain review gates.', p_editor: 'demo-runner' });
          if (!run?.id) throw new Error('start_sequence_run returned no ID; inspect response before retrying');
          record.run_id = run.id;
          save('results.json', results);
        }
        const route = `sequence_runs?select=*&id=eq.${encodeURIComponent(record.run_id)}`;
        const [before] = await sb('GET', route);
        if (!before || before.created_by !== 'demo-runner' || !before.name.startsWith('DEMO ') || before.sequence_id !== record.sequence_id) throw new Error('Refusing to advance an unrecognized demo run');
        if ([before.account_id, ...before.steps.map(s => s.account_id).filter(Boolean)].some(id => !ids.includes(id))) throw new Error('Run references accounts outside DEMO_ACCOUNT_IDS');
        record.before = before;
        record.advancement = before.status === 'open' && Date.parse(before.next_at) <= Date.now()
          ? await advance(before, ctx) : { skipped: true, reason: 'Run is closed or not due' };
        const [after] = await sb('GET', route);
        if (!after) throw new Error('Run missing after advancement');
        record.after = after;
        record.jobs = await sb('GET', `jobs?select=*&sequence_run_id=eq.${encodeURIComponent(record.run_id)}`);
        const tid = after.thread_id || after.state.find(s => s.out?.thread_id)?.out.thread_id;
        if (tid) {
          const { loadConversationGraph } = require('../api/_conversation_graph');
          const graph = await loadConversationGraph(tid, { sb });
          record.legitimacy = { source: 'live database thread snapshot; includes other runs on this thread',
            timing: timingAnalysis(graph.events), report: await generateLegitimacyReport(tid, { graph }) };
        } else record.legitimacy = { status: 'insufficient_data', reason: 'No published thread ID yet' };
        record.status = after.status === 'done' ? 'completed' : after.status === 'open' ? 'waiting' : after.status;
      } catch (e) { record.status = 'failed'; record.error = e.message; }
      save('results.json', results);
    }
    results.status = results.scenarios.every(s => s.status === 'completed') ? 'completed'
      : results.scenarios.some(s => s.status === 'failed') ? 'partial_failure' : 'waiting';
    if (results.status === 'partial_failure') process.exitCode = 1;
  } catch (e) {
    results.status = 'blocked'; results.blockers.push(e.message); process.exitCode = 1;
  } finally {
    global.fetch = nativeFetch;
    results.finished_at = new Date().toISOString();
    save('results.json', results);
    console.log(JSON.stringify({ status: results.status, directory: dir, blockers: results.blockers }, null, 2));
  }
}

module.exports = { scenarios, timingAnalysis, fixtureReports, redact };
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
