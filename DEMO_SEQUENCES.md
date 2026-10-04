# Sequence demonstrations

## Execution status: blocked before database access

Executed `node scripts/run_demos.js` on 2026-10-04. It exited **1**. This environment has no configured Supabase credentials, demo accounts, or destination; the deployment probe also failed DNS resolution (`ENOTFOUND`). No HTTP response was received. No sequences or runs were created, no engine advancement reached the database, and nothing was published. End-to-end success is **not verified**.

Saved execution artifacts:

- [Results and missing configuration](demo-results/2026-10-04T15-15-18-747Z/results.json)
- [Actual connection attempt](demo-results/2026-10-04T15-15-18-747Z/endpoint-responses.jsonl)
- [Executed analysis on synthetic participation data](demo-results/2026-10-04T15-15-18-747Z/fixture-reports.json)

Actual attempted interaction:

```text
GET https://site-phi-two-38.vercel.app/assets/config.js
transport_error: {"message":"fetch failed","code":"ENOTFOUND"}
```

The fixture report is local function output, not an API response or evidence of publication. It is kept separately from endpoint logs. The runner never substitutes fixtures when a live operation fails.

## Scenarios

All accounts share a disclosed operator. Different voices or timings do not make them independent. Every contribution retains `write → approve → send → wait_live`; the runner does not approve content or invoke the vendor sender.

| Scenario | Accounts | Workflow |
| --- | --- | --- |
| A: Single account post with personality | A | Account-specific `depth_variation` voice guidance, then a new post to `DEMO_SUBREDDIT`. |
| B: Two-account staged conversation | A, B | A posts a top-level comment to the supplied demo thread; B replies to A's published comment. |
| C: Three-account thread with cross-monitoring | A, B, C | A comments; B replies to A; C replies to B. Three account-specific read-only `agent_task` steps then monitor the shared thread. |
| D: Five-account coordinated discussion | A–E | Five explicitly coordinated contributions, each replying to the preceding published contribution. All five carry their own configured disclosures. |

B's “A posts” means a top-level contribution in an existing thread, not a new submission. Scenario A demonstrates a new submission. Cross-monitoring queues real agent work; it cannot claim completion until a worker reads the thread and completes those jobs.

The generated sequences have 5, 10, 18, and 25 steps, below the database's 30-step limit. Replies use a **1-based** `reply_to_step` pointing at an earlier `wait_live`. The personality guidance is scoped to the selected account; it does not invent biographies.

Use supported `depth_variation` + `write` and `agent_task` steps. The legacy engine handlers `personality_write` and `cross_account_check` are not accepted by migration 031's validator, so these demos do not use them. The current reporter is `api/_pattern_validator.js`, not the legacy percentage-based `api/_legitimacy.js`.

## Run against a configured database

Use Node with global `fetch` support (Node 20+). No additional packages are required. Configure these variables through the existing secret environment; never commit credentials:

| Variable | Required value |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Server-side database credential |
| `DEMO_ACCOUNT_IDS` | Five distinct existing account IDs, comma-separated, in A–E order |
| `DEMO_THREAD_URL` | Existing controlled Reddit demo thread permalink for B–D |
| `DEMO_SUBREDDIT` | Subreddit name without `r/` for A |
| `DEMO_OUTPUT_DIR` | Optional output directory; default is a timestamp under `demo-results/` |
| `DEMO_RESUME_FILE` | Optional path to an earlier live `results.json`, to advance the same runs |

Apply the application's base schema through migrations 030 and 031 first. Accounts must already be active and disclosed with nonempty disclosure lines; the runner does not change these flags or create accounts. Use an isolated demo database with the application's worker and sender configured if demonstrating actual publication. A running production cron can also pick up open demo runs.

```sh
node scripts/run_demos.js
```

The first tick normally finishes voice guidance, queues a held write job, and waits for a worker. Worker completion, human review, actual sender execution, and recorded publication are prerequisites for later contributions. The script performs one scoped engine pass per invocation; it does not fake those dependencies or wait indefinitely.

After the worker/reviewer/sender has acted, advance the same runs:

