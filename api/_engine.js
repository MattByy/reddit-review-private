/* _engine.js — moves sequence runs forward. Called by the tick every 15 min.
 *
 * A run is a list of steps (migration 029). Each tick, every open run whose
 * next_at has passed is advanced as far as it can go: a finished step hands its
 * output to the next one; a step still waiting writes why into its note and the
 * run stops there until the next tick.
 *
 * Step types (keep in step with sequence_steps_valid() and sequences.html):
 *   write                agent drafts {kind, brief}; the draft is HELD until a send step
 *   approve              a person approves that draft on /review
 *   send                 releases the draft; done when Engain accepted it
 *   wait_live            done when Engain reports it live (a URL); fails if it failed
 *   wait                 {minutes}
 *   check_replies        reads replies under our comment on Reddit (read-only)
 *   answer_replies       one draft_followup job per new real reply; replies send on approval
 *   agent_task           {instruction} for the agent
 *   coordinated_post     initial post from an account in a multi-account thread
 *   independent_reply    reply from a different account acting as autonomous observer
 *   cross_account_check  monitor replies across all accounts in a thread
 *   personality_write    draft content with account-specific voice characteristics
 *   probabilistic_wait   human-like timing with variability (not fixed interval)
 * Nothing here sends: the sender (_send.js) does, with all its gates.
 */
const { sb } = require("./_send.js");
const { repliesTo } = require("./_reddit.js");
const { loadConversationGraph } = require("./_conversation_graph.js");

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

// Decisions and drafting preferences belong to one account, never the whole run.
function accountOut(run, upto, accountId, key) {
  for (let k = upto - 1; k >= 0; k--) {
    const out = run.state[k]?.out?.[key];
    if (out?.account_id === accountId) return out;
  }
  return null;
}
function draftingContext(run, i, accountId) {
  return {
    conversation: accountOut(run, i, accountId, "conversation"),
    depth_variation: accountOut(run, i, accountId, "depth_variation"),
  };
}

