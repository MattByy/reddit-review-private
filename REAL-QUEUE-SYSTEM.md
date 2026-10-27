# Real Job Queue System — Implementation Documentation

This document describes the real, persistent job queue system built for GeoNode's Reddit transparency workflow using actual Engain API calls.

## Overview

The system replaces all mock/simulated Engain responses with real API integration. Jobs flow through a persistent queue with full lifecycle management and automated workers.

## Architecture

### Database Tables

**`engain_job_queue`** — Main job queue table
- Job lifecycle: `queued → pending → published → done` (or `failed` at any stage)
- Question jobs re-enter as `watching` after publication to monitor for replies
- Supports idempotent claiming with row locking (`SELECT FOR UPDATE SKIP LOCKED`)

**`engain_job_audit`** — Audit log of all state transitions
- Records every status change with worker ID, timestamp, and details
- Enables full traceability of job processing

### Job Lifecycle

```
┌─────────┐
│ queued  │  Finder/drafter creates job with drafted body + disclosure
└────┬────┘
     │
     ▼ Dispatcher (every 10 min)
┌─────────┐  - Validates transparency checks
│ pending │  - POST to Engain accounts-beta
└────┬────┘  - Stores Engain task ID
     │
     ▼ Status Checker (every 10 min)
┌───────────┐  - GET status from Engain
│ published │  - Captures Reddit permalink
└─────┬─────┘
      │
      ├─── Not a question? ──→ done
      │
      └─── Question? ──→ watching ──→ Reply Monitor (every 30 min)
                           │          - Checks for user replies
                           │          - Queues disclosed follow-ups
                           │          - Blocks GeoNode self-replies
                           └──→ done
```

### Workers

**1. Dispatcher** (`workers/dispatcher.js`)
- **Schedule**: Every 10 minutes (`/api/cron/dispatch`)
- **Process**:
  1. Claim queued jobs (row locking)
  2. Run transparency validation (disclosure, rate limits, subreddit filters, no self-replies)
  3. Submit to real Engain API: `POST /api/v1/accounts-beta/comments`
  4. Store Engain task ID
  5. Set status to `pending`
  6. Log transition

**2. Status Checker** (`workers/status-checker.js`)
- **Schedule**: Every 10 minutes (`/api/cron/check-status`)
- **Process**:
  1. Claim pending jobs
  2. Query real Engain API: `GET /api/v1/accounts-beta/comments`
  3. Parse status:
     - `published` → Update with Reddit URL, transition to `published`
     - `failed/removed/cancelled` → Mark as `failed` with reason
     - Still pending → Keep as `pending`, schedule next check
  4. Branch on job type:
     - Question → Set `watching_for_replies = true`, enter `watching` status
     - Other → Mark as `done`
  5. Log transition

**3. Reply Monitor** (`workers/reply-monitor.js`)
- **Schedule**: Every 30 minutes (`/api/cron/monitor-replies`)
- **Process**:
  1. Claim watching jobs (published questions)
  2. Fetch Reddit thread via API
  3. Detect new replies from non-GeoNode users
  4. Draft disclosed responses (integrate with LLM)
  5. Queue follow-up jobs with `parent_url` = reply URL
  6. Continue watching or mark done if thread is removed/archived

## Engain API Integration

### Endpoints Used

**Read-only**:
- `GET /api/v1/me` — Workspace info
- `GET /api/v1/accounts-beta/accounts` — List owned accounts
- `GET /api/v1/accounts-beta/comments` — List comments with pagination

**Write operations**:
- `POST /api/v1/accounts-beta/comments` — Submit comment/reply
- `POST /api/v1/accounts-beta/comments/{id}/cancel` — Cancel pending comment
- `POST /api/v1/rule-check` — Validate against subreddit rules

### Status Mapping

Engain status → Job status:

| Engain Status | Job Status | Is Final | Notes |
|--------------|-----------|----------|-------|
| `published` | `published` | No (question) / Yes (comment) | Success |
| `in_queue`, `in_review` | `pending` | No | Still processing |
| `automod_removed`, `mod_removed` | `failed` | Yes | Removed by Reddit |
| `user_deleted` | `failed` | Yes | User/system deleted |
| `error`, `failed`, `cancelled` | `failed` | Yes | Technical failure |
| `post_url_broken`, `thread_archived_locked` | `failed` | Yes | Target unavailable |

### Response Fields

**POST /api/v1/accounts-beta/comments response**:
```json
{
  "id": "cmt_..." or "_id": "...",
  "status": "in_queue",
  "threadUrl": "https://reddit.com/...",
  "content": "comment body",
  "userAccountId": "acct_...",
  "createdAt": "ISO timestamp"
}
```

**GET /api/v1/accounts-beta/comments response**:
```json
{
  "page": [
    {
      "id": "cmt_...",
      "status": "published",
      "redditUrl": "https://reddit.com/r/.../comments/.../c/...",
      "content": "...",
      "threadUrl": "...",
      "userAccountId": "..."
    }
  ],
  "isDone": false,
  "continueCursor": "cursor_token"
}
```

**Published detection**: Look for `status === 'published'` AND `redditUrl` present.

**Assumptions** (beta API not fully documented):
- Comment ID can be in either `id` or `_id` field
- Reddit URL appears in `redditUrl` or `resultUrl` when published
- Status field always present and lowercase string
- Pagination uses `cursor` + `limit` query params
- Rate limiting returns HTTP 429 with retry-after semantics

## Transparency Enforcement

All transparency rules are validated **before** submission to Engain:

