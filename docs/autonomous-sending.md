# Autonomous Sending Setup

This guide covers setting up autonomous Reddit engagement with cron jobs and the best human-like Featherless model.

## Overview

The system automatically:
1. **Collects** Reddit threads and comments from Engain
2. **Ranks** them in Queue 1 based on relevance and engagement
3. **Drafts** responses using AI models (50% OpenRouter, 50% Featherless MiniMax-M3)
4. **Approves and sends** to Reddit via cron jobs

## Architecture

```
Engain → Queue 1 (ranked) → Queue 2 (drafted) → Approve & Send → Reddit
           ↑                      ↑
           │                      └─ AI models write messages
           └─ Cron jobs refill
```

### Jobs (scheduled)

| Job | Interval | What it does |
|-----|----------|--------------|
| `threads` | 10 min | Collects new threads, fills Queue 1 up to target (50) |
| `comments` | 30 min | Checks published comments, inserts at position 5 |
| `tracker` | 10 min | Monitors sent items, updates Engain statuses |
| `auto-approve` | 5 min | Claims Queue 1 items, drafts, approves and sends |

## Model Configuration

### Best Human-Like Model: MiniMax-M3 (Featherless)

Based on research in `docs/plan-human-writing-featherless.md`:

**Why MiniMax-M3:**
- **AI-sounding score:** 24.9 (lower is better; Claude Sonnet 5.5 = 21.8)
- **Disclosure rate:** 100% (always includes "I work at Geonode")
- **Speed:** 2-4 seconds per draft
- **Style:** Natural, specific, no invented claims

**Configuration:**
- Provider: `featherless`
- Model: `MiniMaxAI/MiniMax-M3`
- Temperature: `0.8`
- Prompt style: `natural` (conversational, 1-4 sentences)

### Live A/B Test

The system runs a continuous A/B test:
- **50% Default:** OpenRouter `anthropic/claude-sonnet-5.5`
- **50% Natural MiniMax:** Featherless `MiniMaxAI/MiniMax-M3`

Compare results on the **Prompts** and **Sent** tabs.

## Setup

### 1. Configure Environment

Edit `.env.local`:

```bash
# Required
ENGAIN_API_KEY=your_engain_key
FEATHERLESS_API_KEY=your_featherless_key
OPENROUTER_API_KEY=your_openrouter_key
AGENT_API_KEY=your_agent_key
CRON_SECRET=your_cron_secret

# Optional
OPENROUTER_MODEL=anthropic/claude-sonnet-5.5
JOBS=on  # Set to 'off' for external cron only
BENCH_CONCURRENCY=4
```

### 2. Initialize Autonomous Mode

```bash
npm run setup:autonomous
```

This creates:
- Natural MiniMax prompts for `thread` and `comment` types
- 50/50 percentage split between Default and Natural MiniMax
- Queue settings optimized for autonomous operation

### 3. Start the Server

```bash
npm run dev
```

Server runs at `http://127.0.0.1:3000` with scheduled jobs enabled.

### 4. Run Auto-Approve (Manual or Cron)

**Manual run:**
```bash
npm run auto-approve
```

**Dry run (no sending):**
```bash
npm run auto-approve:dry
```

**Cron job (every 5 minutes):**
```bash
*/5 * * * * cd /path/to/reddit-review-private && npm run auto-approve
```

## Workflow

### Queue 1 → Queue 2 Flow

1. **Threads job** collects from Engain, ranks by relevance, fills Queue 1
2. **Auto-approve** claims #1 item, moves to Queue 2
3. **Writer** drafts message using assigned prompt (Default or Natural MiniMax)
4. **Disclosure check** validates "I work at Geonode" is present
5. **Approve & send** posts to Reddit via Engain

### Manual Approval (Current)

