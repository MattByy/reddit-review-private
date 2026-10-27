# GeoNode Reddit Transparency Enforcement

## Overview

This system implements strict transparency requirements for GeoNode's Reddit engagement. Every aspect of the system is designed to ensure honest, openly-affiliated participation that respects Reddit's community guidelines and user expectations.

## Non-Negotiable Constraints

These constraints are **enforced in code**, not just documentation. The system will refuse to operate if these requirements are not met.

### 1. Own Accounts Only

**Requirement**: Only GeoNode's owned/beta accounts may post. Pooled accounts (where Engain chooses the account) are permanently disabled.

**Enforcement**:
- `_delivery.js` throws errors if pooled mode is requested
- `ENGAIN_DELIVERY` environment variable must be `owned` (or omitted, defaults to `owned`)
- Setting `ENGAIN_DELIVERY=pool` causes immediate failure
- All posting goes through Engain's `accounts-beta` API with explicit `userAccountId`

**Code Location**: `api/_delivery.js`

### 2. Mandatory Disclosure

**Requirement**: Every comment must include clear affiliation disclosure (e.g., "GeoNode team member here").

**Enforcement**:
- Disclosure regex pattern validates every comment body: `/\b(geonode team( here)?|(run|operated|posted) (by|for) geonode|i (work|am) (at|with|for) geonode|disclosure: ?i (work|am) (at|with|for) geonode)\b/i`
- Comments without disclosure are rejected at filing stage (before queuing)
- Comments without disclosure are rejected again at send stage (before submission to Engain)
- Each account must have a `disclosure_line` configured that appears verbatim in every comment
- Transparency audit logs record every disclosure check

**Code Location**: 
- `api/_transparency.js` - `validateDisclosure()`
- `api/_messages.js` - `file()` function adds pre-filing check
- `api/_messages.js` - `sendOne()` function adds pre-send check

### 3. No Staged Conversations

**Requirement**: GeoNode accounts cannot reply to other GeoNode accounts as if they were independent users.

**Enforcement**:
- Before accepting any reply, system checks if parent comment was posted by GeoNode
- If parent is ours, submission is blocked with explicit error
- Exception: Explicitly configured playbook scenarios (requires manual setup, not automatic)
- Check uses `is_our_url()` database function and cross-references `engain_tasks` table

**Code Location**: `api/_transparency.js` - `checkForStagedConversation()`

### 4. Rate Limits

**Requirement**: Respect Reddit's expectations and avoid spam-like behavior.

**Enforced Limits** (configurable via environment variables):
- Maximum 5 comments per account per 24 hours (default)
- Maximum 3 comments per subreddit per 24 hours (default)
- Minimum 24 hours between comments in same subreddit (default)

**Configuration**:
```bash
MAX_COMMENTS_PER_ACCOUNT_PER_DAY=5
MAX_COMMENTS_PER_SUBREDDIT_PER_DAY=3
MIN_HOURS_BETWEEN_SUBREDDIT=24
```

**Code Location**: `api/_transparency.js` - `checkRateLimits()`

### 5. Subreddit Filtering

**Requirement**: Respect subreddit rules. Don't post to subreddits that ban self-promotion.

**Enforcement**:
- `subreddit_filters` table tracks allowed/denied/review subreddits
- Denied subreddits block all posting attempts
- `allowlist_only` mode (optional) restricts to explicitly approved subreddits only
- Default mode allows new subreddits but respects explicit deny list

**Management**:
```sql
-- Add a subreddit to deny list
INSERT INTO subreddit_filters (subreddit, status, reason)
VALUES ('example', 'denied', 'Rules prohibit self-promotion');

-- Add to allow list
INSERT INTO subreddit_filters (subreddit, status, reason)
VALUES ('webscraping', 'allowed', 'Tool discussions welcome');

-- Enable allowlist-only mode
UPDATE workflow_state 
SET value = '{"mode": "allowlist_only"}'::jsonb
WHERE key = 'subreddit_policy';
```

**Code Location**: `api/_transparency.js` - `checkSubredditAllowed()`

