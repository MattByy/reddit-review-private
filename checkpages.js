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

  /* Every CAPITAL_CASE global a page reads must be defined somewhere it can
     see: its own inline script, or the shared app.js it loads. The parser
     cannot catch this — a reference to a deleted global is valid syntax and
     only throws at render, leaving an empty shell. This check exists because
     MODE_WHY was folded into STRATEGIES and one reader survived the edit,
     parsed clean, and would have blanked the whole Review card. */
  const scoped = code => new Set([
    ...[...code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Z][A-Z0-9_]{2,})\b/g)].map(m => m[1]),
    ...[...code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)]
       .flatMap(m => m[1].split(",").map(s => s.split(":").pop().trim()))
       .filter(s => /^[A-Z][A-Z0-9_]{2,}$/.test(s))
  ]);
  const inline = blocks.join("\n");
  // Strip comments, strings and template literals before hunting identifiers:
  // prose like "OUR OWN comment" or "GDPR" inside a message is not a global.
  const codeOnly = s => {
    let t = s.replace(/\/\*[\s\S]*?\*\//g, " ")
             .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    // Template literals nest (`...${cond ? `a` : `b`}...`), so strip the
    // innermost ones repeatedly until nothing changes. One pass leaves the
    // prose of an outer template behind and it gets read as identifiers.
    for (let i = 0, prev = null; i < 20 && t !== prev; i++) {
      prev = t;
      t = t.replace(/`[^`]*`/g, "``");
    }
    return t.replace(/'(?:\\[\s\S]|[^'\\])*'/g, "''")
            .replace(/"(?:\\[\s\S]|[^"\\])*"/g, '""')
            // a.B is a property, not a global we could have deleted
            .replace(/\.\s*[A-Za-z_$][\w$]*/g, ".x");
  };
  const shared = src.includes("assets/app.js") ? fs.readFileSync("assets/app.js", "utf8") : "";
  const known = new Set([...scoped(inline), ...scoped(shared),
                         "JSON", "Math", "Object", "Array", "String", "Number",
                         "Boolean", "Date", "Set", "Map", "Promise", "RegExp",
                         "Intl", "URL", "URLSearchParams", "Error", "NaN"]);
  const readGlobals = new Set([...codeOnly(inline).matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map(m => m[1]));
  for (const g of readGlobals) {
    if (!known.has(g)) { bad++; console.log(`UNDEFINED GLOBAL  ${f}: reads ${g}, defined in neither the page nor app.js`); }
  }

  console.log(`  ${f.padEnd(16)} ${blocks.length} inline block(s), ${ids.size} ids`);
}
console.log(bad ? `\n${bad} PROBLEM(S)` : "\nall pages parse, all referenced ids exist");
process.exit(bad ? 1 : 0);
