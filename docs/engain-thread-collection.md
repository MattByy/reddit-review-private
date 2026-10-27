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

A collection run pulls the selected sources and merges them into one row per Reddit thread ID. It then fetches subreddit stats, cached for 24 hours, and ranks threads from 0 to 100:

- **Added:** relevance (35), Google traffic (25), discussion size (15), Google position (10), freshness (15).
- **Subtracted:** subreddit moderation/removal risk (up to 25), a self-promotion ban (10), BotBouncer (8), and age over 6 months, since the thread may be archived (20).

Each thread shows the breakdown. The weights are a starting point to tune. By default, Smart Search only re-reads stored results; it spends quota only when "spend quota" (`spend_quota: true`) is set.

## Queue and relevant comments

**Queue.** The collector reads Engain's task list (`GET /api/v1/tasks`). Any thread with a live, published or moderator-removed task counts as already engaged; cancelled tasks don't count. `POST /api/queue/build {size:50}` fills the queue with the top N available threads. A thread is available if it is:

- not already engaged,
- not older than 6 months,
- not marked skipped or done.

Skipped and done entries are kept and never re-added.

**Comments.** Engain does not return comment trees, and `www.reddit.com/*.json` answers 403 from a plain local client. The only comment source is therefore `GET /api/v1/mentions`. It tracks Geonode and competitor brands (`GET /api/v1/mentions/brands`: brightdata, oxylabs, firecrawl, serpapi, iproyal and others). Most mentions are comments with `commentContent.body` and `permalink`.

Comments are scored 0–100:

- **Required:** at least one proxy/scraping topic term in the comment or thread title. Without one the score is 0, which drops off-topic hits such as sponsorship chatter.
- **Added:** question or comparison intent, brand and sentiment (a negative competitor mention or a negative Geonode mention scores highest), and recency.
- **Subtracted:** age over 6 months.

The brand's own name is removed before topic matching, so "firecrawl" doesn't count as "crawl".

A thread found only through a mention has no Engain relevance score. It earns relevance from an on-topic title or body (0.5), or from its best on-topic comment (that comment's score ÷ 100). With neither, it is off-topic and never queued.

Collecting all tracked brands takes roughly 1 request per brand per page. Subreddit stats are looked up only for the best 100 candidates per run (`enrich_limit`) and cached for 24 hours. The first live run found about 500 distinct subreddits, which would take 17 minutes at 30/min.

First live run (2026-10-28, geonode.com, 3 pages per feed):

- 2,169 threads and 552 mention comments, 217 of them scoring 40 or more.
- About 120 opportunity threads excluded: 83 likely archived, 39 where moderators removed our earlier task.
- The top-50 queue scored 55–33. 18 queued threads had a relevant comment attached.

| Route | Purpose |
| --- | --- |
| `POST /api/collect {sources, keywords, spend_quota, max_pages}` | Start a background run. Sources: `opportunities`, `mentions`, `smart_search`, `tasks`. Empty keywords re-read Smart Search history for free. |
| `POST /api/queue/build {size, min_score}` / `GET /api/queue` | Build or read the queue, with each thread's relevant comments |
| `POST /api/queue/:thread_id {status: queued\|skipped\|done, note}` | Update a queue entry |
| `GET /api/comments?brand=&own=&min_score=&q=` | Relevant mention comments |
| `GET /api/runs/:id` or `/api/runs/latest` | Progress and summary |
| `GET /api/threads?q=&subreddit=&source=&min_score=` | Ranked threads |
| `GET /api/threads/:id` | One thread with full body |
| `GET /api/subreddits` | Cached subreddit stats |
| `GET /api/status`, `/api/projects`, `/api/balance`, `/api/smart-search/history` | Diagnostics |

Data lives in `.data/dev.db` (SQLite, gitignored). This server is separate from the deployed Vercel/Supabase app and never posts anything.
