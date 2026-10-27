/* tests/transparency.test.cjs — Transparency enforcement tests
 * Tests for GeoNode's strict transparency requirements:
 * 1. Disclosure validation
 * 2. No staged conversations
 * 3. Rate limiting
 * 4. Subreddit filtering
 * 5. Duplicate detection
 */

const test = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');

async function setup() {
  const db = new PGlite();
  
  // Create minimal schema for transparency tests
  await db.exec(`
    CREATE TABLE accounts (
      id text PRIMARY KEY,
      label text,
      active boolean DEFAULT true,
      approved boolean DEFAULT true,
      disclosure_line text,
      reddit_username text
    );
    
    CREATE TABLE message_publications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      message_id uuid,
      account_id text,
      subreddit text,
      thread_id text,
      body text,
      created_at timestamptz DEFAULT now(),
      state text DEFAULT 'submitted',
      transport jsonb
    );
    
    CREATE TABLE subreddit_filters (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      subreddit text UNIQUE,
      status text CHECK (status IN ('allowed', 'denied', 'review')),
      reason text,
      added_at timestamptz DEFAULT now()
    );
    
    CREATE TABLE workflow_state (
      key text PRIMARY KEY,
      value jsonb,
      updated_at timestamptz DEFAULT now()
    );
    
    CREATE TABLE engain_tasks (
      id text PRIMARY KEY,
      user_account_id text,
      reddit_url text,
      status text,
      thread_id text,
      cancel_requested_at timestamptz
    );
    
    CREATE OR REPLACE FUNCTION is_our_url(p_url text) RETURNS boolean AS $$
    BEGIN
      RETURN EXISTS(SELECT 1 FROM engain_tasks WHERE reddit_url = p_url);
    END;
    $$ LANGUAGE plpgsql;
  `);
  
  // Insert test accounts
  await db.exec(`
    INSERT INTO accounts (id, label, active, approved, disclosure_line, reddit_username)
    VALUES
      ('acct_disclosed', 'GeoNode Official', true, true, 'GeoNode team member here', 'u/geonode_official'),
      ('acct_no_disclosure', 'Bad Account', true, true, NULL, 'u/no_disclosure'),
      ('acct_invalid_disclosure', 'Invalid', true, true, 'Just a regular user', 'u/invalid'),
      ('acct_inactive', 'Inactive', false, true, 'GeoNode team here', 'u/inactive')
  `);
  
  // Insert some subreddit filters
  await db.exec(`
    INSERT INTO subreddit_filters (subreddit, status, reason)
    VALUES
      ('banned', 'denied', 'Bans all self-promotion'),
      ('webscraping', 'allowed', 'Allows tool discussions'),
      ('review_sub', 'review', 'Requires manual review')
  `);
  
  // Insert workflow config
  await db.exec(`
    INSERT INTO workflow_state (key, value)
    VALUES ('subreddit_policy', '{"mode": "default"}'::jsonb)
  `);
  
  return { db };
}

test('disclosure validation: valid disclosure passes', async () => {
  const transparency = require('../api/_transparency.js');
  
  const body = 'This is a helpful comment. GeoNode team member here. We offer residential proxies.';
  const result = transparency.validateDisclosure(body, 'GeoNode team member here');
  
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.failures.length, 0);
});

test('disclosure validation: missing disclosure fails', async () => {
  const transparency = require('../api/_transparency.js');
  
  const body = 'This is a comment without disclosure about proxies.';
  const result = transparency.validateDisclosure(body, '');
  
  assert.strictEqual(result.ok, false);
  assert.ok(result.failures.some(f => f.includes('disclosure')));
});

test('disclosure validation: wrong disclosure line fails', async () => {
  const transparency = require('../api/_transparency.js');
  
  const body = 'GeoNode team member here. This has generic disclosure.';
  const accountLine = 'Disclosure: I work at GeoNode';
  const result = transparency.validateDisclosure(body, accountLine);
  
  assert.strictEqual(result.ok, false);
  assert.ok(result.failures.some(f => f.includes('exact disclosure line')));
});