### 6. Human Review Mode (Optional)

**Requirement**: Option to require manual approval before auto-posting.

**Configuration**:
```sql
-- Enable human review mode
UPDATE workflow_state 
SET value = '{"enabled": true, "note": "All drafts require manual approval"}'::jsonb
WHERE key = 'human_review_mode';

-- Check if enabled
SELECT human_review_enabled();
```

**Note**: When enabled, drafts are queued but not auto-sent until manually approved in dashboard.

**Code Location**: `supabase/migrations/047-transparency-enforcement.sql`

## Setup Instructions

### 1. Apply Database Migration

```bash
# Apply migration 047 to your Supabase project
# This creates subreddit_filters, transparency_audits tables
# and adds transparency_check column to message_queue
```

Migration file: `supabase/migrations/047-transparency-enforcement.sql`

### 2. Configure Environment Variables

**Required**:
```bash
# Use owned accounts only (default if omitted)
ENGAIN_DELIVERY=owned

# Engain API key with accounts-beta access
ENGAIN_API_KEY=your_engain_api_key

# Supabase credentials
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_service_key

# LLM API key (for drafting)
# Configure your LLM provider's key (OpenAI, Anthropic, etc.)
OPENAI_API_KEY=your_llm_key  # or equivalent
```

**Optional**:
```bash
# Rate limit overrides (defaults shown)
MAX_COMMENTS_PER_ACCOUNT_PER_DAY=5
MAX_COMMENTS_PER_SUBREDDIT_PER_DAY=3
MIN_HOURS_BETWEEN_SUBREDDIT=24

# Specific Engain project ID (auto-detected if omitted)
ENGAIN_PROJECT_ID=your_project_id
```

**DO NOT SET** (will cause errors):
```bash
# These will trigger transparency violations
ENGAIN_DELIVERY=pool      # FORBIDDEN
ENGAIN_DELIVERY=pooled    # FORBIDDEN
```

### 3. Configure Accounts

Each account must have a disclosure line configured:

```sql
-- Set disclosure line for an account
UPDATE accounts 
SET disclosure_line = 'GeoNode team member here',
    active = true,
    approved = true
WHERE id = 'your_account_id';

-- Verify account configuration
SELECT id, label, disclosure_line, active, approved 
FROM accounts 
WHERE active = true;
```

**Requirements**:
- `disclosure_line` must match the disclosure regex pattern
- Must contain "geonode" (case insensitive)
- Examples:
  - "GeoNode team member here"
  - "Disclosure: I work at GeoNode"
  - "Posted by GeoNode"
  - "I am with GeoNode and can help"

### 4. Configure Subreddit Filters

```sql
-- Add subreddits that ban self-promotion
INSERT INTO subreddit_filters (subreddit, status, reason, added_by)
VALUES 
  ('programming', 'denied', 'Rule 3: No promotion', 'admin'),
  ('webscraping', 'allowed', 'Tool discussions welcome', 'admin'),
  ('datascience', 'review', 'Case-by-case approval needed', 'admin');
```

### 5. Run Tests

```bash
npm test
```

This runs all tests including the new `tests/transparency.test.cjs` which validates:
- Disclosure detection
- Staged conversation blocking
- Rate limiting
- Subreddit filtering
- Duplicate detection
- Account verification

## How It Works

### End-to-End Flow

1. **Thread Discovery**
   - Engain discovers relevant threads via SEO feed, mentions, smart search
   - Library filters eligible candidates based on age, engagement, subreddit rules

2. **Draft Generation**
   - LLM generates comment draft with explicit disclosure requirement in prompt
   - Writer is instructed: "Every comment MUST include disclosure"
   - Draft includes GeoNode affiliation statement

3. **Filing (Pre-Queue Validation)**
   - `file()` function validates disclosure immediately
   - Comments without disclosure rejected before queuing
   - Error returned to writer: "TRANSPARENCY VIOLATION: Missing disclosure"

4. **Queue Validation**
   - Draft enters queue with status `queued`
   - Waits for `decision_due_at` time (pacing)

