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

Threads are topped back up to `thread_target` (default 50) **at the end**. Items that stop qualifying are dropped, and the reason is kept in the history.

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

## Agent API

`POST /api/agent/task` with optional body `{"agent":"writer-1"}`. It refreshes the queue, takes item #1 off it for good and returns it. Positions renumber, and a claimed thread never comes back. It is POST because every call removes an item, so a retry or link preview with GET must not consume work.

```json
{"task_id":"t_1x8eium","status":"thread","action":"comment_on_thread","score":35,
 "why":{"parts":{...},"flags":[...]},
 "thread":{"id","url","title","body","subreddit","created_at","age_days","num_comments","comments_per_day","visits_per_month","engain_reasons","subreddit_rules":{...}},
 "claimed_at":"…","remaining":69}

{"task_id":"c_k17…","status":"comment","action":"reply_to_comment","score":92,
 "comment":{"id","permalink","body","author","brand","sentiment","created_at","age_days"},
 "thread":{…same as above…},"remaining":68}

{"status":"empty","remaining":0,"message":"…"}
```

`GET /api/agent/queue` lists the queued item IDs, kinds and positions without claiming anything.

## Cron API

`POST /api/cron/refresh` with body `{}` collects from Engain (all sources, 3 pages) and refreshes the queue when the run finishes. It returns `{"started":true,"run_id":n}`, or `{"started":false,"reason":…}` if a run is still going. Pass `{"collect":false}` to refresh the queue only. Other collect options (`max_pages`, `keywords`, `spend_quota`, `sources`) pass through.

A full collection takes several minutes at Engain's 30 requests/min. Hourly works. Mentions and opportunities are the parts that change.

Run `check-published` often (every 10–15 minutes) and `refresh` hourly.

## Auth

| Route | Rule |
| --- | --- |
| `/api/agent/*` | `Authorization: Bearer $AGENT_API_KEY` when the key is set. Without a key, only this machine may call. |
| `/api/cron/*` (`refresh`, `check-published`) | `Authorization: Bearer $CRON_SECRET`, same rule. |
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
