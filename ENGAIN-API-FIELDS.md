# Engain API Fields Reference

This document details the exact Engain request/response fields relied upon for the real job queue system, and documents any assumptions made due to the beta API not being fully documented.

## Endpoints Used

### 1. GET /api/v1/me

**Purpose**: Verify workspace access and get project info

**Request**: None (authenticated via X-API-Key header)

**Response**:
```json
{
  "userId": "string",
  "email": "string",
  "projects": [
    {
      "id": "proj_...",
      "name": "string"
    }
  ]
}
```

**Fields We Use**:
- (Read-only for verification)

**Assumptions**:
- Response structure matches authenticated workspace

---

### 2. GET /api/v1/accounts-beta/accounts

**Purpose**: List owned Reddit accounts available for posting

**Request**: None (authenticated via X-API-Key header)

**Response**:
```json
{
  "accounts": [
    {
      "userAccountId": "acct_...",
      "profileUsername": "u/username",
      "usable": true,
      "karma": 123,
      "accountAge": 456
    }
  ]
}
```

**Fields We Use**:
- `userAccountId` (string, required) - Account identifier for API calls
- `profileUsername` (string, optional) - Reddit username for display
- `usable` (boolean, required) - Whether account can post

**Assumptions**:
- `userAccountId` is stable and can be used for future API calls
- `usable: true` means account is ready for immediate posting
- `accounts` array is always present (may be empty)

---

### 3. POST /api/v1/accounts-beta/comments

**Purpose**: Submit comment or reply to Reddit via Engain

**Request**:
```json
{
  "userAccountId": "acct_...",
  "targetUrl": "https://reddit.com/r/subreddit/comments/...",
  "body": "Comment text with disclosure"
}
```

**Fields We Send**:
- `userAccountId` (string, required) - From GET /accounts-beta/accounts
- `targetUrl` (string, required) - Reddit thread or comment URL
- `body` (string, required) - Comment text (must include disclosure)

**Response** (Successful - 200/201):
```json
{
  "id": "cmt_...",
  "_id": "...",
  "status": "in_queue",
  "threadUrl": "https://reddit.com/r/subreddit/comments/...",
  "content": "Comment text",
  "userAccountId": "acct_...",
  "createdAt": "2024-10-27T12:34:56Z",
  "_creationTime": 1234567890000
}
```

**Fields We Use**:
- `id` OR `_id` (string, required) - Task identifier for status polling
  - **ASSUMPTION**: Either field may be present; we check both
- `status` (string, required) - Initial status (usually "in_queue")
- `threadUrl` (string) - Confirms target URL
- `content` (string) - Confirms submitted content

**Fields We Store**:
- Full response in `engain_response` jsonb column
- Task ID extracted from `id` or `_id` → `engain_task_id`
- Status → `engain_status`

**Assumptions**:
- Task ID is stable and unique
- Task ID can be used with GET /accounts-beta/comments to poll status
- `status` field always present on success

---

### 4. GET /api/v1/accounts-beta/comments

**Purpose**: List and poll comment statuses

**Request**:
- Query params: `cursor` (optional), `limit` (optional, default 50)

**Response**:
```json
{
  "page": [
    {
      "id": "cmt_...",
      "_id": "...",
      "status": "published",
      "redditUrl": "https://reddit.com/r/sub/comments/abc123/title/def456/",
      "threadUrl": "https://reddit.com/r/sub/comments/abc123/",
      "content": "Comment text",
      "userAccountId": "acct_...",
      "createdAt": "2024-10-27T12:34:56Z"
    }
  ],
  "isDone": false,
  "continueCursor": "cursor_token_xyz"
}
```

**Fields We Use for Status Detection**:

**Published Detection**:
- `status === 'published'` (string, case-insensitive)
- `redditUrl` OR `resultUrl` present (string) - Reddit comment permalink
  - **ASSUMPTION**: Either field may contain the permalink

**Failed Detection**:
- `status` in:
  - `'automod_removed'` - AutoModerator removed
  - `'mod_removed'` - Moderator removed
  - `'user_deleted'` - User or system deleted
  - `'main_comment_removed_deleted'` - Parent removed
  - `'error'` - Technical error
  - `'failed'` - General failure
  - `'cancelled'` / `'canceled'` - Cancelled by API
  - `'rejected'` - Rejected by system
  - `'post_url_broken'` - Target URL invalid
  - `'thread_archived_locked'` - Thread locked/archived
  - `'subreddit_private_banned'` - Subreddit inaccessible

**Pending Detection** (Still Processing):
- `status` in:
  - `'in_queue'` - Queued for processing
  - `'in_review'` - Under review
  - `'waiting_for_mod_approval'` - Awaiting moderator approval
  - `'waiting_for_parent_comment'` - Waiting for parent to publish

**Unknown Status**:
- Any other `status` value treated as pending
- Logged for monitoring

