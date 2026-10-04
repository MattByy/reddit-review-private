/* _engine.js — moves sequence runs forward. Called by the tick every 15 min.
 *
 * A run is a list of steps (migration 029). Each tick, every open run whose
 * next_at has passed is advanced as far as it can go: a finished step hands its
 * output to the next one; a step still waiting writes why into its note and the
 * run stops there until the next tick.
 *
 * Step types (keep in step with sequence_steps_valid() and sequences.html):
 *   write          agent drafts {kind, brief}; the draft is HELD until a send step
 *   approve        a person approves that draft on /review
 *   send           releases the draft; done when Engain accepted it
 *   wait_live      done when Engain reports it live (a URL); fails if it failed
 *   wait           {minutes}
 *   check_replies  reads replies under our comment on Reddit (read-only)
 *   answer_replies one draft_followup job per new real reply; replies send on approval
 *   agent_task     {instruction} for the agent
 * Nothing here sends: the sender (_send.js) does, with all its gates.
 */
const { sb } = require("./_send.js");
const { repliesTo } = require("./_reddit.js");

const enc = encodeURIComponent;
const nowIso = () => new Date(Date.now()).toISOString();
const DEAD = ["failed", "cancelled", "canceled", "removed", "deleted", "error"];

// The most recent earlier step output carrying `key`.
function lastOut(run, upto, key) {
  for (let i = upto - 1; i >= 0; i--) { const o = run.state[i] && run.state[i].out; if (o && o[key] != null) return o[key]; }
  return null;
}
async function job(dedupe) { const [j] = await sb("GET", `jobs?select=*&dedupe_key=eq.${enc(dedupe)}`); return j || null; }
async function addJob(row) {
  const rows = await sb("POST", "jobs?on_conflict=dedupe_key", [row], "resolution=ignore-duplicates,return=representation");
  return rows && rows[0];
}

/* Each handler returns { done, out?, fail?, note?, next_at? }. `enter` is true the first time. */
const STEPS = {
  async write(run, i, s, ctx) {
    const key = `seq:${run.id}:${i}`;
    if (ctx.enter) {
      const target = s.kind === "reply" ? s.target_url : s.kind === "post" ? null : run.thread_url;
      await addJob({ kind: "write", sequence_run_id: run.id, step: i, account_id: run.account_id, thread_id: run.thread_id,
        target_url: target, title: `Write a ${s.kind}${s.brief ? ": " + String(s.brief).slice(0, 120) : ""}`, created_by: "engine",
        dedupe_key: key, payload: { kind: s.kind, brief: s.brief || "", subreddit: s.subreddit || run.subreddit, title: s.title || null,
          disclosure_line: ctx.account && ctx.account.disclosure_line, sequence: run.name, step: i + 1 } });
    }
    const j = await job(key);
    if (!j) return { note: "queueing the write job" };
    if (j.status === "done" && j.draft_id) return { done: true, out: { draft_id: j.draft_id, job_id: j.id } };
    if (["skipped", "failed"].includes(j.status)) return { fail: `the writer ${j.status} it: ${(j.result && (j.result.reason || j.result.note)) || "no reason given"}` };
    return { note: j.status === "claimed" ? `the agent is writing it (${j.claimed_by})` : "waiting for the agent to write it" };
  },

  async approve(run, i) {
    const id = lastOut(run, i, "draft_id");
    if (!id) return { fail: "nothing to approve: no write step before this one" };
    const [d] = await sb("GET", `drafts?select=status,send_cleared_at,redirect_pending&id=eq.${enc(id)}`);
    if (!d) return { fail: "the draft is gone" };
    if (d.status === "rejected") return { fail: "the draft was rejected on Review" };
    if (["approved", "dispatched", "posted"].includes(d.status) && d.send_cleared_at) return { done: true, out: { approved: true } };
    return { note: d.redirect_pending ? "sent back to the agent for a rewrite" : "waiting for approval on Review" };
  },

  async send(run, i, s, ctx) {
    const id = lastOut(run, i, "draft_id");
    if (!id) return { fail: "nothing to send: no write step before this one" };
    if (ctx.enter) await sb("PATCH", `drafts?id=eq.${enc(id)}`, { sequence_hold: false }, "return=minimal");
    const [t] = await sb("GET", `engain_tasks?select=id,status&draft_id=eq.${enc(id)}&limit=1`);
    if (t) return { done: true, out: { task_id: t.id } };
    const [d] = await sb("GET", `drafts?select=status,send_cleared_at,gate_failure,gate_failed_at&id=eq.${enc(id)}`);
    if (!d || d.status === "rejected") return { fail: "the draft was rejected" };
    if (d.gate_failed_at) return { note: `refused by a send gate: ${d.gate_failure}` };
    if (!d.send_cleared_at) return { note: "released, but it still needs approval on Review" };
    return { note: "released to the sender; goes out on the next send pass (pace floors apply)" };
  },

  async wait_live(run, i) {
    const task = lastOut(run, i, "task_id");
    if (!task) return { fail: "nothing to watch: no send step before this one" };
    const [t] = await sb("GET", `engain_tasks?select=status,reddit_url,published_at&id=eq.${enc(task)}`);
    if (t && t.reddit_url) return { done: true, out: { url: t.reddit_url, published_at: t.published_at } };
    if (t && DEAD.includes(String(t.status || "").toLowerCase())) return { fail: `Engain reports ${t.status}` };
    return { note: `waiting for Engain to publish it (${(t && t.status) || "submitted"})` };
  },

  async wait(run, i, s, ctx) {
    const until = ctx.enter ? new Date(Date.now() + Number(s.minutes) * 60000).toISOString() : ctx.st.until;
    if (new Date(until).getTime() <= Date.now()) return { done: true };
    return { note: `waiting until ${until.slice(0, 16).replace("T", " ")} UTC`, next_at: until, keep: { until } };
  },

  async check_replies(run, i, s, ctx) {
    const url = lastOut(run, i, "url");
    if (!url) return { fail: "nothing to check: no wait-until-live step before this one" };
    const r = await repliesTo(url, ctx.ours);
    if (!r.ok) {
      if (r.gone) return { fail: r.reason };
      return { note: `${r.reason}; retrying next pass`, next_at: new Date(Date.now() + 15 * 60000).toISOString() };
    }
    return { done: true, out: { url: r.url, replies: r.replies, our_score: r.comment.score, checked_at: nowIso() } };
  },

  async answer_replies(run, i, s, ctx) {
    const replies = lastOut(run, i, "replies") || [];
    const answered = new Set();
    for (let k = 0; k < i; k++) for (const id of ((run.state[k] && run.state[k].out && run.state[k].out.replied_to) || [])) answered.add(id);
    const todo = replies.filter(r => !answered.has(r.id));
    if (!todo.length) return { done: true, out: { replied_to: [] }, note: "no new replies" };
    if (ctx.enter) for (const r of todo) await addJob({ kind: "draft_followup", sequence_run_id: run.id, step: i, account_id: run.account_id,
      thread_id: run.thread_id, target_url: r.permalink, created_by: "engine", dedupe_key: `seqreply:${run.id}:${r.id}`,
      title: `Answer u/${r.author}`, payload: { author: r.author, body: r.body, score: r.score, brief: s.brief || "",
        our_comment_url: lastOut(run, i, "url"), disclosure_line: ctx.account && ctx.account.disclosure_line } });
    const jobs = await sb("GET", `jobs?select=status,dedupe_key&sequence_run_id=eq.${enc(run.id)}&step=eq.${i}`);
    const open = jobs.filter(j => ["planned", "claimed"].includes(j.status)).length;
    if (!open) return { done: true, out: { replied_to: todo.map(r => r.id), answered: jobs.filter(j => j.status === "done").length } };
    return { note: `${open} of ${jobs.length} replies still with the agent. Each answer goes to Review and sends when approved.` };
  },

  async agent_task(run, i, s, ctx) {
    const key = `seqtask:${run.id}:${i}`;
    if (ctx.enter) await addJob({ kind: "agent_task", sequence_run_id: run.id, step: i, account_id: run.account_id, thread_id: run.thread_id,
      target_url: run.thread_url, title: String(s.instruction).slice(0, 300), created_by: "engine", dedupe_key: key, payload: { sequence: run.name } });
    const j = await job(key);
    if (j && ["done", "skipped"].includes(j.status)) return { done: true, out: { result: j.result } };
    if (j && j.status === "failed") return { fail: `agent task failed: ${(j.result && j.result.reason) || ""}` };
    return { note: "with the agent" };
  },
};

