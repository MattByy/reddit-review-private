# Live message writer

Production: https://site-phi-two-38.vercel.app/plan#agent

Give the agent `AGENT_BASE_URL=https://site-phi-two-38.vercel.app/api/agent` and the existing `AGENT_API_KEY` through its secret configuration. The dashboard's **Agent setup** tab contains the current startup prompt. No repository setup, transport test or Reddit login is required to write.

1. `GET /writer` reads the instructions and enabled strategies.
2. `POST /work/next {"agent":"your-stable-writer-name"}` returns one task. It resumes owned work, claims due work, or finds and refreshes a thread through Engain.
3. Read `task.prompt`, `context`, `history`, `targets`, `brand` and `limits`. Write with `task.mode`. Submit `POST /work/:task.id` with `agent`, `lease_token`, `body` and `placement` when choosing between targets.
4. Request the next task within the runner's budget. `GET /work` shows comments, approval, mode, Engain checks and delivery status.

All calls use `Authorization: Bearer <AGENT_API_KEY>` and JSON. Paths above are relative to `AGENT_BASE_URL`. Never put secrets in comment text or logs.

Submission automatically approves and queues the exact text. Server checks and delivery run every 15 minutes; existing pacing limits still apply. Engain chooses the posting account. Published comments can queue the next eligible reply with the saved parent text. The writer does not wait for approval or poll Engain itself.

Five enabled modes receive one assignment each per shuffled cycle (20% each); four receive 25% each. Assignments survive retries. The queue records the submitted mode and any justified follow-up override.

Engain supplies thread snapshots, not a complete comment tree. Reply tasks include our saved parent's text and Engain publication evidence. The agent must not invent missing replies or personal experiences. Public contributions must follow community rules and attribution requirements. Skip work when no useful permitted contribution exists.

The server distinguishes **published by Engain** from **independently verified on Reddit**. It does not need direct Reddit access to advance the Engain workflow.

Use [the agent runbook](docs/agent-runbook.md) for request examples and recovery, and [the thread library guide](docs/thread-library.md) for discovery settings. The writer runs in your existing agent runner; server cron handles delivery, collection and checks, not prose generation. Actual email sending is a separate integration and is not part of these Reddit task endpoints.
