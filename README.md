# Geonode Reddit message experiments

**New agent? Read [START_HERE.md](START_HERE.md) first. Current phase: pooled delivery only. Accounts Beta is deferred.**

Production: https://site-phi-two-38.vercel.app/plan

## Documentation

| Document | Purpose |
| --- | --- |
| [Start here](START_HERE.md) | Exact entrypoint and reading order for a fresh agent |
| [Pooled accounts — active](docs/pooled-accounts.md) | Setup, read-only connection check and isolated one-message test |
| [Accounts Beta — deferred](docs/accounts-beta.md) | Separate private-account reference; not part of the pooled trial |
| [System reference](docs/message-system.md) | Architecture, queues, states, script ownership, delivery and implementation gaps |
| [Daily agent runbook](docs/agent-runbook.md) | Fresh-start prompt, decision procedure, exact API fields, checkpoints and recovery |
| [Tracking specification](docs/message-tracking.md) | Planned append-only history, complete failed paths, immediate publication goal and separate monitoring |
| [Agent skill](skills/reddit-agent/SKILL.md) | Short entrypoint for each writing invocation |
| [Engain contract](docs/engain-messages.md) | Provider payloads, statuses and source references |

The operational overview below describes protocol 5 through migration 043. The new documentation distinguishes this implementation from the requested tracking changes: immediate publication success, append-only message events and complete failed-path reports are **not implemented yet**. Current `success_at` and success charts still use the seven-day criterion. The queue-allocation simulation is a proposal, and a daily AI runner must be configured separately.

These worker instructions cover disclosed Geonode participation that follows community rules. Public attribution must be established before filing; the current message workflow does not provide a dedicated server disclosure gate for pooled delivery identities. Do not use multiple accounts to manufacture independent agreement or use removals to choose alternate promotional branches.

## Operational overview

The unit of work is a message. Queue a Reddit thread, choose an opening strategy (or balance automatically), and prepare only its next message. Account allocation belongs to delivery; the dashboard has no account picker, playbook builder, or approval step.

## Queue sequence

