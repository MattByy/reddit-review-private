# Multi-account sequences: agent guide

This guide describes the checked-in implementation, not a verified live deployment.
Use up to **5 distinct managed accounts per thread** as the operational limit,
counting accounts across runs. The current database code does **not enforce** a
five-account cap. A run has one default `account_id`; individual steps override it.
There is no `account_ids` run parameter.

All participants must be active, disclosed and have a configured `disclosure_line`.
Every body includes that line verbatim. Staged conversations must disclose shared
control; do not present managed accounts as unrelated customers or invent experience.
Human review remains required. Agents cannot approve, send or upvote.

## Implementation status

| Capability | Checked-in status |
|---|---|
| Multiple accounts; A publishes, B replies | Supported with `write.account_id` and `reply_to_step` |
| `coordinated_post`, `independent_reply`, `cross_account_check`, `personality_write`, `probabilistic_wait` | Handlers exist in `api/_engine.js`; validators in migrations 030 and 031 reject these names |
| Random wait completion | Incomplete: handler resamples on every visit and never returns `done` |
| Account profiles | Local JSON files; no profile upload endpoint |
| Legitimacy assessment | Local `generateLegitimacyReport` function; no HTTP handler or automatic send gate |

Do not bypass SQL validation to enable unfinished handlers. The examples below
separate supported workflows from handler configuration references.

## 1. Discover accounts and sequences

```sh
export BASE='https://site-phi-two-38.vercel.app/api/agent'
# Supply AGENT_API_KEY through your environment; never commit it.
curl --fail-with-body -sS -H "Authorization: Bearer $AGENT_API_KEY" "$BASE/accounts"
curl --fail-with-body -sS -H "Authorization: Bearer $AGENT_API_KEY" "$BASE/sequences"
```

Choose accounts with `can_post: true`. Replace example account IDs and Reddit URLs
with real records. Account IDs are application IDs, not Reddit usernames. Start
with an existing unlocked, unarchived thread.

## 2. Create a staged conversation

On `/sequences`, create a named sequence, add these ordered steps and save. The UI
uses Supabase RPC `save_sequence` with `p_id` (null for new), `p_name`,
`p_description`, `p_steps`, `p_enabled`, `p_editor`. There is no agent HTTP endpoint
to create sequence definitions. The following JSON is the step configuration to
reproduce in the builder, not a body for the run-start endpoint.

```json
[
  {"type":"write","kind":"comment","account_id":"account-a","brief":"Explain how to reproduce the reported issue. Include this account's operator disclosure."},
  {"type":"approve"},
  {"type":"send"},
  {"type":"wait_live"},
  {"type":"wait","minutes":180},
  {"type":"write","kind":"reply","account_id":"account-b","reply_to_step":4,"brief":"Reply to A with a distinct diagnostic check. Explicitly identify the shared operator; do not imply independent discovery."},
  {"type":"approve"},
  {"type":"send"},
  {"type":"wait_live"},
  {"type":"check_replies"},
  {"type":"answer_replies","account_id":"account-b","brief":"Answer substantive questions with the configured disclosure."}
]
```

`reply_to_step` is **1-based** and must reference an earlier `wait_live`. It resolves
the actual published URL, so B answers A's comment. Alternatively use a literal
comment `target_url`, never both. Step 10 checks B's latest published comment;
it does not crawl the entire thread. Reply checks exclude managed accounts.

For A to create a new Reddit submission, use `write` with `kind: "post"`,
`subreddit` and `title`, then approve → send → wait_live. Start that run without
`thread_url`. The same step-4 reference can target its published URL.

For C–E, repeat explicit write/review/send/live blocks only when each account has
a useful contribution. Keep the sequence within the validator's 30-step limit.
Separate runs can share a thread; count their participants toward the same
operational five-account limit.

## 3. Start and inspect a multi-account run

```sh
export SEQUENCE_ID='<UUID returned by GET /sequences>'
curl --fail-with-body -sS -X POST \
  -H "Authorization: Bearer $AGENT_API_KEY" -H 'Content-Type: application/json' \
  "$BASE/sequences/$SEQUENCE_ID/runs" -d '{
    "account_id":"account-a",
    "thread_url":"https://www.reddit.com/r/testing/comments/abc123/example/",
    "note":"Disclosed A/B diagnostic discussion",
    "agent":"reddit-agent"
  }'
curl --fail-with-body -sS -H "Authorization: Bearer $AGENT_API_KEY" \
  "$BASE/sequence-runs?status=open&limit=20"
```

Start returns `{run, next}`. Listing returns `{runs: [...]}`. Inspect `status`,
`current` (zero-based), `steps`, `state` and `next_at`. Runs snapshot the saved
sequence; editing its definition does not update existing runs. The tick executes
every 15 minutes, so wait deadlines are earliest eligible times, not precise sends.
Approval and sender pace limits can delay publication further.

