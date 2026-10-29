# Prompts API

The prompts decide how every message is written. There are two kinds:

- **`thread`**: comments, meaning the first comment we post in a Reddit thread.
- **`comment`**: replies, meaning the follow-up we post under our own published comment.
- `mention` (replies to competitor mentions) also exists. It is off unless mentions are switched on.

Each kind has **1 to 5 prompts**. Each prompt has a **percentage** of the drafts it writes, and the percentages of one kind always add up to 100. A prompt at 0% is paused. The split is exact rather than random: at 60/40, ten drafts give exactly 6 and 4.

Every draft and send records the prompt's **slug**, so each prompt's results (published, removed, failed…) are counted for it. That is how you compare prompts.

A human does all of this on the **Prompts page** (`/prompts`). An agent does it with the calls below.

## Authentication

Create a key on the Prompts page under **API keys**. The secret (`gnk_…`) is shown once. Send it as a bearer token:

```bash
API=https://<host>            # http://127.0.0.1:3000 locally
KEY=gnk_…
j(){ curl -s -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' "$@"; }
```

- **`prompts` scope** (the default): only the prompt calls on this page, plus `GET /api/models` and `GET /api/keys/me`.
- **`full` scope**: everything `AGENT_API_KEY` can do, such as queues, sending and logs. Give it only to agents you trust.
- **Revoking:** a key revoked on the page stops working at once.
- **Audit:** every change is logged with the key's name (`by: "key:<name>"`).

`GET /api/keys/me` tells you which key you are using.

## Read prompts and their results

```bash
j $API/api/prompts
```

The response has these parts:

- **`variants.thread` / `variants.comment`:** each prompt's `id`, `slug`, `name`, `text`, `weight` (%), and optionally `provider`, `model` and `temperature`.
- **`stats.<kind>.prompts[]`:** per prompt:
  - **Drafts:** `drafted`, `skipped` (the model answered SKIP), `waiting` (in Queue 2), `not_sent`
  - **Sends:** `sent`, split into `sent_pool` and `sent_dedicated`
  - **Outcomes:** `published`, `pending`, and `not_published` (= `removed` + `failed` + `cancelled`)
  - **Rates:** `publish_rate` (published ÷ sent, %), `removal_rate`, `share_of_drafts`, `share_of_published`
- **`variables`:** the `{{placeholders}}` a prompt can use, such as `{{title}}`, `{{subreddit}}`, `{{body}}`, `{{our_comment}}` and `{{style_examples}}`.
- **`max_prompts`:** 5.

## Add a prompt

A new prompt starts at **0%** (paused), so the total stays 100%. Give it a share afterwards.

```bash
j -X POST $API/api/prompt-variants -d '{
  "type": "thread",
  "name": "Short and specific",
  "slug": "thread-short-specific",
  "text": "You are replying in r/{{subreddit}} to: {{title}}\n{{body}}\n\nWrite 2-3 sentences …  If there is nothing useful to add, answer SKIP.",
  "provider": "openrouter",
  "model": "anthropic/claude-sonnet-5.5",
  "temperature": 0.8
}'
```

- **Required:** `type`, `name` and `text`. Instead of `text`, `"style":"natural"` or `"style":"default"` starts from a built-in prompt.
- **Optional:** `slug`, which is made from the name if you leave it out. `provider` is `openrouter` (default) or `featherless`. `model` defaults to the server's model. `temperature` goes from 0 to 2 (default 0.7).
- **Limits:** a sixth prompt of one kind is refused (422). Delete or reuse one instead.

## Set the percentages

```bash
j -X POST $API/api/prompts/weights -d '{"type":"thread","weights":{"thread-default":50,"thread-short-specific":50}}'
```

Name prompts by slug, id or name. Prompts you leave out go to 0%. The numbers must be whole and add up to 100.

## Change or delete a prompt

```bash
j -X POST $API/api/prompt-variants/thread-short-specific -d '{"text":"…","temperature":0.6}'
j -X POST $API/api/prompt-variants/thread-short-specific/delete      # only at 0%, and never the last one
```

`name`, `slug`, `text`, `provider`, `model` and `temperature` can be changed. Percentages only change through `/api/prompts/weights`. An earlier draft keeps the slug it was written with.

## Try before you switch it on

These calls never save or send anything.

```bash
# The prompt exactly as the model would get it, filled in with a real Queue 1 item:
j -X POST $API/api/prompts/preview -d '{"variant_id":"thread-short-specific"}'
# One real draft from it (costs one model call):
j -X POST $API/api/prompts/try -d '{"variant_id":"thread-short-specific"}'
```

Unsaved text works too: `{"type":"thread","text":"…"}`.

## A reasonable experiment loop for an agent

1. **Read** `GET /api/prompts` and note each prompt's `sent`, `publish_rate` and `removal_rate`.
2. **Write** a new prompt for the weaker kind with `POST /api/prompt-variants`, then check it with `/preview` and `/try`.
3. **Give it a share**, for example 20%, with `/api/prompts/weights`, taking that share from the others.
4. **Wait** until it has about 20 sends before judging it. Then shift the percentages toward the better prompts, set the losers to 0%, and delete them.

Errors come back as `{"error":"…"}` with HTTP 401/403 (key), 404 (no such prompt) or 422 (invalid input, with the reason).
