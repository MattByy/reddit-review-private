# Pooled accounts: active setup and first test

**Start here for the current phase. Do not set up Accounts Beta.**

Engain supplies the posting account. We supply a project, target URL and final text. Our writing agent does not choose an account, manage credentials for Reddit users or coordinate our private accounts. Engain's account allocation is a delivery detail, not permission to present staged independent endorsements.

## The two APIs

```text
Writing agent
  -> our /api/agent/messages/:id: save one final message
  -> writing job complete

Our server cron
  -> Engain /api/v1/tasks/comment or /tasks/reply
  -> save Engain task ID
  -> poll task, save returned Reddit URL
  -> verify exact text and parent on Reddit
  -> record the result and schedule the next eligible work
```

| Caller | Credential | Calls |
| --- | --- | --- |
| Writing agent | `AGENT_API_KEY` | Our agent API only |
| Server delivery scripts | `ENGAIN_API_KEY` | Engain pooled task API |
| Dashboard user | Existing password session | Our dashboard |

The writer needs no operator key, Reddit login or private-account ID. Calling Engain directly from the writer would bypass saved queue ownership and delivery reservations.

## Step 1: configuration

Use Node.js 22 or newer for the commands below. In the agent runner, provide `AGENT_API_KEY` through its secret configuration. For local use, the same key can be in ignored `.env.local`. Do not commit it.

```dotenv
AGENT_BASE_URL=https://site-phi-two-38.vercel.app/api/agent
AGENT_API_KEY=<our agent API key>
```

These are **server deployment** settings, not fields in the agent's filing request:

```dotenv
ENGAIN_DELIVERY=pool
ENGAIN_PROJECT_ID=<an accessible Engain project ID>
ENGAIN_API_KEY=<the server's Engain API key>
```

Keep the existing Supabase and cron settings. Explicit `pool` disables publishing through the private fallback. Do not choose `auto` for an intentionally pooled-only deployment: `auto` can use private delivery when no project is selected. If multiple projects exist, configure the intended one explicitly.

A changed hosting setting requires a new deployment. `GET /delivery` now returns `requested_mode` and `pooled_only`; the connection check requires `requested_mode: "pool"` and `pooled_only: true`, as well as an available pooled project. It fails if the server merely selected pool while configured as `auto`.

## Step 2: test locally without publishing

```sh
npm ci
npm run pool:test
```

The isolated test uses the actual API handlers, database migrations and cron handler with simulated Engain/Reddit responses. It verifies:

- One `direct` opening with one-message/one-level limits.
- One saved provider task using `projectId`, `url` and `content`.
- No `userAccountId`, `posterAccount`, upvote order, private-account selection or Accounts Beta submission.
- Provider acceptance remains pending until matching Reddit evidence appears.
- The verified comment URL is saved, monitoring begins and no second message exists.
- The connection-check script cannot claim jobs or post and stops on old protocol, private mode or missing credentials.

It does not contact live Reddit, use a real provider key or establish that a real comment can publish. Humanizer execution is not simulated as a real tool run.

The existing top-level cron also performs read-only legacy monitoring of private task feeds. That does not select a private account or post through Accounts Beta; this test verifies that the new pooled message uses only the pooled submission path.

## Step 3: check the live API read-only

```sh
npm run pool:check
```

[`scripts/pool-check.cjs`](../scripts/pool-check.cjs) loads `.env.local` if present, with exported variables taking precedence. It sends only:

1. `GET /api/agent/bootstrap` — require protocol `5` and workflow `message_experiments`.
2. `GET /api/agent/delivery` — require `available: true`, `mode: "pool"`, `has_project: true`, `requested_mode: "pool"`, `pooled_only: true`.

The output has `ok: true` and `posting_performed: false` on success. A failure exits with code 1 and a specific diagnostic. Do not treat any failed check as permission to switch to Accounts Beta. The script never displays keys or follows redirects with the credential.

This check means **our deployed API is locked to pooled delivery and can identify a pooled project**. It does not verify a chosen Reddit thread, run a rule check, perform the agent editing pass, ensure a particular account identity, prove public visibility or change the server's delivery setting.

If an env file contains `[SENSITIVE]`, that is a redacted export, not a usable key. The checker rejects it before sending a request. A 401 with a real key means the runner must use the currently configured `AGENT_API_KEY` from its secret store. Never copy the Engain or operator key into that field.

Do not substitute the older `scripts/engain-read-check.cjs`: it inspects Accounts Beta too and requires the server's Engain key. The pooled agent needs neither.

## Step 4: first live test — one message

