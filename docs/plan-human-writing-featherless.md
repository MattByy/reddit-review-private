# Plan: pick a Featherless model that writes like a person

Status: **not started**. Saved 2026-10-28 so the work can resume in a later session.

## Goal

Queue 2 messages (thread comments and follow-ups under our own comments) should read like a real Redditor writing in a live conversation, not like an assistant. We will test models on [Featherless](https://featherless.ai) and keep the ones that sound most human, then confirm on Reddit outcomes.

**Fixed rules.** These are enforced in code and the tests do not change them. Every message still carries the Geonode disclosure ("I work at Geonode"). It never poses as an independent user, invents experiences, customers or numbers, or attacks competitors. "Human-sounding" means natural style: tone, rhythm, length and reacting to the thread. It does not mean hiding who wrote it.

## What exists today (dev server, `npm run dev`)

- `server/writer.cjs` drafts each Queue 2 item with **OpenRouter**. The model is `anthropic/claude-sonnet-5.5` (`OPENROUTER_MODEL` overrides it), with one chat call per draft, `max_tokens` 1500 and temperature 0.7.
- **Prompt variants per type** (thread, comment, mention) with a percentage split. The split is exact, so 60/40 gives 6 and 4. Each draft stores `prompt_variant_id`, `prompt_variant_name`, `model` and `prompt_used`.
- **Per-prompt stats**: drafted, sent, published, removed, failed, cancelled and pending. The Sent tab tracks every send's Engain status.
- **Engain rule-check** (`POST /api/v1/rule-check/batch`, up to 25 drafts per subreddit) returns these per draft:
  - `authenticityRisk`: 0–100, "reads as machine-written";
  - `aiDetection`: the Pangram scan, with `fractionHuman`, `fractionAi`, `predictionShort` (AI / Human / Mixed) and `tells`;
  - `naturalnessAdvice`, `marketingIntentRisk` and `removalRisk`.

  These are our objective "sounds human" measurements. Limits are 5 requests/min and 50 items/min.

## Featherless facts (checked 2026-10-28)

- **API:** OpenAI-compatible. `POST https://api.featherless.ai/v1/chat/completions` with header `Authorization: Bearer <key>`, and `GET /v1/models` (public, 22,393 models; fields `id`, `model_class`, `context_length`, `is_gated`, `concurrency_cost`).
- **Key:** none yet. Add `FEATHERLESS_API_KEY=` to `.env.local`.
- **Gated models** (Llama 3.3, Gemma 3) need the model accepted on Hugging Face and linked in Featherless.
- **Concurrency:** limited by plan (`concurrency_cost` per model), so run the bench sequentially or with low parallelism.

### Candidates (all confirmed on Featherless)

| Model | Why test it |
| --- | --- |
| `Sao10K/L3.3-70B-Euryale-v2.3` | Creative/RP fine-tune, casual voice |
| `EVA-UNIT-01/EVA-LLaMA-3.33-70B-v0.0` | Creative fine-tune, natural prose |
| `NousResearch/Hermes-3-Llama-3.1-70B` | Steerable, less "assistant" tone |
| `meta-llama/Llama-3.3-70B-Instruct` (gated) | Baseline instruct |
| `Qwen/Qwen2.5-72B-Instruct` | Strong instruct baseline |
| `Qwen/Qwen3-32B` | Newer, smaller |
| `mistralai/Mistral-Small-24B-Instruct-2501` | Terse, plain |
| `mistralai/Mistral-Nemo-Instruct-2407` | Small, cheap, informal |
| `google/gemma-3-27b-it` (gated) | Different family |
| `deepseek-ai/DeepSeek-V3-0324` | Large, 131k context |
| `moonshotai/Kimi-K2-Instruct` | Large, distinct style |

Reference point: the current `anthropic/claude-sonnet-5.5` via OpenRouter.

## Steps

### 1. Model per prompt variant, two providers

- Give each prompt variant an optional `provider` (`openrouter` | `featherless`), a `model` and a `temperature`. The writer then calls the right endpoint. Both are OpenAI-style chat calls, so only the base URL, key and model change.
- Store `provider` and `model` on every draft (`model` exists already) and add them to the per-prompt stats.
- The existing percentage split then doubles as a **live A/B test across models**. For example: thread prompt "Euryale casual" 50%, "Qwen casual" 50%.
- On the Prompts tab, add a provider/model picker per prompt (model list from `GET /v1/models`, filtered to a shortlist).

### 2. A "natural conversation" prompt style

Write new prompt variants (the defaults stay available) that ask for:

- a reply to *this* thread's specific point, as one person typing in the comments;
- short (1–4 sentences), contractions, plain words, varied openings;
- no "Great question", no summary of the post, no lists, headings or em-dashes, no sign-off;
- the disclosure folded in naturally, e.g. "(I work at Geonode, fwiw)";
- for follow-ups, the same author adding a thought later ("oh and one more thing…"), never a second voice agreeing.

The few-shot style references are **real human comments we already collect**: the Engain mention comment bodies in the `comments` table, filtered to the same subreddit or topic. Add a `{{style_examples}}` variable that pastes 2–3 of them, labelled as examples of tone only, not content to copy.

The thread's existing comments would help flow, but Engain gives only the post, and Reddit's JSON answers 403 here. Only mention comments in the same thread can be used as context for now.

### 3. Offline bench (nothing is posted)

Add a bench (script or `POST /api/bench`) that:

1. Picks ~20 real items: ~12 thread items from Queue 1 or collected threads, plus ~8 comment items from our published comments. Mix subreddits (r/proxies, r/webscraping, r/automation, r/selfhosted…).
2. For each candidate model × the natural prompt (plus the current default for reference), drafts every item. Use the same seed items and temperature for each model.
3. Scores every draft:
   - Engain rule-check batch: `authenticityRisk` ↓, `aiDetection.fractionHuman` ↑ and `predictionShort`, `marketingIntentRisk` ↓, `removalRisk` ↓;
   - disclosure present (`checkDisclosure`), SKIP rate, truncation rate, length, latency and cost.
4. Saves the results in a `bench_runs` / `bench_drafts` table.
5. Shows a **blind comparison page**: drafts for the same item side by side without model names. Matas picks the most human one, and the names are revealed afterwards. Store the picks.
6. Produces a leaderboard per model: human-pick rate, mean `fractionHuman`, mean `authenticityRisk`, disclosure-kept rate, SKIP rate, cost per draft.

Budget the rule-check calls: 20 items × 12 models = 240 drafts ≈ 10 batch calls per subreddit group, about 5 minutes at 50 items/min.

### 4. Live confirmation

Take the top 2–3 models, run them as prompt variants with an even split, and approve as usual. After ~7 days, compare publish rate and removal (AutoModerator vs moderators) per model on the Prompts and Sent tabs. Keep the winner as the default; keep testing a challenger at ~20%.

## Open questions for Matas

- The Featherless API key and plan tier, which sets concurrency and gated-model access.
- Which subreddits matter most for the bench.
- Whether the thread prompt should stay 2–5 sentences or go shorter.

## Where things are

- **Worktree** `../reddit-review-dev-server`, branch `dev-server-thread-collection`. The live server runs from here, and its data is in `.data/dev.db` (gitignored).
- **Code:** `server/writer.cjs` (writer and prompts), `server/send-queue2.cjs` (send guards, `checkDisclosure`), `server/tracker.cjs` (Sent tracking), `server/engain.cjs` (API client; add `ruleCheckBatch` here).
- **Docs:** `docs/engain-thread-collection.md`.
