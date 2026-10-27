# Official Engain API Documentation Findings

## Executive Summary

The URL provided (https://docs.engain.io/#engain-accounts-beta) **does not contain an "accounts-beta" section** in the official Engain API documentation. The OpenAPI specification at https://docs.engain.io/api/openapi.json has been examined, and no "accounts-beta" endpoints exist.

## Documentation Source

- **Official Docs**: https://docs.engain.io/
- **OpenAPI Spec**: https://docs.engain.io/api/openapi.json
- **Date Checked**: 2024-10-27

## Official Task Endpoints (Documented)

The official Engain API documents these task management endpoints:

### POST /api/v1/tasks/comment
Create a comment task on a Reddit post.

**Request**:
```json
{
  "projectId": "project_def456uvw",
  "url": "https://www.reddit.com/r/technology/comments/abc123/title/",
  "content": "This is a helpful comment on the post.",
  "labels": ["food", "pets"],
  "images": ["https://cdn.example.com/images/screenshot.png"],
  "rank": {
    "upvotesGoal": 15,
    "upvotesPerDay": 5,
    "startingDate": "after_3_days"
  },
  "scheduledAt": "2025-02-06T12:00:00.000Z"
}
```

**Response** (201):
```json
{
  "id": "task_comment_xyz",
  "kind": "task",
  "type": "comment",
  "subreddit": "technology",
  "threadUrl": "https://www.reddit.com/r/technology/comments/abc123/title/",
  "content": "This is a helpful comment on the post.",
  "creditsUsed": 5,
  "status": "scheduled",
  "scheduledAt": "2025-02-06T12:00:00.000Z",
  "projectName": "My Project",
  "redditUrl": null,
  "postFlair": null,
  "posterAccount": null,
  "labels": ["food", "pets"],
  "images": ["https://cdn.example.com/images/screenshot.png"]
}
```

### POST /api/v1/tasks/reply
Create a reply task (reply to a comment).

**Similar structure, with parent comment URL**

### GET /api/v1/tasks
List tasks with pagination.

**Query Parameters**:
- `projectId` (required)
- `numItems` (1-100, default 20)
- `cursor` (for pagination)
- `status` (filter by status)
- `createdAfter` (ISO 8601 or Unix ms)
- `createdBefore` (ISO 8601 or Unix ms)

**Response**:
```json
{
  "page": [
    {
      "_id": "task_xyz789",
      "creationDate": "2025-02-06T12:00:00.000Z",
      "boostedUpvotes": 0,
      "content": "Great post, thanks for sharing!",
      "creditsUsed": 5,
      "status": "published",
      "sourceMentionId": null,
      "sourceOpportunityId": "opp_abc123",
      "subreddit": "technology",
      "type": "comment",
      "threadUrl": "https://www.reddit.com/r/technology/comments/abc123/title/",
      "scheduledAt": null,
      "projectName": "My Project",
      "redditUrl": "https://www.reddit.com/r/technology/comments/abc123/title/xyz/",
      "postTitle": null,
      "rank": null,
      "projectId": "project_def456uvw",
      "publishedAt": "2025-02-06T12:30:00.000Z",
      "parentTaskId": null,
      "labels": []
    }
  ],
  "isDone": false,
  "cursor": "cursor_token_next_page"
}
```

### GET /api/v1/tasks/{taskId}
Get specific task details.

**Response**: Same schema as TaskItem above

### POST /api/v1/tasks/{taskId}/cancel
Cancel a pending task.

**Response**:
```json
{
  "success": true
}
```

## Official Task Schema

**TaskItem**:
```typescript
{
  _id: string;                    // Unique task identifier
  creationDate: string;           // ISO 8601
  boostedUpvotes: number;
  content: string;                // Comment/post text
  creditsUsed: number;
  status: string;                 // See status enum below
  sourceMentionId: string | null;
  sourceOpportunityId: string | null;
  subreddit: string;
  type: "comment" | "post" | "reply";
  threadUrl: string | null;
  scheduledAt: string | null;     // ISO 8601
  projectName: string;
  redditUrl: string | null;       // Reddit permalink when published
  postTitle: string | null;       // For post tasks
  rank: object | null;            // Upvote boost settings
  projectId: string;
  publishedAt: string | null;     // ISO 8601
  parentTaskId: string | null;    // For reply tasks
  labels: string[];
}
```

## Official Status Values (Documented)

The official API documents these status values:

**Active Statuses**:
- `scheduled` - Task scheduled for future execution
- `in_review` - Sent to fulfillment, waiting to be picked up (legacy: `sent_for_posting`)
- `in_queue` - Being worked on (legacy: `assigned`)
- `waiting_for_parent_comment` - Waiting for parent comment to publish
- `waiting_for_mod_approval` - Waiting for subreddit moderator approval

**Success Status**:
- `published` - Successfully posted to Reddit

**Failure Statuses**:
- `user_deleted` - User or system deleted
- `automod_removed` - Removed by AutoModerator
- `mod_removed` - Removed by moderator
- `post_url_broken` - Target URL is invalid
- `subreddit_private_banned` - Subreddit is private or banned
- `incorrect_missing_flair` - Flair issue
- `main_comment_removed_deleted` - Parent comment was removed
- `thread_archived_locked` - Thread is archived or locked
- `cancelled` - Cancelled via API
- `error` - Technical error
- `rebuilt` - Task was rebuilt (rare)

**Status Aliases** (Legacy, normalized in responses):
- `sent_for_posting` → `in_review`
- `assigned` → `in_queue`

## Key Differences vs Our Implementation

### 1. No "accounts-beta" Endpoints

**What We Implemented**:
- `/api/v1/accounts-beta/accounts` - List owned accounts
- `/api/v1/accounts-beta/comments` - Create/list comments with userAccountId

**Official Documentation**:
- These endpoints DO NOT EXIST in the official docs
- No mention of "accounts-beta" anywhere

### 2. No Owned Account Selection

**What We Implemented**:
- `userAccountId` field to select which owned account to use
- System enforces owned-accounts-only (no pooled)

**Official Documentation**:
- No `userAccountId` field in any schema
- Tasks use Engain's managed pooled accounts
- Account selection not exposed in API

### 3. Task ID Field Name

**What We Implemented**:
- Check both `id` and `_id` fields

**Official Documentation**:
- **Always `_id`** (underscore prefix)
- No `id` field in TaskItem schema

### 4. Pagination

**What We Implemented**:
- `continueCursor` and `isDone` fields

**Official Documentation**:
- `cursor` and `isDone` fields (no "continue" prefix)

## Matching Elements

These parts of our implementation **match** the official docs:

✅ **Status values** - All documented statuses match what we implemented
✅ **`redditUrl` field** - Published tasks have this field  
✅ **`threadUrl` field** - Target URL for comment/reply
✅ **Rate limiting** - 30 requests/minute documented
✅ **Error responses** - 401, 429, etc. match
✅ **ISO 8601 timestamps** - Standard across API

## Implications

### Option 1: "accounts-beta" is Private/Undocumented
- Matas has access to a private beta API not in public docs
- Our implementation is correct for that private API
- We cannot validate against official docs

### Option 2: Wrong URL Provided
- The URL https://docs.engain.io/#engain-accounts-beta is incorrect
- Actual docs might be elsewhere (internal wiki, email, Slack)

### Option 3: Pooled API is What We Should Use
- The official documented API is what we should implement
- Would require complete rewrite to remove owned-account logic
- Would use `/api/v1/tasks/*` endpoints instead

## Recommendations

1. **Clarify with Matas**: Ask for the correct documentation URL or confirm "accounts-beta" is private
2. **If Private API**: Keep current implementation, document it's based on undocumented beta
3. **If Wrong URL**: Get correct docs and align code
4. **If Should Use Pooled**: Major architecture change needed

## Next Steps Pending Clarification

Cannot proceed with alignment until we confirm which API to use:
- Private "accounts-beta" endpoints (current implementation)
- Public pooled account endpoints (documented at docs.engain.io)

---

**Date**: 2024-10-27  
**Checked**: Official OpenAPI spec at https://docs.engain.io/api/openapi.json  
**Finding**: No "accounts-beta" section exists in official documentation
