#!/usr/bin/env node
/* The disclosure rule (027) on the server copy. A draft without the line must
 * fail; the same draft with it must pass. Run: node checkrules.js */
const { check } = require("./api/_rules.js");
const base = "We hit the same wall scraping retail listings at volume. Rotating residential IPs per request plus a real browser fingerprint fixed most of the blocks for us. Example Team has a pay per GB residential pool if you want to try that route without a contract.";
const cases = [
  [base, false, "no disclosure"],
  [base + " (Example Team team here)", true, "team line"],
  ["Example Team team here. " + base, true, "team line first"],
  [base + " I work at Example Team, so weigh that.", true, "first person"],
  [base.replace("Example Team has", "One provider has") + " (posted for Example Team)", true, "posted for"],
  [base + " (Operated by Another Organization)", true, "other operator"],
];
if (check(base + " (Operated by Example Team)", { disclosure_line: "(Operated by Another Organization)" }).ok) throw new Error("wrong account disclosure accepted");
if (check(base, { disclosure_line: "" }).ok) throw new Error("empty disclosure accepted");
let bad = 0;
for (const [body, want, name] of cases) {
  const got = check(body, { kind: "comment" }).ok;
  if (got !== want) { bad++; console.log(`FAIL  ${name}: expected ${want ? "pass" : "fail"}`, check(body, { kind: "comment" }).fails); }
  else console.log(`ok    ${name}`);
}
process.exit(bad ? 1 : 0);
