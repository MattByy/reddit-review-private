/* _agent.js — the agent's door into the Reddit workflow.
 *
 * One Vercel function, mounted at /api/agent and /api/agent/* by the two thin
 * files in api/agent/. Everything the writing agent needs to run the loop
 * without a human at the keyboard: read the query map, read the threads that
 * rank for it, read what Engain surfaced, register a thread it found itself,
 * file a draft (comment, reply or post), revise its own pending draft, read
 * back what the reviewer changed or rejected, and read where every thread
 * stands.
 *
 * What is deliberately NOT here, and must never be added to this file:
 *   - approve            only review_draft(), from the review page, by a human
 *   - clear to send      only the review page's send tab, by a human
 *   - post / upvote      only engain-post.py, run by a human holding the key
 * The agent files; a person decides; a script posts. Three roles, and this
 * door opens onto exactly the first one. AGENT-API.md documents the contract.
 *
 * Auth: `Authorization: Bearer <AGENT_API_KEY>`, compared in constant time.
 * Data: the Supabase service key, server-side only. It never reaches a browser
 * and it is never echoed in a response.
 */
const crypto = require("crypto");
const { check } = require("./_rules.js");

const SB_URL   = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY   = process.env.SUPABASE_SERVICE_KEY || "";
const AGENT_KEY = process.env.AGENT_API_KEY || "";
const ENG_KEY   = process.env.ENGAIN_API_KEY || "";
const ENG_URL   = "https://api.engain.io";
// Swello, 2026-09-03: a draft is accepted and shown to him ONLY if it scores
// at or under this on Engain's rule-check. Above it, the door refuses and
// nothing is stored. 40 is 02-RUNBOOK.md's ceiling (write-comment.py uses the
// same number on a 5-run mean); the door gets one run because the vendor
// allows five a minute.
const RISK_CEILING = parseInt(process.env.RISK_CEILING || "40", 10);
const ACTOR    = "agent-api";
const MAX_LIMIT = 200;

// ── helpers ─────────────────────────────────────────────────────────────────
function send(res, status, obj) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = status;
  res.end(JSON.stringify(obj, null, 2));
}
class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const bad = (status, message, extra) => { throw new HttpError(status, message, extra); };

function authed(req) {
  const tok = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!AGENT_KEY || !tok) return false;
  const a = Buffer.from(tok), b = Buffer.from(AGENT_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") { try { return JSON.parse(req.body || "{}"); } catch { bad(400, "body is not valid JSON"); } }
    return req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { bad(400, "body is not valid JSON"); }
}

