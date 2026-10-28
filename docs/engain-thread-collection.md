# Engain thread collection

Checked 2026-10-28 against both specs behind docs.engain.io:

- Main API: `https://docs.engain.io/api/openapi.json` (rendered at docs.engain.io)
- Accounts API (closed beta): `https://docs.engain.io/api/engain-accounts-openapi.json` (rendered at docs.engain.io/engain-accounts-beta)

`OFFICIAL-ENGAIN-API-FINDINGS.md` says accounts-beta does not exist. That is wrong: it lives in the second spec, which needs an experimental-project gate on the key.

All calls go to `https://api.engain.io` with an `X-API-Key` header. Keys need a Pro or Max plan and only reach their own workspace's projects. Most calls need a `projectId` (get it from `GET /api/v1/me`).

## Sources of threads

| Endpoint | Cost / limit | What you get |
| --- | --- | --- |
| `GET /api/v1/opportunities?type=new_opportunities` | free, 30/min | Fresh threads Engain matched to the project. `relevance`, `reasons`, post title/body/score/comments. |
| `GET /api/v1/opportunities?type=seo_opportunities` | free, 30/min | Threads that rank on Google: `serpPosition`, `estimatedMonthlyClicks`, `trafficValue`, `allRankingKeywords`. |
| `GET /api/v1/mentions` | free, 30/min | Posts and comments that mention the brand, with `sentiment` and `snippet`. Filter by `brand` or `sentiment`. |
| `POST /api/v1/smart-search {keyword}` | **1 keyword of quota**, 5/min (own bucket) | Threads Google ranks for "`keyword` reddit", plus Reddit search hits. Archived, locked, removed and NSFW threads are already dropped. |
| `GET /api/v1/smart-search/results?keyword=` | free | Re-reads a keyword this project already searched. Returns 404 if it wasn't searched; `isStale` after 30 days. |
| `GET /api/v1/smart-search/history` | free | Past searches by this key's user. |
| `GET /api/v1/opportunities/{id}` | free | Refreshes one opportunity. |

Opportunities and mentions paginate with `cursor` → `continueCursor` until `isDone`. Opportunities take `numItems` up to 500 and `sortBy`, which is one of `relevance`, `date_*`, `comments_*`, `upvotes_*` or `traffic_*`.

## Filtering before you write

- `GET /api/v1/subreddit-stats?subreddit=` (free, needs no projectId) returns:
  - `moderationLevel` (0–95)
  - `ruleFlags`: `bansSelfPromotion`, `bansLinks`, `hasKarmaOrAgeGate`, `holdsPostsForApproval`
  - `botBouncerStatus`
  - removal-rate buckets. A missing `removalRate` means fewer than 10 samples, not zero removals.
- `POST /api/v1/rule-check` and `/rule-check/batch` (up to 25 drafts against one subreddit; 5 req/min and 50 items/min) score a specific draft: `removalRisk`, `marketingIntentRisk`, `violatedRules`.
- `GET /api/v1/accounts-beta/comments/thread-check?userAccountId=&threadUrl=` warns when an account already has a comment task on the thread.

## How the local server uses this

`npm run dev` (live, needs `ENGAIN_API_KEY` in `.env.local`) or `npm run dev:mock` (invented data) starts `server/dev.cjs` on http://127.0.0.1:3000.

A collection run pulls the selected sources and merges them into one row per Reddit thread ID. It then fetches subreddit stats, cached for 24 hours, and scores every thread and comment (weights under **Rules** below).

Each thread shows the breakdown. The weights are a starting point to tune. By default, Smart Search only re-reads stored results; it spends quota only when "spend quota" (`spend_quota: true`) is set.

## The work queue

Every queue item has a **type**, and the type decides where it enters:

| Type | What it is | Enters at | Agent action |
| --- | --- | --- | --- |
| `thread` | A thread to comment on (opportunities, Smart Search) | the **end** | `comment_on_thread` |
| `comment` | One of **our own comments that Engain has published** | **position 5**, pushing everything from there down | `follow_up_on_our_comment` |
| `mention` | A competitor-mention comment (off unless `mention_comments=1`) | right after the new comments | `reply_to_comment` |

**Published check.** `POST /api/cron/check-published` reads only Engain's task list, which is a few requests. Every task with `status: published` and a `redditUrl` is saved with these fields:

- `task_id`, `type` (comment or reply)
- `reddit_url` (our comment), `thread_url`
- `content`, `subreddit`, `published_at`
- `parent_task_id` (for replies), `labels`

The thread title comes from collected data, or from the thread URL's slug.

Comments this server sees for the first time since the last refresh go in at #5, newest first, at most `comment_limit` per refresh. With 20 new comments, the thread at #6 moves to #26. A comment published more than `max_age_days` ago is not queued, and a comment that was claimed, done or skipped never comes back.