**Assumptions**:
- `status` field always lowercase string
- Status values are stable (won't change meaning)
- `redditUrl` format: `https://reddit.com/r/{sub}/comments/{thread_id}/{title}/{comment_id}/`
- Published status is terminal for non-questions
- Failed statuses are terminal (no automatic retry)

**Pagination**:
- `page` array contains comments (newest first assumed)
- `isDone: true` means no more results
- `continueCursor` used for next page

**Assumptions for Pagination**:
- `continueCursor: null` when `isDone: true`
- Cursor tokens are opaque and time-limited
- No guaranteed order, but observed newest-first

---

### 5. POST /api/v1/accounts-beta/comments/{id}/cancel

**Purpose**: Cancel a pending comment

**Request**: None (task ID in URL path)

**Response**:
```json
{
  "success": true,
  "id": "cmt_...",
  "status": "cancelled"
}
```

**Fields We Use**:
- `success` (boolean) - Cancellation succeeded
- `status` (string) - Updated status

**Assumptions**:
- Only works on pending tasks (in_queue, in_review)
- Returns error if already published or failed

---

### 6. POST /api/v1/rule-check

**Purpose**: Pre-validate comment against subreddit rules

**Request**:
```json
{
  "projectId": "proj_...",
  "subreddit": "webscraping",
  "taskType": "comment",
  "content": "Comment body",
  "mediaKind": "text",
  "context": {
    "postUrl": "string",
    "postTitle": "string",
    "parentCommentUrl": "string (optional)",
    "parentComment": "string (optional)"
  }
}
```

**Response**:
```json
{
  "verdict": "pass",
  "removalRisk": 15,
  "authenticityRisk": 20,
  "marketingIntentRisk": 10,
  "violatedRules": [],
  "summary": "Explanation text",
  "contextWarnings": []
}
```

**Fields We Use**:
- `verdict` (string) - "pass", "warn", "fail", "unavailable", "skipped"
- `removalRisk` (number, 0-100) - Risk score
- `violatedRules` (array) - List of rule violations
- `summary` (string) - Explanation

**Assumptions**:
- `verdict: "pass"` and `removalRisk <= threshold` means safe to post
- `verdict: "fail"` blocks posting
- "unavailable" / "skipped" allows posting (degraded mode)

---

## Field Extraction Utilities

**Comment ID Extraction** (`extractCommentId`):
```javascript
function extractCommentId(engainResponse) {
  return engainResponse.id || engainResponse._id || null;
}
```
- Checks both `id` and `_id` fields
- Returns null if neither present

**Reddit URL Extraction** (`extractRedditUrl`):
```javascript
function extractRedditUrl(engainResponse) {
  return engainResponse.redditUrl || engainResponse.resultUrl || null;
}
```
- Checks both `redditUrl` and `resultUrl` fields
- Returns null if neither present

**Status Parsing** (`parseEngainStatus`):
- See Section 4 above for complete status mapping
- Returns: `{ jobStatus, isFinal, reason }`
- `jobStatus`: Our internal status (`'pending'`, `'published'`, `'failed'`)
- `isFinal`: Whether this status is terminal
- `reason`: Human-readable explanation (for failed statuses)

---

## Critical Assumptions

These are assumptions we made due to the beta API not being fully documented:

1. **Task ID Stability**
   - Assumption: Task IDs (`id` or `_id`) are stable and unique
   - Risk: If IDs change or are reused, status polling breaks
   - Mitigation: Store full response, compare multiple fields

2. **Status String Values**
   - Assumption: Status values are lowercase, stable, and match our mappings
   - Risk: New status values added without documentation
   - Mitigation: Log unknown statuses, treat as pending

3. **Published Detection**
   - Assumption: `status === 'published'` AND `redditUrl` present = definitely published
   - Risk: Status could be "published" before URL available, or URL in different field
   - Mitigation: Check both fields, log cases where status=published but no URL

4. **Reddit URL Format**
   - Assumption: `redditUrl` follows pattern: `/r/{sub}/comments/{thread}/{title}/{comment}/`
   - Risk: Format could vary (www prefix, query params, etc.)
   - Mitigation: Parse flexibly, validate against known patterns

5. **Pagination Behavior**
   - Assumption: Comments returned newest-first
   - Risk: Order not guaranteed by API
   - Mitigation: Don't rely on order for correctness, use timestamps

6. **Terminal Status Detection**
   - Assumption: Our "failed" status list is complete
   - Risk: New failure modes could be added
   - Mitigation: Monitor for unknown statuses, alert on anomalies

7. **Rate Limit Handling**
   - Assumption: HTTP 429 with exponential backoff is sufficient
   - Risk: API could enforce quota limits not visible in responses
   - Mitigation: Track usage, respect retry-after headers if present

8. **Account Usability**
   - Assumption: `usable: true` means account ready to post
   - Risk: Could have restrictions not reflected in flag
   - Mitigation: Handle submission errors gracefully

---

## Validation Strategy

To validate these assumptions in production:

1. **Log All Responses**: Store complete Engain responses in `engain_response` jsonb
2. **Monitor Unknown Statuses**: Alert when status not in our mappings
3. **Track Field Presence**: Log when expected fields missing
4. **Validate URLs**: Check Reddit URL format matches expectations
5. **Compare Fields**: When both `id`/`_id` or `redditUrl`/`resultUrl` present, verify they match
6. **Performance Metrics**: Track status transition times and polling frequency

---

## Updates and Changes

If Engain beta API behavior changes:

1. Update status mappings in `api/_engain-real.js`
2. Update this documentation
3. Add migration if database schema affected
4. Test with `npm run live-check` before deploying
5. Monitor production logs for anomalies

---

**Last Updated**: 2024-10-27  
**API Version**: Engain accounts-beta (private beta)  
**Contact**: Check with Engain support for API documentation updates
