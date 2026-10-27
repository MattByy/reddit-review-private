/* _transparency.js — Transparency enforcement for GeoNode Reddit engagement.
 *
 * Non-negotiable constraints (enforced in code, not just documentation):
 * 1. Own accounts only: Only GeoNode's owned/beta accounts may post
 * 2. Mandatory disclosure: Every comment must include clear affiliation disclosure
 * 3. No staged conversations: Block one GeoNode account answering another
 * 4. Rate limits: Per-account and per-subreddit limits
 * 5. Subreddit filtering: Skip subreddits that ban self-promotion
 */

const { sb } = require('./_db.js');
const { DISCLOSURE } = require('./_rules.js');

const enc = encodeURIComponent;
const now = () => new Date().toISOString();

// Rate limit configuration (configurable via env vars with sensible defaults)
const RATE_LIMITS = {
  // Maximum comments per account per day
  MAX_PER_ACCOUNT_PER_DAY: parseInt(process.env.MAX_COMMENTS_PER_ACCOUNT_PER_DAY) || 5,
  // Maximum comments per subreddit per day
  MAX_PER_SUBREDDIT_PER_DAY: parseInt(process.env.MAX_COMMENTS_PER_SUBREDDIT_PER_DAY) || 3,
  // Minimum hours between comments in same subreddit
  MIN_HOURS_BETWEEN_SUBREDDIT_COMMENTS: parseInt(process.env.MIN_HOURS_BETWEEN_SUBREDDIT) || 24,
};

/**
 * Validate that disclosure is present in the comment body.
 * This is a hard requirement that cannot be bypassed.
 */
function validateDisclosure(body, accountDisclosureLine) {
  const failures = [];
  
  // Check for general disclosure pattern
  if (!DISCLOSURE.test(body)) {
    failures.push('Missing mandatory disclosure. Every comment must clearly identify GeoNode affiliation (e.g., "GeoNode team member here" or "Disclosure: I work at GeoNode")');
  }
  
  // If account has a specific disclosure line, it must appear verbatim
  if (accountDisclosureLine) {
    const line = String(accountDisclosureLine).trim();
    if (!line || !DISCLOSURE.test(line)) {
      failures.push(`Account's disclosure_line does not meet requirements: "${line}". Fix the account configuration.`);
    } else if (!body.includes(line)) {
      failures.push(`Must include the account's exact disclosure line: "${line}"`);
    }
  }
  
  return {
    ok: failures.length === 0,
    failures
  };
}

/**
 * Check if this would create a staged conversation (GeoNode account replying to another GeoNode account).
 * This is blocked to maintain transparency - we don't create fake conversations.
 */
async function checkForStagedConversation(parentUrl, proposedAccountId, threadId) {
  if (!parentUrl) {
    // Top-level comment, no staged conversation risk
    return { ok: true };
  }
  
  // Check if the parent comment was made by one of our accounts
  const isOurComment = await sb('POST', 'rpc/is_our_url', { p_url: parentUrl });
  
  if (isOurComment) {
    // Get the parent account to provide helpful error message
    const parentTasks = await sb('GET', 
      `engain_tasks?select=user_account_id,id&reddit_url=eq.${enc(parentUrl)}&limit=1`);
    
    if (parentTasks.length > 0) {
      const parentAccountId = parentTasks[0].user_account_id;
      
      // Even different accounts cannot reply to each other without explicit playbook
      return {
        ok: false,
        reason: `Blocked: This would create a staged conversation. The parent comment at ${parentUrl} was posted by GeoNode account ${parentAccountId}. GeoNode accounts cannot reply to each other as if they were independent users. This violates transparency requirements.`
      };
    }
  }
  
  return { ok: true };
}

/**
 * Check rate limits for an account and subreddit combination.
 */
async function checkRateLimits(accountId, subreddit) {
  const failures = [];
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  
  // Check per-account daily limit
  const accountMessages = await sb('GET',
    `message_publications?select=id&transport->>account_id=eq.${enc(accountId)}&created_at=gte.${enc(yesterday)}`);
  
  if (accountMessages.length >= RATE_LIMITS.MAX_PER_ACCOUNT_PER_DAY) {
    failures.push(`Account rate limit: ${accountMessages.length}/${RATE_LIMITS.MAX_PER_ACCOUNT_PER_DAY} comments in last 24h`);
  }
  
  // Check per-subreddit daily limit
  const subredditMessages = await sb('GET',
    `message_publications?select=id,created_at&subreddit=eq.${enc(subreddit)}&created_at=gte.${enc(yesterday)}&order=created_at.desc`);
  
  if (subredditMessages.length >= RATE_LIMITS.MAX_PER_SUBREDDIT_PER_DAY) {
    failures.push(`Subreddit rate limit: ${subredditMessages.length}/${RATE_LIMITS.MAX_PER_SUBREDDIT_PER_DAY} comments in r/${subreddit} in last 24h`);
  }
  
  // Check minimum time between comments in same subreddit
  if (subredditMessages.length > 0) {
    const lastComment = subredditMessages[0];
    const hoursSince = (Date.now() - Date.parse(lastComment.created_at)) / (3600 * 1000);
    
    if (hoursSince < RATE_LIMITS.MIN_HOURS_BETWEEN_SUBREDDIT_COMMENTS) {
      failures.push(`Too soon: last comment in r/${subreddit} was ${hoursSince.toFixed(1)}h ago, minimum is ${RATE_LIMITS.MIN_HOURS_BETWEEN_SUBREDDIT_COMMENTS}h`);
    }
  }
  
  return {
    ok: failures.length === 0,
    failures
  };
}

