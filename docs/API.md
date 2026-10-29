# API guide

Everything the dashboard does can also be done over HTTP: collecting threads, the two queues, writing, approving and sending, tracking, prompts and their percentages, models, and the model test. This guide is for anyone who wants to test the system or write prompts from a script or another tool.

- **Base URL:** `http://127.0.0.1:3000` (start it with `npm run dev`, or `npm run dev:mock` for invented data with no Engain calls).
- **Format:** JSON in, JSON out. Errors come back as `{"error":"..."}` with an HTTP status (404 not found, 409 not allowed right now, 422 bad input, 502 a model or Engain failed).
- **List of every route:** `GET /api`.

## Access

| Caller | Dashboard routes (`/api/...`) | Agent routes (`/api/agent/...`) | Cron routes (`/api/cron/...`) |
| --- | --- | --- | --- |
| This machine | Open | Open, or `AGENT_API_KEY` if set | Open, or `CRON_SECRET` if set |
| Another machine | `AGENT_API_KEY` | `AGENT_API_KEY` | `CRON_SECRET` |

Send the key as `Authorization: Bearer <key>`. To let someone else reach the server:
1. Set `AGENT_API_KEY` and `CRON_SECRET` in `.env.local`.
2. Start with `HOST=0.0.0.0 npm run dev`. The server refuses a non-local `HOST` without both secrets.
3. The dashboard page itself only opens on this machine.

The examples below assume this machine. From elsewhere, add `-H "Authorization: Bearer $AGENT_API_KEY"`.

```bash
API=http://127.0.0.1:3000
j() { curl -s -H 'Content-Type: application/json' "$@"; }   # small helper
```

## What posts to Reddit, and what doesn't

Only two calls post anything: **`POST /api/agent/queue2/:id/approve`** and **`POST /api/agent/queue2/:id/send`**. Both create a real Engain task, which ends up as a real Reddit comment.

Everything else is safe to call while testing:
- reading;
- writing drafts;
- trying prompts;
- the model test;
- Engain rule-check scoring;
- changing settings.

Every message must say the writer works at Geonode. The send step refuses a message without that (for example "I work at Geonode" or "Disclosure: I work for Geonode"). "We at Geonode" is not enough.

## How the pieces fit

```
Engain ──collect──▶ threads + comments ──rank──▶ Queue 1 ──take #1──▶ Queue 2 ──write──▶ draft
                                                                           │
                                       Sent tracking ◀──approve & send─────┘
```

1. **Queue 1** holds ranked items: `thread` means comment on a thread; `comment` means follow up under our own published comment. Only comments posted from our own accounts after the fresh start get a follow-up (the reply then goes through the pool); pool comments and older ones are ignored.
2. **Taking #1** moves it to **Queue 2**, where a message is written: by a model from the type's prompts (split by percentage), or given by you.
3. **Approve** sends it. Engain's pool and our own accounts take turns in each thread (see Routing below).
4. **Sent** tracks Engain's status until it is final.

---

## Prompts

There are three prompt **types**: `thread` (first comment in a thread), `comment` (follow-up under our own comment) and `mention` (reply to a competitor mention; off by default).

- **Several prompts per type:** each type can have up to 10 prompts.
- **Percentages:** each prompt has a percentage of that type's drafts, and the percentages add up to 100. The split is exact: with 60/40, ten drafts give 6 and 4. A prompt at 0% is paused.
- **Model per prompt:** each prompt can have its own `provider` (`openrouter` or `featherless`), `model` and `temperature` (0–2, default 0.7). Without a model, OpenRouter prompts use the default model (`anthropic/claude-sonnet-5.5`). Featherless prompts always need a model.

### Variables

Write `{{name}}` in a prompt and it is filled in per item:

| Variable | Types | Value |
| --- | --- | --- |
| `{{subreddit}}`, `{{title}}`, `{{body}}`, `{{url}}` | all | The thread (body clipped to 4,000 characters) |
| `{{our_comment}}`, `{{our_comment_url}}` | comment | Our earlier published comment |
| `{{their_comment}}`, `{{brand}}` | mention | The competitor-mentioning comment |
| `{{style_examples}}` | all | 2–3 real comments people wrote, from the same subreddit when possible, for tone. Comments that mention Geonode are left out |

