/* app.js — the shell every page shares: the stepper nav, the Supabase reader,
   and the few formatters that keep pages from each inventing their own.

   The nav IS the workflow, in order. Each step is a page that answers one
   question (02-RUNBOOK.md §2). Pages that are not a step in the loop (History)
   sit to the right, muted. Counts on the steps are live: the number of things
   waiting on a human, never a vanity total. */

const STEPS = [
  ["queries.html", 1, "Queries", "Q"],
  ["targets.html", 2, "Targets", "T"],
  ["topics.html",  3, "Topics",  "TP"],
  ["review.html",  4, "Review",  "R"],
  ["status.html",  5, "Status",  "S"],
  ["audit.html",   6, "Audit",   "A"]
];

/* The funnel a thread walks through, in order. thread_activity.stage is the
   single source (supabase/migrations/007). Keep this list in the view's order. */
const STAGES = [
  ["draft_pending_review",       "draft",     "waiting for review"],
  ["approved_not_cleared",       "approved",  "approved, not cleared to send"],
  ["cleared_not_sent",           "cleared",   "cleared, waiting for the poster"],
  ["waiting_on_engain",          "sent",      "sent to Engain, not published yet"],
  ["published_awaiting_upvotes", "published", "live on Reddit"],
  ["upvotes_running",            "upvotes",   "live, upvotes in progress"],
  ["upvotes_delivered",          "done",      "live, upvotes delivered"]
];
const STAGE_BAD = { send_failed: "failed", removed: "removed", gate_refused: "gate refused", pulled_back: "pulled back" };
/* Two holding stages that are neither on the seven-dot track nor failures:
   a task the reviewer asked to pull back (waiting for Engain's 24h window),
   and a draft the reviewer sent back to the agent. Drawn at the "sent" and
   "draft" dots respectively. */
const STAGE_HOLD = { pullback_requested: ["pull back requested", 3, "pull-back requested, waiting for Engain's 24h cancel window"] };

function nav() {
  const here = location.pathname.split("/").pop() || "index.html";
  const is = h => h === here || h.replace(".html", "") === here;
  const steps = STEPS.map(([h, n, l, k]) =>
    `<a href="${h}" class="${is(h) ? "on" : ""}" ${is(h) ? 'aria-current="page"' : ""}>` +
    `<span class="n" aria-hidden="true">${n}</span><span>${l}</span><span class="c" data-count="${k}" hidden></span></a>`).join("");
  document.body.insertAdjacentHTML("afterbegin",
    `<header class="topbar"><div class="in">` +
      `<a class="brand" href="index.html">Reddit GEO Ops</a>` +
      `<nav class="steps" aria-label="Workflow">${steps}</nav>` +
      `<a class="aux" href="history.html" ${is("history.html") ? 'aria-current="page"' : ""}>History</a>` +
    `</div></header>`);
  /* Inline favicon: one request fewer, and no 404 in every console. */
  document.head.insertAdjacentHTML("beforeend",
    '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 32 32%27%3E%3Crect width=%2732%27 height=%2732%27 rx=%277%27 fill=%27%2317181a%27/%3E%3Ccircle cx=%2716%27 cy=%2716%27 r=%277%27 fill=%27%23ffd815%27/%3E%3C/svg%3E">');
  navCounts().catch(() => {});
}

/* Live step counts: only the numbers that mean "something is waiting". */
async function navCounts() {
  const rows = await cached("nav_stage", 60, () => sbAll("thread_activity", "select=stage&stage=neq.no_draft"));
  const n = s => rows.filter(r => r.stage === s).length;
  const review = n("draft_pending_review") + n("approved_not_cleared") + n("gate_refused");
  const status = n("cleared_not_sent") + n("waiting_on_engain") + n("pullback_requested") + n("published_awaiting_upvotes") + n("upvotes_running");
  setCount("R", review, review > 0);
  setCount("S", status, false);
}
function setCount(key, v, hot) {
  const el = document.querySelector(`[data-count="${key}"]`);
  if (!el) return;
  el.textContent = v; el.hidden = !v; el.classList.toggle("hot", !!hot);
}
async function cached(key, ttlSec, fn) {
  try {
    const hit = JSON.parse(sessionStorage.getItem("c_" + key) || "null");
    if (hit && Date.now() - hit.t < ttlSec * 1000) return hit.v;
  } catch (e) {}
  const v = await fn();
  try { sessionStorage.setItem("c_" + key, JSON.stringify({ t: Date.now(), v })); } catch (e) {}
  return v;
}

/* ── Supabase ─────────────────────────────────────────────────────────────
   Read-only, anon key, RLS enforced server-side. config.js is generated at
   build time from Vercel env vars (see build.js), so no key lives in git. */
const SB_READY = typeof window.SB_URL === "string" && typeof window.SB_KEY === "string";

