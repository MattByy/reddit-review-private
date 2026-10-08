# Geonode Reddit workflow

A durable queue for thread discovery, reviewed drafts, Engain submission and Reddit reply monitoring. Agents start each session from the database; conversation memory is not required. Participation uses attributed accounts, one account per thread, and answers real readers.

Production site: https://site-phi-two-38.vercel.app/review

## Three schedules

| Job | Schedule | Work |
|---|---|---|
| `/api/cron/tick` | Every 15 minutes | Sync accounts, reconcile submissions, poll comments **and posts**, verify Reddit visibility, queue reader replies, advance sequences, ensure a discovery job and submit approved work. |
| External writing/finder agent | Hourly | Read bootstrap and lessons, revise returned drafts, claim jobs, find relevant threads or draft an answer, checkpoint and file/complete. |
| `/api/cron/pullback` | Hourly | Request cancellation of withdrawn work; retain vendor confirmation or the unresolved result. |

The two server schedules are in `vercel.json`. Configure the external agent with [the worker instructions](skills/reddit-agent/SKILL.md), its authorized search tool and `AGENT_API_KEY`. A database job does not itself run an LLM or provide a search subscription. No fourth cron is needed for thread discovery: `agent_task` jobs with `payload.task=find_threads` use the same worker.

## Agent API, protocol 2

All calls use `Authorization: Bearer $AGENT_API_KEY`. `GET /api/agent` lists routes.

| Call | Purpose |
|---|---|
| `GET /api/agent/bootstrap` | Eligible accounts, unfinished jobs, saved progress, returned drafts, recent outcomes, uncertain submissions and finder queries. |
| `POST /api/agent/threads` | Register a canonical Reddit thread and its discovery evidence. |
| `POST /api/agent/threads/:id/queue` | Queue one initial answer per thread. Requires `account_id` and `intent_evidence`; accepts `brief` and `experiment`. |
| `POST /api/agent/jobs/claim` | `{agent, limit:3}` → leased jobs with tokens, current Reddit context, previous decisions, account and checkpoint. |
| `POST /api/agent/jobs/:id/context` | `{agent, claim_token}` → refresh a claimed job. |
| `POST /api/agent/jobs/:id/checkpoint` | `{agent, claim_token, checkpoint}` → persist progress and renew the 30-minute lease. |
| `POST /api/agent/drafts` | `{job_id, agent, claim_token, kind, body, thread_context}` → file one draft **and finish its job in the same transaction**. |
| `POST /api/agent/jobs/:id/complete` | `{agent, claim_token, status, result}` → finish research, skip, fail or block. `blocked` plus `retry_after_minutes` defers transient failures. |
| `POST /api/agent/threads/:id/context` | `{target_url?}` → current context for discovery or revising a returned draft. |
| `PATCH /api/agent/drafts/:id` | Revise pending work; replies include the current `thread_context.parent`. |
| `GET /api/agent/outcomes?group_by=topic` | Latest outcomes within the returned event window, grouped by `topic`, `variant` or `subreddit`. Optional `experiment=<id>`. |

Example filing after a claim:

```json
{
  "job_id": "<claimed job UUID>",
  "agent": "reddit-worker/session-2026-10-06-12",
  "claim_token": "<returned token>",
  "kind": "reply",
  "body": "<useful answer with the account's disclosure line>",
  "thread_context": {
    "parent": {"body": "<current reader comment>"}
  }
}
```

The job supplies the account, thread and reply target. Repeating the same filing returns the existing draft. A standalone draft instead requires a stable `request_id`; queueing a separate agent task also requires `request_id`. Do not invent a new key after a timeout.

Attach `experiment: {id, topic, variant}` when queueing a thread, or `thread_context.experiment` when filing a standalone draft. Follow-ups inherit the experiment tag and retain their own draft/task evidence. Outcome counts are operational observations, not a causal claim about which wording or topic made Reddit remove something. If Engain supplies no reason, the report says so.

Legacy agent `POST /runs` and `POST /sequences/:id/runs` return `410`: they created runs without a durable retry key. Existing runs remain readable; operators can still start sequences on `/sequences`. The normal worker path uses the job queue.

## Recovery and evidence