1. Queue any number of threads. Each starts with exactly one opening message and one of five opening strategies. Only the direct strategy names Geonode in the opening.
2. A writing worker claims a due message and reads fresh thread context. The dashboard also supports entering the current message directly.
3. The server checks, reserves and submits the exact text to Engain, saves its task ID, then saves the Reddit URL returned on publication. Engain status and verified Reddit visibility are separate facts.
4. A verified unbranded message returns to the writing queue with its ID, URL and next due time. No other future messages exist. The first follow-up must reply to the opening. After that, the worker explicitly selects **chain** (reply to the latest publication) or **sibling** (reply to that publication's parent), then decides whether to mention Geonode.
5. A verified Geonode mention stops further writing and enters **monitoring**. A fresh visibility check at or after seven days from first verification, with no observed removal, confirms **success**. Missing checks stay unconfirmed.
6. Removal stops the experiment and local pending work. New experiments default to 6 total messages and 4 levels. At the depth ceiling, only a sibling can continue; at the message ceiling, writing stops even without a brand mention. The scheduler handles due times and transient failures; `wait` is not a conversation action.

A message stores both its chronological posting number and tree depth, the publication that triggered its queue turn (`previous_message_id`), its chosen reply parent, reply mode, decision reason, provider task ID and Reddit permalink. A six-message test can form levels `1,2,2,3,3,4`. Shapes emerge from successive decisions; they are not scripted in advance.

Success rates use completed tests (seven-day success, removal, or exhausted depth). Pending writing/monitoring, manually stopped, and delivery-blocked tests are excluded. The dashboard separates first verified brand mentions from seven-day successes, shows posting count and observed depth/parent sequences, and labels observational comparisons. Imported messages retain their wording and are excluded from trial statistics.

Writers follow community rules and required attribution. Do not fabricate personal experience, independent customers or endorsements. Risk scores and observed removals do not establish why content was removed. Intermittent checks establish observed visibility, not proof of uninterrupted availability.

## Agent decision context

Each due job returns `decision_context`: limits and remaining messages, the five content actions with 20% targets, a persisted balanced suggestion, assignment counts per stage, brand constraints, current parent options and considerations. The worker uses this alongside its own prompt. Opening strategies remain fixed; first and later replies receive least-assigned suggestions with random tie-breaking. The agent selects chain/sibling for relevance, chooses its content action, and records a reason when overriding the suggestion. Follow-up brand relevance is independent of those choices. No future conversation is generated.

The Results tab compares suggested and chosen actions separately for openings, first replies and later replies. It shows sample counts, verified publications, pending work, removals and overrides. Published/written percentages include pending messages and are provisional; assignment shares are not success shares. Existing unlabeled text is not retroactively classified.

Text polishing belongs to the writing agent: draft, perform a separate clarity edit, check meaning/facts/attribution/brand presence, then file final text. Record the default edit as `tool: "agent:self-edit"`; use an external editor only if configured. Optional `draft_body` and `humanization: {tool, meaning_preserved: true}` record agent-reported provenance. Brand presence must be preserved. No external humanizer is required by default. Missing metadata is never represented as a successful tool run.

## Delivery and API contract

Use `ENGAIN_DELIVERY=pool` on the server for the current pooled-only phase, with an accessible project. The writer does not choose accounts. `npm run pool:test` exercises an isolated local flow with simulated external services; `npm run pool:check` only reads our live bootstrap and delivery capability using the agent key. See [the pooled guide](docs/pooled-accounts.md) for exactly what each check establishes.

The adapter also supports `ENGAIN_DELIVERY=auto`, which can fall back to private-account delivery without a selected project; do not use that setting for a deliberately pooled-only deployment. [The Engain contract notes](docs/engain-messages.md) distinguish the two payloads. Changing docs does not set the deployed environment, and current `/delivery` does not expose that environment setting.

Delivery preserves existing pacing: 45 minutes overall, 24 hours per subreddit, 20 per UTC day. One database reservation prevents concurrent senders and browser edits from duplicating a task. A definite HTTP 429 schedules a retry. A timeout or ambiguous response is reconciled against provider tasks before proceeding and never blindly resubmitted. If no unique task can be identified, its state remains `unknown`.

Stopping an experiment stops its local queue immediately. Engain restricts cancellation of already submitted tasks (including its 24-hour eligibility window and work already started); the queue reports whether cancellation was accepted. Stopping cannot guarantee removal of a message already being posted.

## Workers and endpoints

The server clock observes outcomes and delivers queued text every 15 minutes. It does **not** generate prose by itself. A writing agent uses [skills/reddit-agent/SKILL.md](skills/reddit-agent/SKILL.md), or a signed-in user writes the current message in the queue. Existing scheduled worker sessions must read the updated protocol-5 bootstrap/skill.

Agents use `Authorization: Bearer $AGENT_API_KEY`:

- `GET /api/agent/bootstrap`: workflow version, unfinished work, discovery queries, instructions.
- `POST /api/agent/jobs/claim {agent,kinds:["write","agent_task"],limit:3}`: claim durable work and fresh context.
- `POST /api/agent/threads`: register a discovered thread.
- `POST /api/agent/threads/:id/queue {request_id,strategy?,max_messages?,max_depth?}`: start an experiment with a stable UUID; retrying returns the same experiment.
- `POST /api/agent/messages/:id {agent,claim_token,reply_mode,content_action,action_override_reason?,body,rationale,draft_body?,humanization?}`: file the current message and complete its job atomically. The initial brand condition is enforced.
- `POST /api/agent/jobs/:id/context`, `/checkpoint`, `/complete`: refresh context, preserve work, defer or skip with a reason. Lease tokens fence stale workers.
- `GET /api/agent/experiments`: queue and full-history strategy/depth results.
- `GET /api/agent/delivery`: read-only provider capability check.

The dashboard uses `GET /api/messages` and session-authenticated `POST /api/messages` with `action=start|edit|stop`. It has no operator-key prompt. Sign in once with the dashboard password; an opaque Secure/HttpOnly/SameSite=Strict cookie lasts 30 days. Mutations require same-origin requests. Operator bearer authentication remains available to existing automation, but is not needed by dashboard users.

Legacy records remain in Archive. Legacy account/playbook routes cannot start new runs when message workflow is enabled; old submission and reader-followup engines are bypassed. Already submitted legacy tasks continue to be monitored without generating new reply jobs.

## Migrations and deployment

Apply migrations in order through **043-message-decision-context.sql** to project **wtdmwwiwnphqmkisfyrm** before deploying this version. Migration 040 provides dashboard password sessions; 041 creates message experiments, imports the latest eligible unsent standalone comment per thread without rewriting it, holds messages already needing correction, retires unfinished legacy writing jobs/runs, and enables the new engine. Older drafts and preplanned scenario messages remain in the archive. Migration 042 adds publication-triggered queue turns, explicit chain/sibling parent selection, due-time scheduling and seven-day confirmation. Existing immediate successes enter monitoring and require a fresh final check; existing bodies, provider IDs and parent links are preserved. Migration 043 adds configurable depth limits, balanced per-turn content suggestions, decision context, action metrics and text provenance; it preserves existing copy and message limits.

The new tables, results views, and mutation functions are service-role only. Browser reads go through the authenticated messages API. Never apply this migration to a different connected Supabase project.

Required server environment: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY` (build), `ENGAIN_API_KEY`, `AGENT_API_KEY`, `CRON_SECRET`. Optional delivery configuration: `ENGAIN_PROJECT_ID`, `ENGAIN_DELIVERY=auto|pool|private`, `ENGAIN_PRIVATE_ACCOUNT_ID`. Keep service/provider keys on the server. Existing dashboard passwords and sessions survive this migration.

Validate locally:

```sh
npm test
npm run test:browser
node build.js
```

The browser test needs local Chrome and `playwright-core` (or `SIMULATION_PLAYWRIGHT_PATH`). Tests use real migrations and handlers with local PGlite and simulated provider/Reddit responses; they never publish to Reddit. Production deployment uses `vercel deploy --prod --yes --scope geonodebot` after the correct database migration.

## Interactive simulation

For the simple queue view, run `npm run simulate:queue` and open `reports/reddit-simulation/queue.html`. It shows 50 fictional threads, publication outcomes, returning reply/branch decisions and immediate brand badges. Its adaptive allocation of new threads and follow-ups is an illustrative scheduling proposal, not a change to the deployed claim scheduler.

Run `npm run simulate`, then open `reports/reddit-simulation/index.html`, or use `npm run simulate:preview` at `http://127.0.0.1:4186`. `npm run simulate:check` checks the report in Chrome. The standalone report embeds its evidence and needs no API connection.

Thirteen executable scenarios show fresh writer wake-ups, received context, example decisions and text, exact mocked Engain requests/responses, publication verification, branching, removal, limits, rate limiting, uncertain submission recovery, unreadable Reddit, private delivery, missing humanizer, lease recovery and balanced opening allocation. Each scenario runs the production handlers and migrations in a new local PGlite database. Provider/Reddit responses and writer/humanizer choices are fixtures; long intervals age local timestamps rather than waiting in real time. No live API, production database or real posting is used.

The report preserves current limitations: Engain rule-check failures hold text without creating an automatic rewrite job; the missing-humanizer simulation represents an explicitly required external editor; unknown Reddit visibility cannot advance the queue. Passing replay assertions verify these behaviors, not that every scenario succeeds or that live delivery is working.

## Thread discovery

[Thread library](docs/thread-library.md) collects Engain opportunities hourly, stores freshness and engagement separately from writing jobs, and rechecks selected threads. Start the first live test with `queue_lane: "test"` and claim only its `experiment_id`. `/delivery` exposes the deployed pool lock; `npm run pool:check` verifies it. See [START_HERE.md](START_HERE.md) for a fresh agent. Migration 044 adds the library and isolated test lane.