## 4. Handle the agent jobs

```sh
curl --fail-with-body -sS -H "Authorization: Bearer $AGENT_API_KEY" \
  "$BASE/jobs/due?agent=reddit-agent&limit=5"
# Replace job ID and disclosure with those from the returned job/account.
curl --fail-with-body -sS -X POST \
  -H "Authorization: Bearer $AGENT_API_KEY" -H 'Content-Type: application/json' \
  "$BASE/drafts" -d '{
    "job_id":"<claimed job UUID>","kind":"comment",
    "body":"Check the response status before retrying the request. (Operated by Example Team)"
  }'
```

Use the job's `payload.kind`, brief and account. Filing with `job_id` completes
the job and inherits its account and reply parent. `write` jobs in sequences hold
drafts until the send step. `draft_followup` jobs do **not** get that sequence hold;
they can send after human approval. Claims last 30 minutes. Complete unfulfilled
jobs via `POST /api/agent/jobs/:id/complete` with a status and `result.reason`;
see the [agent skill](skills/reddit-agent/SKILL.md) for the hourly workflow.

## New step reference (not yet accepted by SQL)

These are actual engine configuration fields, not working production sequence
payloads. There is no per-step HTTP execution endpoint. Once integrated, sequences
would start through the same `POST /api/agent/sequences/:id/runs` route above.
Draft-producing handlers use the actual `/jobs/due` and `/drafts` endpoints in
section 4; monitoring and waiting happen inside the engine.

### coordinated_post

```json
{"type":"coordinated_post","account_id":"account-a","kind":"comment","brief":"Provide a useful initial answer and disclose the operator."}
```

Creates a `write` job with `payload.is_coordinated: true`, using the run's thread
and subreddit; defaults to `comment`. Follow with approve → send → wait_live.
Despite its name, this handler does not forward a step `title` for new posts.
Working equivalent: ordinary `write` with the same account, kind and brief.

### independent_reply

```json
{"type":"independent_reply","account_id":"account-b","target_url":"https://www.reddit.com/r/testing/comments/abc123/example/def456/","brief":"Add a diagnostic detail as another account operated by the same team. Disclose shared control."}
```

Creates a `draft_followup` job with `is_independent_reply: true`. The name is an
internal label, not evidence of independence. Set a literal comment `target_url`:
its fallback is an earlier `thread_url`, not A's comment, and it does not implement
`reply_to_step`. Its draft is not sequence-held. Use `write` + `reply_to_step` for
the staged, held workflow in section 2.

### cross_account_check

```json
{"type":"cross_account_check"}
```

Reads replies at the latest earlier `out.url`, falling back to the run thread URL.
Returns `out: {url, total_replies, our_score, checked_at}`. Managed authors are
excluded. It does not aggregate all account comments, store reply bodies, generate
an assessment or supply replies to `answer_replies`. Use it after `wait_live` of a
comment; the underlying reader assumes a comment and does not provide a complete
thread crawl. Gone content fails the step; other read failures retry in 15 minutes.
Working equivalent for a comment: `check_replies`, which also stores reply bodies.
Inspect results through `GET /api/agent/sequence-runs?status=open`.

### personality_write and voice injection

```json
{"type":"personality_write","account_id":"account-b","kind":"comment","target_url":"https://www.reddit.com/r/testing/comments/abc123/example/","brief":"Give one concise diagnostic suggestion. Use only verified facts and include the configured disclosure."}
```

The handler reads `data/accounts/account-b/profile.json` relative to the process
working directory. Example profile (replace ID with a real account ID):

```json
{
  "account_id":"account-b",
  "nickname":"Support voice",
  "persona":"technical support",
  "writing_style":{"tone":"plainspoken","vocabulary":"clear"},
  "expertise":[{"domain":"HTTP troubleshooting","depth":4,"keywords":["status codes"]}],
  "topics_avoid":["unverified product claims"],
  "activity":{"timezone":"Europe/Vilnius"}
}
```

Injected brief:

```text
[Voice: Support voice] Give one concise diagnostic suggestion. Use only verified facts and include the configured disclosure.
Style: plainspoken, clear
```

Only nickname, tone and vocabulary are injected. Other profile fields are not
scheduling or drafting enforcement. Disclosure comes from the database account,
not the profile. Missing/unreadable/invalid profiles silently fall back to the
original brief. The checked-in `acct_001/profile.json` is incomplete JSON; do not
copy it as a valid template. Validate your own file with `python3 -m json.tool`.
See [profile reference](data/accounts/profile_SCHEMA.md).

This creates a sequence-held `write` job with `has_personality: true`. It does not
implement `reply_to_step`; supply a literal target for replies. Until SQL support
exists, put the rendered voice brief in an ordinary `write.brief`.

### probabilistic_wait with variance

```json
{"type":"probabilistic_wait","minutes":120,"variance":0.5}
```