5. **Pre-Send Comprehensive Check**
   - When due, `sendOne()` runs full transparency validation:
     - ✅ Disclosure present and matches account's `disclosure_line`
     - ✅ Not replying to our own comment (no staged conversation)
     - ✅ Within rate limits (account and subreddit)
     - ✅ Subreddit is allowed
     - ✅ Not duplicate content in same thread
   - All checks logged to `transparency_audits` table
   - Results stored in message's `transparency_check` field

6. **Submission**
   - If all checks pass: Submit to Engain accounts-beta API
   - If any check fails: Hold message with explicit reason
   - Status: `transparency_blocked` with failure details

7. **Monitoring**
   - Track Engain task status
   - Verify publication on Reddit
   - Log all state changes

## Engain API Integration

### Confirmed Endpoints (accounts-beta)

Based on the codebase and Engain's API structure:

**Owned Accounts (accounts-beta)**:
- `GET /api/v1/accounts-beta/accounts` - List owned accounts
- `POST /api/v1/accounts-beta/comments` - Create comment/reply
  - Body: `{ userAccountId, targetUrl, body }`
- `GET /api/v1/accounts-beta/comments` - List comments (with pagination)
- `POST /api/v1/accounts-beta/comments/{id}/cancel` - Cancel comment

**Project-Level** (used for rule checking only):
- `GET /api/v1/me` - Get accessible projects
- `POST /api/v1/rule-check` - Check comment against subreddit rules
  - Body: `{ projectId, subreddit, taskType, content, mediaKind, context }`

### Important Notes

1. **accounts-beta is a private API**: The public Engain documentation does not list accounts-beta endpoints. This integration was built against existing Engain accounts-beta access. If you don't have accounts-beta access, contact Engain.

2. **No pooled tasks**: The system does NOT use:
   - `POST /api/v1/tasks/comment`
   - `POST /api/v1/tasks/reply`
   - `GET /api/v1/tasks/{taskId}`
   
   These are pooled task endpoints where Engain chooses the account. They are incompatible with transparency requirements.

3. **Rule checking is optional**: If no `projectId` is available, rule checking is skipped but transparency checks still run. Rule checking provides an extra safety layer but is not required for transparency enforcement.

## Dry Run / Simulation Mode

To test the system without posting to Reddit:

```bash
# Run local tests (uses PGlite, no real posting)
npm test

# Run specific transparency tests
node --test tests/transparency.test.cjs
```

The test suite:
- Creates local database with migrations
- Simulates Engain API responses
- Validates all transparency checks
- Tests blocking of violations
- **Never touches real Reddit or Engain APIs**

## Monitoring and Auditing

### Transparency Audit Log

Every transparency check is logged:

```sql
-- View recent transparency audits
SELECT 
  ta.id,
  ta.message_id,
  ta.check_type,
  ta.passed,
  ta.details,
  ta.checked_at,
  m.body
FROM transparency_audits ta
LEFT JOIN message_queue m ON m.id = ta.message_id
ORDER BY ta.checked_at DESC
LIMIT 50;

-- Count failures by check type
SELECT 
  check_type,
  COUNT(*) as total,
  SUM(CASE WHEN passed THEN 1 ELSE 0 END) as passed,
  SUM(CASE WHEN NOT passed THEN 1 ELSE 0 END) as failed
FROM transparency_audits
GROUP BY check_type;
```

### Message Transparency Status

```sql
-- View messages with transparency check results
SELECT 
  m.id,
  m.status,
  m.body,
  m.transparency_check->>'ok' as transparency_ok,
  m.transparency_check->'failures' as failures,
  m.created_at
FROM message_queue m
WHERE m.transparency_check IS NOT NULL
ORDER BY m.created_at DESC;

-- Count blocked messages
SELECT 
  COUNT(*) as total_blocked,
  COUNT(DISTINCT thread_id) as threads_affected
FROM message_queue
WHERE transparency_check->>'ok' = 'false';
```

## Troubleshooting