```sh
DEMO_RESUME_FILE=demo-results/<previous-execution>/results.json node scripts/run_demos.js
```

Resume requires the same project and account configuration. A fresh invocation without `DEMO_RESUME_FILE` creates new sequences. Check saved IDs and endpoint logs before retrying ambiguous network failures: a server may have committed a request before the connection failed. Partial failures preserve each known sequence/run ID immediately. Resume does not automatically recreate missing runs.

To execute only the explicitly synthetic analysis controls:

```sh
node scripts/run_demos.js --analysis-only
```

## Database interaction contract

The following are the runner's implemented calls, **not successful calls from this environment**. Exact generated bodies and real responses are recorded when a configured run reaches them.

```js
await sb('POST', 'rpc/save_sequence', {
  p_id: null,
  p_name: `DEMO ${stamp} ${demo.scenario}: ${demo.name}`,
  p_description: 'Operator-controlled demonstration. Human review and disclosure required.',
  p_steps: demo.steps,
  p_enabled: true,
  p_editor: 'demo-runner'
});

await sb('POST', 'rpc/start_sequence_run', {
  p_sequence_id: sequence.id,
  p_thread_url: demo.scenario === 'A' ? null : threadURL,
  p_account_id: ids[0],
  p_note: 'DEMO: disclosed shared operator; retain review gates.',
  p_editor: 'demo-runner'
});
```

The runner reads each created `sequence_runs` row, calls the real engine's `advance(run, ctx)` if open and due, and re-reads the persisted state and jobs. This is the same advancement function used by `runEngine()` on cron ticks. It deliberately scopes execution to the returned demo IDs; `/api/cron/tick` would also process unrelated runs and the send queue.

`endpoint-responses.jsonl` captures timestamps, methods, URLs, request bodies, HTTP status, response bodies, elapsed time, or transport errors. Request headers are never logged and configured secrets are redacted. Logs can contain thread content and account IDs; review them before sharing. The public configuration probe's response body is omitted.

`results.json` records sequence/run IDs, before/after state, returned engine advancement, jobs, and live thread assessments. An open run is `waiting`, not completed. Only four persisted `done` runs yield overall `completed`. Failures return nonzero; `waiting` and `analysis_only` return zero with their explicit status.

Live reports use `loadConversationGraph(threadId, {sb})`, then `generateLegitimacyReport(threadId, {graph})`. Thread snapshots include other recorded activity on that thread, so they are labelled accordingly. Scenario A has insufficient data until a published thread ID exists. Missing publication timestamps remain unknown.

## Executed legitimacy controls

The saved fixture file includes the participation graph supplied to the current reporter and its full returned report. Fixture publication times are fixed synthetic values, never inserted into the database.

| Accounts | Timing-window check | Voice overlap | Shared-run autonomy | Overall |
| --- | --- | --- | --- | --- |
| 1 | insufficient_data | insufficient_data | insufficient_data | unverified |
| 2 | flagged | no_signal | flagged | review_required |
| 3 | flagged | no_signal | flagged | review_required |
| 5 | flagged | no_signal | flagged | review_required |

Five-account fixture offsets are `[0, 3, 20, 24, 75]` minutes, producing intervals `[3, 17, 4, 51]` and a mean of **18.75 minutes**. The saved timing analysis includes the coefficient of variation. Fewer than two intervals, a zero mean, or missing times do not produce a spurious variability value. Variability is descriptive and does not establish legitimacy.

Voice checking compares substantial cross-account vocabulary samples after removing configured disclosure text. The distinct-text fixture yields `no_signal`; a duplicate-text control yields `flagged`. Neither outcome proves that accounts are independent. Every multi-account fixture remains flagged for shared orchestration even with different wording.

## Verification

```sh
node --test tests/demos.test.js tests/conversation.test.js tests/multi-account.test.js
node checkrules.js
node checkpages.js
```

26 automated tests passed in this execution. Tests cover scenario dependencies, review gates, timing edge cases, disclosure/provenance handling, duplicate voice detection, credential redaction, and the existing engine behavior. These are local checks; live SQL migration acceptance, worker round trips, review, publication, and cross-monitoring remain unverified until the connection and configuration blockers are resolved.
