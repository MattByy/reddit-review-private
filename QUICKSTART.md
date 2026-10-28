# Quick Start: Autonomous Sending

## 1. Configure API Keys

Edit `.env.local` and add your keys:

```bash
# Required - add your actual keys
ENGAIN_API_KEY=your_engain_api_key_here
FEATHERLESS_API_KEY=your_featherless_key_here
OPENROUTER_API_KEY=your_openrouter_key_here
AGENT_API_KEY=generate_a_secure_random_string
CRON_SECRET=generate_another_secure_string
```

**Generate secure keys:**
```bash
# Run these commands and copy the output
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 2. Start the Server

```bash
# Live mode (with Engain API)
npm run dev

# Or mock mode (invented data, no Engain key needed)
npm run dev:mock
```

Server runs at: **http://127.0.0.1:3000**

## 3. Initialize Autonomous Mode

```bash
npm run setup:autonomous
```

This sets up:
- ✅ Natural MiniMax prompts (Featherless) for thread and comment types
- ✅ 50/50 split between Default (OpenRouter) and Natural MiniMax (Featherless)
- ✅ Queue settings optimized for autonomous operation

## 4. Start Autonomous Sending

### Option A: Manual Approval (Recommended for Start)

1. **Monitor Queue 1** filling with threads:
   ```bash
   curl http://127.0.0.1:3000/api/queue
   ```

2. **Review drafted messages in Queue 2:**
   ```bash
   curl http://127.0.0.1:3000/api/agent/queue2
   ```

3. **Approve and send:**
   ```bash
   curl -X POST http://127.0.0.1:3000/api/agent/queue2/12/approve \
     -H 'Content-Type: application/json' \
     -d '{"approved_by":"dashboard"}'
   ```

### Option B: Fully Autonomous

Run the auto-approve script:

```bash
# Test run (dry mode - no sending)
npm run auto-approve:dry

# Live run (claims, drafts, approves and sends)
npm run auto-approve
```

**Set up cron (every 5 minutes):**
```bash
# Add to crontab: crontab -e
*/5 * * * * cd /path/to/reddit-review-private && npm run auto-approve >> logs/auto-approve.log 2>&1
```

## 5. Monitor and Optimize

### Dashboard (http://127.0.0.1:3000)

- **Queue 1 tab:** Ranked threads and comments
- **Queue 2 tab:** Drafted messages ready for approval
- **Prompts tab:** Per-model stats, percentage splits
- **Sent tab:** Published items and Engain statuses
- **Model test tab:** Blind model comparison

### API Monitoring

```bash
# Job status
curl http://127.0.0.1:3000/api/jobs

# Sent items (last 7 days)
curl "http://127.0.0.1:3000/api/sent?days=7"

# Prompt performance
curl http://127.0.0.1:3000/api/prompts | jq '.stats.thread'
```

## Best Model: MiniMax-M3

**Featherless `MiniMaxAI/MiniMax-M3`** is configured as the primary human-like model:

- **AI-sounding score:** 24.9 (Claude Sonnet 5.5 = 21.8 reference)
- **Disclosure rate:** 100%
- **Speed:** 2-4 seconds per draft
- **Style:** Natural, specific, no invented claims

See `docs/plan-human-writing-featherless.md` for full research.

## Next Steps

1. ✅ Add API keys to `.env.local`
2. ✅ Run `npm run setup:autonomous`
3. ✅ Start server with `npm run dev`
4. ✅ Monitor Queue 1 filling (10-min threads job)
5. ✅ Run `npm run auto-approve:dry` to test the flow
6. ✅ Switch to live auto-approve or manual approval
7. ✅ Review Model test tab for model comparison

## Troubleshooting

**Server won't start:**
```bash
# Check port availability
lsof -i :3000

# Start in mock mode (no Engain key required)
npm run dev:mock
```

**Queue 1 empty:**
```bash
# Manually run threads job
curl -X POST http://127.0.0.1:3000/api/cron/threads

# Check job status
curl http://127.0.0.1:3000/api/jobs
```

**Drafting errors:**
- Verify `FEATHERLESS_API_KEY` and `OPENROUTER_API_KEY` are set
- Check Queue 2 items for `write_error` field
- Review server logs for model API responses

## Documentation

- **Full setup guide:** `docs/autonomous-sending.md`
- **API reference:** `docs/API.md`
- **Model research:** `docs/plan-human-writing-featherless.md`