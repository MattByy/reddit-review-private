#!/usr/bin/env node
/**
 * Vercel build step. Writes assets/config.js from environment variables so the
 * anon key is never committed to git. Fails the build loudly if the env is
 * missing — a site that silently renders zero rows is worse than one that
 * doesn't deploy.
 */
const fs = require("fs");
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
