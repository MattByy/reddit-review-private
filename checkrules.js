#!/usr/bin/env node
/* The disclosure rule (027) on the server copy. A draft without the line must
 * fail; the same draft with it must pass. Run: node checkrules.js */
const { check } = require("./api/_rules.js");
const base = "We hit the same wall scraping retail listings at volume. Rotating residential IPs per request plus a real browser fingerprint fixed most of the blocks for us. Geonode has a pay per GB residential pool if you want to try that route without a contract.";
const cases = [
  [base, false, "no disclosure"],
  [base + " (Geonode team here)", true, "team line"],
  ["Geonode team here. " + base, true, "team line first"],
  [base + " I work at Geonode, so weigh that.", true, "first person"],
  [base.replace("Geonode has", "One provider has") + " (posted for Geonode)", true, "posted for"],
];
// With an account chosen: its line must be in the body verbatim, and must name Geonode.
const acct = [
  [base + " (Geonode team here)", "(Geonode team here)", true, "account line present"],
  [base + " I work at Geonode.", "(Geonode team here)", false, "account line missing"],
  [base.replace("Geonode has", "Example Team has") + " (Example Team team here)", "(Example Team team here)", false, "line names someone else"],
];
let bad = 0;
for (const [body, line, want, name] of acct) {
  const got = check(body, { kind: "comment", disclosure_line: line }).ok;
  if (got !== want) { bad++; console.log(`FAIL  ${name}`, check(body, { kind: "comment", disclosure_line: line }).fails); }
  else console.log(`ok    ${name}`);
}
for (const [body, want, name] of cases) {
  const got = check(body, { kind: "comment" }).ok;
  if (got !== want) { bad++; console.log(`FAIL  ${name}: expected ${want ? "pass" : "fail"}`, check(body, { kind: "comment" }).fails); }
  else console.log(`ok    ${name}`);
}
process.exit(bad ? 1 : 0);
