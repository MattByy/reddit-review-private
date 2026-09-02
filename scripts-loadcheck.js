// Loads each deployed page the way a browser does: parse <script src> tags in
// order, fetch each from the SERVER, and execute. No injected config — if the
// page doesn't load config.js itself, SB_URL is undefined and this fails,
// exactly as it did in Swello's browser. That injection is why the previous
// harness passed a site that was broken for every real visitor.
const BASE = "https://site-phi-two-38.vercel.app";
const PAGES = ["index", "queries", "targets", "history", "dominate", "audit", "experiments", "log", "review"];

(async () => {
  for (const p of PAGES) {
    const html = await (await fetch(`${BASE}/${p}`)).text();
    const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
    let ok = true, why = "";

    // does it pull config before app?
    const iCfg = srcs.indexOf("assets/config.js"), iApp = srcs.indexOf("assets/app.js");
    if (iCfg === -1) { ok = false; why = "no config.js tag"; }
    else if (iApp !== -1 && iCfg > iApp) { ok = false; why = "config.js after app.js"; }

    // do those files actually exist on the server?
    for (const s of srcs) {
      const r = await fetch(`${BASE}/${s}`);
      const ct = r.headers.get("content-type") || "";
      if (!r.ok) { ok = false; why = `${s} -> ${r.status}`; }
      else if (ct.includes("text/html")) { ok = false; why = `${s} served HTML (404 page) not JS`; }
    }

    // and does config.js really define the globals?
    if (ok) {
      const cfg = await (await fetch(`${BASE}/assets/config.js`)).text();
      if (!/window\.SB_URL\s*=/.test(cfg) || !/window\.SB_KEY\s*=/.test(cfg)) {
        ok = false; why = "config.js missing SB_URL/SB_KEY";
      }
    }
    console.log(`${ok ? "PASS" : "FAIL"}  /${p}${ok ? "" : "  <- " + why}`);
  }

  // the exact failure Swello hit: JSON.parse on an HTML 404 body
  const bad = await fetch(`${BASE}/assets/config.js`);
  const txt = await bad.text();
  try { JSON.parse(txt); } catch (e) { /* expected: it's JS, not JSON */ }
  console.log("\nconfig.js first line:", txt.split("\n")[0]);
  console.log("defines SB_URL:", /window\.SB_URL="https:\/\/[a-z]+\.supabase\.co"/.test(txt));
})();