The [thread library](thread-library.md) is the separate source of candidates. The agent may select a relevant permitted candidate there; the user does not need to supply a URL manually. Refresh and read the thread before queueing. If none can be verified or none permits a useful contribution, report the observed reason instead of filing arbitrary text.

Use a useful, factual message with clear attribution in the body, for example a truthful “Posting on behalf of Geonode” introduction. Do not assume a pooled username itself identifies Geonode or invent a customer experience. The default polishing step is a separate agent editing pass, honestly recorded as `agent:self-edit`; an external service is optional unless the launcher explicitly requires one.

All requests below use **our API**, relative to `AGENT_BASE_URL`, with the agent bearer credential and JSON bodies.

1. `GET /bootstrap`, then `GET /delivery` (the connection checker performs these).
2. `GET /library` to find candidates. If needed, `POST /library/collect {}` refreshes Engain discovery without creating jobs. `POST /library/:thread_id/refresh {}` returns fresh context in `reddit_observation` and selection reasons. Read that context and current community rules; `selection.eligible` only proves basic filters.
3. Generate and persist a stable request UUID, then `POST /library/:thread_id/queue`:

```json
{
  "request_id": "<saved UUID>",
  "queue_lane": "test",
  "strategy": "direct",
  "max_messages": 1,
  "max_depth": 1
}
```

Queueing rechecks the candidate and creates one writing job. It does not send. Save the returned `experiment.id`; reuse identical parameters and UUID after a lost response. An explicitly supplied registered target can use `/threads/:thread_id/queue` with the same lane and limits.

4. Claim exactly this test:

```json
{
  "agent": "<unique run label>",
  "kinds": ["write"],
  "limit": 1,
  "queue_lane": "test",
  "experiment_id": "<returned experiment.id>"
}
```

Send to `POST /jobs/claim`. The server requires an exact experiment ID for test claims. Normal claims default to `work` and cannot take test jobs; this test claim cannot take normal work or another test. Check `actionable` before drafting. The test shares delivery pacing with normal work and is a real send after filing, not a sandbox.

5. Read the job, prepare the one attributed message, perform the clarity edit, and checkpoint. Then `POST /messages/:message_id`:

```json
{
  "agent": "<same run label>",
  "claim_token": "<token from the current claim>",
  "reply_mode": "opening",
  "content_action": "direct",
  "body": "<one relevant final message, clearly identifying the Geonode affiliation>",
  "draft_body": "<exact text before the editing pass>",
  "humanization": {
    "tool": "agent:self-edit",
    "meaning_preserved": true
  },
  "rationale": "One attributed contribution for the designated pooled delivery test."
}
```

The runbook contains the full checkpoint request and validation rules. The server derives `contains_brand` from final text and saves the thread target. Do not send a made-up comment URL: the new comment does not exist yet.

**Filing is the send handoff.** There is no separate approval or writer-side Engain call. The server cron handles the rest under the normal pacing limits.

## Step 5: inspect evidence, do not repeat the send

The writer can finish its invocation after successful filing. For test inspection, read `GET /messages/:message_id` or the dashboard’s **Isolated tests** filter. Test flows are excluded from normal experiment statistics. Scheduled server scripts, not an AI polling loop, observe progress.

| Evidence | What it proves |
| --- | --- |
| `status: queued` | Final text saved for delivery |
| `task_id` present | Engain task accepted and linked |
| `provider_status: published` | Engain reports publication |
| `reddit_url` present | A returned permalink is saved; check its verification too |
| `verified_at` present and matching visible evidence | Our server verified the submitted comment |
| Flow `brand_visible_at` present | Brand publication observed; writing stops |
| Flow `status: monitoring` | Current seven-day checks underway |
| Flow `success_at` present | Current protocol-5 seven-day criterion met |

Report the experiment ID, message ID, provider task ID, returned URL and **observed** result. No task/URL yet is not a reason to create another experiment. A Reddit 403 is “unconfirmed,” not an approval or rejection. A removal ends this flow; do not work around it through another account or branch.

Current pacing remains 45 minutes globally, 24 hours per subreddit and 20 sends per UTC day. An empty test queue does not automatically reset earlier sending history. Check the saved reason and due times if delivery is pending.

## After the first test

Only call live delivery verified after task acceptance **and** matching Reddit visibility evidence. Local test success and a green connection check are separate milestones. Keep Accounts Beta deferred while investigating pooled failures.

For ordinary authorized writing jobs, follow [the daily agent runbook](agent-runbook.md). The agent still files one message at a time; transport account selection stays with Engain. [The system reference](message-system.md) explains all later states and limits. [The provider contract](engain-messages.md) is for maintaining server scripts, not a second set of posting instructions for the writer.