- Claims expire after 30 minutes. A new session receives a new token and the saved checkpoint; the old token cannot file, renew or finish the job. Five exhausted attempts block for operator review.
- A publication reservation is committed **before** calling Engain. Concurrent senders cannot create a second attempt. Global, subreddit and daily pacing apply to all sends.
- Lost provider responses become `unknown`, visible in bootstrap. They never automatically resubmit. A known task ID can be reconciled without another vendor write.
- Vendor task status and Reddit `visibility` are separate. A URL alone is not publication. Verification compares thread, parent, author and approved body; 403, missing context or mismatched content means unknown.
- Reply depth is an integer separate from status: top-level comment `0`, its reply `1`, the next reply `2`. Partial Reddit trees may have unknown depth. `parent_fullname` identifies the actual parent.
- Monitor and sequence reply discovery share `followup:<Reddit comment ID>` deduplication. An edited reader comment invalidates the old claim or approval. A removed/cancelled parent blocks descendants and requests cancellation of unpublished dependent tasks.
- Definitive vendor refusal remains failed. Rewrite and review a new draft only after confirming the original was not accepted. Uncertain submissions remain held until reconciled.
- Monitoring is bounded: two vendor pages per endpoint per tick, the latest 1,000 local tasks, five due Reddit verifications per tick, and seven days of ongoing verification. These are explicit MVP limits, not complete Reddit history. Reddit's returned comment tree is also partial.

## Operator controls

The browser uses the public Supabase key for reads. Mutations go through `/api/operator` with a separate `OPERATOR_API_KEY`, entered once per browser tab. The agent key cannot approve or dispatch. `/api/dispatch` also requires the operator key. The visual page passcode is not an authorization boundary.

Manual recovery calls, with the operator key:

```json
{"reconcile_attempt":"<attempt UUID>","task_id":"<confirmed Engain task ID>"}
```

The server looks up the vendor task and compares its account, body and target before attaching it. A task absent from the inspected pages stays unresolved.

```json
{"retry_job":"<blocked or failed job UUID>","note":"<what was fixed>"}
```

Retry only applies to jobs without a filed draft. Existing drafts go through revision/review.

Pages: `/review` approves work; `/plan` shows jobs, runs and account eligibility; `/status` distinguishes verified publication from vendor reports; `/sequences` remains the optional workflow editor.

## Configuration and rollout

Server environment: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ENGAIN_API_KEY`, `AGENT_API_KEY`, `OPERATOR_API_KEY`, `CRON_SECRET`. Browser build environment: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Secrets never belong in committed files. Keep the operator and agent keys distinct.

This change needs migrations **035, 036 and 037**, in order, on the existing schema through 034. It changes worker completion and approval authorization. Pause old workers and server schedules for the coordinated rollout, set the operator key, apply migrations, deploy the matching API/UI, install protocol-2 worker instructions, then resume schedules. Do not run an old worker against the new completion RPC. Existing drafts and vendor tasks are preserved. Never roll back only the code after changing these RPCs.

Before live publication, choose an account whose attribution is true and verify it on Plan → Accounts. Use a controlled or moderator-approved test destination. The inspected live environment on 2026-10-06 had no eligible attributed account and no Engain scoring project. Skipped scoring is displayed explicitly for human review. No production migrations or public test posts were performed by the local regression suite.

## Verification

```sh
npm ci --ignore-scripts
npm test
npm run simulate
node simulation/preview.cjs
```

The simulator runs the current handlers and PostgreSQL migrations against PGlite, with invented vendor/Reddit responses and no network fallback. The report is `reports/reddit-simulation/index.html` and is served at `http://127.0.0.1:4186`. PGlite checks SQL/transactions but does not replace production multi-connection load testing. It does not test autonomous LLM judgment or live moderation.

`node simulation/check-report.cjs` checks the report in Chrome (requires an installed `playwright-core`). `node tests/review-browser.cjs` checks the actual review UI with intercepted I/O and the same Chrome dependency.

For a separate **read-only** live Engain contract check:

```sh
node scripts/engain-read-check.cjs /path/to/private/engain.env
```

This reads `.env.local` and the supplied private environment file, issues four GET requests, and prints statuses/schema summaries without API keys or comment text.
