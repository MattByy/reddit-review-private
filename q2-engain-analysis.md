# Q2 (queue2) to Engain Analysis — CORRECTED

## Executive Summary

**Can queue2 items be sent to Engain?**

- **(a) Thread comments:** ✅ **YES** — `kind: 'thread'` items have thread URLs and can be posted as top-level comments
- **(b) Replies to comments:** ✅ **YES** — `kind: 'comment'` and `kind: 'mention'` items have comment URLs and can be posted as replies

**However:** Queue2 items are currently **NOT ready** to send as-is. Critical fields are missing and safety gates are absent.

---

## 1. What is Q2? (The REAL Q2)

**Q2 is the `queue2` SQLite table** in the local dev server (`server/store.cjs`, `server/queue.cjs`, `server/dev.cjs`).

This is NOT the production `experiment_messages` table. It's a local development server that collects Reddit threads from Engain's API.

### The Two-Queue System

From `docs/engain-thread-collection.md`:

**Queue 1** (table: `queue`):
- Work items to be done
- Contains threads, our published comments, and competitor mentions
- Prioritized and ranked

**Queue 2** (table: `queue2`):
- Items from queue 1 that have a message attached
- Created by calling `POST /api/agent/task`
- The item never returns to queue 1

### Queue2 Table Structure

From `server/store.cjs` lines 36-39:

```sql
CREATE TABLE queue2(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,          -- 'thread' | 'comment' | 'mention'
  thread_id TEXT,
  url TEXT,                     -- Where the message goes
  thread_url TEXT,              -- The thread URL
  title TEXT,                   -- Thread title
  message TEXT NOT NULL,        -- Message body
  message_source TEXT NOT NULL, -- 'given' | 'random'
  item TEXT NOT NULL,           -- Full queue 1 item JSON
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### Three Item Kinds

From `docs/engain-thread-collection.md`:

| Kind | What it is | `url` (where message goes) | `thread_url` | Action |
|------|-----------|---------------------------|--------------|---------|
| `thread` | A thread to comment on | Thread URL | Thread URL | Post top-level comment |
| `comment` | Our published comment | Our comment permalink | Thread URL | Reply to our comment |
| `mention` | Competitor mention | Competitor comment permalink | Thread URL | Reply to competitor |

### How Items Enter Queue2

From `server/dev.cjs` and `server/queue.cjs`:

```javascript
// POST /api/agent/task with optional body {"agent":"writer-1","message":"..."}
// Moves #1 from queue 1 to queue 2 with a message

const result = {
  "task_id": "p_k976...",
  "status": "comment",           // The kind
  "url": "https://reddit.com/r/sub/comments/.../comment/abc123",
  "thread_url": "https://reddit.com/r/sub/comments/...",
  "comment": {...},              // Details about our comment
  "thread": {...},               // Thread metadata
  "remaining": 58,               // Items left in queue 1
  "queue2": {
    "queue2_id": 5,
    "status": "comment",
    "url": "...",
    "message": "Placeholder message: ...",
    "message_source": "random",  // or "given"
    "item": {...}                // Full queue 1 item
  }
}
```

---

## 2. What Engain Needs

### Official Engain Accounts Beta API

From https://docs.engain.io/engain-accounts-beta:

**Endpoint:** `POST /api/v1/accounts-beta/comments`

**Request:**
```json
{
  "userAccountId": "acct_...",
  "targetUrl": "https://reddit.com/r/subreddit/comments/...",
  "body": "Comment text with disclosure"
}
```

**Response:**
```json
{
  "id": "cmt_...",
  "status": "in_queue",
  "threadUrl": "https://reddit.com/...",
  "content": "Comment text",
  "userAccountId": "acct_...",
  "createdAt": "2026-10-28T00:00:00Z"
}
```

### How Engain Determines Comment vs Reply

**From the URL format only:**

- **Thread comment:** `targetUrl` = thread URL like `https://reddit.com/r/sub/comments/abc123/title/`
- **Reply:** `targetUrl` = comment URL like `https://reddit.com/r/sub/comments/abc123/title/def456/`

Same endpoint for both. Engain parses the URL.

---

## 3. Field Mapping: Queue2 → Engain

### Queue2 Item Fields

```javascript
{
  queue2_id: 5,
  item_id: "p_k976...",
  kind: "comment",                    // 'thread' | 'comment' | 'mention'
  url: "https://reddit.com/r/...",    // Where message goes
  thread_url: "https://reddit.com/...",
  title: "Thread title",
  message: "Placeholder message: ...",
  message_source: "random",           // 'given' | 'random'
  created_by: "agent-1",
  created_at: "2026-10-28T00:00:00Z",
  item: {...}                         // Full queue 1 item JSON
}
```