test('disclosure validation: accepts various valid disclosure formats', async () => {
  const transparency = require('../api/_transparency.js');
  
  const validBodies = [
    'GeoNode team member here. Check out our docs.',
    'Disclosure: I work at GeoNode and can help with this.',
    'Posted by GeoNode - here\'s what we recommend.',
    'I work with GeoNode and have experience with this.',
    'Run by Geonode team, happy to explain.'
  ];
  
  for (const body of validBodies) {
    const result = transparency.validateDisclosure(body, '');
    assert.strictEqual(result.ok, true, `Should pass for: ${body}`);
  }
});

test('staged conversation detection: blocks GeoNode replying to GeoNode', async (t) => {
  const { db } = await setup();
  const transparency = require('../api/_transparency.js');
  
  // Mock sb to use our test database
  const originalSb = require('../api/_db.js').sb;
  require('../api/_db.js').sb = async (method, path, body) => {
    if (method === 'POST' && path.includes('is_our_url')) {
      // Simulate that the parent URL is ours
      return true;
    }
    if (method === 'GET' && path.includes('engain_tasks')) {
      return [{
        id: 'task_123',
        user_account_id: 'acct_other',
        reddit_url: 'https://reddit.com/r/test/comments/abc/test/def'
      }];
    }
    return [];
  };
  
  try {
    const result = await transparency.checkForStagedConversation(
      'https://reddit.com/r/test/comments/abc/test/def',
      'acct_disclosed',
      'abc'
    );
    
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes('staged conversation'));
  } finally {
    require('../api/_db.js').sb = originalSb;
  }
});

test('staged conversation detection: allows replying to non-GeoNode comments', async (t) => {
  const { db } = await setup();
  const transparency = require('../api/_transparency.js');
  
  const originalSb = require('../api/_db.js').sb;
  require('../api/_db.js').sb = async (method, path) => {
    if (method === 'POST' && path.includes('is_our_url')) {
      return false; // Not our comment
    }
    return [];
  };
  
  try {
    const result = await transparency.checkForStagedConversation(
      'https://reddit.com/r/test/comments/abc/test/def',
      'acct_disclosed',
      'abc'
    );
    
    assert.strictEqual(result.ok, true);
  } finally {
    require('../api/_db.js').sb = originalSb;
  }
});

test('rate limits: enforces per-account daily limit', async (t) => {
  const { db } = await setup();
  const transparency = require('../api/_transparency.js');
  
  // Create 5 messages in last 24h from same account
  const yesterday = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  for (let i = 0; i < 5; i++) {
    await db.exec(`
      INSERT INTO message_publications (account_id, subreddit, created_at, transport)
      VALUES ('acct_disclosed', 'test', '${yesterday}', '{"account_id": "acct_disclosed"}'::jsonb)
    `);
  }
  
  const originalSb = require('../api/_db.js').sb;
  require('../api/_db.js').sb = async (method, path) => {
    const result = await db.query(
      `SELECT id FROM message_publications 
       WHERE transport->>'account_id' = $1 
       AND created_at >= NOW() - INTERVAL '24 hours'`,
      ['acct_disclosed']
    );
    return result.rows;
  };
  
  try {
    const result = await transparency.checkRateLimits('acct_disclosed', 'test');
    assert.strictEqual(result.ok, false);
    assert.ok(result.failures.some(f => f.includes('Account rate limit')));
  } finally {
    require('../api/_db.js').sb = originalSb;
  }
});

test('subreddit filtering: blocks denied subreddits', async (t) => {
  const { db } = await setup();
  const transparency = require('../api/_transparency.js');
  
  const originalSb = require('../api/_db.js').sb;
  require('../api/_db.js').sb = async (method, path) => {
    if (path.includes('subreddit_filters')) {
      const result = await db.query(
        'SELECT * FROM subreddit_filters WHERE subreddit = $1',
        ['banned']
      );
      return result.rows;
    }
    return [];
  };
  
  try {
    const result = await transparency.checkSubredditAllowed('banned');
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('deny list'));
  } finally {
    require('../api/_db.js').sb = originalSb;
  }
});

test('subreddit filtering: allows approved subreddits', async (t) => {
  const { db } = await setup();
  const transparency = require('../api/_transparency.js');
  
  const originalSb = require('../api/_db.js').sb;
  require('../api/_db.js').sb = async (method, path) => {
    if (path.includes('subreddit_filters')) {
      const result = await db.query(
        'SELECT * FROM subreddit_filters WHERE subreddit = $1',
        ['webscraping']
      );
      return result.rows;
    }
    return [];
  };
  
  try {
    const result = await transparency.checkSubredditAllowed('webscraping');
    assert.strictEqual(result.allowed, true);
  } finally {
    require('../api/_db.js').sb = originalSb;
  }
});

