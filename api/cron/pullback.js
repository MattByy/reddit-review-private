/* Hourly cancellation worker. Accounts-beta uses its comments/posts endpoint;
 * legacy project tasks retain their original cancellation window. A successful
 * request without explicit confirmation remains pending for status polling.
 */
const SB_URL  = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY || "";
const ENG_KEY = process.env.ENGAIN_API_KEY || "";
const WINDOW_H = 24;
const ACTOR = "cron/pullback";

const {sb,engain,logger}=require('../_db.js');
const log=logger(ACTOR);

async function projectId() {
  if (process.env.ENGAIN_PROJECT_ID) return process.env.ENGAIN_PROJECT_ID;
  const { json } = await engain("GET", "/api/v1/me");
  const p = json.projects?.length === 1 ? json.projects[0] : null;
  if (!p) throw new Error("set ENGAIN_PROJECT_ID when the vendor key does not have exactly one project");
  return p.id;
}

async function cancelOne(t, live) {
  const now = new Date();
  const attempt = { cancel_attempts: (t.cancel_attempts || 0) + 1, last_cancel_attempt_at: now.toISOString() };
  const patch = (extra) => sb("PATCH", `engain_tasks?id=eq.${encodeURIComponent(t.id)}`, { ...attempt, ...extra }, "return=minimal");

  // accounts-beta (027: the only send path) cancels directly, with no 24h window.
  if (t.project_id === "accounts-beta") {
    if (live && (live.resultUrl || live.redditUrl)) {
      const m = `already live: ${live.resultUrl || live.redditUrl}`;
      await patch({ cancel_result: m, status: live.status });
      await log("pullback_failed_live", { task: t.id, thread: t.thread_id });
      return { outcome: "live", message: m };
    }
    const { status, json } = await engain("POST", `/api/v1/accounts-beta/${t.task_type==="post"?"posts":"comments"}/${encodeURIComponent(t.id)}/cancel`, null);
    if (status >= 200 && status < 300 && json.success!==false) {
      if(!['cancelled','canceled'].includes(String(json.status||'').toLowerCase())){
        await patch({cancel_result:'Cancellation requested; waiting for vendor confirmation'});
        return {outcome:'requested',message:'Awaiting confirmed vendor cancellation'};
      }
      await patch({ cancel_result: "cancelled", cancelled_at: now.toISOString(), status: "cancelled" });
      await sb("PATCH", `eval_log?task_id=eq.${encodeURIComponent(t.id)}`, { survival_status: "cancelled", survival_checked_at: now.toISOString(), note: "pulled back before publish (cron)" }, "return=minimal");
      if (t.draft_id) {
        try { await sb("POST", "rpc/review_draft", { p_draft_id: t.draft_id, p_action: "reject", p_body: null, p_note: `pulled back at Engain (${t.id}) by cron`, p_editor: ACTOR }); }
        catch (e) { await log("pullback_draft_not_retired", { task: t.id, error: String(e.message).slice(0, 200) }); }
      }
      await log("pullback_cancelled", { task: t.id, thread: t.thread_id, draft: t.draft_id, vendor: json });
      return { outcome: "cancelled", message: "cancelled" };
    }
    const m = `vendor ${status}: ${JSON.stringify(json).slice(0, 300)}`;
    await patch({ cancel_result: m });
    await log("pullback_refused", { task: t.id, thread: t.thread_id, status, vendor: json });
    return { outcome: "refused", message: m };
  }

  if (!live) { const m = "task not in the vendor's last 100 tasks"; await patch({ cancel_result: m }); return { outcome: "gone", message: m }; }
  if (live.redditUrl || live.publishedAt) {
    const m = `already live: ${live.redditUrl}`;
    await patch({ cancel_result: m, reddit_url: live.redditUrl, published_at: live.publishedAt, status: live.status });
    await log("pullback_failed_live", { task: t.id, thread: t.thread_id, url: live.redditUrl });
    return { outcome: "live", message: m };
  }
  if (live.status === "cancelled") {
    const m = "cancelled: vendor already shows the task cancelled";
    await patch({ cancel_result: m, cancelled_at: now.toISOString(), status: "cancelled" });
    return { outcome: "cancelled", message: m };
  }
  const opens = new Date(new Date(t.submitted_at).getTime() + WINDOW_H * 3600 * 1000);
  if (now < opens) {
    const m = `not cancellable yet (window opens ${opens.toISOString().slice(0, 16).replace("T", " ")} UTC)`;
    await patch({ cancel_result: m, status: live.status });
    return { outcome: "not_yet", message: m, window_opens: opens.toISOString() };
  }
  const { status, json } = await engain("POST", `/api/v1/tasks/${encodeURIComponent(t.id)}/cancel`, null);
  if (status >= 200 && status < 300 && (json.success !== false)) {
    const m = `cancelled: ${json.message || ""}`.trim();
    await patch({ cancel_result: m, cancelled_at: now.toISOString(), status: "cancelled" });
    await sb("PATCH", `eval_log?task_id=eq.${encodeURIComponent(t.id)}`,
             { survival_status: "cancelled", survival_checked_at: now.toISOString(), note: "pulled back before publish (cron)" }, "return=minimal");
    if (t.draft_id) {
      try { await sb("POST", "rpc/review_draft", { p_draft_id: t.draft_id, p_action: "reject", p_body: null, p_note: `pulled back at Engain (${t.id}) by cron`, p_editor: ACTOR }); }
      catch (e) { await log("pullback_draft_not_retired", { task: t.id, error: String(e.message).slice(0, 200) }); }
    }
    await log("pullback_cancelled", { task: t.id, thread: t.thread_id, draft: t.draft_id, vendor: json });
    return { outcome: "cancelled", message: m };
  }
  const body = JSON.stringify(json).slice(0, 300);
  const m = body.includes("TASK_NOT_CANCELLABLE") ? `not cancellable yet per vendor (${status}). ${body}` : `vendor ${status}: ${body}`;
  await patch({ cancel_result: m });
  await log("pullback_refused", { task: t.id, thread: t.thread_id, status, vendor: json });
  return { outcome: "refused", message: m };
}

