# reddit-review

The approval screen for Geonode's Reddit scenario system — the one place a
human decides whether a drafted comment is sent.

**Live:** https://site-phi-two-38.vercel.app/review

Split out of `geonode-strategy/04-reddit/site` (2026-10-02) with its full
history. The scripts that generate drafts and talk to the vendor still live in
`geonode-strategy/04-reddit/scripts`; this repo is the review surface only.

## Pages

- `/review` — the approval screen. **Ungated on purpose** (approving from a
  phone should not need a code); `build.js` strips the gate tag from it.
  Every other page carries the 4-digit gate.
- `/plan` — the planner: what is due in the next 48h and why anything is
  blocked, every run, the disclosed playbooks, and the accounts (where a human
  marks an account disclosed).
- `/audit`, `/history`, `/status`, `/queries`, `/targets`, `/topics`

## Functions

- `api/_send.js` — the one sender: disclosed accounts only (Engain
  accounts-beta), one account per thread, disclosure line required, no upvotes.
- `api/dispatch.js` — the review page calls it after Approve.
- `api/cron/tick.js` — every 15 min: sync accounts, poll what published, run
  due reply checks (a stranger's reply becomes a `draft_followup` job), send.
- `api/cron/pullback.js` — hourly; cancels vendor tasks whose approval was
  withdrawn.
- `api/agent/` — the agent-facing endpoints. The hourly agent's instructions
  are `skills/reddit-agent/SKILL.md`.

Schema: `geonode-strategy/04-reddit/supabase/migrations/027-disclosed-planner.sql`
(accounts, jobs, claim_jobs, plan_timeline, the `d_*` playbooks).

Checks: `node checkrules.js` (disclosure rule), `node checkpages.js`.

## Env (set in Vercel, never committed)

`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ENGAIN_API_KEY`, `AGENT_API_KEY`, `CRON_SECRET`. The browser only
ever uses the anon key; the service and vendor keys are server-side only.

## Deploy

Pushes to `main` deploy to the Vercel project `site`. Docs for the page
itself: `geonode-strategy/04-reddit/03-REVIEW-PAGE.md`.