Engain does not return replies under our comment or its current votes. Reddit's JSON answers 403 from here.

Threads are added **at the end**, only while the queue holds fewer than `queue_target` (default 50) items in total. Items that stop qualifying are dropped, and the reason is kept in the history.

### Rules

**A thread is never queued if:**

- Geonode is mentioned anywhere in it (post or comment).
- We already have a live, published or moderator-removed task there (from Engain's task list).
- It was already claimed, done or skipped.
- It is older than `max_age_days` (default 120) or its date is unknown.
- It has fewer than `min_comments` (default 3) comments.
- It has no proxy/scraping relevance.
- It was found only through a brand mention. Those become comment items instead.

**A comment is queued if:**

- It mentions a competitor, not Geonode.
- The comment itself names a proxy/scraping topic. Generic words like "IP", "VPN" or "blocked" don't count on their own, and the brand's own name ("firecrawl") is ignored.
- It scores at least `min_comment_score` (default 40).
- The same thread rules apply: no Geonode mention, no existing task, not too old.

**Other rules:**

- **One item per thread.** A comment to reply to replaces a queued thread item in the same thread.
- **Thread score (0–100):**
  - Added: Engain relevance (35), Google traffic (20), Google position (5), discussion size (10), activity in comments per day (15), freshness (15, full up to 14 days and falling to 0 at `max_age_days`).
  - Subtracted: subreddit moderation/removal risk, self-promotion bans and BotBouncer.

The `min_*` and `max_age_days` values are live settings, changed with `GET` or `POST /api/settings` or the dashboard.

## Agent API: queue 1 → queue 2

There are two queues:

- **Queue 1** is the work to do: threads, our published comments and (optionally) competitor mentions.
- **Queue 2** holds items that have a message attached.

Every item in both queues carries `url` and `thread_url`:

| Type | `url` (where the message goes) | `thread_url` |
| --- | --- | --- |
| thread | the thread | the thread |
| comment | our published comment | its thread |
| mention | the competitor comment | its thread |

`POST /api/agent/task` with optional body `{"agent":"writer-1","message":"…"}` drops stale items, then moves #1 of queue 1 into queue 2 with a message in one step. The message is the one given (`message_source: "given"`) or a random placeholder (`message_source: "random"`, text starting "Placeholder message:").

The item never returns to queue 1; its history notes "Moved to queue 2 (#id)". An invalid message is rejected before anything moves.

```json
{"task_id":"p_k976…","status":"comment","url":"https://reddit.com/r/langchain/comments/1gbl08x/comment/p9gtyiu",
 "thread_url":"https://reddit.com/r/langchain/comments/1gbl08x/code_included_…","comment":{…},"thread":{…},"remaining":58,
 "queue2":{"queue2_id":5,"status":"comment","url":"…","thread_url":"…","title":"Code included: …",
   "message":"Placeholder message: …","message_source":"random","item":{…full queue 1 item…}}}
```

An empty queue 1 returns `{"status":"empty","remaining":0}`.

| Route | Purpose |
| --- | --- |
| `GET /api/agent/queue2` | Queue 2, newest first |
| `POST /api/agent/queue2/:id {"message":"…"}` | Replace an entry's message (`message_source` becomes `given`) |
| `GET /api/agent/queue` | Queue 1 IDs, kinds and positions without moving anything |

## Scheduled jobs

`npm run dev` runs two jobs inside the server (`JOBS=off` disables them). Each is also an HTTP route, so an outside cron can call it instead. Intervals are queue settings.

| Job | Every | Route | What it does |
| --- | --- | --- | --- |
| **threads** | 10 min (`threads_every_minutes`) | `POST /api/cron/threads` | See below. |
| **comments** | 30 min (`comments_every_minutes`) | `POST /api/cron/comments` | See below. |

**threads job.** With `queue_target` (default 50) or more items queued (threads and comments together), it does nothing and makes no Engain calls. Below the target, it adds threads **at the end** until the target is reached.

If the stored threads were collected more than `thread_collect_minutes` (60) ago, it first runs a collection: opportunities, Smart Search history, our tasks, and only Geonode's own mentions (to exclude threads that mention us). Competitor mentions are read too only when `mention_comments=1`.

**comments job.** It reads our Engain task list and records every task's status, with a verdict:

| Verdict | Engain statuses |
| --- | --- |
| **approved** | `published` |
| **disapproved** | `mod_removed`, `automod_removed` |
| **pending** | scheduled, in review/queue, waiting |
| **cancelled** | `cancelled` |
| **failed** | everything else |

Every status change is appended to `task_events` with its time. Newly published comments go in **at position 5 immediately**, even past the queue target. A queued comment whose task is no longer `published` is removed from the queue, and the reason ("Engain status is now mod_removed (disapproved)") is kept in its history.

- **Claims don't refill.** `POST /api/agent/task` only removes the first item and drops stale ones; refilling is the threads job's work.
- **Status and records:** `GET /api/jobs` shows the last and next run of each job. `GET /api/our-comments?verdict=` lists every recorded task with its status history.
- **Other routes:** `POST /api/cron/refresh` still runs a full collection regardless of queue size. `POST /api/cron/check-published` is an alias for the comments job.

## Auth

| Route | Rule |
| --- | --- |
| `/api/agent/*` | `Authorization: Bearer $AGENT_API_KEY` when the key is set. Without a key, only this machine may call. |
| `/api/cron/*` (`threads`, `comments`, `refresh`) | `Authorization: Bearer $CRON_SECRET`, same rule. |
| Everything else (dashboard) | This machine only. |

The server listens on `127.0.0.1` by default. `HOST=0.0.0.0` (for a remote agent or cron runner) refuses to start unless both `AGENT_API_KEY` and `CRON_SECRET` are set.

## Dashboard routes (local only)

| Route | Purpose |
| --- | --- |
| `POST /api/collect {sources, keywords, spend_quota, max_pages, enrich_limit}` | Start a collection run. Sources: `opportunities`, `mentions`, `smart_search`, `tasks`. Empty keywords re-read Smart Search history for free. |
| `GET /api/queue?history=` | Queued items plus recent claimed, done, skipped and removed items |
| `POST /api/queue/refresh {reset}` | Refresh the queue, or rebuild it from scratch |
| `POST /api/queue/:item_id {status: skipped\|done, note}` | Take an item off the queue by hand |
| `GET`/`POST /api/settings` | Queue rules |
| `GET /api/threads?q=&subreddit=&source=&available=true` | All threads with score and eligibility reasons |
| `GET /api/comments?brand=&own=&available=true&min_score=` | All mention comments with score and eligibility reasons |
| `GET /api/runs/:id` or `/api/runs/latest` | Run progress and summary |
| `GET /api/status`, `/api/subreddits`, `/api/projects`, `/api/balance`, `/api/smart-search/history` | Diagnostics |

## First live run (2026-10-28, geonode.com, 3 pages per feed)

- **Collected:** 2,169 threads and 552 mention comments (Geonode plus 10 competitors).
- **Not queueable:**
  - 1,076 threads older than 120 days;
  - 720 with fewer than 3 comments;
  - 79 that already mention Geonode;
  - 69 where moderators removed our task;
  - 11 with a published task.
- **Queueable:** 335 threads and 46 comments.
- **Queue:** 70 items. Threads at #1–4, 20 competitor comments at #5–24, then threads.

Comments come only from Engain mentions. Reddit's own JSON returns 403 to a plain local client, so comments that name no brand are not covered.

---

## Queue 2: Manual Sending to Engain

After an agent claims an item from Queue 1 and generates a message, it moves to **Queue 2** (`queue2` SQLite table). Queue 2 holds items ready to be sent to Engain using either:

1. **Pooled Delivery** (main API, `X-API-Key`): posts from a managed pool of accounts
2. **Accounts Beta** (beta API): posts from a specific user-claimed account

### Queue 2 Database Schema

The `queue2` table tracks:

- **Original fields:** `id`, `item_id`, `kind` (`thread`/`comment`/`mention`), `url`, `thread_url`, `title`, `message`, `message_source`, `item` (JSON), `created_by`, `created_at`, `updated_at`
- **Delivery fields:** `delivery_mode` (`pool`|`beta`), `user_account_id` (beta), `poster_account` (pooled, 1–40), `send_status` (`ready`|`sending`|`submitted`|`published`|`failed`|`cancelled`), `engain_task_id`, `reddit_url`, `send_error`, `send_reason`
- **Timestamps:** `reserved_at`, `sent_at`, `published_at`, `failed_at`, `last_status_check`
- **Overrides:** `thread_check_override` (for beta when account already commented)

### Engain API Mapping

| Queue2 kind | Pooled (main API) | Accounts Beta |
| --- | --- | --- |
| `thread` | `POST /api/v1/tasks/comment {projectId, url, content, posterAccount?}` | `POST /api/v1/accounts-beta/comments {userAccountId, targetUrl, body}` |
| `comment` or `mention` | `POST /api/v1/tasks/reply {projectId, url, content, posterAccount?}` | `POST /api/v1/accounts-beta/comments {userAccountId, targetUrl, body}` |

- **Pooled:** `url` is the thread or comment permalink; `posterAccount` 1–40 (optional, >=2 requires multi-account entitlement)
- **Beta:** `targetUrl` is the thread or comment permalink; `userAccountId` from `GET /api/v1/accounts-beta/accounts` (must be `usable` / `isReadyForSelection`)

### Safety Guards (Enforced Before Send)

1. **Placeholder Rejection:** Refuses `message_source === 'random'` or message starting with `"Placeholder message:"`
2. **Disclosure Requirement:** Message body must mention "GeoNode" and include disclosure language (e.g., "disclosure", "I work for")
3. **Idempotency:** Entry status must be `ready`; reservation locks prevent duplicate sends
4. **Beta Thread-Check:** `GET /api/v1/accounts-beta/comments/thread-check?userAccountId&threadUrl` blocks if account already commented (unless `thread_check_override` is set)
5. **Pacing Limits:**
   - 45 minutes between any two sends (global)
   - 24 hours between sends to same subreddit
   - 20 sends per UTC day

### Manual Send Routes

| Route | Purpose |
| --- | --- |
| `GET /api/agent/beta-accounts` | List accounts-beta accounts (username, karma, usable, isReadyForSelection) |
| `GET /api/agent/project-id` | Get pooled projectId from config or `GET /api/v1/me` |
| `POST /api/agent/queue2/:id/send {mode, userAccountId?, posterAccount?}` | Send one queue2 entry. `mode` = `pool` or `beta`. Beta requires `userAccountId`; pooled accepts optional `posterAccount` (1–40, default 1). |
| `POST /api/agent/queue2/:id/poll {}` | Poll Engain for status and save Reddit URL when published |
| `POST /api/agent/queue2/:id/override {field, value}` | Set `thread_check_override` to bypass beta duplicate comment check |

### Dashboard: Queue 2 Tab

The web dashboard (`http://127.0.0.1:3000/`) shows Queue 2 items with:

- **Status icons:** ⚪ ready, 🔵 sending, 🟡 submitted, 🟢 published, 🔴 failed, ⚫ cancelled
- **Send controls** (for `ready` items with non-placeholder message):
  - Mode selector: Pooled or Beta
  - Account selector (beta) or poster number input (pooled, 1–40)
  - Send button
- **Refresh status button** (for submitted items) to poll Engain and fetch Reddit URL

### Example Send Workflow

1. **Collect threads:** `POST /api/collect {sources, keywords}`
2. **Claim item:** `POST /api/agent/task {agent: "dashboard"}` moves #1 from Queue 1 to Queue 2 with a message
3. **Review message:** Check Queue 2 tab; replace placeholder if needed: `POST /api/agent/queue2/:id {message: "..."}`
4. **Send:** On Queue 2 tab, select mode (pooled or beta), choose account (if beta), click Send
5. **Poll status:** Click "Refresh status" until `send_status` becomes `published` and `reddit_url` appears
6. **Verify:** Open the `reddit_url` link to confirm the comment is live on Reddit

### Mock Mode Testing

Run `npm run dev:mock` to test sends against a simulated Engain that never touches real Reddit. Mock Engain:

- Returns fake task IDs and immediately marks tasks as `published`
- Provides 3 mock beta accounts (`acct_mock_1`, `acct_mock_2`, `acct_mock_3`)
- Accepts both pooled and beta requests without credentials

### Before First Live Send

1. Set `ENGAIN_API_KEY` in `.env.local` (real API key, not mock)
2. Verify every message includes GeoNode disclosure (e.g., "Disclosure: I work for GeoNode")
3. Test in mock mode first (`npm run dev:mock`)
4. Choose appropriate delivery mode:
   - **Pooled:** faster, multi-account support, less control over which account posts
   - **Beta:** full account control, thread-check gate, requires account selection
5. Respect pacing limits to avoid exceeding Reddit's natural rate and Engain's rate limits

### Pacing State

Global pacing state is tracked in the `queue2_pacing` table (single row, `id=1`):

- `last_send_global`: ISO timestamp of last send (any subreddit)
- `sends_today_utc`: count of sends in current UTC day
- `today_utc_date`: current UTC date (`YYYY-MM-DD`)
- `subreddit_last_send`: JSON object mapping subreddit name to last send timestamp

Pacing resets:

- Global 45min floor resets after each send
- Per-subreddit 24h floor resets per subreddit
- Daily 20-send cap resets at UTC midnight

### Dry-Run Script

`scripts/q2-dry-run.cjs` reads the `queue2` table and shows what WOULD be sent (both pooled and beta payloads) without actually sending anything:

```bash
node scripts/q2-dry-run.cjs
node scripts/q2-dry-run.cjs --db .data/dev.db
node scripts/q2-dry-run.cjs --limit 5
node scripts/q2-dry-run.cjs --show-placeholders
```

Displays:

- Queue2 item details (id, url, message, message_source)
- URL analysis (valid Reddit format, subreddit, thread ID)
- Disclosure check result
- Both pooled and beta Engain payloads
- Send blockers (placeholder, missing disclosure, invalid URL)
- Safety gate status (implemented vs missing)
