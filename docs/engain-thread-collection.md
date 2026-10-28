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