### Mapping to Engain Request

| Engain Field | Queue2 Source | Present? | Notes |
|--------------|---------------|----------|-------|
| `userAccountId` | ❌ NOT PRESENT | **NO** | **MISSING: No account selection** |
| `targetUrl` | `url` | ✅ YES | Maps directly |
| `body` | `message` | ✅ YES | Present, but may be placeholder |

### Field Status by Kind

**Thread comments (`kind: 'thread'`):**
- ✅ `url` is thread URL → Engain posts top-level comment
- ✅ `message` is the body text
- ❌ `userAccountId` missing
- ⚠️ `message` might be placeholder (`message_source: 'random'`)

**Replies to our comments (`kind: 'comment'`):**
- ✅ `url` is our comment permalink → Engain posts reply to it
- ✅ `message` is the body text
- ❌ `userAccountId` missing
- ⚠️ `message` might be placeholder

**Replies to competitor mentions (`kind: 'mention'`):**
- ✅ `url` is competitor comment permalink → Engain posts reply to it
- ✅ `message` is the body text
- ❌ `userAccountId` missing
- ⚠️ `message` might be placeholder

---

## 4. Critical Gaps

### ❌ Missing Required Fields

1. **No `userAccountId`**
   - Engain requires specifying which account posts
   - Queue2 has no account field
   - Must be chosen before sending

2. **No `projectId`**
   - May be in server config (`process.env.ENGAIN_PROJECT_ID`)
   - Not stored per-item in queue2

### ⚠️ Placeholder Messages

From `server/queue.cjs` lines 180-187:

```javascript
const PLACEHOLDERS = [
  'Placeholder message: thanks for sharing this, useful thread.',
  'Placeholder message: interesting point, worth testing before deciding.',
  // ... more placeholders
];
```

**Problem:**
- Items with `message_source: 'random'` contain placeholder text
- These explicitly say "Placeholder message:" at the start
- **MUST NOT** be sent to Reddit
- Need a gate to reject `message_source: 'random'`

### 🚫 Missing Safety Gates

Comparing to production `api/_messages.js` and `api/_send.js`:

| Safety Gate | Production | Queue2 Dev Server |
|-------------|-----------|------------------|
| **Disclosure check** | ✅ Required | ❌ Missing |
| **Transparency validation** | ✅ Full validation | ❌ Missing |
| **Account eligibility** | ✅ Active & disclosed | ❌ No account chosen |
| **Thread already engaged check** | ✅ One account per thread | ❌ Missing |
| **Duplicate body check** | ✅ Never same text twice | ❌ Missing |
| **Rate limiting** | ✅ 45min global / 24h per sub | ❌ Missing |
| **Pace floor** | ✅ 20 per UTC day cap | ❌ Missing |
| **Rule check** | ✅ Engain rule validation | ❌ Missing |
| **Parent verification** | ✅ Check parent still exists | ❌ Missing |
| **Forbidden phrases** | ✅ Block unsupported claims | ❌ Missing |
| **Sent/status tracking** | ✅ Full lifecycle | ❌ No status column |
| **Idempotency** | ✅ Prevent duplicate sends | ❌ No sent tracking |

### 📊 No Status Tracking

