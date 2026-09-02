#!/usr/bin/env node
/* Extract each page's inline <script> and syntax-check it with the real JS
 * parser. A page whose JS throws renders an empty shell, and the build cannot
 * see that — only a parser can. */
const fs = require("fs"), vm = require("vm");
let bad = 0;
for (const f of fs.readdirSync(".").filter(f => f.endsWith(".html"))) {
  const src = fs.readFileSync(f, "utf8");
  const blocks = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  blocks.forEach((code, i) => {
    try { new vm.Script(code, { filename: `${f}#${i}` }); }
    catch (e) { bad++; console.log(`SYNTAX ERROR  ${f} block ${i}: ${e.message}`); }
  });
  // Every id referenced via getElementById must exist in the markup, or the
  // page silently half-renders.
  const ids = new Set([...src.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const used = new Set([...src.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]));
  const dollar = new Set([...src.matchAll(/\$\(['"]([^'"]+)['"]\)/g)].map(m => m[1]));
  for (const u of [...used, ...dollar]) {
    if (!ids.has(u)) { bad++; console.log(`MISSING ELEMENT  ${f}: JS reads #${u}, no such id in markup`); }
  }
  console.log(`  ${f.padEnd(16)} ${blocks.length} inline block(s), ${ids.size} ids`);
}
console.log(bad ? `\n${bad} PROBLEM(S)` : "\nall pages parse, all referenced ids exist");
process.exit(bad ? 1 : 0);
