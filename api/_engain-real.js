/* _engain-real.js — Real Engain API client (NO MOCKS)
 *
 * All calls go to actual Engain accounts-beta endpoints.
 * Response parsing based on actual API behavior (beta API not fully documented).
 * 
 * Supported endpoints:
 * - GET /api/v1/me
 * - GET /api/v1/accounts-beta/accounts
 * - POST /api/v1/accounts-beta/comments
 * - GET /api/v1/accounts-beta/comments
 * - POST /api/v1/accounts-beta/comments/{id}/cancel
 * - POST /api/v1/rule-check
 */

const ENGAIN_API_KEY = process.env.ENGAIN_API_KEY || '';
const ENGAIN_BASE_URL = 'https://api.engain.io';

if (!ENGAIN_API_KEY) {
  console.warn('WARNING: ENGAIN_API_KEY not set. Engain API calls will fail.');
}

/**
 * Make authenticated request to Engain API
 */
async function request(method, path, body = null, queryParams = {}) {
  if (!ENGAIN_API_KEY) {
    throw new Error('ENGAIN_API_KEY is not configured');
  }
  
  const url = new URL(path, ENGAIN_BASE_URL);
  Object.entries(queryParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, String(value));
    }
  });
  
  const options = {
    method,
    headers: {
      'X-API-Key': ENGAIN_API_KEY,
      'Content-Type': 'application/json',
      'User-Agent': 'GeoNode-Transparency-Bot/1.0'
    }
  };
  
  if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(url.toString(), options);
  const text = await response.text();
  
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (e) {
    json = { error: 'Invalid JSON response', raw: text };
  }
  
  return {
    status: response.status,
    ok: response.ok,
    json,
    headers: Object.fromEntries(response.headers.entries())
  };
}

/**
 * GET /api/v1/me - Get current user and accessible projects
 */
async function getMe() {
  return request('GET', '/api/v1/me');
}

/**
 * GET /api/v1/accounts-beta/accounts - List owned accounts
 * 
 * Response format (observed):
 * {
 *   accounts: [
 *     {
 *       userAccountId: "acct_...",
 *       profileUsername: "u/username",
 *       usable: true
 *     }
 *   ]
 * }
 */
async function getAccounts() {
  return request('GET', '/api/v1/accounts-beta/accounts');
}

/**
 * POST /api/v1/accounts-beta/comments - Create comment/reply
 * 
 * Request:
 * {
 *   userAccountId: "acct_...",
 *   targetUrl: "https://reddit.com/r/subreddit/comments/...",
 *   body: "Comment text with disclosure"
 * }
 * 
 * Response format (observed):
 * {
 *   id: "cmt_..." or "_id": "...",
 *   status: "in_queue" | "in_review" | "published" | etc,
 *   redditUrl: "https://reddit.com/..." (when published),
 *   content: "comment body",
 *   threadUrl: "target url",
 *   userAccountId: "acct_...",
 *   createdAt: "ISO timestamp",
 *   _creationTime: timestamp (alternative field)
 * }
 */
async function createComment(userAccountId, targetUrl, body) {
  return request('POST', '/api/v1/accounts-beta/comments', {
    userAccountId,
    targetUrl,
    body
  });
}

/**
 * GET /api/v1/accounts-beta/comments - List comments with pagination
 * 
 * Query params:
 * - cursor: continuation token for pagination
 * - limit: max items (optional)
 * 
 * Response format (observed):
 * {
 *   page: [ array of comment objects ],
 *   isDone: boolean,
 *   continueCursor: "cursor_token" | null
 * }
 */
async function getComments(cursor = null, limit = 50) {
  const params = { limit };
  if (cursor) params.cursor = cursor;
  return request('GET', '/api/v1/accounts-beta/comments', null, params);
}

/**
 * GET comment by ID - Fetch single comment details
 * 
 * Note: Engain accounts-beta doesn't have a direct GET /comments/{id} endpoint
 * We need to list and filter, or use the task feed
 */
