/* Shared pure analysis for the browser and server. No credentials or network calls. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ConversationModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const time = v => v == null || v === '' ? null : Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
  const words = s => (String(s || '').match(/\S+/g) || []).length;
  const threadOf = url => String(url || '').match(/\/comments\/([a-z0-9]+)/i)?.[1]?.toLowerCase();
  const depthOf = body => words(body) <= 60 ? 'brief' : words(body) <= 120 ? 'standard' : 'detailed';
  function buildConversationGraph({ threadId, tasks = [], runs = [], accounts = [] }) {
    const events = [], decisions = [], seen = new Set(), provenance = new Map();
    for (const run of runs) {
      for (const st of run.state || []) {
        if (st?.out?.task_id) provenance.set(String(st.out.task_id), run.id);
        const d = st?.out?.conversation;
        if (d?.thread_id === threadId) decisions.push({ ...d, run_id: run.id });
      }
    }
    for (const t of tasks) {
      if ((t.thread_id || threadOf(t.reddit_url)) !== threadId || !t.reddit_url || t.status === 'test_artifact') continue;
      const key = String(t.id);
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({ id: key, account_id: t.user_account_id || null, thread_id: threadId,
        engagement_type: t.task_type || 'unknown', published_at: t.published_at || null,
        body: t.content || '', words: words(t.content), depth: t.content ? depthOf(t.content) : 'unknown',
        url: t.reddit_url, run_id: provenance.get(key) || null });
    }
    events.sort((a, b) => (time(a.published_at) ?? Infinity) - (time(b.published_at) ?? Infinity) || a.id.localeCompare(b.id));
    const ids = new Set([...events.map(e => e.account_id), ...decisions.map(d => d.account_id)].filter(Boolean));
    const nodes = [...ids].sort().map(id => {
      const a = accounts.find(a => a.id === id), own = events.filter(e => e.account_id === id);
      return { id, label: a?.label || id, disclosure_line: a?.disclosure_line || '', disclosed: a?.disclosed === true,
        engagements: own.length, depths: [...new Set(own.map(e => e.depth))],
        mean_words: own.length ? Math.round(own.reduce((n, e) => n + e.words, 0) / own.length) : null };
    });
    return { thread_id: threadId, accounts: nodes, events, decisions,
      edges: events.map(({ body, ...e }) => e), known_account_count: accounts.length };
  }
  const result = (status, findings, samples) => ({ status, findings, samples });
  function checkCoordinationWindows(graph, { windowMinutes = 15 } = {}) {
    if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) throw new Error('windowMinutes must be positive');
    const valid = graph.events.filter(e => e.account_id && time(e.published_at) !== null);
    const findings = [];
    for (let i = 0; i < valid.length; i++) for (let j = i + 1; j < valid.length; j++) {
      if (valid[i].account_id !== valid[j].account_id && Math.abs(time(valid[i].published_at) - time(valid[j].published_at)) <= windowMinutes * 60000)
        findings.push({ event_ids: [valid[i].id, valid[j].id], message: `Different accounts published within ${windowMinutes} minutes` });
    }
    const sufficient = new Set(valid.map(e => e.account_id)).size >= 2 && valid.length === graph.events.length;
    return result(findings.length ? 'flagged' : sufficient ? 'no_signal' : 'insufficient_data', findings, valid.length);
  }
  function checkVoiceDistinctiveness(graph) {
    const tokens = e => {
      const line = graph.accounts.find(a => a.id === e.account_id)?.disclosure_line;
      const body = line ? e.body.split(line).join(' ') : e.body;
      return new Set((body.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []));
    };
    const valid = graph.events.filter(e => e.account_id && tokens(e).size >= 20), findings = [];
    let comparisons = 0;
    for (let i = 0; i < valid.length; i++) for (let j = i + 1; j < valid.length; j++) {
      if (valid[i].account_id === valid[j].account_id) continue;
      comparisons++;
      const a = tokens(valid[i]), b = tokens(valid[j]);
      const intersection = [...a].filter(w => b.has(w)).length;
      const similarity = intersection / (a.size + b.size - intersection);
      if (similarity >= 0.8) findings.push({ event_ids: [valid[i].id, valid[j].id], similarity, message: 'High vocabulary overlap after removing configured disclosures' });
    }
    return result(findings.length ? 'flagged' : comparisons ? 'no_signal' : 'insufficient_data', findings, comparisons);
  }
  function checkEngagementAutonomy(graph) {
    const grouped = new Map();
    for (const e of [...graph.events, ...graph.decisions]) {
      if (!e.run_id || !e.account_id) continue;
      if (!grouped.has(e.run_id)) grouped.set(e.run_id, new Set());
      grouped.get(e.run_id).add(e.account_id);
    }
    const findings = [...grouped].filter(([, ids]) => ids.size > 1).map(([run_id, ids]) => ({ run_id, account_ids: [...ids], message: 'Multiple accounts share an orchestration run; decisions are not independent' }));
    return result(findings.length ? 'flagged' : 'insufficient_data', findings, graph.decisions.length);
  }
  function checkOrganicDiscovery(graph) {
    const first = new Map();
    for (const d of graph.decisions) {
      if (!d.account_id || time(d.observed_at) === null) continue;
      if (!first.has(d.account_id) || time(d.observed_at) < time(first.get(d.account_id).observed_at)) first.set(d.account_id, d);
    }
    const records = [...first.values()];
    const stages = new Set(records.map(d => d.lifecycle_stage).filter(s => s && s !== 'unknown'));
    const findings = records.length >= 2 && stages.size === 1 ? [{ message: 'Recorded first observations occur at the same lifecycle stage' }] : [];
    // Observation through an assigned sequence is never evidence of organic discovery.
    return { ...result(findings.length ? 'flagged' : 'insufficient_data', findings, records.length), stages: [...stages], source: 'assigned_sequence' };
  }
  function generateLegitimacyReport(threadId, graph) {
    if (!graph || graph.thread_id !== threadId) throw new Error('A matching conversation graph is required');
    const checks = { coordination: checkCoordinationWindows(graph), voice: checkVoiceDistinctiveness(graph),
      autonomy: checkEngagementAutonomy(graph), discovery: checkOrganicDiscovery(graph) };
    const flagged = Object.values(checks).filter(c => c.status === 'flagged').length;
    return { thread_id: threadId, status: flagged ? 'review_required' : 'unverified', checks,
      metrics: { accounts: graph.accounts.length, engagements: graph.events.length, decisions: graph.decisions.length,
        flagged_checks: flagged, unknown_timestamps: graph.events.filter(e => time(e.published_at) === null).length,
        undisclosed_accounts: graph.accounts.filter(a => !a.disclosed).length,
        depth_by_account: graph.accounts.map(a => ({ account_id: a.id, mean_words: a.mean_words, depths: a.depths })) },
      limitation: 'Patterns are heuristics, not proof of independence or legitimacy. Shared control must remain disclosed.' };
  }
  return { buildConversationGraph, checkCoordinationWindows, checkVoiceDistinctiveness,
    checkEngagementAutonomy, checkOrganicDiscovery, generateLegitimacyReport, depthOf };
});