Queue2 has no fields for:
- `sent_at` (when submitted to Engain)
- `engain_task_id` (Engain's task ID)
- `status` (pending, published, failed)
- `reddit_url` (published permalink)
- `sent_by` (which system sent it)

**Problem:** Nothing prevents sending the same item twice.

---

## 5. URL Format Verification

### Thread URLs (kind: 'thread')

Example: `https://reddit.com/r/webscraping/comments/abc123/title/`

✅ **Format is correct** for Engain `targetUrl`
- Matches Engain's expected thread URL format
- Will create top-level comment

### Comment URLs (kind: 'comment' and 'mention')

Example: `https://reddit.com/r/webscraping/comments/abc123/title/def456/`

✅ **Format is correct** for Engain `targetUrl`
- Matches Engain's expected comment permalink format
- Last segment (`def456`) is comment ID
- Will create reply to that comment

**Verified:** The URL formats in queue2 match what Engain expects.

---

## 6. Existing Code Reuse

### Can Production Code Be Reused?

**Production path:** `api/_delivery.js` → `api/_engain-real.js`

```javascript
// api/_delivery.js
async function submit(message, transport) {
  return engain('POST', '/api/v1/accounts-beta/comments', {
    userAccountId: transport.account_id,
    targetUrl: message.target_url,
    body: message.body
  });
}
```

**Dev server path:** `server/engain.cjs`

```javascript
// server/engain.cjs
const client = ({apiKey, fetchImpl=fetch, limits=true, log=()=>{}} = {}) => {
  async function call(method, path, {query, body, bucket='general'} = {}) {
    // Makes authenticated Engain API calls
    // Handles rate limiting (30 req/min)
  }
  
  return {
    me: () => call('GET', '/api/v1/me'),
    opportunities: q => call('GET', '/api/v1/opportunities', {query: q}),
    // ... etc
    // NO accounts-beta endpoints!
  };
};
```

### What Can Be Reused?

**✅ Can reuse:**
- HTTP client structure (`server/engain.cjs`)
- Rate limiting logic (`Bucket` class)
- API key authentication
- Request/response handling

**❌ Cannot reuse directly:**
- `api/_delivery.js` is production code (Vercel Functions)
- Depends on production Supabase tables
- Assumes full transparency enforcement stack
- Dev server has different data model

### Smallest Path to Wire Up

**Option 1: Add accounts-beta to dev server client**

In `server/engain.cjs`, add:

```javascript
return {
  // ... existing methods
  
  // Accounts beta
  accounts: () => call('GET', '/api/v1/accounts-beta/accounts'),
  createComment: (userAccountId, targetUrl, body) => 
    call('POST', '/api/v1/accounts-beta/comments', {
      body: {userAccountId, targetUrl, body}
    }),
  getComments: (cursor) => 
    call('GET', '/api/v1/accounts-beta/comments', {
      query: cursor ? {cursor} : {}
    }),
  cancelComment: (commentId) => 
    call('POST', `/api/v1/accounts-beta/comments/${commentId}/cancel`),
};
```

**Option 2: New minimal sender**

Create `server/send-queue2.cjs`:

```javascript
const {client} = require('./engain.cjs');

async function sendQueue2Item(item, {apiKey, accountId}) {
  // 1. Validate not placeholder
  if (item.message_source === 'random') {
    throw new Error('Cannot send placeholder message');
  }
  
  // 2. Validate disclosure present
  if (!/geonode/i.test(item.message)) {
    throw new Error('Message must include GeoNode disclosure');
  }
  
  // 3. Call Engain
  const engain = client({apiKey});
  const response = await engain.call('POST', '/api/v1/accounts-beta/comments', {
    body: {
      userAccountId: accountId,
      targetUrl: item.url,
      body: item.message
    }
  });
  
  return response;
}

module.exports = {sendQueue2Item};
```

---

## 7. Recommended Implementation Plan

### Phase 1: Minimal Sender (Proof of Concept)

**Goal:** Send one queue2 item manually with safeguards

**Steps:**
1. Add accounts-beta methods to `server/engain.cjs`
2. Create `server/send-queue2.cjs` with:
   - Placeholder rejection (`message_source === 'random'` → error)
   - Basic disclosure check (contains "GeoNode")
   - Engain API call
3. Add manual route: `POST /api/queue2/:id/send {"accountId":"acct_..."}`
4. Test with one item
5. **DO NOT** auto-send anything

**Files to create/modify:**
- `server/engain.cjs` — add accounts-beta methods
- `server/send-queue2.cjs` — new sender module
- `server/dev.cjs` — add manual send route

### Phase 2: Status Tracking

**Goal:** Prevent duplicate sends

**Steps:**
1. Add columns to queue2:
   ```sql
   ALTER TABLE queue2 ADD COLUMN sent_at TEXT;
   ALTER TABLE queue2 ADD COLUMN engain_task_id TEXT;
   ALTER TABLE queue2 ADD COLUMN status TEXT DEFAULT 'draft';
   ALTER TABLE queue2 ADD COLUMN reddit_url TEXT;
   ```
2. Update sender to:
   - Check `status != 'sent'` before sending
   - Record `sent_at` and `engain_task_id` after success
   - Mark `status = 'sent'`
3. Add status polling (check Engain for published status)

### Phase 3: Full Safety Gates

**Goal:** Match production transparency enforcement

**Steps:**
1. Port disclosure rules from `api/_rules.js`
2. Add account selection (list accounts, choose least-used)
3. Add duplicate body check (same text on same thread)
4. Add rate limiting (45min global, 24h per subreddit, 20/day)
5. Add Engain rule check before send
6. Add parent existence verification
7. Add transparency validation

### Phase 4: Integration

**Goal:** Connect to production workflow

**Steps:**
1. Decide: dev server → production, or separate?
2. If separate: keep as testing/staging environment
3. If production: migrate data model to match `experiment_messages`
4. Add monitoring and alerts

---

## 8. Answers to User Questions

### (a) Thread Comments

**Can queue2 `kind: 'thread'` items be sent as thread comments?**

✅ **YES — Partially**

**What works:**
- `url` field contains thread URL in correct format
- Engain will accept it as `targetUrl`
- Will create top-level comment

**What's missing:**
- ❌ `userAccountId` (which account to post from)
- ❌ Disclosure in message body (may be placeholder)
- ❌ Placeholder detection (`message_source: 'random'` check)
- ❌ Duplicate send protection
- ❌ Rate limiting
- ❌ Transparency validation
- ❌ Subreddit rules check

**Status:** **PARTIALLY** — URL format works, but critical safety fields missing

---

### (b) Replies to Comments

**Can queue2 `kind: 'comment'` and `kind: 'mention'` items be sent as replies?**

✅ **YES — Partially**

**What works:**
- `url` field contains comment permalink in correct format
- Engain will accept it as `targetUrl`
- Will create reply to that comment

**What's missing:**
- ❌ `userAccountId` (which account to post from)
- ❌ Disclosure in message body (may be placeholder)
- ❌ Placeholder detection (`message_source: 'random'` check)
- ❌ Parent verification (comment still exists and not removed)
- ❌ Duplicate send protection
- ❌ Rate limiting
- ❌ Transparency validation
- ❌ Subreddit rules check

**Status:** **PARTIALLY** — URL format works, but critical safety fields missing

---

## 9. Complete Gap Summary

### Required Before Sending

| Requirement | Status | Notes |
|-------------|--------|-------|
| **Account selection** | ❌ MISSING | Need `userAccountId` for every send |
| **Project ID** | ⚠️ MAYBE | May be in config, not per-item |
| **Placeholder guard** | ❌ MISSING | Block `message_source: 'random'` |
| **Disclosure enforcement** | ❌ MISSING | Must verify GeoNode mention in body |
| **Status tracking** | ❌ MISSING | No `sent_at`, `status`, `task_id` columns |
| **Duplicate prevention** | ❌ MISSING | Nothing stops re-sending same item |
| **Rate limiting** | ❌ MISSING | No pacing, no daily caps |
| **Rule check** | ❌ MISSING | No Engain rule validation |
| **Parent verification** | ❌ MISSING | No check if comment still exists |
| **Thread engagement check** | ❌ MISSING | No "already have task there" gate |
| **Forbidden phrases** | ❌ MISSING | No filter for unsupported claims |
| **Transparency log** | ❌ MISSING | No audit trail |

### URL Format

| Kind | URL Format | Engain Compatible? |
|------|-----------|-------------------|
| `thread` | Thread URL | ✅ YES |
| `comment` | Our comment URL | ✅ YES |
| `mention` | Competitor comment URL | ✅ YES |

---

## 10. Final Recommendation

### Immediate Next Step

**DO NOT send queue2 items to Engain yet.** Critical safety gates are missing.

### Recommended Path Forward

**Step 1: Proof of Concept (1-2 hours)**
- Add accounts-beta methods to `server/engain.cjs`
- Create `server/send-queue2.cjs` with minimal gates:
  - Reject placeholder messages
  - Require "GeoNode" in body
  - Require `accountId` parameter
- Add `POST /api/queue2/:id/send` route (manual only)
- Test with ONE item (dry-run first)

**Step 2: Status Tracking (2-3 hours)**
- Add `sent_at`, `status`, `engain_task_id` columns to queue2
- Update sender to record sends
- Add duplicate send check
- Add status polling from Engain

**Step 3: Full Safety (8-12 hours)**
- Port all transparency gates from production
- Add rate limiting and pacing
- Add rule checks
- Add parent verification
- Add comprehensive logging

### Alternative: Use Production System

Instead of extending the dev server, consider:
- Dev server generates queue2 items as drafts
- Export to production `experiment_messages` table
- Use existing production sender (`api/_messages.js`)
- All safety gates already present

This avoids duplicating the transparency enforcement stack.

---

## Summary

**Can queue2 items be sent to Engain?**

### Thread Comments
- **Technical capability:** ✅ YES (URL format compatible)
- **Production ready:** ❌ NO (missing account, disclosure, safety gates)
- **Status:** **PARTIALLY SUPPORTED**

### Replies to Comments  
- **Technical capability:** ✅ YES (URL format compatible)
- **Production ready:** ❌ NO (missing account, disclosure, safety gates)
- **Status:** **PARTIALLY SUPPORTED**

### Critical Gaps
1. No `userAccountId` (cannot choose posting account)
2. No placeholder detection (would send "Placeholder message:" to Reddit)
3. No disclosure enforcement (transparency violation risk)
4. No status tracking (duplicate send risk)
5. No rate limiting (could trigger Reddit/Engain limits)
6. No safety gates (transparency, rules, duplicate checks)

### Recommended Next Step
Build minimal proof-of-concept sender with placeholder rejection and disclosure check. Add status tracking. Do NOT auto-send anything until all safety gates are ported from production.

**Estimated work:** 12-16 hours for production-ready queue2 sender with full safety.