### "TRANSPARENCY VIOLATION: Pooled accounts are disabled"

**Cause**: `ENGAIN_DELIVERY=pool` is set or code is trying to use pooled mode.

**Fix**: Set `ENGAIN_DELIVERY=owned` or remove the variable (defaults to owned).

### "Missing mandatory disclosure"

**Cause**: Comment body does not include required disclosure phrase.

**Fix**: 
1. Ensure disclosure is in the draft: "GeoNode team member here"
2. Check account's `disclosure_line` is configured
3. Verify LLM prompts emphasize disclosure requirement

### "Blocked: This would create a staged conversation"

**Cause**: Trying to reply to a comment posted by another GeoNode account.

**Fix**: This is working as designed. Do not reply to your own comments. If you need follow-up engagement, wait for real users to reply first.

### "Account rate limit: 5/5 comments in last 24h"

**Cause**: Account has reached daily limit.

**Fix**: 
1. Wait 24 hours, or
2. Increase limit: `MAX_COMMENTS_PER_ACCOUNT_PER_DAY=10`, or
3. Use a different account

### "Subreddit r/example: Subreddit is in deny list"

**Cause**: Subreddit is marked as denied in `subreddit_filters`.

**Fix**:
1. Verify subreddit actually bans self-promotion
2. If allowed, update: `UPDATE subreddit_filters SET status='allowed' WHERE subreddit='example'`
3. If genuinely banned, skip this thread

### "No owned accounts available"

**Cause**: Engain accounts-beta API returned no usable accounts.

**Fix**:
1. Verify Engain API key has accounts-beta access
2. Check Engain dashboard for connected accounts
3. Ensure at least one account is marked `usable: true`

## Architecture Decisions

### Why Code Enforcement vs. Guidelines?

**Problem**: Documentation can be ignored. Mistakes happen. Guidelines without enforcement don't guarantee compliance.

**Solution**: Hard-coded enforcement ensures violations are impossible, not just discouraged.

### Why Block Staged Conversations?

**Problem**: One GeoNode account replying to another looks like fake social proof. Reddit users (and moderators) recognize and reject this.

**Solution**: Automatically block this pattern. If context genuinely requires follow-up, use the same disclosed account or wait for real user replies.

### Why Mandatory Disclosure on Every Comment?

**Problem**: A comment without disclosure looks like an independent endorsement. This violates Reddit's authenticity expectations and FTC guidelines.

**Solution**: Server rejects any comment without disclosure. Cannot be bypassed.

### Why Owned Accounts Only?

**Problem**: Pooled accounts (where Engain chooses) don't guarantee consistent disclosure or identity. Cannot maintain transparent account relationships.

**Solution**: GeoNode controls the accounts, sets disclosure, and maintains clear identity across threads.

## Future Enhancements

Possible additions (not implemented):

1. **Per-subreddit disclosure templates**: Different subreddits might prefer different phrasing
2. **Automated subreddit rule checking**: Scrape subreddit rules to auto-populate deny list
3. **Engagement quality scoring**: Track which types of helpful content get positive reception
4. **Cross-platform transparency**: Extend to other platforms (HN, forums, etc.)

## Support

For questions or issues:

1. Check transparency audit logs: `SELECT * FROM transparency_audits ORDER BY checked_at DESC`
2. Review blocked messages: `SELECT * FROM message_queue WHERE status = 'transparency_blocked'`
3. Verify configuration: `SELECT * FROM workflow_state WHERE key IN ('human_review_mode', 'subreddit_policy')`
4. Run tests: `npm test`

## Summary

This system enforces GeoNode's commitment to transparent, honest Reddit engagement:

✅ **Own accounts only** - No pooled accounts  
✅ **Mandatory disclosure** - Every comment identifies GeoNode  
✅ **No staged conversations** - No fake social proof  
✅ **Rate limits** - Respectful pacing  
✅ **Subreddit filtering** - Respect community rules  
✅ **Full audit trail** - Every check logged  

All constraints are **enforced in code**. Violations are blocked automatically.