async function sb(table, query = "", token) {
  if (!SB_READY) throw new Error("Supabase config missing: build.js did not run");
  const r = await fetch(`${window.SB_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: window.SB_KEY, Authorization: "Bearer " + (token || window.SB_KEY) }
  });
  if (!r.ok) throw new Error(`${table} ${r.status}: ${await r.text()}`);
  return r.json();
}

/* PostgREST hard-caps a response at 1000 rows and `&limit=5000` does NOT
   override it: it truncates silently, which reads as "we have 1000 threads"
   when we have 1410. Any table that can outgrow 1000 rows comes through here. */
async function sbAll(table, baseQuery = "", pageSize = 1000, token) {
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const q = baseQuery + (baseQuery ? "&" : "") + `limit=${pageSize}&offset=${offset}`;
    const rows = await sb(table, q, token);
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
}

/* Exact row count without fetching the rows: PostgREST answers the Content-Range
   header when asked, so a 1,646-row table costs one 1-row request. */
async function sbCount(table, query = "") {
  if (!SB_READY) throw new Error("Supabase config missing: build.js did not run");
  const r = await fetch(`${window.SB_URL}/rest/v1/${table}?select=*${query ? "&" + query : ""}`, {
    method: "HEAD", headers: { apikey: window.SB_KEY, Authorization: "Bearer " + window.SB_KEY, Prefer: "count=exact", Range: "0-0" }
  });
  if (!r.ok && r.status !== 206) throw new Error(`${table} ${r.status}`);
  const m = (r.headers.get("content-range") || "").match(/\/(\d+|\*)$/);
  return m && m[1] !== "*" ? Number(m[1]) : 0;
}

/* Page-level error surface: never show an empty table and call it data. */
function fail(err, where) {
  console.error(err);
  const el = document.querySelector("main") || document.body;
  el.insertAdjacentHTML("afterbegin",
    `<div class="notice bad" role="alert">${ICON.alert}<div class="body"><b>Could not load ${where ? esc(where) : "this page"}.</b> ` +
    `This page shows nothing rather than stale or invented rows.<br><code>${esc(String(err.message || err))}</code></div></div>`);
}

/* ── formatters ─────────────────────────────────────────────────────────── */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const subOf = url => { const m = String(url || "").match(/\/r\/([^/]+)/); return m ? m[1] : ""; };
const cleanTitle = (t, url) =>
  String(t || "").replace(/^r\/[^:]+\s+on\s+Reddit:\s+/, "").replace(/\s*:\s*r\/[A-Za-z0-9_]+\s*$/, "").trim() ||
  (String(url || "").split("/comments/")[1] || "").split("/").slice(1).join(" ").replace(/_/g, " ") || "(untitled)";
const fmtN = n => (n == null ? "" : Number(n).toLocaleString("en-US"));
const fmtDate = d => (d ? String(d).slice(0, 10) : "");
function ago(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  if (s < 86400 * 30) return Math.round(s / 86400) + " d ago";
  return fmtDate(iso);
}
function chip(kind, text) { return `<span class="chip ${kind}">${esc(text)}</span>`; }
function skeleton(el, n = 4) {
  el.innerHTML = Array.from({ length: n }, (_, i) => `<div class="sk" style="width:${[92, 71, 84, 60, 77][i % 5]}%"></div>`).join("");
}
/* Stage track: seven dots, the current one ringed in saffron. */
function track(stage) {
  const hold = STAGE_HOLD[stage];
  const i = hold ? hold[1] : STAGES.findIndex(s => s[0] === stage);
  const bad = stage in STAGE_BAD;
  const badAt = stage === "gate_refused" ? 2 : 3;
  return `<span class="track" aria-hidden="true">` +
    STAGES.map((s, k) => `<i class="${bad && k === badAt ? "bad" : k < i ? "done" : k === i ? "now" : ""}"></i>`).join("") + `</span>`;
}
function stageLabel(stage) {
  const s = STAGES.find(x => x[0] === stage);
  return s ? s[1] : (STAGE_BAD[stage] || (STAGE_HOLD[stage] || [])[0] || stage || "");
}
const STAGE_WORDS_X = {
  send_failed: "send failed at Engain",
  removed: "removed after posting",
  gate_refused: "approved, but the final check_draft.py run refused it. Edit or reject on Review",
  pulled_back: "pulled back at Engain before it published"
};
function stageWords(stage) {
  const s = STAGES.find(x => x[0] === stage);
  return s ? s[2] : (STAGE_WORDS_X[stage] || (STAGE_HOLD[stage] || [])[2] || stage || "");
}
function stageKind(stage) {
  if (stage in STAGE_BAD) return "bad";
  if (["published_awaiting_upvotes", "upvotes_running", "upvotes_delivered"].includes(stage)) return "ok";
  if (stage === "draft_pending_review" || stage === "approved_not_cleared" || stage in STAGE_HOLD) return "warn";
  return "info";
}

/* One icon set, one stroke. Inline so the harness browser (no internet) sees them. */
const ICON = {
  alert: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5 2.5 16.5h15L10 3.5Z"/><path d="M10 8v4M10 14.5h.01"/></svg>',
  check: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 10.5 4 4 8-9"/></svg>',
  x:     '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>',
  info:  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v5M10 6.5h.01"/></svg>',
  search:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="9" r="5.5"/><path d="m13.5 13.5 3 3"/></svg>',
  left:  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 5-5 5 5 5"/></svg>',
  right: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 5 5 5-5 5"/></svg>'
};

nav();
