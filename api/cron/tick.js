/* api/cron/tick.js — the planner's clock, every 15 minutes (vercel.json).
 *
 * Replaces the laptop loop (scenario-dispatch.py poll + link). Each pass:
 *   1. accounts: sync the Engain accounts-beta roster into `accounts`. Never
 *      touches `disclosed`, which only a human sets on /plan.
 *   2. poll: read what Engain published, failed or cancelled, and write it on
 *      engain_tasks, drafts and scenario_acts. An act turning `published` fires
 *      the plan_watch_jobs trigger (027), which plans its reply checks.
 *   3. check_replies: for each due check, read our comment on Reddit. Every
 *      reply from someone who is not us becomes a `draft_followup` job for the
 *      agent. Nothing is written to Reddit here.
 *   4. sequences: advance every open sequence run (_engine.js, migration 029).
 *   5. send: runQueue(), the same sender as /api/dispatch.
 * Every outcome is in the JSON it returns and in activity_log (actor cron/tick).
 */
const { runQueue, sb, engain, logger } = require("../_send.js");
const { permalink } = require("../_reddit.js");
const { runEngine } = require("../_engine.js");

const ACTOR = "cron/tick";
const log = logger(ACTOR);
const enc = encodeURIComponent;
const now = () => new Date().toISOString();
const { UA } = require("../_reddit.js");

async function syncAccounts() {
  const { status, json } = await engain("GET", "/api/v1/accounts-beta/accounts");
  if (status >= 300) return { ok: false, status };
  const rows = (json.accounts || []).map(a => ({ id: a.userAccountId, label: a.label || a.displayName || null,
    reddit_username: a.profileUsername || null, niche: a.niche || null, lifecycle: a.lifecycleStatus || null,
    usable: a.usable ?? null, synced_at: now() }));
  if (rows.length) await sb("POST", "accounts?on_conflict=id", rows, "resolution=merge-duplicates,return=minimal");
  return { ok: true, synced: rows.length };
}

function vendorState(c) {
  const s = String(c.status || "").toLowerCase();
  if (s.includes("remov") || s.includes("delet")) return "removed";
  if ((s === "completed" || s === "published") && (c.resultUrl || c.redditUrl)) return "published";
  if (s === "failed") return "failed";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  return null;   // still in flight
}

async function poll() {
  const open = await sb("GET", "engain_tasks?select=id,draft_id,thread_id,status&project_id=eq.accounts-beta&reddit_url=is.null&cancelled_at=is.null&limit=200");
  const want = new Map(open.filter(t => !["failed", "cancelled", "removed"].includes(String(t.status).toLowerCase())).map(t => [t.id, t]));
  // Every accounts-beta task, so /status can show Engain's reply count (034).
  const known = new Map((await sb("GET", "engain_tasks?select=id,reply_count&project_id=eq.accounts-beta&limit=1000")).map(t => [t.id, t.reply_count]));
  const changes = [];
  let cursor = null, replyCounts = 0;
  for (let page = 0; page < 10; page++) {
    const { status, json } = await engain("GET", "/api/v1/accounts-beta/comments", undefined, cursor ? { cursor } : undefined);
    if (status >= 300) { changes.push({ error: `vendor ${status}` }); break; }
    for (const c of json.page || []) {
      if (known.has(c._id) && c.replyCount != null && known.get(c._id) !== c.replyCount) {
        await sb("PATCH", `engain_tasks?id=eq.${enc(c._id)}`, { reply_count: c.replyCount }, "return=minimal").catch(() => {});
        replyCounts++;
      }
      const t = want.get(c._id); if (!t) continue;
      want.delete(c._id);
      const state = vendorState(c);
      await sb("PATCH", `engain_tasks?id=eq.${enc(c._id)}`, { status: c.status, last_polled: now() }, "return=minimal");
      if (!state) continue;
      const at = new Date(c.updatedAt || Date.now()).toISOString();
      if (state === "published") {
        const url = await permalink(c.resultUrl || c.redditUrl);
        await sb("PATCH", `engain_tasks?id=eq.${enc(c._id)}`, { reddit_url: url, published_at: at }, "return=minimal");
        if (t.draft_id) await sb("PATCH", `drafts?id=eq.${enc(t.draft_id)}&status=neq.rejected`, { status: "posted", posted_url: url, posted_at: at, engain_status: c.status, engain_seen_at: now() }, "return=minimal");
        await sb("PATCH", `scenario_acts?task_id=eq.${enc(c._id)}&status=neq.rejected`, { status: "published", url, published_at: at, engain_status: c.status, engain_seen_at: now() }, "return=minimal");
        await sb("PATCH", `eval_log?task_id=eq.${enc(c._id)}`, { survival_status: "published" }, "return=minimal");
      } else {
        const actState = state === "removed" ? "removed" : "failed";
        if (t.draft_id) await sb("PATCH", `drafts?id=eq.${enc(t.draft_id)}&status=neq.rejected`, { status: state === "removed" ? "removed" : "cancelled", engain_status: c.status, engain_seen_at: now() }, "return=minimal");
        await sb("PATCH", `scenario_acts?task_id=eq.${enc(c._id)}&status=neq.rejected`, { status: actState, engain_status: c.status, engain_seen_at: now() }, "return=minimal");
        await sb("PATCH", `eval_log?task_id=eq.${enc(c._id)}`, { survival_status: state }, "return=minimal");
      }
      changes.push({ task: c._id, state });
    }
    if (json.isDone || !json.continueCursor) break;
    cursor = json.continueCursor;
  }
  return { open: open.length, changes, reply_counts_updated: replyCounts };
}