async function sb(method, path, body, prefer) {
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  let r;
  try {
    r = await fetch(`${SB_URL}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new HttpError(502, "database unreachable", { detail: String(e && e.cause && e.cause.message || e.message).slice(0, 200) });
  }
  if (!r.ok) {
    const text = await r.text();
    throw new HttpError(r.status === 404 ? 404 : 502, `supabase ${r.status} on ${method} ${path.split("?")[0]}`, { supabase: text.slice(0, 600) });
  }
  const text = await r.text();
  return text.trim() ? JSON.parse(text) : null;   // return=minimal answers 201/204 with an empty body
}

const limitOf = (sp, dflt = 50) => Math.min(Math.max(parseInt(sp.get("limit") || dflt, 10) || dflt, 1), MAX_LIMIT);
const offsetOf = sp => Math.max(parseInt(sp.get("offset") || 0, 10) || 0, 0);
const enc = encodeURIComponent;
const threadId = raw => String(raw || "").trim().replace(/^t3_/, "");
const isRedditUrl = u => /^https?:\/\/(www\.|old\.)?reddit\.com\//i.test(String(u || ""));

/* Engain's rule-check, the vendor's own opinion of whether the subreddit
   will remove this. Returns {verdict, removal_risk, marketing, summary,
   violated_rules} or {unavailable, status}. Never throws.

   SAMPLED, because the vendor scorer is NONDETERMINISTIC. Identical text
   scored [22, 28, 48, 28, 28] on five consecutive calls, and write-comment.py
   has always known this — it confirms a 5-run mean before it hands a draft
   over. The door used to re-roll ONCE, so a draft genuinely averaging 28 was
   refused on a 48 or a 52 and the whole run was thrown away. That is not a
   stricter gate, it is a noisier one: it rejects and accepts the same comment
   at random.

   The ceiling does NOT move (published comments average risk 22, automod
   removed ones 66). What changes is that the door measures the same way the
   writer does. Worst-case is reported alongside the mean so a draft that ever
   spikes badly is still visible in the record. */
async function vendorCheckOnce(body, kind, subreddit, title, pid) {
  const r = await fetch(`${ENG_URL}/api/v1/rule-check`, { method: "POST",
    headers: { "X-API-Key": ENG_KEY, "Content-Type": "application/json", "User-Agent": "geonode-reddit-agent/1.0 (+api)" },
    body: JSON.stringify({ projectId: pid, subreddit, taskType: kind, content: body, mediaKind: "text", context: { postTitle: title || "" } }) });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 300) }; }
  if (!r.ok) return { unavailable: true, status: r.status, retryable: r.status === 429,
    why: r.status === 429 ? "vendor rule-check rate limit (5 per minute). Retry in 60 seconds." : `vendor ${r.status}: ${JSON.stringify(j).slice(0, 200)}` };
  return { verdict: j.verdict || "unavailable", removal_risk: j.removalRisk ?? null, marketing: j.marketingIntentRisk ?? null,
           summary: j.summary || "", violated_rules: j.violatedRules || [], ceiling: RISK_CEILING };
}

/* A 429 is a QUEUE, not a verdict. The vendor allows 5 rule-checks a minute and
   write-comment.py spends most of that budget confirming its own draft, so the
   door's samples routinely arrive to a locked window. Treating that as
   "unavailable" refused perfectly good drafts: 14 cron runs, 0 filed, 83 rate
   limit hits, every one of them a draft that had already passed every gate.
   Waiting is nearly free here — the alternative is discarding work that cost
   ten model calls to produce. */
async function vendorCheckRetry(body, kind, subreddit, title, pid) {
  const waits = [20000, 40000, 60000];
  for (let i = 0; ; i++) {
    const one = await vendorCheckOnce(body, kind, subreddit, title, pid);
    if (!one.retryable || i >= waits.length) return one;
    await new Promise(r => setTimeout(r, waits[i]));
  }
}
const VC_SAMPLES = Number(process.env.VC_SAMPLES || 2);   // see the budget note below
async function vendorCheck(body, kind, subreddit, title) {
  if (!ENG_KEY) return { unavailable: true, status: 0, why: "ENGAIN_API_KEY not configured" };
  try {
    const me = await fetch(`${ENG_URL}/api/v1/me`, { headers: { "X-API-Key": ENG_KEY, "User-Agent": "geonode-reddit-agent/1.0 (+api)" } }).then(r => r.json());
    const pid = process.env.ENGAIN_PROJECT_ID || ((me.projects || []).find(p => p.name === "geonode.com") || {}).id;
    if (!pid) return { unavailable: true, status: 0, why: "no geonode.com project on the vendor key" };

    // BUDGET: the vendor allows 5 rule-checks per minute for the WHOLE pipeline,
    // and write-comment.py already spends several confirming its own draft
    // before it ever reaches this door. Sampling 3 here starved it and filed
    // nothing for 14 straight runs. Two samples still catch the noise that
    // mattered (a lone 48 among 28s no longer decides the outcome) while
    // leaving the writer room, and each one retries through a 429 rather than
    // throwing the draft away.
    const runs = [];
    for (let i = 0; i < VC_SAMPLES; i++) {
      const one = await vendorCheckRetry(body, kind, subreddit, title, pid);
      // Out of retries: keep any sample we already have rather than discarding
      // the draft over a vendor window we do not control.
      if (one.unavailable) {
        if (!runs.length) return one;
        break;
      }
      runs.push(one);
      if (i < VC_SAMPLES - 1) await new Promise(r => setTimeout(r, 1500));
    }
    const risks = runs.map(r => r.removal_risk).filter(n => typeof n === "number");
    if (!risks.length) return runs[0];
    const mean = Math.round(risks.reduce((a, b) => a + b, 0) / risks.length);
    const worst = Math.max(...risks);
    // Any single FAIL verdict is still a fail: the vendor naming a violated
    // rule is a categorical answer, not a noisy score.
    const failed = runs.find(r => r.verdict === "fail");
    const lead = failed || runs.reduce((a, b) => (b.removal_risk > a.removal_risk ? b : a), runs[0]);
    return { ...lead, removal_risk: mean, samples: risks, worst, sampled: risks.length,
             summary: `${lead.summary} [${risks.length}-run mean ${mean}, worst ${worst}, samples ${risks.join("/")}]` };
  } catch (e) { return { unavailable: true, status: 0, why: String(e.message).slice(0, 200) }; }
}
/* The door's verdict on a vendor score. Refuses on `fail`, on a risk over
   the ceiling, and on no score at all (absence of evidence blocks). */
function overCeiling(vc) {
  if (vc.unavailable) return `the vendor rule-check could not run (${vc.why}). Nothing is filed without a score.`;
  if (vc.verdict === "fail") return `Engain rule-check FAIL, removal risk ${vc.removal_risk} of 100: ${vc.summary}`;
  if (vc.removal_risk == null) return "Engain returned no removal risk. Nothing is filed without a score.";
  if (vc.removal_risk > RISK_CEILING) return `removal risk ${vc.removal_risk} is over the ceiling of ${RISK_CEILING}: ${vc.summary}`;
  return null;
}
async function recordCheck(draftId, subreddit, vc, note) {
  // The draft is already stored when this runs; a failure to write the score
  // must not turn a filed draft into a 502 (it did, once, under a key that
  // could not insert rule_checks). Log it instead.
  try {
    await sb("POST", "rule_checks", [{ draft_id: draftId, subreddit, verdict: vc.verdict, removal_risk: vc.removal_risk,
      violated_rules: vc.violated_rules, summary: `${note}: ${vc.summary}${vc.marketing != null ? ` marketingIntentRisk ${vc.marketing}.` : ""}` }], "return=minimal");
  } catch (e) { await log("rule_check_not_recorded", { draft: draftId, error: String(e.message).slice(0, 200), vendor: vc }); }
}

async function log(action, detail) {
  try { await sb("POST", "activity_log", [{ actor: ACTOR, action, detail }], "return=minimal"); }
  catch { /* logging must never fail the request */ }
}

// ── routes ──────────────────────────────────────────────────────────────────
const HELP = {
  service: "Reddit GEO Ops · agent API",
  docs: "04-reddit/AGENT-API.md in the repo",
  auth: "Authorization: Bearer <AGENT_API_KEY>",
  routes: {
    "GET  /api/agent/queries":              "the query map. ?q=term&shape=category|cost|blocked|alternative|unlimited&limit&offset",
    "GET  /api/agent/threads":              "threads worth commenting on. ?source=ranking|engain&subreddit=&status=&limit",
    "GET  /api/agent/threads/:id":          "one thread with everything known about it: ranking, Engain view, drafts, tasks, stage",
    "POST /api/agent/threads":              "register a thread you found yourself {id,url,title,subreddit,score,num_comments}",
    "GET  /api/agent/drafts":               "drafts. ?status=pending|approved|edited|rejected|posted&kind=comment|reply|post&mode=comment|reply|sharpen&thread_id=&needs_agent=true&limit",
    "GET  /api/agent/drafts/:id":           "one draft with its revisions, rule checks and vendor task",
    "POST /api/agent/drafts":               "file a draft for human review {kind,mode,thread_id,parent_url,subreddit,title,body,models,sharpen,thread_context,...}",
    "PATCH /api/agent/drafts/:id":          "revise a pending draft: yours, or one the reviewer sent back (needs_agent). {body,models,sharpen,...} clears redirect_pending",
    "POST /api/agent/drafts/:id/withdraw":  "pull a pending draft {reason}",
    "POST /api/agent/check":                "dry-run the copy rules AND the vendor rule-check on a body {body,kind,subreddit,title}. would_file says whether the door would take it",
    "GET  /api/agent/lessons":              "what the reviewer changed, rejected and sent back (redirects), and why. Read before writing.",
    "GET  /api/agent/our-comments":         "permalinks of comments WE published. A reply's parent must never be one of these.",
    "GET  /api/agent/status":               "where every thread stands. ?stage=draft|approved|cleared|sent|published|upvotes|done|failed|removed",
  },
  not_here: "approve, clear-to-send, post, upvote and pull-back. Humans on /review and engain-post.py only.",
  door: `a draft is filed only if Engain's rule-check scores it at or under ${RISK_CEILING} of 100 and not 'fail'. Above that it is refused with the vendor's reason and nothing is stored. Rewrite from a different angle; do not hill-climb the same idea.`,
  modes: "comment = top-level answer. reply = answer under ONE real stranger's comment (parent_url, and send thread_context.parent so the reviewer sees it). sharpen = you ran a small model to simulate the sub's reaction and used it as PRIVATE context; put it in `sharpen`, never in the body. Never file both sides of a conversation.",
};

async function getQueries(sp) {
  const parts = ["select=id,q,shape,source,volume,cpc,canonical,intent", "order=volume.desc.nullslast,id.asc",
                 `limit=${limitOf(sp)}`, `offset=${offsetOf(sp)}`];
  if (sp.get("q"))     parts.push(`q=ilike.*${enc(sp.get("q").replace(/[*,()]/g, " ").trim())}*`);
  if (sp.get("shape")) parts.push(`shape=eq.${enc(sp.get("shape"))}`);
  return { queries: await sb("GET", `queries?${parts.join("&")}`) };
}

async function getThreads(sp) {
  const source = sp.get("source") || "ranking";
  const lim = limitOf(sp);
  if (source === "engain") {
    const parts = ["select=*", "order=relevance.desc.nullslast,last_seen.desc", `limit=${lim}`, `offset=${offsetOf(sp)}`];
    if (sp.get("subreddit")) parts.push(`subreddit=eq.${enc(sp.get("subreddit"))}`);
    return { source, threads: await sb("GET", `opportunities?${parts.join("&")}`),
             note: "relevance and traffic_value are Engain's own model, not measured. est_monthly_clicks_model is modelled." };
  }
  if (source !== "ranking") bad(400, "source must be ranking or engain");
  const parts = ["select=*", "order=n_queries.desc,best_pos.asc.nullslast", `limit=${lim}`, `offset=${offsetOf(sp)}`];
  if (sp.get("subreddit")) parts.push(`subreddit=eq.${enc(sp.get("subreddit"))}`);
  if (sp.get("status"))    parts.push(`status=eq.${enc(sp.get("status"))}`);
  return { source, threads: await sb("GET", `targets?${parts.join("&")}`),
           note: "n_queries = how many buyer searches this one thread ranks for. That is the signal. best_pos is the best Google position seen." };
}

async function getThread(id) {
  id = threadId(id);
  if (!id) bad(400, "thread id required");
  const q = (path) => sb("GET", path);
  const [thread, target, opps, drafts, tasks, activity, queries] = await Promise.all([
    q(`threads?select=*&id=eq.${enc(id)}`),
    q(`targets?select=*&thread_id=eq.${enc(id)}`),
    q(`opportunities?select=*&thread_id=eq.${enc(id)}&order=last_seen.desc`),
    q(`drafts?select=id,kind,status,source,parent_url,title,body,reject_reason,upvotes_suggested,send_cleared_at,created_at,reviewed_at,posted_at&thread_id=eq.${enc(id)}&order=created_at.desc`),
    q(`engain_tasks?select=id,draft_id,task_type,status,reddit_url,credits_used,submitted_at,published_at,error&thread_id=eq.${enc(id)}&order=submitted_at.desc`),
    q(`thread_activity?select=*&thread_id=eq.${enc(id)}`),
    q(`observations?select=query_id,position,obs_date,approx&thread_id=eq.${enc(id)}&order=obs_date.desc&limit=100`),
  ]);
  if (!thread.length && !opps.length) bad(404, `thread ${id} is not known. POST /api/agent/threads to register it first.`);
  const ranks_for = [...new Set(queries.map(o => o.query_id))];
  const qrows = ranks_for.length ? await q(`queries?select=id,q,shape,volume&id=in.(${ranks_for.map(enc).join(",")})`) : [];
  return {
    thread: thread[0] || null,
    ranking: target[0] || null,
    ranks_for: qrows,
    engain: opps,
    drafts, tasks,
    stage: activity[0] || null,
    can_comment: thread[0] ? (thread[0].archived !== true && thread[0].locked !== true) : null,
  };
}

const commentId = u => { const m = String(u || "").match(/\/comments\/[A-Za-z0-9]+\/[^/?#]+\/([A-Za-z0-9]+)/); return m ? m[1].toLowerCase() : null; };
async function ourComments() {
  const rows = await sb("GET", "engain_tasks?select=id,thread_id,reddit_url,published_at&reddit_url=not.is.null&order=published_at.desc");
  return rows.map(r => ({ task: r.id, thread: r.thread_id, url: r.reddit_url, comment_id: commentId(r.reddit_url), published_at: r.published_at }));
}
async function isOurs(url) {
  const cid = commentId(url);
  if (!cid) return false;
  return (await ourComments()).some(c => c.comment_id === cid);
}

async function postThread(body) {
  const id = threadId(body.id || body.thread_id);
  if (!id || !/^[a-z0-9]{5,8}$/i.test(id)) bad(422, "id must be the Reddit post id (the 6-7 characters after /comments/), with or without t3_");
  if (!isRedditUrl(body.url)) bad(422, "url must be the full reddit.com permalink of the post");
  const row = { id, url: body.url, title: body.title || null, subreddit: (body.subreddit || "").replace(/^r\//, "") || null,
                score: Number.isInteger(body.score) ? body.score : null,
                num_comments: Number.isInteger(body.num_comments) ? body.num_comments : null };
  const [saved] = await sb("POST", "threads?on_conflict=id", [row], "resolution=merge-duplicates,return=representation");
  await log("thread_registered", { thread: id, subreddit: row.subreddit });
  return { thread: saved, note: "archived/locked are unknown until a screen runs (fetch-thread.py). A draft on an archived thread is blocked at post time." };
}

const DRAFT_COLS = "id,kind,mode,thread_id,parent_url,subreddit,title,strategy,format,body,body_original,status,source,agent_note," +
                   "upvotes_suggested,upvotes_reason,prompt_version,reject_reason,send_cleared_at,created_at,updated_at,reviewed_at,posted_at," +
                   "models,sharpen,redirect_pending,redirected_at,redirect_note,gate_failed_at,gate_failure,pullback_requested_at,parent_confirmed_by";

async function getDrafts(sp) {
  const parts = [`select=${DRAFT_COLS}`, "order=created_at.desc", `limit=${limitOf(sp)}`, `offset=${offsetOf(sp)}`];
  for (const k of ["status", "kind", "mode", "source", "thread_id"]) if (sp.get(k)) parts.push(`${k}=eq.${enc(sp.get(k))}`);
  if (sp.get("needs_agent") === "true") parts.push("redirect_pending=eq.true");
  return { drafts: await sb("GET", `drafts?${parts.join("&")}`),
           note: sp.get("needs_agent") === "true" ? "these were sent back by the reviewer (redirect_note says why, mode says how). PATCH a new body to deliver; approval is refused until you do." : undefined };
}

async function getDraft(id) {
  const [drafts, revisions, checks, tasks] = await Promise.all([
    sb("GET", `drafts?select=${DRAFT_COLS},thread_context&id=eq.${enc(id)}`),
    sb("GET", `draft_revisions?select=at,editor,action,body_before,body_after,note&draft_id=eq.${enc(id)}&order=at.asc`),
    sb("GET", `rule_checks?select=verdict,removal_risk,violated_rules,summary,checked_at&draft_id=eq.${enc(id)}&order=checked_at.desc`),
    sb("GET", `engain_tasks?select=id,task_type,status,reddit_url,credits_used,submitted_at,published_at,error,cancel_requested_at,cancelled_at,cancel_result&draft_id=eq.${enc(id)}`),
  ]);
  if (!drafts.length) bad(404, `draft ${id} not found`);
  return { draft: drafts[0], revisions, rule_checks: checks, tasks };
}

function shapeDraft(body) {
  const kind = String(body.kind || "comment").toLowerCase();
  if (!["comment", "reply", "post"].includes(kind)) bad(422, "kind must be comment, reply or post");
  const mode = String(body.mode || (kind === "reply" ? "reply" : "comment")).toLowerCase();
  if (!["comment", "reply", "sharpen"].includes(mode)) bad(422, "mode must be comment, reply or sharpen");
  if (kind === "post" && mode !== "comment") bad(422, "a post has no mode");
  if (kind === "reply" && mode === "comment") bad(422, "a reply's mode is reply (or sharpen)");
  if (kind === "comment" && mode === "reply") bad(422, "mode reply needs kind reply and a parent_url");
  const d = {
    kind, mode,
    thread_id: kind === "post" ? null : threadId(body.thread_id),
    parent_url: kind === "reply" ? String(body.parent_url || "").trim() : null,
    subreddit: kind === "post" ? String(body.subreddit || "").replace(/^r\//, "").trim() || null : null,
    title: kind === "post" ? String(body.title || "").trim() || null : null,
    body: String(body.body || ""),
  };
  if (kind !== "post" && !d.thread_id) bad(422, "thread_id is required for a comment or reply");
  if (kind === "reply" && !isRedditUrl(d.parent_url)) bad(422, "parent_url must be the reddit.com permalink of the comment you are answering");
  if (kind === "post" && (!d.subreddit || !d.title)) bad(422, "a post needs subreddit and title");
  if (kind === "post" && d.title.length > 300) bad(422, "Reddit titles are capped at 300 characters");
  return d;
}

function optional(body, out) {
  for (const k of ["models", "sharpen"]) if (body[k] !== undefined) {
    if (body[k] !== null && typeof body[k] !== "object") bad(422, `${k} must be an object`);
    out[k] = body[k];
  }
  if (body.upvotes_suggested !== undefined) {
    const n = parseInt(body.upvotes_suggested, 10);
    if (!Number.isInteger(n) || n < 0 || n > 7) bad(422, "upvotes_suggested must be 0 to 7. The cap is 3 to 7, dripped; bursts drew removals.");
    out.upvotes_suggested = n;
  }
  for (const k of ["upvotes_reason", "agent_note", "prompt_version"]) if (body[k] !== undefined) out[k] = body[k] === null ? null : String(body[k]);
  if (body.thread_context !== undefined) {
    if (body.thread_context !== null && typeof body.thread_context !== "object") bad(422, "thread_context must be an object");
    out.thread_context = body.thread_context;
  }
  return out;
}

async function postDraft(body) {
  const d = shapeDraft(body);
  let thread = null;
  if (d.thread_id) {
    const t = await sb("GET", `threads?select=id,archived,locked,subreddit&id=eq.${enc(d.thread_id)}`);
    if (!t.length) bad(422, `thread ${d.thread_id} is not registered. POST /api/agent/threads first so the reviewer sees what you saw.`);
    if (t[0].archived === true || t[0].locked === true) bad(409, `thread ${d.thread_id} is ${t[0].archived ? "archived" : "locked"}. Nothing can be posted there.`);
    thread = t[0];
  }
  if (d.kind === "reply" && await isOurs(d.parent_url)) {
    bad(422, "parent_url is one of OUR OWN published comments. A reply answers a real stranger, never our own account (02-RUNBOOK.md §0 rule 8). GET /api/agent/our-comments lists them.");
  }
  const verdict = check(d.body, { kind: d.kind });
  if (!verdict.ok) bad(422, "the draft breaks a hard rule. Fix and refile.", { verdict });
  // The door: Engain's own score, at or under the ceiling, or it is not filed.
  const sub = d.subreddit || (thread && thread.subreddit) || null;
  if (!sub) bad(422, "the thread has no subreddit on record, so the vendor rule-check cannot run. Register the thread with its subreddit.");
  const vc = await vendorCheck(d.body, d.kind, sub, d.title || (body.thread_context && body.thread_context.title) || "");
  const over = overCeiling(vc);
  if (over) bad(vc.unavailable ? 503 : 422, `not filed: ${over}`, { verdict, vendor: vc, next: vc.unavailable ? "retry in 60 seconds" : "rewrite from a different angle and refile. Read /lessons. Do not hill-climb the same idea." });
  verdict.vendor = vc;
  if (d.kind === "reply" && !(body.thread_context && body.thread_context.parent && body.thread_context.parent.body)) {
    verdict.warns.push("no thread_context.parent {author, body, score, permalink, created_utc}: the reviewer has to open Reddit to see whose comment this answers. Send it.");
  }
  if (d.mode === "sharpen" && !(body.sharpen && typeof body.sharpen === "object")) {
    verdict.warns.push("mode sharpen with no `sharpen` object: the reviewer cannot see what shaped the text. Send {model, at, simulation}.");
  }

  /* Persist the RESOLVED subreddit on every draft, not only on posts. It was
     null for comments and replies (the thread carried it instead), so every
     surface reading the draft alone printed "r/?". A row that is judged on its
     own must carry the facts it is judged by. */
  const row = optional(body, {
    ...d,
    subreddit: sub,
    body_original: d.body,
    status: "pending",
    source: "agent_api",
    prompt_version: body.prompt_version ? String(body.prompt_version) : "agent-api-v1",
  });
  const [saved] = await sb("POST", `drafts?select=${DRAFT_COLS}`, [row], "return=representation");
  await recordCheck(saved.id, sub, vc, "filed through the door");
  await log("draft_filed", { draft: saved.id, kind: d.kind, thread: d.thread_id, subreddit: sub, words: verdict.words, removal_risk: vc.removal_risk, verdict: vc.verdict });
  return { draft: saved, verdict, next: "A human reads it on /review. Poll GET /api/agent/drafts/" + saved.id + " or read /api/agent/lessons later." };
}

async function patchDraft(id, body) {
  const cur = (await sb("GET", `drafts?select=${DRAFT_COLS}&id=eq.${enc(id)}`))[0];
  if (!cur) bad(404, `draft ${id} not found`);
  if (cur.status !== "pending") bad(409, `draft is '${cur.status}': a human has already acted on it. File a new draft instead of rewriting history.`);
  // A draft the reviewer sent back (redirect_pending) is the agent's to
  // rewrite whoever filed it; otherwise only API-filed drafts are editable.
  if (cur.source !== "agent_api" && !cur.redirect_pending) bad(409, "this draft was not filed through the API. Only the reviewer edits it.");

  const patch = optional(body, {});
  if (body.body !== undefined) {
    const verdict = check(String(body.body), { kind: cur.kind });
    if (!verdict.ok) bad(422, "the revision breaks a hard rule.", { verdict });
    const t = cur.thread_id ? await sb("GET", `threads?select=subreddit&id=eq.${enc(cur.thread_id)}`) : [];
    const sub = cur.subreddit || (t[0] && t[0].subreddit) || null;
    if (!sub) bad(422, "no subreddit on record for the vendor rule-check");
    const vc = await vendorCheck(String(body.body), cur.kind, sub, cur.title || "");
    const over = overCeiling(vc);
    if (over) bad(vc.unavailable ? 503 : 422, `not accepted: ${over}`, { verdict, vendor: vc });
    verdict.vendor = vc; patch._vc = [sub, vc];
    patch.body = String(body.body); patch.body_original = patch.body; patch._verdict = verdict;
    if (cur.redirect_pending) patch.redirect_pending = false;   // delivered: approval opens again
  }
  if (cur.kind === "reply" && cur.redirect_pending && body.body !== undefined && cur.parent_url && await isOurs(cur.parent_url)) {
    bad(422, "this draft's parent is one of our own comments. Do not deliver a body; withdraw it.");
  }
  if (cur.kind === "post" && body.title !== undefined) {
    const t = String(body.title).trim(); if (!t || t.length > 300) bad(422, "title must be 1 to 300 characters");
    patch.title = t;
  }
  const verdict = patch._verdict; delete patch._verdict;
  const vcRec = patch._vc; delete patch._vc;
  if (!Object.keys(patch).length) bad(400, "nothing to change. Editable while pending: body, title (posts), upvotes_suggested, upvotes_reason, agent_note, thread_context, models, sharpen.");
  const [saved] = await sb("PATCH", `drafts?id=eq.${enc(id)}&select=${DRAFT_COLS}`, patch, "return=representation");
  if (vcRec) await recordCheck(id, vcRec[0], vcRec[1], "revised through the door");
  await log("draft_revised", { draft: id, fields: Object.keys(patch) });
  return { draft: saved, verdict: verdict || null };
}

async function withdrawDraft(id, body) {
  const cur = (await sb("GET", `drafts?select=id,status,source&id=eq.${enc(id)}`))[0];
  if (!cur) bad(404, `draft ${id} not found`);
  if (cur.status !== "pending") bad(409, `draft is '${cur.status}': only a pending draft can be withdrawn.`);
  const reason = "withdrawn by agent" + (body.reason ? ": " + String(body.reason).slice(0, 500) : "");
  const [saved] = await sb("PATCH", `drafts?id=eq.${enc(id)}&select=${DRAFT_COLS}`,
                           { status: "rejected", reject_reason: reason, reviewed_at: new Date().toISOString() }, "return=representation");
  await log("draft_withdrawn", { draft: id, reason });
  return { draft: saved };
}

async function getLessons(sp) {
  const lim = limitOf(sp);
  const [edits, rejections, revisions, redirects, gateFails] = await Promise.all([
    sb("GET", `edit_lessons?select=*&limit=${lim}`),
    sb("GET", `drafts?select=id,kind,mode,thread_id,subreddit,title,body,reject_reason,reviewed_at,source&status=eq.rejected&order=reviewed_at.desc.nullslast&limit=${lim}`),
    sb("GET", `draft_revisions?select=draft_id,at,editor,action,note&order=at.desc&limit=${lim}`),
    sb("GET", `drafts?select=id,kind,mode,thread_id,parent_url,redirect_note,redirected_at,body&redirect_pending=eq.true&order=redirected_at.desc&limit=${lim}`),
    sb("GET", `drafts?select=id,kind,thread_id,gate_failure,gate_failed_at&gate_failed_at=not.is.null&order=gate_failed_at.desc&limit=${lim}`),
  ]);
  return {
    edits, rejections, decisions: revisions, redirects, gate_refusals: gateFails,
    how_to_read: "edits: agent_wrote vs human_kept is the only record of the reviewer's judgement. rejections: reject_reason says why a draft died. redirects: the reviewer changed the mode and is waiting for a new body (PATCH it). gate_refusals: bodies the final check_draft.py refused at post time. Do not repeat what got cut.",
  };
}

async function getStatus(sp) {
  const parts = ["select=*", `limit=${limitOf(sp, 100)}`];
  if (sp.get("stage")) parts.push(`stage=eq.${enc(sp.get("stage"))}`);
  return { threads: await sb("GET", `thread_activity?${parts.join("&")}`),
           stages: "draft → approved → cleared → sent → published → upvotes → done, plus failed and removed. A thread is published when Engain hands back a reddit_url, never because we asked." };
}

// ── dispatcher ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  try {
    if (!SB_URL || !SB_KEY || !AGENT_KEY) {
      bad(503, "agent API is not configured: set AGENT_API_KEY, SUPABASE_URL and SUPABASE_SERVICE_KEY in the Vercel project's environment.");
    }
    if (!authed(req)) { res.setHeader("WWW-Authenticate", "Bearer"); bad(401, "missing or wrong bearer key"); }

    const url = new URL(req.url, "http://local");
    const seg = url.pathname.replace(/^\/api\/agent\/?/, "").split("/").filter(Boolean);
    const sp = url.searchParams;
    const m = req.method.toUpperCase();
    const [a, b, c] = seg;

    let out;
    if (seg.length === 0 && m === "GET")                       out = HELP;
    else if (a === "queries" && !b && m === "GET")             out = await getQueries(sp);
    else if (a === "threads" && !b && m === "GET")             out = await getThreads(sp);
    else if (a === "threads" && !b && m === "POST")            out = await postThread(await readBody(req));
    else if (a === "threads" && b && !c && m === "GET")        out = await getThread(b);
    else if (a === "drafts" && !b && m === "GET")              out = await getDrafts(sp);
    else if (a === "drafts" && !b && m === "POST")             out = await postDraft(await readBody(req));
    else if (a === "drafts" && b && !c && m === "GET")         out = await getDraft(b);
    else if (a === "drafts" && b && !c && m === "PATCH")       out = await patchDraft(b, await readBody(req));
    else if (a === "drafts" && b && c === "withdraw" && m === "POST") out = await withdrawDraft(b, await readBody(req));
    else if (a === "check" && !b && m === "POST") {
      const body = await readBody(req);
      const verdict = check(String(body.body || ""), { kind: body.kind || "comment" });
      // With a subreddit the dry-run also asks the vendor, so the agent sees
      // the same door verdict it will get on filing. Free, 5 per minute.
      if (verdict.ok && body.subreddit) { const vc = await vendorCheck(String(body.body || ""), body.kind || "comment", String(body.subreddit).replace(/^r\//, ""), body.title || ""); verdict.vendor = vc; verdict.refusal = overCeiling(vc); verdict.would_file = !verdict.refusal; }
      out = { verdict, ceiling: RISK_CEILING };
    }
    else if (a === "lessons" && !b && m === "GET")             out = await getLessons(sp);
    else if (a === "our-comments" && !b && m === "GET")        out = { comments: await ourComments(), note: "never file a reply whose parent_url is one of these. Never two of our accounts in one exchange." };
    else if (a === "status" && !b && m === "GET")              out = await getStatus(sp);
    else if (["approve", "clear", "send", "post", "publish", "upvote", "pullback", "cancel", "redirect"].includes(a) || ["approve", "clear", "pullback", "cancel", "redirect"].includes(c))
      bad(403, "not through this door. Approving, clearing to send, posting and upvoting are human and engain-post.py actions. See AGENT-API.md.");
    else bad(404, "no such route. GET /api/agent lists them.");

    send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    send(res, 500, { error: "unexpected failure", detail: String(e && e.message || e).slice(0, 300) });
  }
};
