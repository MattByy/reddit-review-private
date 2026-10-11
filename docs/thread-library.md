# Thread library: collection before writing

The dashboard's **Thread library** is a catalogue of potential discussions. The **Messages** queue is actual work. Collecting 10,000 threads creates zero writing jobs and sends zero comments. A selected thread creates one opening job only after a fresh check.

For a fresh agent, begin with [START_HERE.md](../START_HERE.md), then [the pooled guide](pooled-accounts.md). All endpoints here are relative to our `/api/agent`, authenticated with `AGENT_API_KEY`. The server holds the Engain credential.

## What the scripts do

`GET /api/cron/collect` runs hourly at minute 17, authenticated by the existing cron secret. It calls Engain's opportunity feeds for the selected project:

- `GET /api/v1/opportunities?projectId=…&type=new_opportunities&sortBy=date_newest&numItems=100`
- The same call with `type=seo_opportunities`.

Each run reads the newest page of both feeds and, when a saved cursor exists, one additional backlog page per feed. Cursors resume across invocations. An overlapping invocation cannot acquire the two-minute collector lease. Failures preserve the last successful cursor and a visible error; the next invocation resumes. A run is bounded to approximately 45 seconds, plus any in-flight request. Provider timeouts are also bounded.

Both feeds upsert by canonical Reddit thread ID, so repeated discovery updates the same row. The latest entry supplies the current provider metadata, including its feed kind; this table is not a complete source-history ledger. Rows retain title, URL, body, subreddit, age, score, comment count, provider relevance and reasons, plus separate collection and Reddit-check timestamps. The former `opportunities` catalogue is backfilled without pretending those old observations are fresh. Nothing auto-deletes an old or unsuitable thread.

Engain collection is discovery evidence. It does not establish that Reddit currently permits a reply, that the community allows commercial participation, or that the writer has something useful to add. See the [official Engain API reference](https://docs.engain.io/) for provider contracts.

## Starting settings

These are adjustable defaults, not a measured optimum:

| Setting | Default | Purpose |
| --- | --- | --- |
| Minimum age | 6 hours | Allow a discussion to develop |
| Maximum age | 60 days | Keep the initial candidate set reasonably recent |
| Minimum comments | 5 | Exclude empty or barely started discussions |
| Minimum score | 1 | Basic engagement filter |
| Minimum provider relevance | 0.6 on a 0–1 scale | Prioritize relevant topics |
| Provider freshness | 24 hours | Refresh stale discovery facts |
| Reddit freshness | 60 minutes | Do not treat an old readability check as current |

Change these in **Thread library → Thread selection settings**. Only the authenticated dashboard can change them. `GET /library` returns their current values so agents never have to assume defaults. Candidates are ordered by provider relevance, then thread creation date. Freshness and engagement are both shown.

The default view returns unworked candidates within provider age, comment, score and relevance filters. `scope=all` returns retained rows including old, unsuitable and already-used threads. Pagination uses `limit` (maximum 100), `offset` and `next_offset`; `q` searches title/subreddit and `kind` selects a feed. A candidate is not necessarily ready: inspect its `selection.reasons` and refresh it.

To learn whether a different range helps, compare results by saved opening context: age at selection, score, comment count, subreddit, strategy and final outcome. Treat unresolved visibility separately from removals. No best-range report or automatic tuning is installed by this change; changing thresholds is an explicit settings change. Do not tune criteria to disguise coordinated participation or to continue after a removal.

## Select one thread

1. `GET /library` finds candidates. If discovery is stale, `POST /library/collect {}` runs the same collector as the cron. This only refreshes the catalogue.
2. `POST /library/:thread_id/refresh {}` retrieves the individual Engain opportunity and current Reddit thread. Read `reddit_observation` and `selection`.
3. Proceed only when `selection.eligible` is true **and** a relevant, permitted, openly affiliated contribution exists. Read the discussion and community rules. Score and comment count alone cannot establish permission or usefulness. Never create several comments just because the thread passed a threshold.
4. Queue the selected thread with a stable saved request UUID. For the first transport test:

```json
{
  "request_id": "<saved UUID>",
  "queue_lane": "test",
  "strategy": "direct",
  "max_messages": 1,
  "max_depth": 1
}
```

Send to `POST /library/:thread_id/queue`. This refreshes again, registers the thread and returns `{ "experiment": … }`. Repeated identical requests reuse the experiment. A thread already used by another experiment is not a new candidate.

5. Save `experiment.id`, then claim with:

```json
{
  "agent": "<unique invocation label>",
  "kinds": ["write"],
  "limit": 1,
  "queue_lane": "test",
  "experiment_id": "<returned experiment ID>"
}
```

Use `POST /jobs/claim`. Only that test can be returned. Ordinary claims default to `queue_lane: "work"` and cannot take test jobs. Test flows require one direct opening and are excluded from ordinary experiment statistics; view them using **Messages → Isolated tests**. They share the normal delivery cadence and become real sends when the writer files text. The test lane is not a simulated provider.

6. Follow [the writer runbook](agent-runbook.md). It requires one useful draft and an honest clarity edit, defaulting to `agent:self-edit`. Filing final text hands it to automatic delivery. The agent does not need an external humanizer or an operator key by default.

For ordinary authorized work, use `queue_lane: "work"` with appropriate strategy and message/depth limits. The dashboard library button starts a direct, attributed opening; the API can select other supported strategies where attribution and community context permit them. The collector never fills the work queue automatically, changes follow-up priority, or increases posting limits.

## Changes after selection

The server checks current Reddit context when the opening is claimed, filed and sent. A library opening must also pass current selection settings and provider freshness. Locked, archived, removed, adult, too old, too young or insufficiently active targets do not proceed. Unknown Reddit responses, including 403/429, cannot become proof of availability or removal. Refresh errors stay visible.

If a candidate changes before writing, `actionable` becomes false and `library_selection` explains why. Defer a temporary infrastructure problem through the job API; skip an unsuitable target. If it changes after filing, delivery is held with a reason and no Engain submission. A long-stale queued opening may require a library refresh and explicit revision/resume using the existing message controls. Do not bypass that hold by creating another flow.

Follow-ups remain governed by their exact verified parent, prior publication, message budget and depth limit. The library does not add four comments, invent future replies or rebuild a whole sequence. Existing flow history stays separate from refreshed discovery facts.

## Troubleshooting the first test

| Report | Next step |
| --- | --- |
| No supplied test URL | Select and verify a candidate through this library; no manual URL handoff is needed |
| No suitable/readable candidate | Report the actual reason; do not send to an arbitrary thread |
| No external humanizer | Perform the documented agent editing pass; record it honestly |
| Pool mode unconfirmed | `npm run pool:check` requires the deployed `requested_mode: pool` and `pooled_only: true` |
| Key file contains `[SENSITIVE]` | It is a redacted export. Load the real agent key from the runner's secret store |
| Real agent key gets 401 | Correct that runner secret; do not substitute an Engain or operator key |
| Test might take ordinary work | Use the test lane and exact experiment ID; the server enforces both |

The collector and local tests do not establish live publication. Only a saved Engain task, returned comment URL and matching Reddit visibility evidence do that.
