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

This guide does not change deployed environment variables. A setting changed on the hosting platform needs a deployment that uses it. The current `/delivery` response reports the selected capability, not the configured `ENGAIN_DELIVERY` value, so the connection check cannot prove this setting is locked to pool.

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
2. `GET /api/agent/delivery` — require `available: true`, `mode: "pool"`, `has_project: true`.

The output has `ok: true` and `posting_performed: false` on success. A failure exits with code 1 and a specific diagnostic. Do not treat any failed check as permission to switch to Accounts Beta. The script never displays keys or follows redirects with the credential.

This check means **our API can currently identify a pooled delivery capability**. It does not verify a chosen Reddit thread, run a rule check, configure a humanizer, ensure a particular account identity, prove public visibility or change the server's delivery setting.

Do not substitute the older `scripts/engain-read-check.cjs`: it inspects Accounts Beta too and requires the server's Engain key. The pooled agent needs neither.

## Step 4: first live test — one message

Use a designated permitted test thread and an isolated queue/workspace. The current claim API does not filter by experiment ID; a busy production queue can return someone else's earlier job. Do not bulk-claim unrelated work to reach a test item. If the queue is not isolated or no target has been designated, report that condition and finish after the read-only checks.

Use a useful, factual message with clear attribution in the body, for example a truthful “Posting on behalf of Geonode” introduction. Adequate in-message attribution does not require the worker to obtain a private-account profile. Do not assume a pooled username itself identifies Geonode, or invent a customer experience. Use the actual configured humanizer as required by the writing runbook.

For this first transport test, **one direct opening is enough**. It exercises the whole submit → task → URL → verification path without a planned conversation.

All requests below use **our API**, relative to `AGENT_BASE_URL`, with `Authorization: Bearer <AGENT_API_KEY>` and JSON bodies. Replace placeholders with real designated values.

1. `GET /bootstrap`, then `GET /delivery` (the connection-check command already performs these).
2. If the designated thread is not registered, `POST /threads`:

```json
{
  "id": "<Reddit thread ID>",
  "url": "<canonical permitted thread URL>",
  "title": "<actual thread title>",
  "subreddit": "<actual subreddit>",
  "discovery": {
    "source": "designated-pooled-test",
    "query": "",
    "intent_evidence": "<why this factual contribution is relevant and permitted>"
  }
}
```

3. Generate and persist a stable request UUID, then `POST /threads/:thread_id/queue`:

```json
{
  "request_id": "<saved UUID>",
  "strategy": "direct",
  "max_messages": 1,
  "max_depth": 1
}
```

Reuse the same UUID and parameters after a lost response. This creates one message to write; it does not post yet. Save the returned experiment ID.

4. `POST /jobs/claim` with `{ "agent": "<unique run label>", "kinds": ["write"], "limit": 1 }`. Verify the job's experiment ID matches the designated test and `actionable` is true. If it differs, do not file against it; record the mismatch through the runbook's job deferral procedure and stop this test.
5. Read the job, prepare the one attributed message, run the configured text tool, and checkpoint. Then `POST /messages/:message_id`:

```json
{
  "agent": "<same run label>",
  "claim_token": "<token from the current claim>",
  "reply_mode": "opening",
  "content_action": "direct",
  "body": "<one relevant final message, clearly identifying the Geonode affiliation>",
  "draft_body": "<exact source text passed to the actual configured tool>",
  "humanization": {
    "tool": "<actual tool identifier>",
    "meaning_preserved": true
  },
  "rationale": "One attributed contribution for the designated pooled delivery test."
}
```

The runbook contains the full checkpoint request and validation rules. The server derives `contains_brand` from final text and saves the thread target. Do not send a made-up comment URL: the new comment does not exist yet.

**Filing is the send handoff.** There is no separate approval or writer-side Engain call. The server cron handles the rest under the normal pacing limits.

## Step 5: inspect evidence, do not repeat the send

The writer can finish its invocation after successful filing. For test inspection, read `GET /messages/:message_id` or the dashboard. Scheduled server scripts, not an AI polling loop, observe progress.

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