module.exports = async function handler(req, res) {
  const out = (status, obj) => { res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.statusCode = status; res.end(JSON.stringify(obj, null, 2)); };
  // Vercel sends Authorization: Bearer <CRON_SECRET> on scheduled runs. A
  // manual call must carry the same header. No secret configured = refuse.
  const secret = process.env.CRON_SECRET || "";
  const auth = String(req.headers.authorization || "");
  if (!secret || auth !== `Bearer ${secret}`) return out(401, { error: "cron secret missing or wrong" });
  if (!SB_URL || !SB_KEY) return out(503, { error: "SUPABASE_URL / SUPABASE_SERVICE_KEY not configured" });

  try {
    const waiting = await sb("GET", "engain_tasks?select=id,draft_id,thread_id,project_id,task_type,submitted_at,cancel_requested_at,cancel_attempts&cancel_requested_at=not.is.null&cancelled_at=is.null&reddit_url=is.null&order=last_cancel_attempt_at.asc.nullsfirst&limit=10");
    if (!waiting.length) {
      await log("pullback_cron", { waiting: 0, note: "nothing requested" });
      return out(200, { ok: true, waiting: 0, results: [], note: "no pull-back requests waiting: none requested, or all already cancelled or live" });
    }
    if (!ENG_KEY) {
      const results = waiting.map(t => ({ task: t.id, thread: t.thread_id, outcome: "no_vendor_key",
        window_opens: new Date(new Date(t.submitted_at).getTime() + WINDOW_H * 3600 * 1000).toISOString() }));
      await log("pullback_cron_no_key", { waiting: waiting.length, tasks: waiting.map(t => t.id) });
      return out(200, { ok: false, waiting: waiting.length, results,
        note: "ENGAIN_API_KEY is not set on this Vercel project, so the cron can report but not cancel. Run `engain-post.py pullback` where the key lives, or add the key (cancel-only function)." });
    }
    const byId = new Map();
    if (waiting.some(t => t.project_id === "accounts-beta")) {
      for(const kind of ['comments','posts']){
        const {status,json}=await engain('GET','/api/v1/accounts-beta/'+kind);
        if(status>=300)continue;
        for(const c of json.page||[])byId.set(c._id,c);
      }
    }
    if (waiting.some(t => t.project_id !== "accounts-beta")) {
      const pid = await projectId().catch(() => null);
      if (pid) { const { json: listing } = await engain("GET", "/api/v1/tasks", undefined, { projectId: pid, numItems: 100 });
                 for (const t of listing.page || []) byId.set(t._id, t); }
    }
    const results = [];
    const deadline=Date.now()+30000;
    for(const t of waiting){
      if(Date.now()>=deadline)break;
      try{results.push({task:t.id,thread:t.thread_id,...await cancelOne(t,byId.get(t.id))});}
      catch(e){results.push({task:t.id,outcome:'error',message:e.message});}
    }
    await log("pullback_cron", { waiting: waiting.length, results });
    return out(200, { ok: true, waiting: waiting.length, results });
  } catch (e) {
    await log("pullback_cron_error", { error: String(e.message).slice(0, 300) });
    return out(500, { error: String(e.message).slice(0, 300) });
  }
};
