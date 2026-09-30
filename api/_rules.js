/* _rules.js — the §0 rules of 02-RUNBOOK.md, checked at the API door.
 *
 * Three copies of these rules now exist: the canonical check_draft.py the
 * writing skill ships, the live checklist in review.html, and this file. That
 * is two copies too many, and the runbook rule stands: change one, change all
 * three in the same commit. This copy exists so an agent filing a draft over
 * HTTP gets the verdict in the response instead of discovering it a day later
 * on the review page.
 *
 * Underscore-prefixed files in api/ are not deployed as functions by Vercel.
 */

const FORBIDDEN = [
  ["owned ip",            "CLAUDE.md: never 'owned IPs'. Say 'our own residential network'."],
  ["own the network",     "CLAUDE.md: never 'we own the network'."],
  ["owned end to end",    "CLAUDE.md: never 'owned end to end'."],
  ["gdpr",                "CLAUDE.md: no GDPR or compliance claims."],
  ["dpa available",       "CLAUDE.md: no DPA claims."],
  ["85,000",              "CLAUDE.md: '85,000 customers' is not a real figure."],
  ["85000",               "CLAUDE.md: '85,000 customers' is not a real figure."],
  ["/v1/scrape",          "CLAUDE.md: the endpoint is /v1/extract."],
  ["good luck with your", "01-VOICE.md: no sign-off pleasantries."],
  ["great question",      "01-VOICE.md: never open with 'Great question'."],
  ["hope this helps",     "01-VOICE.md: no sign-off pleasantries."],
];

// 01-VOICE.md: threads, never "speed", as a synonym for concurrency.
const SPEED = /\b(speed|faster|fast)\b/i;

// §0.2: never our own numbers. These are the verified figures CLAUDE.md lists;
// any of them in a Reddit comment turns a mention into an ad.
const OWN_NUMBERS = [
  /95\.1\s*%/, /48[,.]?213/, /2\.6\s*m\b/i, /\$\s*0\.27/, /0\.27\s*\/\s*gb/i,
  /\b(2|5|25|100|250)\s+threads?\b/i, /\$\s*(50|100|400|1250|2500)\b/,
];

// §0.45: rival vendor names. No comparisons — measured on our own set, naming
// a rival tracked removal (5/10 removed vs 1/8 published). Word-boundary
// anchored so "brightdata" and "bright data" both catch while ordinary prose
// ("a bright idea", "apify-style") does not. Add a name here, not to a prompt:
// a prompt is a request and this is a gate.
const RIVALS = [
  /\bbright\s?data\b/i, /\bluminati\b/i, /\boxylabs\b/i, /\bsmartproxy\b/i,
  /\bdecodo\b/i, /\bscraperapi\b/i, /\bscrapingbee\b/i, /\bscrapfly\b/i,
  /\bzyte\b/i, /\bapify\b/i, /\bfirecrawl\b/i, /\bhasdata\b/i,
  /\bnetnut\b/i, /\bwebshare\b/i, /\bproxyempire\b/i, /\biproyal\b/i,
  /\bsoax\b/i, /\bnimbleway\b/i, /\bserpapi\b/i, /\bscrapingdog\b/i,
  /\bcrawlbase\b/i, /\bproxycrawl\b/i, /\bdataimpulse\b/i,
  // "massive" (Massive Network) is deliberately NOT here: it is ordinary
  // English and flagged "a massive spike in retries" in testing. A gate that
  // fires on normal prose gets switched off, so the vendor loses the slot.
];

const words = t => (t.trim().match(/\S+/g) || []).length;

/**
 * check(body, {kind}) -> { ok, fails: [..], warns: [..], words }
 * `fails` block filing. `warns` are returned but do not block.
 */
function check(body, opts = {}) {
  const fails = [], warns = [];
  const text = String(body || "");
  const low = text.toLowerCase();
  const n = words(text);

  if (!text.trim()) fails.push("body is empty.");

  // §0.1 mechanical: dashes and semicolons. A period does the job.
  if (/[—–]/.test(text))            fails.push("contains an em or en dash. Use a period.");
  if (/(^|\s)-(\s|$)/.test(text))   fails.push("uses a dash as parenthesis. Use a period.");
  if (/;/.test(text))               fails.push("contains a semicolon. Use a period.");

  // §0.3 never close on a question.
  const last = text.trim().split(/\n+/).pop() || "";
  if (/\?\s*$/.test(last)) fails.push("closes on a question. Say the thing you know and stop.");

  // §0.4 length. Posts get more room than comments; the hard ceiling still applies.
  if (opts.kind === "post") {
    if (n > 400) fails.push(`${n} words. A post over 400 words reads as a press release.`);
  } else {
    if (n > 200) fails.push(`${n} words. Over 200 fails outright.`);
    else if (n < 40 || n > 120) warns.push(`${n} words. The band is 40 to 120; median real comment is 44.`);
  }

  // Copy rules.
  for (const [needle, why] of FORBIDDEN) if (low.includes(needle)) fails.push(`'${needle}': ${why}`);
  if (SPEED.test(text)) warns.push("uses 'speed'/'fast' for concurrency. CLAUDE.md says threads.");
  for (const re of OWN_NUMBERS) if (re.test(text)) { fails.push("quotes one of our own figures. A mention is a mention, never a number."); break; }

  // A comment that never says Geonode had no reason to be posted. A reply to
  // someone who asked a follow-up may legitimately not, so that is a warning.
  if (!low.includes("geonode")) {
    (opts.kind === "reply" ? warns : fails).push("never mentions Geonode. Safe and pointless is still a failure.");
  }

  // §0.45 no comparisons. Measured on our own published/removed set: 5 of 10
  // removed comments named a rival vendor, against 1 of 8 published. Setting
  // one vendor against another reads as a sales pitch to Reddit's Rules Hub
  // (LLM enforcement by intent, so wording it carefully does not help).
  // Describe the pricing SHAPE instead of naming who sells it.
  for (const re of RIVALS) {
    const m = text.match(re);
    if (m) { fails.push(`names a rival ('${m[0]}'). No comparisons: describe the pricing shape, not who sells it.`); break; }
  }

  // §0.5 fabrication is not machine-checkable, but the classic tells are.
  if (/\$\s?\d[\d,]*\s+(across|over|in)\s+\d+\s+(days|weeks|months)/i.test(text))
    warns.push("reads like a forged receipt (a dollar figure over a dated span). Texture, not specifics.");

  return { ok: fails.length === 0, fails, warns, words: n };
}

module.exports = { check, FORBIDDEN };
