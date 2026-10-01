/* api/dispatch.js — approved means sent. The server-side poster.
 *
 * Swello, 2026-09-03: "I just said it's cleared and that's it." A watcher
 * that depends on a laptop being awake is not a pipeline, so this function
 * does what `engain-post.py post` does, on Vercel, the moment the review page
 * asks (right after Approve) and every 15 minutes as a fallback (vercel.json
 * crons). Calling it is NOT an authorization: it will only ever send drafts a
 * human approved (review_draft sets status=approved AND send_cleared_at), and
 * it re-reads that on the draft id before every vendor call.
 *
 * The gates, every one a refusal, none a warning to click through:
 *   0. cleared, approved, not sent back, not gate-failed, not pulled back
 *      (posting_queue applies most of these in SQL; re-read here anyway)
 *   1. the §0 rules (_rules.js check(), the same list as the review page and
 *      check_draft.py) on the exact body about to go out
 *   2. a reply's parent is confirmed by the reviewer and is not one of ours
 *   3. no byte-identical body already sent on the same thread
 *   4. Engain's rule-check, run fresh: `fail` blocks and is written on the
 *      draft in red with the vendor's reason; `warn` is recorded and posts,
 *      because the human already judged the text and the score drifts 20
 *      points between identical runs (02-RUNBOOK.md §5)
 * Then, and only then, POST /tasks/{comment|reply|post}. The task, the draft
 * flip to `dispatched`, the eval_log row and the activity_log line follow.
 *
 * Holds ENGAIN_API_KEY and the Supabase service key, server-side only. Never
 * echoes either. Rule-check is 5/min at the vendor, so a run takes at most
 * MAX_PER_RUN drafts and the cron catches the rest.
 */
const { check } = require("./_rules.js");

const SB_URL  = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY || "";
const ENG_KEY = process.env.ENGAIN_API_KEY || "";
const ENG_URL = "https://api.engain.io";
const ACTOR = "dispatch";
const MAX_PER_RUN = 3;
const UPVOTE_MIN = 3, UPVOTE_MAX = 7;
const FORBIDDEN = [
  ["owned ip", "never 'owned IPs'"], ["we own the network", "never claim network ownership"], ["own our ips", "never claim IP ownership"],
  ["owned end to end", "never 'owned end to end'"], ["gdpr", "no GDPR claims"], ["dpa available", "no DPA claims"],
  ["85,000", "85,000 is not a real figure"], ["85000", "85,000 is not a real figure"], ["/v1/scrape", "the endpoint is /v1/extract"],
  ["i work at geonode", "never reveal affiliation"], ["i work for geonode", "never reveal affiliation"], ["disclosure:", "never reveal affiliation"],
];