async function advance(run, ctx) {
  const state = run.state.map(x => ({ ...x }));
  let current = run.current, status = run.status, next_at = nowIso(), moved = 0;
  while (status === "open" && current < run.steps.length && moved < 12) {
    const s = run.steps[current], st = state[current] || (state[current] = { status: "waiting" });
    const enter = st.status === "waiting";
    if (enter) { st.status = "active"; st.started_at = nowIso(); }
    const res = await STEPS[s.type]({ ...run, state, current }, current, s, { ...ctx, enter, st });
    if (res.keep) Object.assign(st, res.keep);
    if (res.fail) { st.status = "failed"; st.note = res.fail; status = "failed"; break; }
    if (!res.done) { st.note = res.note || null; next_at = res.next_at || next_at; break; }
    st.status = "done"; st.done_at = nowIso(); st.note = res.note || null; if (res.out) st.out = res.out;
    current++; moved++;
  }
  if (status === "open" && current >= run.steps.length) status = "done";
  await sb("PATCH", `sequence_runs?id=eq.${enc(run.id)}`, { state, current, status, next_at, updated_at: nowIso() }, "return=minimal");
  return { run: run.id, name: run.name, step: Math.min(current, run.steps.length - 1) + 1, of: run.steps.length, status,
           note: (state[current] && state[current].note) || (state[current - 1] && state[current - 1].note) || null, moved };
}

async function runEngine() {
  const runs = await sb("GET", `sequence_runs?select=*&status=eq.open&next_at=lte.${enc(nowIso())}&order=next_at.asc&limit=25`);
  if (!runs.length) return { runs: 0 };
  const ours = new Set((await sb("GET", "accounts?select=reddit_username&reddit_username=not.is.null")).map(a => a.reddit_username.toLowerCase()));
  const accounts = Object.fromEntries((await sb("GET", "accounts?select=id,disclosure_line")).map(a => [a.id, a]));
  const results = [];
  for (const run of runs) {
    try { results.push(await advance(run, { ours, account: accounts[run.account_id] })); }
    catch (e) { results.push({ run: run.id, error: String(e.message).slice(0, 200) }); }
  }
  return { runs: runs.length, results };
}

module.exports = { runEngine, STEP_TYPES: Object.keys(STEPS) };