test('duplicate detection: blocks identical content in same thread', async (t) => {
  const { db } = await setup();
  const transparency = require('../api/_transparency.js');
  
  const body = 'This is a test comment with disclosure.';
  await db.exec(`
    INSERT INTO message_publications (thread_id, body, account_id, state)
    VALUES ('thread_123', '${body}', 'acct_disclosed', 'submitted')
  `);
  
  const originalSb = require('../api/_db.js').sb;
  require('../api/_db.js').sb = async (method, path) => {
    if (path.includes('message_publications')) {
      const result = await db.query(
        `SELECT id, account_id FROM message_publications 
         WHERE thread_id = $1 AND body = $2 AND state != 'failed'`,
        ['thread_123', body]
      );
      return result.rows;
    }
    return [];
  };
  
  try {
    const result = await transparency.checkDuplicateContent(body, 'thread_123', 'acct_disclosed');
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes('Duplicate'));
  } finally {
    require('../api/_db.js').sb = originalSb;
  }
});

test('owned account verification: requires valid account', async (t) => {
  const { db } = await setup();
  const transparency = require('../api/_transparency.js');
  
  const originalSb = require('../api/_db.js').sb;
  require('../api/_db.js').sb = async (method, path) => {
    if (path.includes('accounts')) {
      const result = await db.query('SELECT * FROM accounts WHERE id = $1', ['acct_disclosed']);
      return result.rows;
    }
    return [];
  };
  
  try {
    const result = await transparency.verifyOwnedAccount('acct_disclosed');
    assert.strictEqual(result.ok, true);
    assert.ok(result.account);
    assert.strictEqual(result.account.id, 'acct_disclosed');
  } finally {
    require('../api/_db.js').sb = originalSb;
  }
});

test('owned account verification: rejects account without disclosure', async (t) => {
  const { db } = await setup();
  const transparency = require('../api/_transparency.js');
  
  const originalSb = require('../api/_db.js').sb;
  require('../api/_db.js').sb = async (method, path) => {
    if (path.includes('accounts')) {
      const result = await db.query('SELECT * FROM accounts WHERE id = $1', ['acct_no_disclosure']);
      return result.rows;
    }
    return [];
  };
  
  try {
    const result = await transparency.verifyOwnedAccount('acct_no_disclosure');
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes('disclosure_line'));
  } finally {
    require('../api/_db.js').sb = originalSb;
  }
});

test('owned account verification: rejects inactive account', async (t) => {
  const { db } = await setup();
  const transparency = require('../api/_transparency.js');
  
  const originalSb = require('../api/_db.js').sb;
  require('../api/_db.js').sb = async (method, path) => {
    if (path.includes('accounts')) {
      const result = await db.query('SELECT * FROM accounts WHERE id = $1', ['acct_inactive']);
      return result.rows;
    }
    return [];
  };
  
  try {
    const result = await transparency.verifyOwnedAccount('acct_inactive');
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes('inactive'));
  } finally {
    require('../api/_db.js').sb = originalSb;
  }
});

test('comprehensive validation: passes when all checks pass', async (t) => {
  const { db } = await setup();
  const transparency = require('../api/_transparency.js');
  
  const originalSb = require('../api/_db.js').sb;
  require('../api/_db.js').sb = async (method, path) => {
    if (path.includes('is_our_url')) return false;
    if (path.includes('message_publications') && method === 'GET') return [];
    if (path.includes('subreddit_filters')) {
      const result = await db.query('SELECT * FROM subreddit_filters WHERE subreddit = $1', ['webscraping']);
      return result.rows;
    }
    if (path.includes('workflow_state')) {
      return [{ value: { mode: 'default' } }];
    }
    return [];
  };
  
  try {
    const result = await transparency.validateTransparency({
      body: 'Helpful comment here. GeoNode team member here. We recommend...',
      accountId: 'acct_disclosed',
      accountDisclosureLine: 'GeoNode team member here',
      subreddit: 'webscraping',
      threadId: 'new_thread',
      parentUrl: null,
      kind: 'comment'
    });
    
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.failures.length, 0);
  } finally {
    require('../api/_db.js').sb = originalSb;
  }
});

console.log('Transparency enforcement tests completed.');