The formula is `round(minutes * (1 + (random - 0.5) * 2 * variance))`: 120 with
0.5 gives approximately 60–180 minutes. Defaults are 15 minutes and 0.5 variance;
current `||` defaults mean zero variance also becomes 0.5. Use positive minutes
and variance between 0 and 1 when preparing configurations; no handler validation
currently enforces that range.

**Do not run this handler yet:** each tick resamples and it never completes. For
a working sequence, sample once when constructing the definition and save an
ordinary `wait` step (all runs of that saved definition share that sampled delay):

```js
const minutes = 120;
const variance = 0.5;
const step = {
  type: 'wait',
  minutes: Math.max(1, Math.round(minutes * (1 + (Math.random() - 0.5) * 2 * variance)))
};
console.log(JSON.stringify(step));
```

Timing variation is scheduling flexibility; it does not establish independent
participation or replace disclosure and review.

## Legitimacy assessment integration

`api/_legitimacy.js` exports
`generateLegitimacyReport(threadId, accountIds, participationData)`. Run it locally
with recorded data before deciding whether further participation is useful. The
caller must filter records to the intended thread and supply actual timestamps,
content and account IDs. It does not fetch Reddit or database records itself.

Save this as a local script in the repository root, after creating valid account
profiles and a `participation.json` file:

```js
const fs = require('node:fs');
const { generateLegitimacyReport } = require('./api/_legitimacy.js');
const threadId = 'abc123';
const records = JSON.parse(fs.readFileSync('participation.json', 'utf8'))
  .filter(row => row.thread_id === threadId);
const accountIds = [...new Set(records.map(row => row.account_id))];
const report = generateLegitimacyReport(threadId, accountIds, records);
// Voice diagnostics contain Sets; preserve them in serialized output.
console.log(JSON.stringify(report, (_, value) =>
  value instanceof Set ? [...value] : value, 2));
```

Example input shape (replace with recorded events):

```json
[
  {"thread_id":"abc123","account_id":"account-a","timestamp":"2026-10-01T09:00:00Z","content":"Recorded published body including disclosure","engagement_type":"comment"},
  {"thread_id":"abc123","account_id":"account-b","timestamp":"2026-10-01T12:00:00Z","content":"Recorded reply including disclosure","engagement_type":"reply"}
]
```

Checks cover timing interval variability, profile voice differences, content-length
variation and entry intervals grouped by thread. `overall.score` is the fraction
of four checks passing; `overall.is_legitimate` uses a 0.75 threshold. Output also
includes `checks`, `assessed_at`, counts, summary and recommendations.

These are heuristics, not proof of legitimacy: insufficient timing/depth data and
missing profiles can pass, malformed profiles can throw, and discovery counts
all events rather than each account's first entry. There is no separate autonomy
check. Review source data and disclosure alongside the report. No cron, sequence
step or sender automatically invokes this module; `cross_account_check` is a
separate reply reader. An `agent_task` can request a local assessment and record
its findings through `/jobs/:id/complete`, but does not automatically block sends.

## API endpoint reference

All implemented agent routes require `Authorization: Bearer $AGENT_API_KEY`.
Use `Content-Type: application/json` for POST bodies. `GET /api/agent` lists routes.

| Requested path | Availability and actual entry point |
|---|---|
| `POST /api/sequences/runs` (`start_sequence_run`) | Not implemented; use `POST /api/agent/sequences/:id/runs` |
| `GET /api/sequences/runs` (active runs) | Not implemented; use `GET /api/agent/sequence-runs?status=open` |
| `GET /api/legitimacy/report` | Not implemented; use the local function above. No HTTP auth, query or response contract exists yet |

`POST /api/agent/sequences/:id/runs` accepts `account_id` (required default),
`thread_url` (existing thread; omit for a new post), optional `note` and optional
`agent` (defaults to `agent-api`). It invokes Supabase `rpc/start_sequence_run`
with `p_sequence_id`, `p_thread_url`, `p_account_id`, `p_note`, `p_editor`. It takes
saved steps, not inline `steps` or an account list. Accounts and step types are
validated before insertion. `GET /api/agent/sequence-runs` accepts `status` and
`limit`; use `open` for active runs.

Missing/wrong bearer keys return 401; unknown agent routes return 404; prohibited
agent actions return 403; missing server configuration returns 503. Draft checks
can return 422/409. Run-start SQL exceptions currently reach the generic 500
handler with a `detail` field, so inspect that field before retrying.

Sources: [dispatcher](api/_agent.js), [engine](api/_engine.js),
[migration 030](supabase/migrations/030-multi-account-sequences.sql),
[migration 031](supabase/migrations/031-conversation-orchestration.sql),
[assessment module](api/_legitimacy.js). Existing schema migrations through 029
are prerequisites to 030; apply 031 afterward for conversation orchestration.