/**
 * Check if a subreddit is in the deny list or missing from allow list.
 * Returns { allowed: boolean, reason?: string }
 */
async function checkSubredditAllowed(subreddit) {
  // Check for subreddit filters in database
  const filters = await sb('GET', `subreddit_filters?select=*&subreddit=eq.${enc(subreddit)}&limit=1`);
  
  if (filters.length > 0) {
    const filter = filters[0];
    if (filter.status === 'denied') {
      return {
        allowed: false,
        reason: filter.reason || 'Subreddit is in deny list (likely bans self-promotion)'
      };
    }
    if (filter.status === 'allowed') {
      return { allowed: true };
    }
  }
  
  // Check if there's an allow-list-only mode
  const config = await sb('GET', 'workflow_state?select=value&key=eq.subreddit_policy&limit=1');
  if (config.length > 0 && config[0].value?.mode === 'allowlist_only') {
    return {
      allowed: false,
      reason: 'Subreddit not in allow list (allowlist-only mode is active)'
    };
  }
  
  // Default: allowed (can post to new subreddits)
  return { allowed: true };
}

/**
 * Check for duplicate content in the same thread.
 * Prevents posting the exact same comment multiple times.
 */
async function checkDuplicateContent(body, threadId, accountId) {
  if (!threadId) {
    return { ok: true };
  }
  
  // Check for identical body in this thread
  const existing = await sb('GET',
    `message_publications?select=id,account_id&thread_id=eq.${enc(threadId)}&body=eq.${enc(body)}&state=neq.failed&limit=1`);
  
  if (existing.length > 0) {
    return {
      ok: false,
      reason: `Duplicate: identical content already posted in this thread by account ${existing[0].account_id}`
    };
  }
  
  return { ok: true };
}

/**
 * Comprehensive transparency check that enforces all constraints.
 * This is the main entry point called before queueing any message.
 */
async function validateTransparency(opts) {
  const {
    body,
    accountId,
    accountDisclosureLine,
    subreddit,
    threadId,
    parentUrl,
    kind
  } = opts;
  
  const failures = [];
  
  // 1. Validate disclosure (mandatory, cannot be bypassed)
  const disclosureCheck = validateDisclosure(body, accountDisclosureLine);
  if (!disclosureCheck.ok) {
    failures.push(...disclosureCheck.failures);
  }
  
  // 2. Check for staged conversations (no GeoNode replying to GeoNode)
  if (kind === 'reply' && parentUrl) {
    const stagedCheck = await checkForStagedConversation(parentUrl, accountId, threadId);
    if (!stagedCheck.ok) {
      failures.push(stagedCheck.reason);
    }
  }
  
  // 3. Check rate limits
  const rateLimitCheck = await checkRateLimits(accountId, subreddit);
  if (!rateLimitCheck.ok) {
    failures.push(...rateLimitCheck.failures);
  }
  
  // 4. Check subreddit allowed
  const subredditCheck = await checkSubredditAllowed(subreddit);
  if (!subredditCheck.allowed) {
    failures.push(`Subreddit r/${subreddit}: ${subredditCheck.reason}`);
  }
  
  // 5. Check for duplicate content
  const dupeCheck = await checkDuplicateContent(body, threadId, accountId);
  if (!dupeCheck.ok) {
    failures.push(dupeCheck.reason);
  }
  
  return {
    ok: failures.length === 0,
    failures,
    checks_performed: {
      disclosure: disclosureCheck.ok,
      no_staged_conversation: kind !== 'reply' || !parentUrl || (await checkForStagedConversation(parentUrl, accountId, threadId)).ok,
      rate_limits: rateLimitCheck.ok,
      subreddit_allowed: subredditCheck.allowed,
      no_duplicate: dupeCheck.ok
    }
  };
}

/**
 * Verify that an account is owned/beta account (not pooled).
 * This enforces the "own accounts only" constraint.
 */
async function verifyOwnedAccount(accountId) {
  if (!accountId) {
    return {
      ok: false,
      reason: 'No account specified. Only owned GeoNode accounts may post.'
    };
  }
  
  const accounts = await sb('GET', `accounts?select=*&id=eq.${enc(accountId)}&limit=1`);
  
  if (accounts.length === 0) {
    return {
      ok: false,
      reason: `Account ${accountId} not found in accounts table`
    };
  }
  
  const account = accounts[0];
  
  if (!account.active) {
    return {
      ok: false,
      reason: `Account ${account.label || accountId} is inactive`
    };
  }
  
  if (!account.approved) {
    return {
      ok: false,
      reason: `Account ${account.label || accountId} is not approved for posting`
    };
  }
  
  // Check that disclosure line is configured
  if (!account.disclosure_line || !DISCLOSURE.test(account.disclosure_line)) {
    return {
      ok: false,
      reason: `Account ${account.label || accountId} does not have a valid disclosure_line configured. Every account must have disclosure.`
    };
  }
  
  return {
    ok: true,
    account
  };
}

module.exports = {
  validateTransparency,
  validateDisclosure,
  checkForStagedConversation,
  checkRateLimits,
  checkSubredditAllowed,
  checkDuplicateContent,
  verifyOwnedAccount,
  RATE_LIMITS
};