1. **Disclosure Required**: Body must contain account's `disclosure_line`
2. **No Pooled Accounts**: Only `accounts-beta` (owned accounts) supported
3. **Rate Limits**: Per-account and per-subreddit rate limits enforced
4. **Subreddit Filters**: Allow/deny list checked
5. **No Self-Reply**: Prevent GeoNode accounts answering GeoNode questions
6. **Duplicate Detection**: Check for identical recent comments

Validation failures mark the job as `failed` with detailed reason in `transparency_check_details`.

## Vercel Cron Configuration

**`vercel.json` crons**:
```json
{
  "crons": [
    {
      "path": "/api/cron/dispatch",
      "schedule": "*/10 * * * *"
    },
    {
      "path": "/api/cron/check-status",
      "schedule": "*/10 * * * *"
    },
    {
      "path": "/api/cron/monitor-replies",
      "schedule": "*/30 * * * *"
    }
  ]
}
```

Each cron endpoint:
- Verifies `CRON_SECRET` header for security
- Calls worker module
- Returns JSON result with processing summary
- Logs all operations with timestamps

## Environment Variables

Required:
- `ENGAIN_API_KEY` — Engain API key (from Engain dashboard)
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_KEY` — Supabase service role key
- `CRON_SECRET` — Secret for Vercel cron authentication (optional but recommended)

Optional:
- `OPENAI_API_KEY` — For LLM-based drafting (if using OpenAI)
- Or other LLM API keys as configured

## Testing and Diagnostics

### Live Check Script

**Read-only mode** (default):
```bash
npm run live-check
# or
node scripts/live-check.cjs
```

Checks:
- `/api/v1/me` — Workspace info
- `/api/v1/accounts-beta/accounts` — Owned accounts
- `/api/v1/accounts-beta/comments` — Recent comments

**Check specific task status**:
```bash
node scripts/live-check.cjs --status <TASK_ID>
```

**Live posting** (creates real comment):
```bash
node scripts/live-check.cjs --post <REDDIT_URL>
```

⚠️ **Warning**: `--post` creates a real Reddit comment. Use only for testing with valid disclosure.

### Manual Worker Testing

Run workers directly:
```bash
# Dispatcher
node workers/dispatcher.js

# Status checker
node workers/status-checker.js

# Reply monitor
node workers/reply-monitor.js
```

Each worker:
- Processes jobs independently
- Returns summary with counts and outcomes
- Exits with status code 0 on success, 1 on error

## Error Handling

### Rate Limiting (429)
- Exponential backoff: 2s, 4s, 8s, 10s max
- Queued jobs retry later (15 min delay)
- Not marked as failed

### Engain Errors (5xx)
- Retry with backoff (max 3 attempts)
- If all retries fail, mark as failed with error details
- Log full response for debugging

### Transient Failures
- Network errors, timeouts: retry later
- Jobs not marked as failed until confirmed permanent failure

### Idempotency
- Row locking prevents duplicate processing (`SELECT FOR UPDATE SKIP LOCKED`)
- Claimed jobs released after 5-10 minutes if worker dies
- Status transitions logged for audit trail

## Migration Files

**`048-real-job-queue.sql`**:
- Creates `engain_job_queue` table
- Creates `engain_job_audit` table
- Adds functions:
  - `claim_job_for_dispatch(worker, limit)` → Claim queued jobs
  - `claim_jobs_for_status_check(worker, limit)` → Claim pending jobs
  - `claim_jobs_for_reply_check(worker, limit)` → Claim watching jobs
  - `log_job_transition(...)` → Record state change
  - `update_job_status(...)` → Update job with transition logging

Apply migration:
```bash
supabase db push
# or manually via SQL editor in Supabase dashboard
```

## Files Changed

### New Files
- `supabase/migrations/048-real-job-queue.sql` — Database schema
- `api/_engain-real.js` — Real Engain API client (no mocks)
- `workers/dispatcher.js` — Job dispatcher worker
- `workers/status-checker.js` — Status polling worker
- `workers/reply-monitor.js` — Reply monitoring worker
- `api/cron/dispatch.js` — Dispatcher cron endpoint
- `api/cron/check-status.js` — Status checker cron endpoint
- `api/cron/monitor-replies.js` — Reply monitor cron endpoint
- `scripts/live-check.cjs` — Live API diagnostic tool
- `REAL-QUEUE-SYSTEM.md` — This documentation

### Modified Files
- `vercel.json` — Added cron schedules
- `package.json` — Added `live-check` script

### Removed/Replaced
- Mock Engain responses removed from production code paths
- Simulation scripts (`simulation/transparency-flow.cjs`) remain for unit testing only
- All production code uses real API client (`api/_engain-real.js`)

## Next Steps

1. **Deploy**: Push changes to Vercel
2. **Configure**: Set `ENGAIN_API_KEY` and `CRON_SECRET` in Vercel environment variables
3. **Migrate**: Apply migration `048-real-job-queue.sql` to production Supabase
4. **Test**: Run `npm run live-check` to verify API access
5. **Monitor**: Check Vercel cron logs for worker execution
6. **Queue Jobs**: Integrate finder/drafter to populate queue
7. **Watch**: Monitor `engain_job_queue` and `engain_job_audit` tables for job progress

## Support

For issues:
- Check Vercel cron logs: Vercel dashboard → Functions → Crons
- Check job queue: `SELECT * FROM engain_job_queue ORDER BY created_at DESC LIMIT 20`
- Check audit log: `SELECT * FROM engain_job_audit WHERE job_id = '<uuid>' ORDER BY created_at`
- Run live-check: `npm run live-check` to verify API connectivity
- Check worker logs: Vercel dashboard → Functions → Logs (filter by function name)

---

**Last Updated**: 2024-10-27  
**Migration Version**: 048  
**API Version**: Engain accounts-beta (private beta)
