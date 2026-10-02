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
- `/audit`, `/history`, `/status`, `/queries`, `/targets`, `/topics`

## Functions

- `api/dispatch.js` — runs the rule ladder, the vendor rule-check and the
  send. Cron every 15 min retries anything stuck.
- `api/cron/pullback.js` — hourly; cancels vendor tasks whose approval was
  withdrawn.
- `api/agent/` — the agent-facing endpoints.

## Env (set in Vercel, never committed)

`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ENGAIN_API_KEY`. The browser only
ever uses the anon key; the service and vendor keys are server-side only.

## Deploy

Pushes to `main` deploy to the Vercel project `site`. Docs for the page
itself: `geonode-strategy/04-reddit/03-REVIEW-PAGE.md`.
