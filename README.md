# reddit-review

The approval screen for multi-account Reddit operations — the one place a
human decides whether a drafted comment is sent.

**Live:** https://site-phi-two-38.vercel.app/review

## Pages

- `/review` — the approval screen. **Ungated on purpose** (approving from a
  phone should not need a code); `build.js` strips the gate tag from it.
  Every other page carries the 4-digit gate.
- `/sequences` — build workflows step by step (write, approve, send, wait until
  live, wait, check replies, answer replies, agent task) and start them on a
  thread with a disclosed account. `api/_engine.js` advances runs on each tick.
- `/plan` — the planner: what is due in the next 48h and why anything is
  blocked, every run, the disclosed playbooks, and the accounts (where a human
  marks an account disclosed).
- `/audit`, `/history`, `/status`, `/queries`, `/targets`, `/topics`

## Functions

- `api/_send.js` — the one sender: disclosed accounts only (Engain
  accounts-beta), multiple accounts per thread, disclosure line required, no upvotes.
- `api/dispatch.js` — the review page calls it after Approve.
- `api/cron/tick.js` — every 15 min: sync accounts, poll what published, run
  due reply checks (a stranger's reply becomes a `draft_followup` job), send.
- `api/cron/pullback.js` — hourly; cancels vendor tasks whose approval was
  withdrawn.
- `api/agent/` — the agent-facing endpoints. The hourly agent's instructions
  are `skills/reddit-agent/SKILL.md`.

## Multi-account sequences

Use up to **5 accounts per thread** as an operational limit (not yet enforced by
SQL). See [SEQUENCES_GUIDE.md](SEQUENCES_GUIDE.md) for practical run creation,
staged conversations, profiles, timing, monitoring and endpoint examples, and the
[agent skill](skills/reddit-agent/SKILL.md) for the hourly workflow.

The engine includes `coordinated_post`, `independent_reply`, `cross_account_check`,
`personality_write` and `probabilistic_wait` handlers, but current SQL validation
rejects these types. The random-wait handler also needs completion logic. Use the
supported `write`/`wait` workflow below until those gaps are fixed. Legitimacy
assessment is a local module, not an HTTP endpoint or automatic send gate.

Actual run routes are `POST /api/agent/sequences/:id/runs` and
`GET /api/agent/sequence-runs?status=open`. The requested `/api/sequences/runs`
and `/api/legitimacy/report` paths are not implemented.

The run's `account_id` is the default. A `write`, `answer_replies`, or `agent_task`
step may override it with its own `account_id`. All participating accounts must be
active and disclosed. Each draft uses the selected account's configured disclosure.

For Account A to publish and Account B to answer it, use these steps:

```json
[
  {"type":"write","kind":"comment","account_id":"account-a","brief":"Contribute to the thread."},
  {"type":"approve"},
  {"type":"send"},
  {"type":"wait_live"},
  {"type":"write","kind":"reply","account_id":"account-b","reply_to_step":4,"brief":"Offer another perspective with your account disclosure."},
  {"type":"approve"},
  {"type":"send"},
  {"type":"wait_live"}
]
```

`reply_to_step` is a 1-based reference to an earlier `wait_live` step. Alternatively,
provide a literal `target_url`. Separate runs may also use different accounts on
one thread. Automated reply checks continue to exclude managed accounts; staged
replies use explicit write steps. Every send still needs review and duplicate
bodies remain blocked.

Apply `supabase/migrations/030-multi-account-sequences.sql` after existing schema
migrations 027–029 before deploying. It updates run creation, step validation,
review, redirects and the posting queue. Existing account disclosure lines and
run snapshots are preserved. New accounts need an operator-specific disclosure
line configured before posting.

Checks: `node checkrules.js`, `node --test tests/multi-account.test.js`,
`node checkpages.js`. SQL integration checks: `psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/multi-account.sql`
against an isolated database with schema migrations through 030 installed.

Demonstrations: [DEMO_SEQUENCES.md](DEMO_SEQUENCES.md) documents four scenarios,
the `node scripts/run_demos.js` runner, and saved execution evidence. The current
live attempt is blocked by missing configuration and DNS; fixture reports are
explicitly separated from live results.

## Env (set in Vercel, never committed)

`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ENGAIN_API_KEY`, `AGENT_API_KEY`, `CRON_SECRET`, `ENGAIN_PROJECT_ID` (required when the vendor key has multiple projects). The browser only
ever uses the anon key; the service and vendor keys are server-side only.

## Deploy

Pushes to `main` deploy to the Vercel project `site`.

## Script review hierarchy

[Script hierarchy and bulk review fix](REVIEW-HIERARCHY.md) documents migration
033, expandable scripts, individual segment review, bulk selection, Status
links and the 4/5/3-segment test fixtures. Apply the migration before deploying
the updated pages. Browser and SQL integration commands are in that document.
