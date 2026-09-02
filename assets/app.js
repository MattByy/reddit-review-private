const NAV = [
  ["index.html","Overview"],
  ["queries.html","1 · Queries"],
  ["targets.html","2 · Targets"],
  ["dominate.html","3 · Dominate"],
  ["audit.html","4 · Audit"],
  ["history.html","History"],
  ["experiments.html","Experiments"],
  ["log.html","Log"]
];
function nav(active){
  const here = location.pathname.split("/").pop() || "index.html";
  document.body.insertAdjacentHTML("afterbegin",
    '<nav><span class="brand">Reddit GEO Ops</span>' +
    NAV.map(([h,l])=>`<a href="${h}" class="${h===here?'on':''}">${l}</a>`).join("") + "</nav>");
}

/* ── Supabase ─────────────────────────────────────────────────────────────
   Read-only, anon key, RLS enforced server-side. config.js is generated at
   build time from Vercel env vars (see build.js), so no key lives in git.   */
const SB_READY = typeof window.SB_URL === "string" && typeof window.SB_KEY === "string";

async function sb(table, query=""){
  if(!SB_READY) throw new Error("Supabase config missing — build.js did not run");
  const r = await fetch(`${window.SB_URL}/rest/v1/${table}?${query}`, {
    headers:{ apikey: window.SB_KEY, Authorization: "Bearer " + window.SB_KEY }
  });
  if(!r.ok) throw new Error(`${table} ${r.status}: ${await r.text()}`);
  return r.json();
}

/* PostgREST hard-caps a response at 1000 rows and `&limit=5000` does NOT
   override it — it truncates silently, which reads as "we have 1000 threads"
   when we have 1410. Any table that can outgrow 1000 rows must come through
   here, not through sb(). This has already bitten three separate surfaces. */
async function sbAll(table, baseQuery="", pageSize=1000){
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const q = baseQuery + (baseQuery ? "&" : "") + `limit=${pageSize}&offset=${offset}`;
    const rows = await sb(table, q);
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
}

/* page-level error surface: never show an empty table and call it data */
function fail(err, where){
  console.error(err);
  const el = document.querySelector("main") || document.body;
  el.insertAdjacentHTML("afterbegin",
    `<div class="card" style="border-color:#f87171;color:#f87171">
       <b>Could not load data${where?" for "+where:""}.</b><br>
       <span style="font:12px ui-monospace,monospace">${String(err.message||err)}</span><br>
       This page shows nothing rather than showing stale or invented rows.
     </div>`);
}

const j = u => fetch(u).then(r => { if(!r.ok) throw new Error(u+" "+r.status); return r.json(); });
function pill(s){ return `<span class="pill ${s}">${s}</span>`; }
nav();
