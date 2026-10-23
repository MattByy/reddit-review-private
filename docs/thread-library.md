# Engain thread discovery

The writer normally calls `POST /work/next {agent}`. The server selects an eligible thread from Engain when no writing task is due, refreshes its context and creates one opening task with an assigned mode. No manual URL, Reddit login or initial test is required. See [the live runbook](agent-runbook.md).

The dashboard's **Thread library** is the catalogue of potential discussions; **Message queue** contains actual writing and delivery work. Collection alone sends no comments.

## Provider collection

`/api/cron/collect` runs hourly at minute 17. It reads Engain's `new_opportunities` and `seo_opportunities` feeds for the configured project, including the newest page and a saved backlog page. A lease prevents overlapping collection; failures retain the cursor and error. Rows upsert by canonical Reddit thread ID, preserving title, post text, URL, subreddit, age, score, comment count, relevance and provider reasons.

Selected opportunities are refreshed through Engain's individual opportunity endpoint. The production context source is Engain by default. `MESSAGE_CONTEXT_SOURCE=reddit` exists only for direct-reader diagnostics and regression compatibility.

Engain supplies the original post and engagement snapshot, not a complete comment tree. The context includes `source:engain`, `visibility:provider_reported`, `partial:true` and explicit limitations. The API retains historical field names `reddit_observation`, `reddit_checked_at` and `reddit_fresh_minutes` for compatibility; inspect the observation source instead of inferring it from those names.

A reply to our publication also fetches the Engain task and verifies its task ID, published state, exact saved body, target and returned comment URL. The writer receives that actual parent text. Unrecorded reader comments are not invented or substituted for a known parent.

## Selection settings

| Setting | Default |
| --- | --- |
| Minimum thread age | 6 hours |
| Maximum age | 60 days |
| Minimum comments | 5 |
| Minimum score | 1 |
| Minimum relevance | 0.6 on a 0–1 scale |
| Provider freshness | 24 hours |
| Context freshness | 60 minutes |

Settings are editable in **Thread library → Thread selection settings**. Candidates are ordered by relevance, then thread creation date. These filters select useful candidates; they do not establish community permission or that another comment adds value.

`GET /library` returns candidates, settings and collector status. Use `scope=all` for retained unsuitable or already-used threads, `q` for title/subreddit search and `kind` to choose a feed. `limit`, `offset` and `next_offset` paginate. The library keeps old rows; it does not silently delete them.

## Optional manual selection

All paths below are relative to `/api/agent` and use the agent bearer credential:

1. `GET /library` finds candidates. `POST /library/collect {}` refreshes the catalogue if needed.
2. `POST /library/:thread_id/refresh {}` refreshes from Engain and returns context plus `selection.reasons`.
3. `POST /library/:thread_id/queue {request_id:"<stable UUID>"}` queues an eligible opening with automatic rotation. Optional `strategy` fixes an opening outside rotation; `max_messages` and `max_depth` override the normal 6-message, 4-level limits.
4. `POST /work/next {agent}` claims due work. Read its context and write only when `can_write` is true and a useful permitted contribution exists.

The lower-level queue response retains its compatibility envelope `{experiment:…}`. Identical request UUIDs are idempotent; already-used threads are not new candidates. The isolated test lane remains available to developers through the lower-level API, but is not required by the live writing flow.

## Changes and failures

Current Engain context is checked when claiming, filing and sending; a recently fetched opportunity can be reused for up to five minutes. Openings must still pass current selection settings. Missing provider data, stale targets and failed rule checks stay visible as reasons. Unknown provider status is neither publication nor removal.

The server runs Engain's rule check before submission. A failure holds the message; an unavailable check retries. Engain performs its own delivery checks for unavailable or closed targets. The feed itself does not establish a full current moderation/lock state, so the UI labels its evidence as provider supplied.

A provider-reported publication advances only after matching the task, exact text, original target and same-thread comment URL. It sets `provider_published_at`, leaving independent `verified_at` separate. Removals stop local follow-up work. Follow-up budgets and parents are checked again each turn.