/* Each handler returns { done, out?, fail?, note?, next_at? }. `enter` is true the first time. */
const STEPS = {
  async conversation_aware(run, i, s, ctx) {
    const threadId = lastOut(run, i, "thread_id") || run.thread_id;
    if (!threadId) return { fail: "conversation awareness needs an existing thread" };
    const key = `seqconversation:${run.id}:${i}`;
    // Check durable job existence on every retry, including a crash after insertion.
    let j = await job(key);
    if (!j) {
      const graph = await loadConversationGraph(threadId, { accounts: Object.values(ctx.accounts) });
      await addJob({ kind: "agent_task", sequence_run_id: run.id, step: i, account_id: ctx.account.id,
        thread_id: threadId, target_url: lastOut(run, i, "thread_url") || run.thread_url, created_by: "engine", dedupe_key: key,
        title: "Consider thread history and decide whether this account has a useful contribution",
        payload: { instruction: "Read the current thread and the recorded history. Return result {participate: boolean, reason: nonempty string}. Skip if there is no distinct useful contribution. Shared control remains disclosed. Do not fabricate discovery or independence.",
          thread_history: graph, observed_at: nowIso(), lifecycle_stage: graph.events.length === 0 ? "no_recorded_engagement" : graph.events.length < 5 ? "early_recorded_engagement" : "established_recorded_engagement" } });
      return { note: "thread history queued for an account-specific decision" };
    }
    if (["done", "skipped"].includes(j.status)) {
      const d = j.result || {};
      if (typeof d.participate !== "boolean" || !String(d.reason || "").trim()) return { fail: "conversation decision requires participate:boolean and a reason" };
      return { done: true, out: { conversation: { account_id: ctx.account.id, thread_id: threadId,
        participate: j.status === "skipped" ? false : d.participate, reason: String(d.reason).slice(0, 2000),
        observed_at: j.payload?.observed_at || null, lifecycle_stage: j.payload?.lifecycle_stage || "unknown", source: "assigned_sequence" } } };
    }
    if (j.status === "failed") return { fail: "conversation decision job failed" };
    return { note: "waiting for the account's conversation decision" };
  },

  async asymmetric_participation(run, i, s, ctx) {
    const decision = accountOut(run, i, ctx.account.id, "conversation");
    const threadId = lastOut(run, i, "thread_id") || run.thread_id;
    if (!decision || decision.thread_id !== threadId) return { fail: "participation needs a conversation-aware decision for this account and thread" };
    const max = Number(s.max_engagements ?? 1);
    if (!Number.isInteger(max) || max < 1 || max > 100) return { fail: "max_engagements must be an integer from 1 to 100" };
    const graph = await loadConversationGraph(threadId, { accounts: Object.values(ctx.accounts) });
    const count = graph.events.filter(e => e.account_id === ctx.account.id).length;
    return { done: true, out: { conversation: { ...decision, participate: decision.participate && count < max,
      reason: count >= max ? `account has reached its ${max}-engagement limit` : decision.reason } } };
  },

  async depth_variation(run, i, s, ctx) {
    if (!["brief", "standard", "detailed"].includes(s.depth)) return { fail: "choose brief, standard or detailed depth" };
    return { done: true, out: { depth_variation: { account_id: ctx.account.id, depth: s.depth,
      word_range: { brief: [40, 60], standard: [61, 120], detailed: [121, 200] }[s.depth],
      voice: String(s.voice || "Use the account's established voice; do not invent experiences.").slice(0, 1000) } } };
  },
  async write(run, i, s, ctx) {
    const key = `seq:${run.id}:${i}`;
    if (ctx.enter) {
      const target = s.kind === "reply"
        ? (s.reply_to_step != null ? run.state[s.reply_to_step - 1]?.out?.url : s.target_url)
        : s.kind === "post" ? null : lastOut(run, i, "thread_url") || run.thread_url;
      if (s.kind === "reply" && !target) return { fail: "reply target is not published: use an earlier wait_live step or a comment permalink" };
      const parent = s.reply_to_step != null ? run.state[s.reply_to_step - 1]?.out : null;
      await addJob({ kind: "write", sequence_run_id: run.id, step: i, account_id: ctx.account.id, thread_id: parent?.thread_id || lastOut(run, i, "thread_id") || run.thread_id,
        target_url: target, title: `Write a ${s.kind}${s.brief ? ": " + String(s.brief).slice(0, 120) : ""}`, created_by: "engine",
        dedupe_key: key, payload: { kind: s.kind, brief: s.brief || "", subreddit: s.subreddit || parent?.subreddit || lastOut(run, i, "subreddit") || run.subreddit, title: s.title || null,
          ...draftingContext(run, i, ctx.account.id), disclosure_line: ctx.account && ctx.account.disclosure_line, sequence: run.name, step: i + 1 } });
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
    if (t && t.reddit_url) {
      const match = t.reddit_url.match(/^https?:\/\/(?:www\.|old\.)?reddit\.com\/r\/([^/]+)\/comments\/([a-z0-9]+)\/([^/?#]*)/i);
      if (!match) return { fail: "published URL is not a Reddit permalink" };
      const thread_id = match[2].toLowerCase(), subreddit = match[1], thread_url = match[0] + "/";
      await sb("POST", "threads?on_conflict=id", [{ id: thread_id, subreddit, url: thread_url, screen_source: "sequence" }], "resolution=ignore-duplicates,return=minimal");
      return { done: true, out: { url: t.reddit_url, published_at: t.published_at, thread_id, subreddit, thread_url } };
    }
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
    for (let k = 0; k < i; k++) {
      if ((run.steps[k].account_id || run.account_id) !== ctx.account.id) continue;
      for (const id of (run.state[k]?.out?.replied_to || [])) answered.add(id);
    }
    const todo = replies.filter(r => !answered.has(r.id));
    if (!todo.length) return { done: true, out: { replied_to: [] }, note: "no new replies" };
    if (ctx.enter) for (const r of todo) await addJob({ kind: "draft_followup", sequence_run_id: run.id, step: i, account_id: ctx.account.id,
      thread_id: lastOut(run, i, "thread_id") || run.thread_id, target_url: r.permalink, created_by: "engine", dedupe_key: `seqreply:${run.id}:${ctx.account.id}:${r.id}`,
      title: `Answer u/${r.author}`, payload: { author: r.author, body: r.body, score: r.score, brief: s.brief || "",
        ...draftingContext(run, i, ctx.account.id), our_comment_url: lastOut(run, i, "url"), disclosure_line: ctx.account && ctx.account.disclosure_line } });
    const jobs = await sb("GET", `jobs?select=status,dedupe_key&sequence_run_id=eq.${enc(run.id)}&step=eq.${i}`);
    const open = jobs.filter(j => ["planned", "claimed"].includes(j.status)).length;
    if (!open) return { done: true, out: { replied_to: todo.map(r => r.id), answered: jobs.filter(j => j.status === "done").length } };
    return { note: `${open} of ${jobs.length} replies still with the agent. Each answer goes to Review and sends when approved.` };
  },

  async agent_task(run, i, s, ctx) {
      const key = `seqtask:${run.id}:${i}`;
      if (ctx.enter) await addJob({ kind: "agent_task", sequence_run_id: run.id, step: i, account_id: ctx.account.id, thread_id: lastOut(run, i, "thread_id") || run.thread_id,
        target_url: run.thread_url, title: String(s.instruction).slice(0, 300), created_by: "engine", dedupe_key: key, payload: { sequence: run.name } });
      const j = await job(key);
      if (j && ["done", "skipped"].includes(j.status)) return { done: true, out: { result: j.result } };
      if (j && j.status === "failed") return { fail: `agent task failed: ${(j.result && (j.result.reason || j.result.note)) || ""}` };
      return { note: "with the agent" };
    },

    async coordinated_post(run, i, s, ctx) {
      const key = `coordpost:${run.id}:${i}`;
      if (ctx.enter) {
        await addJob({ kind: "write", sequence_run_id: run.id, step: i, account_id: ctx.account.id,
          thread_id: run.thread_id, target_url: run.thread_url,
          title: `Coordinated post: ${String(s.brief || "").slice(0, 120)}`, created_by: "engine",
          dedupe_key: key, payload: { kind: s.kind || "comment", brief: s.brief || "",
            subreddit: run.subreddit, is_coordinated: true, sequence: run.name, step: i + 1,
            disclosure_line: ctx.account && ctx.account.disclosure_line } });
      }
      const j = await job(key);
      if (!j) return { note: "queueing coordinated post" };
      if (j.status === "done" && j.draft_id) return { done: true, out: { draft_id: j.draft_id, job_id: j.id } };
      if (j.status === "failed") return { fail: `coordinated post failed: ${j.result?.reason || "no reason"}` };
      return { note: `agent is preparing coordinated post (${j.status})` };
    },

    async independent_reply(run, i, s, ctx) {
      const key = `indepreply:${run.id}:${i}`;
      if (ctx.enter) {
        const target = s.target_url || lastOut(run, i, "thread_url");
        if (!target) return { fail: "independent reply needs a target URL" };
        await addJob({ kind: "draft_followup", sequence_run_id: run.id, step: i, account_id: ctx.account.id,
          thread_id: run.thread_id, target_url: target,
          title: `Independent reply as autonomous observer`, created_by: "engine",
          dedupe_key: key, payload: { kind: "reply", brief: s.brief || "Reply as independent observer",
            is_independent_reply: true, sequence: run.name, step: i + 1,
            disclosure_line: ctx.account && ctx.account.disclosure_line } });
      }
      const j = await job(key);
      if (!j) return { note: "queueing independent reply" };
      if (j.status === "done" && j.draft_id) return { done: true, out: { draft_id: j.draft_id, replied_to: s.target_url } };
      if (j.status === "failed") return { fail: `independent reply failed: ${j.result?.reason}` };
      return { note: `agent is drafting independent reply (${j.status})` };
    },

    async cross_account_check(run, i, s, ctx) {
      const url = lastOut(run, i, "url") || run.thread_url;
      if (!url) return { fail: "no thread URL to check" };
      const r = await repliesTo(url, ctx.ours);
      if (!r.ok) {
        if (r.gone) return { fail: "thread or comment is no longer available" };
        return { note: `${r.reason}; will retry`, next_at: new Date(Date.now() + 15 * 60000).toISOString() };
      }
      return { done: true, out: { url: r.url, total_replies: r.replies.length, our_score: r.comment.score, checked_at: nowIso() } };
    },

    async personality_write(run, i, s, ctx) {
      const key = `perswrite:${run.id}:${i}`;
      if (ctx.enter) {
        const profilePath = `data/accounts/${ctx.account.id}/profile.json`;
        let voiceBrief = s.brief || "";
        try {
          const fs = require("fs");
          const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
          voiceBrief = `[Voice: ${profile.nickname || ctx.account.label}] ${s.brief || ""}\nStyle: ${profile.writing_style?.tone || "professional"}, ${profile.writing_style?.vocabulary || "clear"}`;
        } catch (e) {
          voiceBrief = s.brief || "";
        }
        await addJob({ kind: "write", sequence_run_id: run.id, step: i, account_id: ctx.account.id,
          thread_id: run.thread_id, target_url: s.target_url || lastOut(run, i, "thread_url"),
          title: `Personality write: ${String(voiceBrief).slice(0, 100)}`, created_by: "engine",
          dedupe_key: key, payload: { kind: s.kind || "comment", brief: voiceBrief,
            subreddit: run.subreddit, has_personality: true, sequence: run.name, step: i + 1,
            disclosure_line: ctx.account && ctx.account.disclosure_line } });
      }
      const j = await job(key);
      if (!j) return { note: "queueing personality-aware draft" };
      if (j.status === "done" && j.draft_id) return { done: true, out: { draft_id: j.draft_id } };
      if (j.status === "failed") return { fail: `personality write failed: ${j.result?.reason}` };
      return { note: `agent is writing with account voice (${j.status})` };
    },

    async probabilistic_wait(run, i, s, ctx) {
      const baseMinutes = s.minutes || 15;
      const variance = s.variance || 0.5;
      const waitMinutes = Math.round(baseMinutes * (1 + (Math.random() - 0.5) * 2 * variance));
      const until = new Date(Date.now() + waitMinutes * 60000).toISOString();
      return { note: `waiting ${waitMinutes} min (probabilistic: base ${baseMinutes}m ±${Math.round(variance * 100)}%)`, next_at: until, keep: { waitMinutes, baseMinutes } };
    },
  };

async function advance(run, ctx) {
  const state = run.state.map(x => ({ ...x }));
  let current = run.current, status = run.status, next_at = nowIso(), moved = 0;
  while (status === "open" && current < run.steps.length && moved < 12) {
    const s = run.steps[current], st = state[current] || (state[current] = { status: "waiting" });
    const enter = st.status === "waiting";
    if (enter) { st.status = "active"; st.started_at = nowIso(); }
    const account = ctx.accounts[s.account_id || run.account_id];
    if (["write", "answer_replies", "agent_task", "conversation_aware", "asymmetric_participation", "depth_variation"].includes(s.type) && (!account || !account.active || !account.disclosed)) {
      st.status = "failed"; st.note = "step account is missing, inactive or undisclosed"; status = "failed"; break;
    }
    if (!STEPS[s.type]) { st.status = "failed"; st.note = `unknown step: ${s.type}`; status = "failed"; break; }
    const liveRun = { ...run, state };
    const decision = accountOut(liveRun, current, account?.id, "conversation");
    const threadId = lastOut(liveRun, current, "thread_id") || run.thread_id;
    let priorWrite = null;
    for (let k = current - 1; k >= 0; k--) if (run.steps[k].type === "write") { priorWrite = state[k]; break; }
    const skip = (["write", "answer_replies"].includes(s.type) && decision?.thread_id === threadId && !decision.participate)
      || (["approve", "send", "wait_live", "check_replies", "answer_replies"].includes(s.type) && priorWrite?.out?.skipped);
    const res = skip ? { done: true, out: { skipped: true }, note: decision?.reason || "the preceding write was skipped" } : await STEPS[s.type]({ ...run, state, current }, current, s, { ...ctx, account, enter, st });
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
  const accounts = Object.fromEntries((await sb("GET", "accounts?select=id,label,disclosure_line,active,disclosed")).map(a => [a.id, a]));
  const results = [];
  for (const run of runs) {
    try { results.push(await advance(run, { ours, accounts })); }
    catch (e) { results.push({ run: run.id, error: String(e.message).slice(0, 200) }); }
  }
  return { runs: runs.length, results };
}

module.exports = { runEngine, advance, STEP_TYPES: Object.keys(STEPS) };
