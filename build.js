#!/usr/bin/env node
/**
 * Vercel build step.
 *
 * 1. Writes assets/config.js from environment variables so the anon key is
 *    never committed to git. Fails the build loudly if the env is missing — a
 *    site that silently renders zero rows is worse than one that doesn't deploy.
 * 2. Injects the passcode gate into every page. Doing it here rather than by
 *    hand means a NEW page cannot be added ungated by someone who forgot the
 *    script tag — the build is the enforcement.
 */
const fs = require("fs");
const path = require("path");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error("BUILD FAILED: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set.");
  process.exit(1);
}
if (key.startsWith("sb_secret") || key.startsWith("service_role") || key.includes("service_role")) {
  console.error("BUILD FAILED: that looks like a SECRET key. The browser gets the publishable/anon key only.");
  process.exit(1);
}
fs.writeFileSync("assets/config.js",
  `// generated at build time by build.js — do not edit, do not commit\n` +
  `window.SB_URL=${JSON.stringify(url.replace(/\/$/, ""))};\n` +
  `window.SB_KEY=${JSON.stringify(key)};\n`);
console.log("wrote assets/config.js for", url);

// ── gate every page ────────────────────────────────────────────────────────
// The gate must load BEFORE config.js and app.js so nothing renders behind it.
//
// UNGATED is a deliberate list, not an oversight. review.html is the page
// Swello opens from a phone to approve or reject a comment, and the founders'
// call (2026-09-03) is that nothing — no gate, no login — stands between the
// link and that decision. The gate never protected data anyway: the anon key
// ships in config.js, and migration 008 lets that key read and review drafts.
const UNGATED = new Set(["review.html"]);
const GATE = '<script src="assets/gate.js"></script>';
let gated = 0, already = 0, skipped = 0;
for (const f of fs.readdirSync(".").filter(f => f.endsWith(".html"))) {
  const src = fs.readFileSync(f, "utf8");
  if (UNGATED.has(f)) {
    if (src.includes("assets/gate.js")) {
      fs.writeFileSync(f, src.replace(/\s*<script src="assets\/gate\.js"><\/script>/g, ""));
      console.log(`  removed gate from ${f} (on the ungated list)`);
    }
    skipped++;
    continue;
  }
  if (src.includes("assets/gate.js")) { already++; continue; }
  if (!src.includes('<script src="assets/config.js">')) {
    console.error(`BUILD FAILED: ${f} has no config.js tag — cannot place the gate reliably.`);
    process.exit(1);
  }
  fs.writeFileSync(f, src.replace('<script src="assets/config.js"></script>', GATE + '\n' + '<script src="assets/config.js"></script>'));
  gated++;
}
console.log(`passcode gate: ${gated} injected, ${already} already had it, ${skipped} deliberately ungated`);
