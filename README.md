# Geonode live message queue

Production: https://site-phi-two-38.vercel.app/plan

Start with [START_HERE.md](START_HERE.md) or the dashboard's **Agent setup** tab. The agent gets a contextual writing task from Engain, writes with the assigned strategy and submits it for automatic approval and delivery.

## Agent API

Base: `https://site-phi-two-38.vercel.app/api/agent`, with `Authorization: Bearer <AGENT_API_KEY>`.

| Call | Purpose |
| --- | --- |
| `GET /writer` | Self-contained instructions, enabled modes and startup prompt |
| `POST /work/next {agent}` | Resume/claim due work or automatically find and refresh an Engain thread |
| `POST /work/:id {agent,lease_token,body,placement?}` | Approve and queue the final message, recording its mode and writer |
| `GET /work` | Comments, approval, Engain checks, publication URLs, status and reasons |

The server handles Engain authentication, accounts, rule checks, delivery, status polling and follow-up scheduling. The writer needs no Reddit login, direct Engain credential or initial test. The external agent runner controls when prose is written; server cron does not generate it.

## Message flow

1. Engain's new and SEO feeds fill the library hourly. The next-task call selects a candidate when no writing work is due.
2. A task contains the thread snapshot, mode-specific prompt, history, exact available parent text and message/depth limits.
3. Submission automatically approves and queues the exact text. The queue records mode, placement, approval time, writer and optional decision/editing provenance.
4. Every 15 minutes the server runs checks, submits due messages and polls Engain. Accepted and published remain separate states.
5. A matching Engain publication can create the next eligible reply. It must match task ID, body, original target and thread. The first reply targets the opening; later turns choose chain or sibling from returned targets.
6. A brand mention stops writing and starts seven-day monitoring. Removal stops local follow-ups. Defaults remain six messages and four levels; do not force a brand mention to consume the budget.

Engain supplies post snapshots rather than a complete comment tree. Saved replies include parent text checked against Engain. Provider publication is recorded in `provider_published_at`; independent Reddit verification remains in `verified_at`. The queue and Activity tab distinguish these sources. Direct Reddit access is optional diagnostic infrastructure.

Automatic assignments rotate in shuffled cycles across openings and replies. Every enabled mode appears once per cycle: five modes receive 20% each, four receive 25% each. Fixed openings and developer test lanes are outside rotation. Retries preserve assignments; contextual follow-up overrides require a reason and remain visible.

Write useful, openly affiliated contributions that follow community rules. Never invent reader replies, personal experiences or independent agreement. Skip unsuitable work; defer temporary missing context. The server stores provider reasons without inferring why a moderator acted.

Delivery preserves pacing: 45 minutes overall, 24 hours per subreddit and 20 per UTC day. A database reservation prevents duplicate sends. A definite rate limit retries; an ambiguous response is reconciled before any resubmission. Failed rule checks hold the message for attention. Stopping local work cannot guarantee cancellation of a task already being posted by Engain.

## Dashboard and compatibility

**Message queue** shows work and delivery state. **Strategies** configures enabled modes. **Agent setup** provides the current startup prompt. **Thread library** allows optional manual selection. Dashboard sign-in persists with a secure session cookie; no operator-key prompt is required.

Lower-level protocol-5 endpoints, tables and RPCs retain historical `experiment` names for compatibility. Their existence does not require an experiment or test phase. Legacy records stay in Archive. The old direct-reader simulations and aggregate views remain developer diagnostics; the live Activity tab counts Engain publications as well as independently verified messages.

See [the agent runbook](docs/agent-runbook.md), [thread discovery](docs/thread-library.md), [system internals](docs/message-system.md) and [Engain contract](docs/engain-messages.md). Actual email sending and a scheduled AI writer are separate integrations. Append-only audit history and adaptive scheduling remain specifications, not implemented features.

## Migrations and deployment

Apply migrations in order through **046-live-provider-work.sql** to project **wtdmwwiwnphqmkisfyrm** before deploying this version. Migration 040 provides dashboard password sessions; 041 creates message experiments, imports the latest eligible unsent standalone comment per thread without rewriting it, holds messages already needing correction, retires unfinished legacy writing jobs/runs, and enables the new engine. Older drafts and preplanned scenario messages remain in the archive. Migration 042 adds publication-triggered queue turns, explicit chain/sibling parent selection, due-time scheduling and seven-day confirmation. Existing immediate successes enter monitoring and require a fresh final check; existing bodies, provider IDs and parent links are preserved. Migration 043 adds configurable depth limits, balanced per-turn content suggestions, decision context, action metrics and text provenance; it preserves existing copy and message limits. Migration 044 adds the thread library and isolated test lane. Migration 045 adds durable shuffled mode cycles, assignment prompt snapshots and automatic approval evidence. Old assignments and text are preserved without inventing historical approval timestamps. Migration 046 adds Engain publication evidence, provider-driven follow-up advancement and atomic skip/defer handling. Deploy the updated API and dashboard after applying all migrations; no external AI runner schedule is installed.

The new tables, results views, and mutation functions are service-role only. Browser reads go through the authenticated messages API. Never apply this migration to a different connected Supabase project.

Required server environment: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY` (build), `ENGAIN_API_KEY`, `AGENT_API_KEY`, `CRON_SECRET`. Optional delivery configuration: `ENGAIN_PROJECT_ID`, `ENGAIN_DELIVERY=auto|pool|private`, `ENGAIN_PRIVATE_ACCOUNT_ID`. Keep service/provider keys on the server. Existing dashboard passwords and sessions survive this migration.

Validate locally:

```sh
npm test
npm run test:browser
node build.js
```

The browser test needs local Chrome and `playwright-core` (or `SIMULATION_PLAYWRIGHT_PATH`). Tests use real migrations and handlers with local PGlite and simulated provider/Reddit responses; they never publish to Reddit. Production deployment uses `vercel deploy --prod --yes --scope geonodebot` after the correct database migration.