```bash
# Review drafted items
curl http://127.0.0.1:3000/api/agent/queue2

# Approve and send
curl -X POST http://127.0.0.1:3000/api/agent/queue2/12/approve \
  -H 'Content-Type: application/json' \
  -d '{"approved_by":"dashboard"}'
```

### Fully Autonomous (Recommended)

The `auto-approve.js` script handles the complete flow:
- Claims items from Queue 1
- Drafts with AI models
- Auto-approves ready drafts
- Sends to Reddit

Monitor with:
```bash
# Queue status
curl http://127.0.0.1:3000/api/queue

# Jobs status
curl http://127.0.0.1:3000/api/jobs

# Sent items
curl "http://127.0.0.1:3000/api/sent?days=7"
```

## Monitoring

### Dashboard Tabs

- **Queue 1:** Ranked threads and comments ready for engagement
- **Queue 2:** Drafted messages awaiting approval
- **Prompts:** Per-prompt stats, percentage splits, model comparison
- **Sent:** Published, removed, and in-progress items with Engain statuses
- **Model test:** Blind comparison of models with Engain scoring

### Key Metrics

**Per-prompt stats:**
- Drafted, sent, published counts
- Publish rate (published ÷ sent)
- Removal rate (AutoModerator vs moderators)

**Engain scores (Model test):**
- `authenticity_risk`: AI-sounding detection (0-100, lower better)
- `marketing_risk`: Promotional tone (0-100)
- `removal_risk`: Likelihood of removal (0-100)
- `disclosure_kept`: Share with proper disclosure

## Model Test (Blind Comparison)

Test new models before going live:

```bash
# Start a bench test
curl -X POST http://127.0.0.1:3000/api/bench \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "MiniMax vs Kimi",
    "threads": 10,
    "comments": 5,
    "contestants": [
      {
        "provider": "featherless",
        "model": "MiniMaxAI/MiniMax-M3",
        "prompt": "natural",
        "temperature": 0.8
      },
      {
        "provider": "featherless",
        "model": "moonshotai/Kimi-K2.6",
        "prompt": "natural"
      }
    ]
  }'
```

**Process:**
1. Start test with 2-4 models
2. Review blind drafts (model names hidden)
3. Pick "most human" per item
4. Run Engain rule-check scoring
5. Review leaderboard with picks and scores
6. Promote winner to live prompts

## Troubleshooting

### Queue 1 empty
- Check `threads` job status: `GET /api/jobs`
- Run manual collection: `POST /api/cron/threads`
- Verify Engain API key and project ID

### Drafting failures
- Check `FEATHERLESS_API_KEY` and `OPENROUTER_API_KEY` in `.env.local`
- Review `write_error` in Queue 2 items
- Adjust `BENCH_CONCURRENCY` if hitting rate limits

### Send errors
- Verify disclosure: message must include "I work at Geonode"
- Check account availability: `GET /api/agent/beta-accounts`
- Review Engain task statuses: `GET /api/our-comments`

### Concurrency limits (Featherless)
- Reduce `BENCH_CONCURRENCY` (default 4)
- Run model tests sequentially
- Check plan tier for `concurrency_cost` per model

## API Reference

Full API guide: `docs/API.md`

**Key endpoints:**
- `GET /api/prompts` - All prompts and stats
- `POST /api/bench` - Start model test
- `POST /api/agent/task` - Claim Queue 1 item
- `POST /api/agent/queue2/:id/approve` - Approve and send
- `GET /api/jobs` - Job status and schedule

## Next Steps

1. **Run setup:** `npm run setup:autonomous`
2. **Start server:** `npm run dev`
3. **Monitor Queue 1** filling with threads
4. **Run auto-approve** to test the flow
5. **Review Model test** tab for MiniMax vs Default comparison
6. **Adjust percentages** based on publish rates and Engain scores

## Research Sources

- `docs/plan-human-writing-featherless.md` - Model selection research
- `docs/API.md` - Complete API reference
- Featherless model catalog: 22,000+ models via `GET /api/models?q=<search>`