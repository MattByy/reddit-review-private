/* api/cron/pullback.js — the kill switch's clock.
 *
 * A reviewer presses "Pull back" on /review; request_pullback() writes
 * engain_tasks.cancel_requested_at. Engain refuses cancels for the first 24
 * hours of a task's life (TASK_NOT_CANCELLABLE), so someone has to come back
 * at the 24h mark and fire it. engain-post.py watch does that when it is
 * running; this cron is the fallback that does not depend on a laptop being
 * awake. Vercel calls it hourly (vercel.json "crons").
 *
 * This function can ONLY cancel. It has no route to post, approve or clear,
 * and the vendor key it holds is used for exactly two calls: list tasks and
 * cancel one. It reports every outcome twice: in the JSON it returns and in
 * activity_log, so a silent cron is impossible.
 *
 * Env (Vercel project, production): CRON_SECRET (Vercel sets the header),
 * SUPABASE_URL, SUPABASE_SERVICE_KEY, and ENGAIN_API_KEY. Without the Engain
 * key it still runs, still reports what is waiting, and cancels nothing.
 */
const SB_URL  = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY || "";
const ENG_KEY = process.env.ENGAIN_API_KEY || "";
const ENG_URL = "https://api.engain.io";
const WINDOW_H = 24;
const ACTOR = "cron/pullback";

async function sb(method, path, body, prefer) {
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`supabase ${r.status} on ${method} ${path.split("?")[0]}: ${(await r.text()).slice(0, 300)}`);
  const text = await r.text();
  return text.trim() ? JSON.parse(text) : null;   // return=minimal answers 201/204 with an empty body
}
async function log(action, detail) {
  try { await sb("POST", "activity_log", [{ actor: ACTOR, action, detail }], "return=minimal"); } catch {}
}
async function engain(method, path, body, params) {
  const url = ENG_URL + path + (params ? "?" + new URLSearchParams(params) : "");
  const r = await fetch(url, { method, headers: { "X-API-Key": ENG_KEY, "Content-Type": "application/json", "User-Agent": "geonode-reddit-agent/1.0 (+cron)" },
                               body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; const text = await r.text();
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: r.status, json };
}

async function projectId() {
  if (process.env.ENGAIN_PROJECT_ID) return process.env.ENGAIN_PROJECT_ID;
  const { json } = await engain("GET", "/api/v1/me");
  const p = (json.projects || []).find(x => x.name === "geonode.com");
  if (!p) throw new Error("no geonode.com project on this key");
  return p.id;
}

async function cancelOne(t, live) {
  const now = new Date();
  const attempt = { cancel_attempts: (t.cancel_attempts || 0) + 1, last_cancel_attempt_at: now.toISOString() };
  const patch = (extra) => sb("PATCH", `engain_tasks?id=eq.${encodeURIComponent(t.id)}`, { ...attempt, ...extra }, "return=minimal");

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
    const waiting = await sb("GET", "engain_tasks?select=id,draft_id,thread_id,submitted_at,cancel_requested_at,cancel_attempts&cancel_requested_at=not.is.null&cancelled_at=is.null&reddit_url=is.null&order=submitted_at.asc");
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
    const pid = await projectId();
    const { json: listing } = await engain("GET", "/api/v1/tasks", undefined, { projectId: pid, numItems: 100 });
    const byId = new Map((listing.page || []).map(t => [t._id, t]));
    const results = [];
    for (const t of waiting) results.push({ task: t.id, thread: t.thread_id, ...(await cancelOne(t, byId.get(t.id))) });
    await log("pullback_cron", { waiting: waiting.length, results });
    return out(200, { ok: true, waiting: waiting.length, results });
  } catch (e) {
    await log("pullback_cron_error", { error: String(e.message).slice(0, 300) });
    return out(500, { error: String(e.message).slice(0, 300) });
  }
};