async function checkReplies() {
  const jobs = await sb("POST", "rpc/claim_jobs", { p_agent: ACTOR, p_kinds: ["check_replies"], p_limit: 10 });
  const ours = new Set((await sb("GET", "accounts?select=reddit_username&reddit_username=not.is.null")).map(a => a.reddit_username.toLowerCase()));
  const results = [];
  for (const j of jobs) {
    const done = (status, result) => sb("POST", "rpc/complete_job", { p_id: j.id, p_agent: ACTOR, p_status: status, p_result: result });
    try {
      const url = await permalink(j.target_url);
      const r = await fetch(url.replace(/\/?$/, "/") + ".json?limit=100&depth=2", { headers: { "User-Agent": UA } });
      if (!r.ok) { await done("blocked", { reason: `reddit ${r.status} reading ${url}` }); results.push({ job: j.id, outcome: "blocked", status: r.status }); continue; }
      const data = await r.json();
      const ourComment = data[1] && data[1].data.children[0] && data[1].data.children[0].data;
      if (!ourComment || ["[deleted]", "[removed]"].includes(ourComment.body)) {
        await done("skipped", { reason: "our comment is gone" }); results.push({ job: j.id, outcome: "gone" }); continue;
      }
      const replies = ((ourComment.replies && ourComment.replies.data && ourComment.replies.data.children) || [])
        .filter(c => c.kind === "t1").map(c => c.data)
        .filter(c => c.author && !["[deleted]", "AutoModerator"].includes(c.author) && !ours.has(c.author.toLowerCase()));
      let planned = 0;
      for (const c of replies) {
        const rows = await sb("POST", "jobs?on_conflict=dedupe_key", [{ kind: "draft_followup", run_id: j.run_id, act_id: j.act_id,
          account_id: j.account_id, thread_id: j.thread_id, target_url: `https://www.reddit.com${c.permalink}`, created_by: ACTOR,
          dedupe_key: `followup:${c.id}`, payload: { author: c.author, body: c.body, score: c.score, our_comment_url: url, our_body: ourComment.body } }],
          "resolution=ignore-duplicates,return=representation");
        planned += (rows || []).length;
      }
      await done("done", { replies: replies.length, followups_planned: planned, our_score: ourComment.score });
      results.push({ job: j.id, outcome: "done", replies: replies.length, followups_planned: planned });
    } catch (e) {
      await done("failed", { reason: String(e.message).slice(0, 200) }).catch(() => {});
      results.push({ job: j.id, outcome: "error", error: String(e.message).slice(0, 200) });
    }
  }
  return results;
}

module.exports = async function handler(req, res) {
  const out = (status, obj) => { res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.statusCode = status; res.end(JSON.stringify(obj, null, 2)); };
  const secret = process.env.CRON_SECRET || "";
  if (!secret || String(req.headers.authorization || "") !== `Bearer ${secret}`) return out(401, { error: "cron secret missing or wrong" });
  const report = {};
  for (const [name, fn] of [["accounts", syncAccounts], ["poll", poll], ["check_replies", checkReplies], ["sequences", runEngine],
                            ["send", async () => (await runQueue(ACTOR)).body]]) {
    try { report[name] = await fn(); }
    catch (e) { report[name] = { error: String(e.message).slice(0, 300) }; }
  }
  await log("tick", report);
  return out(200, { ok: true, ...report });
};