A model that answers exactly `SKIP` marks the item as "nothing useful to add".

### Read

```bash
curl -s $API/api/prompts                      # all prompts, per-prompt stats, built-in default + natural texts, variables
curl -s $API/api/prompt-variants/v_default_thread   # one prompt
```

`GET /api/prompts` returns:
- `variants`: per type, the list of `{id, name, text, weight, provider?, model?, temperature?}`;
- `stats`: per type and prompt, the counts drafted, sent, published, removed, failed, cancelled and pending, plus the publish rate;
- `defaults` and `natural`: the built-in prompt texts;
- `variables`, `model` (the default OpenRouter model), `openrouter_key`, `featherless_key` and `shortlist`.

### Add one prompt

New prompts start at **0%**. Give `text`, or `"style":"natural"` / `"style":"default"` to start from a built-in.

```bash
j -X POST $API/api/prompt-variants -d '{"type":"thread","name":"Casual MiniMax","style":"natural",
  "provider":"featherless","model":"MiniMaxAI/MiniMax-M3","temperature":0.8}'
# → {"type":"thread","variant":{"id":"v_3f2a…","name":"Casual MiniMax","weight":0,…},"variants":[…]}
```

### Edit one prompt

You can change any of `name`, `text`, `provider`, `model` and `temperature`. Switching to `openrouter` without a model goes back to the default model.

```bash
j -X POST $API/api/prompt-variants/v_3f2a… -d '{"text":"You are replying in r/{{subreddit}} …"}'
j -X POST $API/api/prompt-variants/v_3f2a… -d '{"model":"moonshotai/Kimi-K2.6","temperature":0.9}'
```

### Set percentages

Name prompts by id or by name. Prompts you leave out go to 0%, and the total must be 100.

```bash
j -X POST $API/api/prompts/weights -d '{"type":"thread","weights":{"Default":50,"Casual MiniMax":50}}'
```

### Delete one prompt

The prompt must be at 0%, and each type keeps at least one prompt.

```bash
j -X POST $API/api/prompt-variants/v_3f2a…/delete
```

### Replace a type's whole list at once

```bash
j -X POST $API/api/prompts -d '{"type":"comment","variants":[
  {"name":"Default","text":"…","weight":70},
  {"name":"Natural","text":"…","weight":30,"provider":"featherless","model":"MiniMaxAI/MiniMax-M3"}]}'
```

Include `id` on prompts you keep, so their stats stay linked.

### Try a prompt without saving or sending anything

Both calls take the same input:
- **Item** (optional): `{"item_id":"t_…"}` for a Queue 1 item, or `{"queue2_id":12}`. By default it uses the first Queue 1 item of the type.
- **Prompt:** `{"variant_id":"v_…"}`, `{"text":"… {{title}} …"}` or `{"style":"natural"|"default"}`, with `"type"` when the item isn't given.

`preview` returns the prompt as the model would receive it. It makes no model call.

```bash
j -X POST $API/api/prompts/preview -d '{"variant_id":"v_3f2a…"}'
# → {"type":"thread","item":{…},"prompt":"You're replying in a Reddit thread in r/webscraping …"}
```

`try` makes one model call and returns the draft and its checks. Nothing is stored.

```bash
j -X POST $API/api/prompts/try -d '{"type":"thread","text":"Reply to {{title}} … I work at Geonode …",
  "provider":"featherless","model":"MiniMaxAI/MiniMax-M3","temperature":0.8}'
# → {"text":"…","disclosure":{"ok":true},"flags":[],"skipped":false,"latency_ms":9227,"prompt":"…","item":{…}}
```

`flags` lists the common tells:
- `no disclosure`;
- `opens with disclosure`;
- `possible invented claim`: made-up experience, like "I had the same issue";
- `emoji`, `em-dash`, `list or heading`, `link`;
- `stock opener`, `long`;
- `reasoning instead of a comment`.

## Models

