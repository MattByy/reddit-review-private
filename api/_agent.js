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
 * The writer files and revises drafts. The automatic preparation and sender
 * perform publication checks. Operator endpoints support optional edits and stops.
 *
 * Auth: `Authorization: Bearer <AGENT_API_KEY>`, compared in constant time.
 * Data: the Supabase service key, server-side only. It never reaches a browser
 * and it is never echoed in a response.
 */
const crypto = require("crypto");
const { check } = require("./_rules.js");
const workflow = require('./_workflow.js');
const {request}=require('./_db.js');

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
    r = await request(`${SB_URL}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new HttpError(502, "database unreachable", { detail: String(e && e.cause && e.cause.message || e.message).slice(0, 200) });
  }
  if (!r.ok) {
    const text = await r.text();
    let detail;try{detail=JSON.parse(text);}catch{}
    if(['40001','23505'].includes(detail?.code))throw new HttpError(409,detail.message);
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

// One vendor verdict per attempt; rate limits return to the durable queue.
async function vendorCheckOnce(body, kind, subreddit, title, pid) {
  const r = await request(`${ENG_URL}/api/v1/rule-check`, { method: "POST",
    headers: { "X-API-Key": ENG_KEY, "Content-Type": "application/json", "User-Agent": "geonode-reddit-agent/1.0 (+api)" },
    body: JSON.stringify({ projectId: pid, subreddit, taskType: kind, content: body, mediaKind: "text", context: { postTitle: title || "" } }) });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 300) }; }
  if (!r.ok) return { unavailable: true, status: r.status, retryable: r.status === 429,
    why: r.status === 429 ? "vendor rule-check rate limit (5 per minute). Retry in 60 seconds." : `vendor ${r.status}: ${JSON.stringify(j).slice(0, 200)}` };
  return { verdict: j.verdict || "unavailable", removal_risk: j.removalRisk ?? null, marketing: j.marketingIntentRisk ?? null,
           summary: j.summary || "", violated_rules: j.violatedRules || [], ceiling: RISK_CEILING };
}

async function vendorCheck(body,kind,subreddit,title){
  if(!ENG_KEY)return {unavailable:true,status:0,why:'ENGAIN_API_KEY not configured'};
  try{
    const response=await request(`${ENG_URL}/api/v1/me`,{headers:{'X-API-Key':ENG_KEY}});
    if(!response.ok)return {unavailable:true,status:response.status,why:'Engain identity unavailable'};
    const me=await response.json();
    const pid=process.env.ENGAIN_PROJECT_ID||(me.projects||[]).find(p=>p.name==='geonode.com')?.id;
    if(!pid)return {skipped:true,verdict:'skipped',removal_risk:null,violated_rules:[],summary:'Engain rule-check unavailable: this key has no project. Automatic account, content and target checks still apply.'};
    return await vendorCheckOnce(body,kind,subreddit,title,pid);
  }catch(e){return {unavailable:true,status:0,why:String(e.message).slice(0,200)};}
}
/* The door's verdict on a vendor score. Refuses on `fail`, on a risk over
   the ceiling, and on no score at all (absence of evidence blocks). */
function overCeiling(vc) {
  if (vc.skipped) return null;
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
  docs: "README.md and skills/reddit-agent/SKILL.md in this repo",
  auth: "Authorization: Bearer <AGENT_API_KEY>",
  protocol_version: 5,
  routes: {
    "GET  /api/agent/experiments": "message queue, observed outcomes and full-history strategy/depth statistics",
    "GET  /api/agent/delivery": "available Engain delivery capability; no account setup required",
    "GET  /api/agent/messages/:id": "one experiment message and its delivery/visibility evidence",
    "POST /api/agent/messages/:id": "file this queue turn {agent,claim_token,reply_mode,content_action,action_override_reason?,body,rationale,draft_body?,humanization?}; atomically completes its writing job",
    "GET  /api/agent/bootstrap":           "start every agent session here: capabilities, unfinished work, recent outcomes, discovery queries and protocol",
    "POST /api/agent/jobs/claim":          "claim durable work {agent,limit}; returns a claim_token and fresh thread context",
    "POST /api/agent/jobs/:id/context":    "refresh a claimed job {agent,claim_token}",
    "POST /api/agent/jobs/:id/checkpoint": "save progress and renew the lease {agent,claim_token,checkpoint}",
    "POST /api/agent/threads/:id/context": "refresh thread context for discovery or draft revisions; optional {target_url}",
    "POST /api/agent/threads/:id/queue":   "start a message experiment {request_id: UUID, strategy?, max_messages?, max_depth?}; one active experiment per thread",
    "GET  /api/agent/outcomes":            "observed outcomes and exact supplied reasons; ?experiment=&group_by=topic|variant|subreddit",
    "GET  /api/agent/queries":              "the query map. ?q=term&shape=category|cost|blocked|alternative|unlimited&limit&offset",
    "GET  /api/agent/threads":              "threads worth commenting on. ?source=ranking|engain&subreddit=&status=&limit",
    "GET  /api/agent/threads/:id":          "one thread with everything known about it: ranking, Engain view, drafts, tasks, stage",
    "POST /api/agent/threads":              "register a thread you found yourself {id,url,title,subreddit,score,num_comments}",
    "GET  /api/agent/drafts":               "drafts. ?status=pending|approved|edited|rejected|posted&kind=comment|reply|post&mode=comment|reply|sharpen&thread_id=&needs_agent=true&limit",
    "GET  /api/agent/drafts/:id":           "one draft with its revisions, rule checks and vendor task",
    "POST /api/agent/drafts":               "legacy compatibility for an experiment job; use POST /messages/:id",
    "PATCH /api/agent/drafts/:id":          "revise a pending draft: yours, or one the reviewer sent back (needs_agent). {body,models,sharpen,...} clears redirect_pending",
    "POST /api/agent/drafts/:id/withdraw":  "pull a pending draft {reason}",
    "POST /api/agent/check":                "dry-run the copy rules AND the vendor rule-check on a body {body,kind,subreddit,title}. would_file says whether the door would take it",
    "GET  /api/agent/lessons":              "what the reviewer changed, rejected and sent back (redirects), and why. Read before writing.",
    "GET  /api/agent/our-comments":         "permalinks of our published comments; playbook jobs supply the exact one their assigned account must reply to.",
    "GET  /api/agent/status":               "current items and publication evidence. ?bucket=posted|review|planned|rejected|ignored",
    "GET  /api/agent/jobs/due":             "CLAIM what is due for you this hour. ?agent=<your name>&limit=5. Includes playbook write steps and separate reader follow-ups.",
    "POST /api/agent/jobs/:id/complete":    "finish {agent,claim_token,status:done|skipped|failed|blocked,result}; blocked may carry retry_after_minutes",
    "GET  /api/agent/playbooks":            "account-to-account playbooks; operators assign two accounts and start runs on Plan",
    "GET  /api/agent/accounts":             "our Engain accounts. All accounts are enabled. Active accounts that the provider reports as usable can post. Use the account's disclosure_line verbatim.",
    "GET  /api/agent/plan":                 "the planner: jobs and acts, due and blocked, next 48h",
    "GET  /api/agent/queue":                "everything queued, grouped by hour. ?hours=48",
    "GET  /api/agent/sequences":            "the sequences people built on /sequences (ordered steps: write, approve, send, wait_live, wait, check_replies, answer_replies, agent_task)",
    "GET  /api/agent/sequence-runs":        "runs and where each one is. ?status=open",
    "POST /api/agent/jobs":                 "queue a task for later {request_id,title, due_at | delay_minutes, thread_id?, target_url?, account_id?, payload?}. It comes back from /jobs/due when due.",
    "(drafts) send_after | delay_minutes":  "on POST /api/agent/drafts: queue the send. Automatic checks still apply; the server sends it no earlier than that time.",
  },
  not_here: "approve, clear-to-send, post, upvote and pull-back. The server automatically checks and sends eligible drafts; optional edits and stops are on /review.",
  disclosure: "every draft carries the account's disclosure_line, e.g. '(Geonode team here)'. A draft without it is refused. Playbooks assign different accounts to the opening comment and its reply.",
  door: `a draft is filed only if Engain's rule-check scores it at or under ${RISK_CEILING} of 100 and not 'fail'. Above that it is refused with the vendor's reason and an outcome event records the refusal. With no Engain project, scoring is explicitly skipped; the remaining publication checks still apply.`,
  modes: "comment = top-level answer. reply = answer under a specific comment, including the previous playbook account's comment (parent_url, and send thread_context.parent so the reviewer sees it). sharpen = you ran a small model to simulate the sub's reaction and used it as PRIVATE context; put it in `sharpen`, never in the body. For account-to-account conversations, file only the assigned playbook jobs; the engine resolves the published parent.",
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
  return await sb("POST", "rpc/is_our_url", { p_url: url });
}

async function postThread(body) {
  const id = threadId(body.id || body.thread_id);
  if (!id || !/^[a-z0-9]{5,8}$/i.test(id)) bad(422, "id must be the Reddit post id (the 6-7 characters after /comments/), with or without t3_");
  if (!isRedditUrl(body.url)) bad(422, "url must be the full reddit.com permalink of the post");
  let parsed; try { parsed = require('./_reddit.js').identity(body.url); } catch(e) { bad(422,e.message); }
  if(parsed.thread_id!==id||parsed.comment_id)bad(422,'URL must identify the registered thread, not a comment');
  const row = { id, url: body.url, title: body.title || null, subreddit: (body.subreddit || "").replace(/^r\//, "") || null,
                score: Number.isInteger(body.score) ? body.score : null,
                num_comments: Number.isInteger(body.num_comments) ? body.num_comments : null,
                discovery: {source:String(body.discovery?.source||'agent').slice(0,120),query:String(body.discovery?.query||'').slice(0,300),
                  intent_evidence:String(body.discovery?.intent_evidence||'').slice(0,2000),experiment:workflow.experiment(body.discovery?.experiment),registered_at:new Date().toISOString()} };
  const [saved] = await sb("POST", "threads?on_conflict=id", [row], "resolution=merge-duplicates,return=representation");
  await log("thread_registered", { thread: id, subreddit: row.subreddit });
  return { thread: saved, note: "Queueing and drafting fetch current Reddit context. Unknown or closed threads are held." };
}

const DRAFT_COLS = "id,kind,mode,thread_id,parent_url,subreddit,title,strategy,format,body,body_original,status,source,agent_note," +
                   "upvotes_suggested,upvotes_reason,prompt_version,reject_reason,send_cleared_at,created_at,updated_at,reviewed_at,posted_at," +
                   "models,sharpen,redirect_pending,redirected_at,redirect_note,gate_failed_at,gate_failure,pullback_requested_at,parent_confirmed_by,account_id,send_after,thread_context,filing_key,origin_job_id";

async function getDrafts(sp) {
  const parts = [`select=${DRAFT_COLS}`, "order=created_at.desc", `limit=${limitOf(sp)}`, `offset=${offsetOf(sp)}`];
  for (const k of ["status", "kind", "mode", "source", "thread_id"]) if (sp.get(k)) parts.push(`${k}=eq.${enc(sp.get(k))}`);
  if (sp.get("needs_agent") === "true") parts.push("redirect_pending=eq.true");
  return { drafts: await sb("GET", `drafts?${parts.join("&")}`),
           note: sp.get("needs_agent") === "true" ? "these were sent back by the reviewer (redirect_note says why, mode says how). PATCH a new body to deliver; approval is refused until you do." : undefined };
}

async function getDraft(id) {
  const [drafts, revisions, checks, tasks] = await Promise.all([
    sb("GET", `drafts?select=${DRAFT_COLS}&id=eq.${enc(id)}`),
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
  if (body.upvotes_suggested !== undefined && Number(body.upvotes_suggested) > 0)
    bad(422, "no upvote orders. A disclosed comment earns its votes or it does not.");
  if (body.account_id !== undefined) out.account_id = body.account_id === null ? null : String(body.account_id);
  const at = whenOf(body);
  if (at !== undefined) out.send_after = at;
  for (const k of ["upvotes_reason", "agent_note", "prompt_version"]) if (body[k] !== undefined) out[k] = body[k] === null ? null : String(body[k]);
  if (body.thread_context !== undefined) {
    if (body.thread_context !== null && typeof body.thread_context !== "object") bad(422, "thread_context must be an object");
    out.thread_context = body.thread_context;
  }
  return out;
}

async function postDraft(body) {
  const filingKey=body.job_id?`job:${body.job_id}`:body.request_id?`request:${String(body.request_id).slice(0,150)}`:null;
  if(!filingKey)bad(422,'job_id or a stable request_id is required for retry-safe filing');
  const [already]=await sb('GET',`drafts?select=*&filing_key=eq.${enc(filingKey)}&limit=1`);
  if(already){
    if(already.body!==body.body||already.kind!==(body.kind||'comment')||['thread_id','account_id','parent_url','title','subreddit'].some(k=>body[k]!==undefined&&body[k]!==already[k]))bad(409,'This filing key was used for different content');
    return {draft:already,replayed:true,next:'The draft already exists. Do not file another copy.'};
  }
  // A draft written for a job takes the job's account, and a sequence write is
  // HELD until its run reaches the Send step (029).
  let forJob = null;
  if (body.job_id) {
    const [j] = await sb("GET", `jobs?select=*&id=eq.${enc(body.job_id)}`);
    if (!j) bad(404, `job ${body.job_id} not found`);
    if (!["write", "draft_followup"].includes(j.kind)) bad(422, "only write and draft_followup jobs take a draft");
    if(j.kind==='draft_followup'&&body.kind!=='reply')bad(422,'A follow-up job requires kind reply to its reader parent');
    await workflow.ownedJob(j.id,String(body.agent||''),body.claim_token);
    if (j.kind === "write" && j.payload && j.payload.kind && String(body.kind || "comment") !== j.payload.kind)
      bad(422, `this step asks for a ${j.payload.kind}`);
    forJob = j;
    if(body.thread_id&&j.thread_id&&body.thread_id!==j.thread_id)bad(409,'Draft thread differs from claimed job');
    if(body.parent_url&&j.target_url&&(j.kind==='draft_followup'||j.payload?.kind==='reply')&&body.parent_url!==j.target_url)bad(409,'Draft parent differs from claimed job');
    if (j.account_id) body.account_id = j.account_id;
    if (j.thread_id && !body.thread_id) body.thread_id = j.thread_id;
    if (j.kind === "draft_followup" && !body.parent_url) body.parent_url = j.target_url;
    if (j.kind === "write" && j.payload && j.payload.kind === "reply" && !body.parent_url) body.parent_url = j.target_url;
    if (j.kind === "write" && j.payload && j.payload.kind === "post") {
      if (!body.subreddit) body.subreddit = j.payload.subreddit;
      if (!body.title && j.payload.title) body.title = j.payload.title;
    }
  }
  const d = shapeDraft(body);
  const account = body.account_id ? await eligibleAccount(body.account_id) : null;
  let thread = null;
  if (d.thread_id) {
    const t = await sb("GET", `threads?select=id,archived,locked,subreddit&id=eq.${enc(d.thread_id)}`);
    if (!t.length) bad(422, `thread ${d.thread_id} is not registered. POST /api/agent/threads first so the reviewer sees what you saw.`);
    if (t[0].archived === true || t[0].locked === true) bad(409, `thread ${d.thread_id} is ${t[0].archived ? "archived" : "locked"}. Nothing can be posted there.`);
    thread = t[0];
    const observed=await workflow.context(d.thread_id,d.kind==='reply'?d.parent_url:null);
    if(!observed.observation.ok||observed.observation.visibility!=='visible')bad(409,'Current Reddit context is unavailable',{context:observed});
    if(observed.observation.thread.locked||observed.observation.thread.archived||observed.observation.thread.removed)bad(409,'Thread is locked, archived or removed');
    if(d.kind==='reply'){
      const parent=observed.observation.target;
      if(!parent||!body.thread_context?.parent?.body)bad(422,'Replies require the observed parent body in thread_context.parent');
      if(body.thread_context.parent.body!==parent.body)bad(409,'Parent changed. Read the fresh job context before drafting',{context:observed});
    }
    body.thread_context={...body.thread_context,version:observed.version,observed_at:observed.observation.observed_at,
      title:observed.observation.thread.title,url:observed.thread.url,subreddit:observed.observation.thread.subreddit,
      parent:observed.observation.target||null,thread:observed.observation.thread,
      experiment:workflow.experiment(body.thread_context?.experiment||forJob?.payload?.experiment)};
  }
  const play = await workflow.playbookContext(forJob?.id,body.account_id,d.parent_url);
  if (play.playbook && !play.ready) bad(422,play.reason);
  if (d.kind === "reply" && await isOurs(d.parent_url) && !play.self_reply) {
    bad(422, "Replies to our comments require a playbook job assigning a different account to the preceding published comment.");
  }
  const verdict = check(d.body, { kind: d.kind, ...(account ? { disclosure_line: account.disclosure_line } : {}) });
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
    sequence_hold: !!(forJob && forJob.kind === "write" && forJob.sequence_run_id),
    subreddit: sub,
    body_original: d.body,
    status: "pending",
    source: "agent_api",
    prompt_version: body.prompt_version ? String(body.prompt_version) : "agent-api-v1",
  });
  const saved=await sb('POST','rpc/file_agent_draft',{p_row:row,p_key:filingKey,p_job_id:forJob?.id||null,p_agent:String(body.agent||'agent-api'),p_token:body.claim_token||null});
  await recordCheck(saved.id, sub, vc, "filed through the door");
  await log("draft_filed", { draft: saved.id, kind: d.kind, thread: d.thread_id, subreddit: sub, words: verdict.words, removal_risk: vc.removal_risk, verdict: vc.verdict, job: forJob && forJob.id });
  return { draft: saved, verdict, next: "Automatic checks queue eligible drafts for sending. Optional edits are on /review. Poll GET /api/agent/drafts/" + saved.id + " or read /api/agent/lessons later." };
}

async function patchDraft(id, body) {
  const cur = (await sb("GET", `drafts?select=${DRAFT_COLS}&id=eq.${enc(id)}`))[0];
  if (!cur) bad(404, `draft ${id} not found`);
  if (cur.status !== "pending") bad(409, `draft is '${cur.status}': it has already advanced beyond drafting. File a new draft instead of rewriting history.`);
  const context = await sb("POST", "rpc/scenario_context", { p_draft_id: id, p_parent_url: cur.parent_url || null });
  const play = await workflow.playbookContext(cur.origin_job_id,body.account_id || cur.account_id,cur.parent_url);
  if (play.playbook && !play.ready) bad(422,play.reason);
  // Existing pending scenario drafts are filed by roleplay.py, not this API.
  // Permit their revision only with a real DB association; caller flags do
  // not grant access to the scenario exemption or create a second draft.
  if (cur.source !== "agent_api" && !cur.redirect_pending && !context.scenario)
    bad(409, "this draft was not filed through the API. Only the reviewer edits it.");
  if (context.scenario && !context.allowed) bad(422, "scenario is disabled or uses multiple accounts in one thread");
  if (cur.kind === "reply" && cur.parent_url && await isOurs(cur.parent_url) && !context.self_reply && !play.self_reply)
    bad(422, "parent is ours but is not this act's sanctioned scenario dependency");
  const patch = optional(body, {});
  if(cur.thread_id && (body.body!==undefined||body.thread_context!==undefined)){
    const latest=await workflow.context(cur.thread_id,cur.kind==='reply'?cur.parent_url:null),o=latest.observation;
    if(!o.ok||o.visibility!=='visible'||o.thread.locked||o.thread.archived||o.thread.removed)bad(409,'Fresh Reddit context unavailable or closed');
    if(cur.kind==='reply'&&body.thread_context?.parent?.body!==o.target?.body)bad(409,'Read the current parent and include it in thread_context.parent');
    patch.thread_context={...cur.thread_context,...body.thread_context,version:latest.version,observed_at:o.observed_at,parent:o.target,
      thread:o.thread,title:o.thread.title,url:latest.thread.url,subreddit:o.thread.subreddit};
  }
  if (body.body !== undefined) {
    const acctId = body.account_id || cur.account_id;
    const account = acctId ? await eligibleAccount(acctId) : null;
    const verdict = check(String(body.body), { kind: cur.kind, ...(account ? { disclosure_line: account.disclosure_line } : {}) });
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
  if (cur.kind === "reply" && cur.redirect_pending && body.body !== undefined && cur.parent_url && await isOurs(cur.parent_url) && !context.self_reply && !play.self_reply) {
    bad(422, "this draft's parent is one of our own comments. Do not deliver a body; withdraw it.");
  }
  if (cur.kind === "post" && body.title !== undefined) {
    const t = String(body.title).trim(); if (!t || t.length > 300) bad(422, "title must be 1 to 300 characters");
    patch.title = t;
  }
  const verdict = patch._verdict; delete patch._verdict;
  const vcRec = patch._vc; delete patch._vc;
  if (!Object.keys(patch).length) bad(400, "nothing to change. Editable while pending: body, title (posts), upvotes_suggested, upvotes_reason, agent_note, thread_context, models, sharpen.");
  const [saved] = await sb("PATCH", `drafts?id=eq.${enc(id)}&status=eq.pending&select=${DRAFT_COLS}`, patch, "return=representation");
  if(!saved)bad(409,'Draft was reviewed while you were revising it');
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
  const bucket=sp.get('bucket');
  if(bucket&&!['posted','review','planned','rejected','ignored'].includes(bucket))bad(422,'Unknown status bucket');
  const items=await sb('GET',`status_items?select=*&order=at.desc.nullslast&limit=${limitOf(sp,100)}${bucket?'&bucket=eq.'+enc(bucket):''}`);
  const ids=[...new Set(items.map(i=>i.task_id).filter(Boolean))];
  const tasks=ids.length?await sb('GET',`engain_tasks?select=id,status,visibility,error,parent_fullname,reply_depth,verified_at,observed_at&id=in.(${ids.map(enc).join(',')})`):[];
  const byId=new Map(tasks.map(t=>[t.id,t]));
  return {items:items.map(i=>({...i,publication:byId.get(i.task_id)||null})),
    stages:'Review → submitted → verified visible on Reddit. Vendor state, parent, depth and visibility are separate fields.'};
}

// ── planner (027) and queue (028) ───────────────────────────────────────────
// A time in the queue: {send_after|due_at: ISO} or {delay_minutes: n}. Up to 14 days out.
function whenOf(body, keys = ["send_after", "due_at"]) {
  let t;
  for (const k of keys) if (body[k] !== undefined && body[k] !== null) t = new Date(body[k]);
  if (body.delay_minutes !== undefined && body.delay_minutes !== null) {
    const m = Number(body.delay_minutes);
    if (!Number.isFinite(m) || m < 0) bad(422, "delay_minutes must be a number of minutes, 0 or more");
    t = new Date(Date.now() + m * 60000);
  }
  if (t === undefined) return undefined;
  if (isNaN(t)) bad(422, "send_after / due_at must be an ISO timestamp");
  if (t.getTime() > Date.now() + 14 * 86400e3) bad(422, "the queue holds at most 14 days ahead");
  return t.toISOString();
}

async function postJob(body) {
  const title = String(body.title || "").trim();
  if (!title) bad(422, "a queued task needs a title: what should happen when it comes due");
  if(!body.request_id)bad(422,'A stable request_id is required when queueing a task');
  const due = whenOf(body, ["due_at"]) || new Date().toISOString();
  const row = { kind: "agent_task", title: title.slice(0, 300), due_at: due, created_by: String(body.agent || "agent-api").slice(0, 60),
    thread_id: body.thread_id ? threadId(body.thread_id) : null, target_url: body.target_url ? String(body.target_url) : null,
    account_id: body.account_id ? String(body.account_id) : null,
    payload: body.payload && typeof body.payload === "object" ? body.payload : {},dedupe_key:`agent-task:${String(body.request_id).slice(0,150)}` };
  const rows=await sb('POST','jobs?on_conflict=dedupe_key',[row],'resolution=ignore-duplicates,return=representation');
  const [job]=rows.length?rows:await sb('GET',`jobs?select=*&dedupe_key=eq.${enc(row.dedupe_key)}`);
  await log("job_queued", { job: job.id, title, due_at: due });
  return { job, next: `It shows on /plan and comes back from GET /api/agent/jobs/due at ${due}.` };
}

async function getQueue(sp) {
  const hours = Math.min(Number(sp.get("hours")) || 48, 24 * 14);
  const until = new Date(Date.now() + hours * 3600e3).toISOString();
  const rows = await sb("GET", `plan_timeline?select=*&status=in.(planned,claimed,due,pending,edited,approved,dispatched,blocked)&or=(due_at.is.null,due_at.lte.${enc(until)})&order=due_at.asc.nullsfirst&limit=500`);
  const byHour = {};
  for (const r of rows) { const h = r.due_at ? r.due_at.slice(0, 13) + ":00Z" : "unscheduled"; (byHour[h] = byHour[h] || []).push(r); }
  return { hours, queue: byHour, count: rows.length };
}

async function eligibleAccount(id) {
  const [a] = await sb("GET", `accounts?select=*&id=eq.${enc(id)}`);
  if (!a) bad(422, `account ${id} is not in the accounts table. GET /api/agent/accounts lists them.`);
  if (a.usable !== true) bad(422, "This account is not currently usable at Engain");
  if (!a.active) bad(422, `account ${a.label || id} is inactive`);
  if (!a.approved) bad(422, `account ${a.label || id} is disabled`);
  return a;
}

async function getAccounts() {
  const rows = await sb("GET", "accounts?select=id,label,reddit_username,niche,lifecycle,usable,approved,disclosed,disclosure_line,active&order=label.asc");
  return { accounts: rows.map(a => ({ ...a, can_post: !!(a.approved && a.active && a.usable === true) })),
           note: "only can_post accounts may be used. Put disclosure_line in every body, verbatim." };
}

async function getPlaybooks() {
  return { playbooks: await sb("GET", "sequences?select=id,name,description,steps&enabled=eq.true&playbook=eq.true&order=name.asc"),
    note: "Account A comments first; after verified publication and the configured delay, account B replies to that comment. Start runs on Plan, then claim each write job. Reader reply monitoring is separate." };
}

async function getJobsDue(sp) {
  return workflow.claim({agent:sp.get('agent'),limit:sp.get('limit'),kinds:sp.get('kinds')?.split(',')});
}

async function completeJob(id, body) {
  const status = String(body.status || "");
  if (!["done", "skipped", "failed", "blocked"].includes(status)) bad(422, "status must be done, skipped, failed or blocked");
  const result = body.result && typeof body.result === "object" ? body.result : { note: body.note || null };
  const job = await sb("POST", "rpc/complete_job", { p_id: id, p_agent: String(body.agent || "agent-api"), p_status: status, p_result: result, p_draft_id: body.draft_id || null, p_token: body.claim_token || null, p_retry_minutes: body.retry_after_minutes ?? null });
  return { job };
}

async function getPlan(sp) {
  const parts = ["select=*", "order=due_at.asc.nullslast", `limit=${limitOf(sp)}`];
  if (sp.get("status")) parts.push(`status=eq.${enc(sp.get("status"))}`);
  return { plan: await sb("GET", `plan_timeline?${parts.join("&")}`) };
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
    else if (a === "bootstrap" && !b && m === "GET")          out = await workflow.bootstrap();
    else if (a === 'messages' && b && m === 'GET') out = {message:await require('./_messages.js').getMessage(b)};
    else if (a === 'messages' && b && m === 'POST') out = {message:await require('./_messages.js').file(b,await readBody(req))};
    else if (a === 'experiments' && !b && m === 'GET') out = await require('./_messages.js').rows();
    else if (a === 'delivery' && !b && m === 'GET') {
      const caps=await require('./_delivery.js').capabilities();out={available:caps.available,mode:caps.mode,has_project:!!caps.project_id,available_private_accounts:caps.accounts.length,reason:caps.reason};
    }
    else if (a === "outcomes" && !b && m === "GET")           out = await workflow.outcomes(sp);
    else if (a === "threads" && b && c === "queue" && m === "POST") out = await workflow.queueThread(b,await readBody(req));
    else if (a === "threads" && b && c === "context" && m === "POST") out = await workflow.context(b,(await readBody(req)).target_url);
    else if (a === "threads" && b && !c && m === "GET")        out = await getThread(b);
    else if (a === "drafts" && !b && m === "GET")              out = await getDrafts(sp);
    else if (a === "drafts" && !b && m === "POST") {
      const body=await readBody(req);
      if(await require('./_messages.js').enabled()){
        const [j]=body.job_id?await sb('GET','jobs?select=payload&id=eq.'+enc(body.job_id)):[];
        if(!j?.payload?.message_id)bad(410,'Queue a message experiment, claim its job, and file through /messages/:id.');
        out={message:await require('./_messages.js').file(j.payload.message_id,body)};
      }else try{out=await postDraft(body);}catch(e){await workflow.recordRefusal(body,e).catch(()=>{});throw e;}
    }
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
    else if (a === "our-comments" && !b && m === "GET")        out = { comments: await ourComments(), note: "Playbook write jobs assign another account to reply to the preceding verified comment. Use the job’s target_url." };
    else if (a === "status" && !b && m === "GET")              out = await getStatus(sp);
    else if (a === "jobs" && b === "due" && m === "GET")       out = await getJobsDue(sp);
    else if (a === "jobs" && b === "claim" && m === "POST")   out = await workflow.claim(await readBody(req));
    else if (a === "jobs" && b && c === "context" && m === "POST") {
      const body=await readBody(req);out=await workflow.jobContext(await workflow.ownedJob(b,body.agent,body.claim_token));
    }
    else if (a === "jobs" && b && c === "checkpoint" && m === "POST") {
      const body=await readBody(req);out={job:await sb('POST','rpc/checkpoint_job',{p_id:b,p_agent:body.agent,p_token:body.claim_token,p_checkpoint:body.checkpoint||{}})};
    }
    else if (a === "jobs" && !b && m === "POST")               out = await postJob(await readBody(req));
    else if (a === "queue" && !b && m === "GET")               out = await getQueue(sp);
    else if (a === "sequences" && !b && m === "GET")           out = { sequences: await sb("GET", "sequences?select=id,name,description,steps,enabled&enabled=eq.true&order=name.asc") };
    else if (a === 'sequences' && b && c === 'runs' && m === 'POST') bad(410,'Start sequences through the operator UI. Agents should claim queued jobs.');
    else if (a === "sequence-runs" && !b && m === "GET")       out = { runs: await sb("GET", `sequence_runs?select=*&order=created_at.desc&limit=${limitOf(sp)}${sp.get("status") ? "&status=eq." + enc(sp.get("status")) : ""}`) };
    else if (a === "jobs" && b && c === "complete" && m === "POST") out = await completeJob(b, await readBody(req));
    else if (a === "playbooks" && !b && m === "GET")           out = await getPlaybooks();
    else if (a === "accounts" && !b && m === "GET")            out = await getAccounts();
    else if (a === 'runs' && !b && m === 'POST') bad(410,'Use thread registration, threads/:id/queue and leased jobs. Existing runs remain readable.');
    else if (a === "plan" && !b && m === "GET")                out = await getPlan(sp);
    else if (["approve", "clear", "send", "post", "publish", "upvote", "pullback", "cancel", "redirect"].includes(a) || ["approve", "clear", "pullback", "cancel", "redirect"].includes(c))
      bad(403, "not through this door. The server performs automatic checks and sends eligible drafts. No upvotes.");
    else bad(404, "no such route. GET /api/agent lists them.");

    send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
    if(e.status&&e.status>=400&&e.status<500)return send(res,e.status,{error:e.message,...e.extra});
    console.error(e);
    send(res, 500, { error: "unexpected failure", detail: String(e && e.message || e).slice(0, 300) });
  }
};