async function sb(method, path, body, prefer) {
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`supabase ${r.status} on ${method} ${path.split("?")[0]}: ${(await r.text()).slice(0, 300)}`);
  const text = await r.text();
  return text.trim() ? JSON.parse(text) : null;   // return=minimal answers 201/204 with an empty body
}
async function log(action, detail) { try { await sb("POST", "activity_log", [{ actor: ACTOR, action, detail }], "return=minimal"); } catch {} }
async function engain(method, path, body, params) {
  const url = ENG_URL + path + (params ? "?" + new URLSearchParams(params) : "");
  const r = await fetch(url, { method, headers: { "X-API-Key": ENG_KEY, "Content-Type": "application/json", "User-Agent": "geonode-reddit-agent/1.0 (+dispatch)" },
                               body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: r.status, json };
}
async function projectId() {
  if (process.env.ENGAIN_PROJECT_ID) return process.env.ENGAIN_PROJECT_ID;
  const { json } = await engain("GET", "/api/v1/me");
  const p = (json.projects || []).find(x => x.name === "geonode.com");
  if (!p) throw new Error("no geonode.com project on this key");
  return p.id;
}
const commentId = u => { const m = String(u || "").match(/\/comments\/[A-Za-z0-9]+\/[^/?#]+\/([A-Za-z0-9]+)/); return m ? m[1].toLowerCase() : null; };
const enc = encodeURIComponent;
const now = () => new Date().toISOString();

async function flag(d, where, reasons) {
  const text = `${where}: ${reasons.join(" | ")}`.slice(0, 2000);
  await sb("PATCH", `drafts?id=eq.${enc(d.draft_id)}`, { gate_failed_at: now(), gate_failure: text }, "return=minimal");
  await log("gate_refused", { draft: d.draft_id, thread: d.thread_id, where, reasons });
  return { draft: d.draft_id, thread: d.thread_id, outcome: "refused", where, reasons };
}

async function dispatchOne(d, pid, ourIds) {
  const kind = d.kind || "comment";
  const head = { draft: d.draft_id, thread: d.thread_id, kind, subreddit: d.subreddit };

  // gate 0: re-read the row itself, on its own id
  const [cur] = await sb("GET", `drafts?select=status,send_cleared_at,redirect_pending,gate_failed_at,pullback_requested_at,body,parent_url,parent_confirmed_by,kind&id=eq.${enc(d.draft_id)}`);
  if (!cur || cur.status !== "approved" || !cur.send_cleared_at || cur.redirect_pending || cur.gate_failed_at || cur.pullback_requested_at)
    return { ...head, outcome: "skipped", why: "state changed since the queue was read (held, sent back, refused, or no longer approved)" };
  const body = cur.body || "";

  // gate 1: the rules, on the exact bytes
  //
  // A scenario SETUP act is allowed not to name us: act 1 asks the question that
  // act 2 answers hours later, and its spec says mentions_geonode: false on
  // purpose. Without this lookup the gate failed act 1 of every scripted
  // scenario, which is why the only run ever started has sat open with act 2
  // pending behind it. The flag comes from the scenario spec in the database,
  // never from the caller, so a draft cannot ask to skip the mention rule.
  const context = await sb("POST", "rpc/scenario_context", {
    p_draft_id: d.draft_id, p_parent_url: cur.parent_url || null
  });
  if (context.scenario && !context.pace_ok) return { ...head, outcome: "deferred", why: "scenario pace floor (45m global / 24h subreddit / 20 per UTC day)" };
  if (!context.ready) return { ...head, outcome: "skipped", why: "scenario disabled, wrong dependency, or waiting for publication/gap" };
  const isSetup = context.setup === true;
  const low = body.toLowerCase();
  const forb = FORBIDDEN.filter(([p]) => low.includes(p)).map(([p, why]) => `'${p}': ${why}`);
  const v = check(body, { kind, setup: isSetup });
  if (!v.ok || forb.length) return flag(d, "final rule check", [...v.fails, ...forb]);

  // gate 2: a DB-proven same-account follow-up is sanctioned.
  // Multi-account conversations (same_thread_accounts=true) remain refused.
  if (kind === "reply") {
    if (!cur.parent_url) return flag(d, "reply", ["no parent_url"]);
    if (!cur.parent_confirmed_by && !context.self_reply) return { ...head, outcome: "skipped", why: "reply parent not confirmed by the reviewer" };
    if (!context.self_reply && (ourIds.has(commentId(cur.parent_url)) ||
        await sb("POST", "rpc/is_our_url", { p_url: cur.parent_url }))) return flag(d, "stranger gate", ["parent is one of our own published comments"]);
  }
  if (kind === "post" && !(d.subreddit && d.title)) return flag(d, "post", ["needs subreddit and title"]);

  // gate 3: never the same bytes twice on one thread (02-RUNBOOK.md §5)
  if (d.thread_id) {
    const dup = await sb("GET", `engain_tasks?select=id&thread_id=eq.${enc(d.thread_id)}&status=neq.test_artifact&content=eq.${enc(body)}&limit=1`);
    if (dup.length) return flag(d, "dedupe", [`byte-identical body already sent on this thread (task ${dup[0].id})`]);
  }

  // gate 4: Engain's rule-check, fresh. fail blocks, warn posts and is recorded.
  const rc = await engain("POST", "/api/v1/rule-check", { projectId: pid, subreddit: d.subreddit, taskType: kind, content: body, mediaKind: "text", context: { postTitle: d.title || "" } });
  if (rc.status === 429) return { ...head, outcome: "deferred", why: "vendor rule-check rate limit (5/min). Next run picks it up." };
  const verdict = rc.status < 300 ? (rc.json.verdict || "unavailable") : "unavailable";
  await sb("POST", "rule_checks", [{ draft_id: d.draft_id, subreddit: d.subreddit, verdict, removal_risk: rc.json.removalRisk ?? null,
    violated_rules: rc.json.violatedRules || [], summary: `dispatch ${now().slice(0, 16)}: ${rc.json.summary || JSON.stringify(rc.json).slice(0, 200)}` }], "return=minimal");
  if (verdict === "fail") return flag(d, `Engain rule-check fail, removal risk ${rc.json.removalRisk} of 100`, [rc.json.summary || "", ...(rc.json.violatedRules || [])].filter(Boolean));
  if (verdict === "unavailable") return { ...head, outcome: "deferred", why: `vendor rule-check unavailable (${rc.status}). Next run retries.` };

  // the vendor call
  const labels = ["geonode-agent", "nodas"];
  let endpoint, payload, target;
  if (kind === "reply") { endpoint = "/api/v1/tasks/reply"; payload = { projectId: pid, url: cur.parent_url, content: body, labels }; target = cur.parent_url; }
  else if (kind === "post") { endpoint = "/api/v1/tasks/post"; payload = { projectId: pid, subredditUrl: `https://www.reddit.com/r/${d.subreddit}/`, postTitle: d.title, content: body, labels }; target = `r/${d.subreddit}`; }
  else { endpoint = "/api/v1/tasks/comment"; payload = { projectId: pid, url: d.thread_url, content: body, labels }; target = d.thread_url; }
  if (context.scenario) {
    // Vendor rule-check may have taken seconds; honor a review made meanwhile.
    const [fresh] = await sb("GET", `drafts?select=status,send_cleared_at,body,parent_url,kind,redirect_pending,gate_failed_at,pullback_requested_at&id=eq.${enc(d.draft_id)}`);
    const proof = await sb("POST", "rpc/scenario_context", { p_draft_id: d.draft_id, p_parent_url: cur.parent_url || null });
    if (!fresh || fresh.status !== "approved" || !fresh.send_cleared_at || fresh.body !== body ||
        fresh.parent_url !== cur.parent_url || fresh.kind !== kind || fresh.redirect_pending ||
        fresh.gate_failed_at || fresh.pullback_requested_at || !proof.ready || !proof.pace_ok ||
        (context.self_reply && !proof.self_reply))
      return { ...head, outcome: "skipped", why: "scenario approval, text or gates changed before submission" };
  }
  const { status, json: task } = await engain("POST", endpoint, payload);
  if (status >= 300 || !task.id) {
    await log("engain_submit_failed", { draft: d.draft_id, thread: d.thread_id, status, vendor: task });
    return { ...head, outcome: "vendor_error", status, vendor: JSON.stringify(task).slice(0, 300) };
  }
  await sb("POST", "engain_tasks", [{ id: task.id, draft_id: d.draft_id, thread_id: d.thread_id, project_id: pid, task_type: kind, subreddit: d.subreddit,
    thread_url: d.thread_url || cur.parent_url, content: body, status: task.status, reddit_url: task.redditUrl || null, credits_used: task.creditsUsed ?? null,
    labels, mode: d.mode, models: d.models }], "return=minimal");
  await sb("PATCH", `drafts?id=eq.${enc(d.draft_id)}&status=neq.rejected`, {
    status: "dispatched", engain_task_id: task.id, engain_status: task.status || null, engain_seen_at: now()
  }, "return=minimal");
  await sb("PATCH", `scenario_acts?draft_id=eq.${enc(d.draft_id)}&status=neq.rejected`, {
    status: "dispatched", task_id: task.id, dispatched_at: now(),
    engain_status: task.status || null, engain_seen_at: now()
  }, "return=minimal");
  let nq = null;
  if (d.thread_id) { const t = await sb("GET", `targets?select=n_queries&thread_id=eq.${enc(d.thread_id)}`); nq = t.length ? t[0].n_queries : null; }
  await sb("POST", "eval_log", [{ draft_id: d.draft_id, task_id: task.id, thread_id: d.thread_id, subreddit: d.subreddit, kind, mode: d.mode,
    strategy: d.strategy, prompt_version: d.prompt_version, models: d.models, n_queries: nq, submitted_at: now(), survival_status: task.status }], "return=minimal");
  const up = Math.min(Math.max(parseInt(d.upvotes_suggested || UPVOTE_MIN, 10) || UPVOTE_MIN, UPVOTE_MIN), UPVOTE_MAX);
  await log(`engain_${kind}_submitted`, { task: task.id, thread: d.thread_id, kind, mode: d.mode, subreddit: d.subreddit, credits: task.creditsUsed, rule_verdict: verdict, removal_risk: rc.json.removalRisk, upvotes_planned: up,
    cancel_window_opens: new Date(Date.now() + 24 * 3600 * 1000).toISOString() });
  return { ...head, outcome: "sent", task: task.id, vendor_status: task.status, credits: task.creditsUsed, rule_verdict: verdict, removal_risk: rc.json.removalRisk, target };
}

module.exports = async function handler(req, res) {
  const out = (status, obj) => { res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.setHeader("Access-Control-Allow-Origin", "*"); res.statusCode = status; res.end(JSON.stringify(obj, null, 2)); };
  if (req.method === "OPTIONS") { res.setHeader("Access-Control-Allow-Origin", "*"); res.setHeader("Access-Control-Allow-Methods", "POST, GET"); res.statusCode = 204; return res.end(); }
  if (!SB_URL || !SB_KEY) return out(503, { error: "SUPABASE_URL / SUPABASE_SERVICE_KEY not configured" });
  if (!ENG_KEY) return out(503, { error: "ENGAIN_API_KEY not configured on this project: nothing can be sent" });
  try {
    const queue = (await sb("GET", "posting_queue?select=*&send_cleared_at=not.is.null&order=send_cleared_at.asc")).slice(0, MAX_PER_RUN);
    const waiting = await sb("GET", "posting_queue?select=draft_id&send_cleared_at=not.is.null");
    if (!queue.length) return out(200, { ok: true, cleared: 0, results: [], note: "nothing approved and cleared that is not already sent, refused, held or with the agent" });
    const pid = await projectId();
    const ours = new Set((await sb("GET", "engain_tasks?select=reddit_url&reddit_url=not.is.null")).map(t => commentId(t.reddit_url)).filter(Boolean));
    const results = [];
    for (const d of queue) {
      try { results.push(await dispatchOne(d, pid, ours)); }
      catch (e) { results.push({ draft: d.draft_id, thread: d.thread_id, outcome: "error", error: String(e.message).slice(0, 300) }); }
    }
    await log("dispatch_run", { cleared: waiting.length, took: queue.length, results });
    return out(200, { ok: true, cleared: waiting.length, took: queue.length, results, note: waiting.length > queue.length ? `${waiting.length - queue.length} more wait for the next run (rule-check is 5/min at the vendor)` : undefined });
  } catch (e) {
    await log("dispatch_error", { error: String(e.message).slice(0, 300) });
    return out(500, { error: String(e.message).slice(0, 300) });
  }
};