```bash
curl -s $API/api/models                 # default OpenRouter model, the shortlist, which keys are set
curl -s "$API/api/models?q=kimi"        # + search all ~22,000 Featherless models (id, concurrency cost, gated)
```

- **Any listed id works:** any Featherless model id can be used as a prompt's `model` with `"provider":"featherless"`.
- **OpenRouter ids:** any OpenRouter model id can be used with `"provider":"openrouter"`.
- **Keys:** they come from `.env.local` (`FEATHERLESS_API_KEY`, `OPENROUTER_API_KEY`).
- **Gated models:** gated Featherless models (Llama, Gemma) need access granted on Hugging Face first.

## Model test (blind comparison)

The model test drafts the same Queue 1 items with several models and prompts, so you can compare them. Queue 1 is not changed and nothing is posted.

```bash
# Start: up to 20 models; threads/comments = how many items of each (max 40)
j -X POST $API/api/bench -d '{"name":"Kimi vs MiniMax","threads":8,"comments":4,"contestants":[
  {"provider":"featherless","model":"MiniMaxAI/MiniMax-M3","prompt":"natural","temperature":0.8},
  {"provider":"featherless","model":"moonshotai/Kimi-K2.6","prompt":"natural"},
  {"provider":"openrouter","model":"anthropic/claude-sonnet-5.5","prompt":"Default"}]}'
# "prompt" is "natural", "default", or the name of a saved prompt.

curl -s $API/api/bench                  # all tests, plus shortlist and the prompt styles you can use
curl -s $API/api/bench/1                # progress and leaderboard
curl -s $API/api/bench/1/compare        # per item: drafts A, B, C… (model names hidden until picked)
j -X POST $API/api/bench/1/pick -d '{"item_key":"t_abc","draft_id":42}'     # most human
j -X POST $API/api/bench/1/pick -d '{"item_key":"t_abc","draft_id":null}'   # none are good
j -X POST $API/api/bench/1/pick -d '{"item_key":"t_abc","undo":true}'
j -X POST $API/api/bench/1/score        # Engain rule-check on every draft (read-only, ~50 drafts/min)
j -X POST $API/api/bench/1/resume       # retry failed drafts
```

The leaderboard has one row per model and prompt:

| Field | What it means |
| --- | --- |
| `picked`, `judged`, `pick_rate` | Your blind picks |
| `authenticity_risk` | Engain's "reads as machine-written", 0–100, lower is better |
| `human_pct` | Pangram's human share |
| `marketing_risk`, `removal_risk` | Engain's 0–100 judgements, lower is better |
| `disclosure_kept` | Share of drafts that say "I work at Geonode" or similar |
| `invented` | Share of drafts flagged for possibly made-up experience |
| `avg_words`, `avg_seconds` | Average length and time per draft |
| `skipped`, `failed` | Counts of SKIP answers and errors |

## Queue 1

```bash
curl -s $API/api/queue                       # queued items with thread/comment details, ranking reasons; ?history=50 adds taken/removed
curl -s $API/api/agent/queue                 # compact: item_id, kind, position, score
j -X POST $API/api/queue/t_abc -d '{"status":"skipped","note":"off-topic"}'   # or "done"
j -X POST $API/api/queue/refresh -d '{}'     # re-apply the rules now; {"reset":true} rebuilds the order
j -X POST $API/api/queue/fresh-start -d '{}' # only our comments published from now on enter Queue 1; {"since":"2026-10-29T16:00:00Z"} picks the date
curl -s $API/api/threads?q=proxy\&subreddit=webscraping\&available=true\&limit=50
curl -s $API/api/threads/1abc23              # one thread with its ranking
curl -s $API/api/comments?brand=brightdata.com\&min_score=40
```

### Rules (settings)

