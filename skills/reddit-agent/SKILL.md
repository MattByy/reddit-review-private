---
name: reddit-agent
description: Write live Geonode comments from Engain-discovered threads using the simple task API; the server owns automatic approval, delivery, checks and follow-up scheduling.
---

# Live comment writer

Use `AGENT_BASE_URL` (normally https://site-phi-two-38.vercel.app/api/agent) and the securely supplied `AGENT_API_KEY`. All requests send a bearer token and JSON. Keep secrets out of messages and logs.

1. `GET /writer` returns the current startup instructions and strategy configuration.
2. `POST /work/next {agent}` returns one owned writing task, automatically finding a thread through Engain when necessary. No repository setup, test lane or separate Reddit login is required.
3. Read the assigned `mode`, `prompt`, `brand`, `context`, `history`, `targets`, `limits` and checkpoint. Write only when `can_write` is true and a useful, permitted contribution exists. Engain post snapshots are partial; never invent missing replies, personal experience or independent agreement. Follow community rules and public attribution requirements.
4. Draft and edit one comment. `POST /work/:task.id {agent,lease_token,body,placement?}` saves it. Placement is the available target's `reply_mode`; later turns choose chain or sibling. Optional follow-up mode changes require `mode_reason`. Openings keep their assigned mode and brand condition.
5. Submission automatically approves and queues delivery, records the mode and approving writer, and completes the task. Request the next task within the run budget. Stop when `task:null`.

Use the same stable agent name on retries. Modes rotate in shuffled cycles: five enabled modes receive 20% each, four receive 25% each. Never reroll assignments. The server chooses delivery accounts and owns posting, task IDs, checks, URLs and follow-up scheduling. A returned publication is labelled by its evidence source; queued text is not published.

Skip unsuitable work through the submission endpoint with `{agent,lease_token,outcome:"skip",reason}`. Temporary missing context uses `outcome:"defer"` and optional `retry_minutes`; missing dependencies use `outcome:"blocked"`. Keep required attribution even when it conflicts with an opening condition; skip the task if no suitable contribution satisfies both.

Leases last 30 minutes. Save progress and renew through `/jobs/:id/checkpoint` with `{agent,claim_token:lease_token,checkpoint}`. Read the saved message before retrying an uncertain submission. Do not duplicate a saved comment or bypass a hold or removal.

`GET /work` shows comments and their Engain checks/status. Read [the runbook](../../docs/agent-runbook.md) for exact request and recovery details and [thread discovery](../../docs/thread-library.md) for optional selection controls. Actual email sending and the external writer schedule require their own integrations.