async function getCommentById(commentId) {
  // Get recent comments and find the one we want
  const result = await getComments(null, 100);
  if (!result.ok) return result;
  
  const comment = result.json.page?.find(c => 
    (c.id === commentId || c._id === commentId)
  );
  
  if (!comment) {
    return {
      status: 404,
      ok: false,
      json: { error: 'Comment not found', commentId }
    };
  }
  
  return {
    status: 200,
    ok: true,
    json: comment
  };
}

/**
 * POST /api/v1/accounts-beta/comments/{id}/cancel - Cancel comment
 */
async function cancelComment(commentId) {
  return request('POST', `/api/v1/accounts-beta/comments/${commentId}/cancel`);
}

/**
 * POST /api/v1/rule-check - Check comment against subreddit rules
 * 
 * Request:
 * {
 *   projectId: "proj_...",
 *   subreddit: "webscraping",
 *   taskType: "comment" | "reply",
 *   content: "comment body",
 *   mediaKind: "text",
 *   context: { postUrl, postTitle, parentCommentUrl?, parentComment? }
 * }
 * 
 * Response:
 * {
 *   verdict: "pass" | "warn" | "fail" | "unavailable" | "skipped",
 *   removalRisk: 0-100,
 *   authenticityRisk: 0-100,
 *   marketingIntentRisk: 0-100,
 *   violatedRules: [],
 *   summary: "explanation",
 *   contextWarnings: []
 * }
 */
async function ruleCheck(projectId, subreddit, taskType, content, context = {}) {
  return request('POST', '/api/v1/rule-check', {
    projectId,
    subreddit,
    taskType,
    content,
    mediaKind: 'text',
    context
  });
}

/**
 * Parse Engain status into our job status
 * 
 * Engain statuses observed:
 * - in_queue, in_review: pending
 * - published: published
 * - automod_removed, mod_removed, user_deleted: failed
 * - post_url_broken, thread_archived_locked, error: failed
 */
function parseEngainStatus(engainStatus) {
  const status = String(engainStatus || '').toLowerCase();
  
  // Published
  if (status === 'published') {
    return { jobStatus: 'published', isFinal: false };
  }
  
  // Failed/removed
  if (['automod_removed', 'mod_removed', 'user_deleted', 'main_comment_removed_deleted'].includes(status)) {
    return { jobStatus: 'failed', isFinal: true, reason: `Removed: ${status}` };
  }
  
  // Error states
  if (['error', 'failed', 'cancelled', 'canceled', 'rejected'].includes(status)) {
    return { jobStatus: 'failed', isFinal: true, reason: status };
  }
  
  // Technical failures
  if (['post_url_broken', 'thread_archived_locked', 'subreddit_private_banned'].includes(status)) {
    return { jobStatus: 'failed', isFinal: true, reason: status };
  }
  
  // Still pending
  if (['in_queue', 'in_review', 'waiting_for_mod_approval', 'waiting_for_parent_comment'].includes(status)) {
    return { jobStatus: 'pending', isFinal: false };
  }
  
  // Unknown status - treat as pending for now
  return { jobStatus: 'pending', isFinal: false, reason: `Unknown status: ${status}` };
}

/**
 * Extract comment ID from Engain response
 * Handles both 'id' and '_id' fields
 */
function extractCommentId(engainResponse) {
  return engainResponse.id || engainResponse._id || null;
}

/**
 * Extract Reddit URL from Engain response
 */
function extractRedditUrl(engainResponse) {
  return engainResponse.redditUrl || engainResponse.resultUrl || null;
}

/**
 * Check if Engain response indicates success
 */
function isEngainSuccess(response) {
  return response.ok && response.status < 300;
}

/**
 * Retry logic with exponential backoff
 */
async function withRetry(fn, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      
      // If rate limited (429), wait and retry
      if (result.status === 429) {
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
      
      return result;
    } catch (error) {
      lastError = error;
      
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError || new Error('Max retries exceeded');
}

module.exports = {
  // API methods
  getMe,
  getAccounts,
  createComment,
  getComments,
  getCommentById,
  cancelComment,
  ruleCheck,
  
  // Utilities
  parseEngainStatus,
  extractCommentId,
  extractRedditUrl,
  isEngainSuccess,
  withRetry,
  
  // For testing
  request
};