```bash
curl -s $API/api/settings
j -X POST $API/api/settings -d '{"queue_target":80,"max_age_days":60}'
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `queue_target` | 50 | The threads job fills Queue 1 up to this |
| `comment_limit` / `comment_position` | 20 / 5 | New own comments per refresh, and where they are inserted |
| `max_age_days` / `min_comments` | 120 / 3 | Thread age limit and minimum comment count |
| `min_thread_score` / `min_comment_score` | 0 / 40 | Ranking floors |
| `mention_comments` | 0 | 1 adds competitor-mention items |
| `thread_collect_minutes` | 60 | Ask Engain for new threads when the last collection is older than this |
| `threads_every_minutes` / `comments_every_minutes` / `tracker_every_minutes` | 10 / 30 / 10 | Job intervals |

## Queue 2: writing, approving, sending

```bash
# Take #1 of Queue 1. With "write":true a model drafts it from the type's prompts; with "message" you give the text.
j -X POST $API/api/agent/task -d '{"agent":"my-script","write":true}'
j -X POST $API/api/agent/task -d '{"agent":"my-script","message":"… (I work at Geonode)"}'

curl -s $API/api/agent/queue2               # all entries
curl -s $API/api/agent/queue2/12            # one entry
j -X POST $API/api/agent/queue2/12/write    # (re)draft with its prompt; a redraft keeps the same prompt
j -X POST $API/api/agent/queue2/12 -d '{"message":"edited text … I work at Geonode"}'   # edit (withdraws approval)
j -X POST $API/api/agent/queue2/12/discard  # throw away an unsent entry
```

Each entry includes:
- the item, `message` and `message_source` (`openrouter` means model-written, `given` means typed);
- how it was written: `write_status` (`written` / `skipped` / `truncated` / `failed` / `edited`), `provider`, `model`, `prompt_variant_name` and `prompt_used` (exactly what the model received);
- `disclosure` (`{"ok":true}` or the reason it fails) and `send_status`.

### Approve and send (posts to Reddit)

```bash
j -X POST $API/api/agent/queue2/12/approve -d '{}'
```

Routing is automatic. The pool and our own accounts take turns in a thread:
- **Nothing of ours in the thread yet:** the post goes from a random ready account of ours, so the follow-up reply goes through the pool.
- **Our first post there came from the pool:** the next one goes from a random ready account of ours. Accounts that already commented in that thread are skipped.
- **Our first post there came from our accounts:** the next one goes through the pool.
- "Our posts" are Engain's task list plus our Queue 2 sends it hasn't listed yet. Cancelled and failed tasks never reached Reddit, so they don't count; removed ones do.
- **Replies** (comment and mention items) can't come from our accounts (Engain v2). A reply whose turn is ours is not sent: it goes to the Send log, and Auto-send leaves it in Queue 2.
- Each Queue 2 entry shows the choice as `next_delivery` (`{first, next, posts}`), and the send logs a `delivery.chosen` event.
- **Overriding:** use `{"mode":"pool"}`, or `{"mode":"dedicated","userAccountId":"…"}`.

```bash
curl -s $API/api/agent/beta-accounts        # our own accounts and whether each can post now
j -X POST $API/api/agent/queue2/12/poll     # ask Engain for this one entry's status now
```

## Tracking what was sent

```bash
curl -s "$API/api/sent?days=7"              # 0 = all time
j -X POST $API/api/cron/tracker             # check statuses now (also runs every 10 min)
curl -s $API/api/our-comments?verdict=disapproved   # every Engain task of ours with status history
```

`/api/sent` returns:
- **Totals:** `total`, `published_rate`, and `counts` per outcome.
- **`groups`**, with these keys:
  - `in_progress`;
  - `published`;
  - `removed`, split into AutoModerator, moderators, parent removed and deleted;
  - `not_posted`;
  - `other` (cancelled or error).
- **`items`**, each with `bucket`, `engain_status`, `reddit_url`, `prompt_variant_name` and the status `history`.

## Collecting and jobs

```bash
j -X POST $API/api/collect -d '{"sources":["opportunities","mentions","smart_search","tasks"],"keywords":["rotating proxies"],"spend_quota":false,"max_pages":3}'
curl -s $API/api/runs/72                    # progress / summary of a collection
curl -s $API/api/jobs                       # the three jobs: next run, last result
j -X POST $API/api/cron/threads             # run a job now (waits for it)
j -X POST $API/api/cron/comments
j -X POST $API/api/cron/refresh -d '{"collect":false}'   # just re-rank; without it, a full collection
curl -s $API/api/status                     # counts, project, whether keys and secrets are set
curl -s $API/api/balance                    # Engain credits
```

## Activity log (debugging)

Everything the server does is logged: jobs and collection runs, items added to or removed from
Queue 1 (with the reason), Queue 1 -> Queue 2 moves, every model call (the exact prompt, the reply,
latency, tokens, retries, errors), edits, approvals, the account picked, every Engain send (request,
response or error, and refusals before sending), sent-status and our-task status changes, every
POST with its body, failed requests, and console lines. Newest first; kept `LOG_KEEP_DAYS` days (30).

The same events are appended to `.data/logs/YYYY-MM-DD.jsonl`, one JSON object per line, so
`grep`/`jq` work on them. On the dashboard: the **Logs** tab.

```bash
curl -s "$API/api/logs?item_id=t_abc123"     # one item's whole journey
curl -s "$API/api/logs?queue2_id=17"         # everything about Queue 2 #17
curl -s "$API/api/logs?type=llm"             # an area (job, collect, queue, queue2, llm, account, send, sent, engain, fast, http, server) or an exact type (send.failed)
curl -s "$API/api/logs?errors=1"             # only failures (types with error, failed or rejected)
curl -s "$API/api/logs?q=429&since=2026-10-29T00:00:00Z&limit=500"
curl -s "$API/api/logs?before_id=1234"       # older page (next_before_id from the last answer)
curl -s $API/api/logs/types                  # every type with its count
jq -c 'select(.type|startswith("send."))' .data/logs/2026-10-29.jsonl
```

Job events carry `source`: `schedule`, `cron`, `dashboard button` or `fast_mode #N`. Fast mode
(the dashboard's 30-second cycles) logs `fast.started`, `fast.cycle` (or `fast.cycle_error`) and
`fast.stopped`, including when the page is closed or reloaded.

### For an agent checking what is happening

The same log under `/api/agent/`, so an agent on another machine can read it with
`Authorization: Bearer <AGENT_API_KEY>` (no key needed on this machine).

```bash
curl -s -H "Authorization: Bearer $AGENT_API_KEY" "$API/api/agent/logs/summary?minutes=60"
#   counts per event type, recent_errors, latest events, jobs (running / next / last result),
#   fast_mode (on/off), queues (Queue 1, Queue 2 ready, sent waiting for a status)
curl -s -H "Authorization: Bearer $AGENT_API_KEY" "$API/api/agent/logs?errors=1&limit=50"
curl -s -H "Authorization: Bearer $AGENT_API_KEY" "$API/api/agent/logs?item_id=t_abc123"   # all filters above work
curl -s -H "Authorization: Bearer $AGENT_API_KEY" $API/api/agent/logs/types
```

## A full prompt-writing loop, start to finish

```bash
# 1. Write a prompt and see it filled in
j -X POST $API/api/prompt-variants -d '{"type":"thread","name":"Short and plain","text":"…{{title}}…{{body}}…{{style_examples}}…","provider":"featherless","model":"MiniMaxAI/MiniMax-M3"}'
j -X POST $API/api/prompts/preview -d '{"variant_id":"<id>"}'
# 2. Try it on a few items, then edit and try again
j -X POST $API/api/prompts/try -d '{"variant_id":"<id>","item_id":"<a Queue 1 item_id>"}'
j -X POST $API/api/prompt-variants/<id> -d '{"text":"…"}'
# 3. Compare it blind against the current prompt
j -X POST $API/api/bench -d '{"threads":10,"comments":0,"contestants":[{"provider":"featherless","model":"MiniMaxAI/MiniMax-M3","prompt":"Short and plain"},{"provider":"openrouter","model":"anthropic/claude-sonnet-5.5","prompt":"Default"}]}'
# 4. Put it live for a share of real drafts, then watch per-prompt stats and the Sent tab
j -X POST $API/api/prompts/weights -d '{"type":"thread","weights":{"Default":70,"Short and plain":30}}'
curl -s $API/api/prompts | jq '.stats.thread'
```
