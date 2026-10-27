/* tests/staged-conversation.test.cjs — Tests for no-staged-conversation enforcement
 * 
 * Verifies that GeoNode accounts cannot reply to other GeoNode accounts,
 * but can reply to non-GeoNode users.
 */

const test = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');

async function setup() {
  const db = new PGlite();
  
  await db.exec(`
    CREATE TABLE engain_tasks (
      id text PRIMARY KEY,
      user_account_id text,
      reddit_url text,
      status text,
      thread_id text,
      visibility text,
      cancel_requested_at timestamptz
    );
    
    CREATE TABLE accounts (
      id text PRIMARY KEY,
      reddit_username text
    );
    
    CREATE OR REPLACE FUNCTION is_our_url(p_url text) RETURNS boolean AS $$
    BEGIN
      RETURN EXISTS(SELECT 1 FROM engain_tasks WHERE reddit_url = p_url);
    END;
    $$ LANGUAGE plpgsql;
  `);
  
  // Insert GeoNode accounts
  await db.exec(`
    INSERT INTO accounts (id, reddit_username)
    VALUES 
      ('acct_geonode_1', 'u/geonode_official'),
      ('acct_geonode_2', 'u/geonode_team');
  `);
  
  return { db };
}

test('staged conversation: blocks GeoNode account replying to GeoNode comment', async (t) => {
  const { db } = await setup();
  
  // Insert a GeoNode comment in engain_tasks
  await db.exec(`
    INSERT INTO engain_tasks (id, user_account_id, reddit_url, status, thread_id, visibility)
    VALUES ('task_001', 'acct_geonode_1', 'https://reddit.com/r/test/comments/abc/test/ghi', 'published', 'abc', 'visible')
  `);
  
  const transparency = require('../api/_transparency.js');
  
  // Mock sb to use our test database
  const originalSb = require('../api/_db.js').sb;
  require('../api/_db.js').sb = async (method, path, body) => {
    if (method === 'POST' && path.includes('is_our_url')) {
      const result = await db.query('SELECT is_our_url($1) as result', [body.p_url]);
      return result.rows[0].result;
    }
    if (method === 'GET' && path.includes('engain_tasks')) {
      const result = await db.query(
        'SELECT * FROM engain_tasks WHERE reddit_url = $1 LIMIT 1',
        ['https://reddit.com/r/test/comments/abc/test/ghi']
      );
      return result.rows;
    }
    return [];
  };
  
  try {
    const result = await transparency.checkForStagedConversation(
      'https://reddit.com/r/test/comments/abc/test/ghi',
      'acct_geonode_2',  // Different GeoNode account trying to reply
      'abc'
    );
    
    assert.strictEqual(result.ok, false, 'Should block staged conversation');
    assert.ok(result.reason, 'Should provide reason');
    assert.ok(result.reason.includes('staged conversation'), 'Reason should mention staged conversation');
    assert.ok(result.reason.includes('acct_geonode_1'), 'Reason should identify parent account');
  } finally {
    require('../api/_db.js').sb = originalSb;
  }
});

test('staged conversation: allows replying to non-GeoNode user', async (t) => {
  const { db } = await setup();
  
  // No GeoNode comments in engain_tasks (simulating reply to external user)
  
  const transparency = require('../api/_transparency.js');
  
  const originalSb = require('../api/_db.js').sb;
  require('../api/_db.js').sb = async (method, path, body) => {
    if (method === 'POST' && path.includes('is_our_url')) {
      const result = await db.query('SELECT is_our_url($1) as result', [body.p_url]);
      return result.rows[0].result;
    }
    if (method === 'GET' && path.includes('engain_tasks')) {
      return []; // No matching tasks = not our comment
    }
    return [];
  };
  
  try {
    const result = await transparency.checkForStagedConversation(
      'https://reddit.com/r/test/comments/abc/test/xyz',  // External user's comment
      'acct_geonode_1',
      'abc'
    );
    
    assert.strictEqual(result.ok, true, 'Should allow reply to non-GeoNode user');
    assert.strictEqual(result.reason, undefined, 'Should not have reason when allowed');
  } finally {
    require('../api/_db.js').sb = originalSb;
  }
});

test('staged conversation: allows top-level comment (no parent)', async (t) => {
  const { db } = await setup();
  const transparency = require('../api/_transparency.js');
  
  const result = await transparency.checkForStagedConversation(
    null,  // No parent URL = top-level comment
    'acct_geonode_1',
    'abc'
  );
  
  assert.strictEqual(result.ok, true, 'Should allow top-level comment');
});

test('staged conversation: same account can reply to itself with playbook', async (t) => {
  const { db } = await setup();
  
  // This tests that the check happens - playbook exception is handled at a higher level
  await db.exec(`
    INSERT INTO engain_tasks (id, user_account_id, reddit_url, status, thread_id, visibility)
    VALUES ('task_002', 'acct_geonode_1', 'https://reddit.com/r/test/comments/def/test/jkl', 'published', 'def', 'visible')
  `);
  
  const transparency = require('../api/_transparency.js');
  
  const originalSb = require('../api/_db.js').sb;
  require('../api/_db.js').sb = async (method, path, body) => {
    if (method === 'POST' && path.includes('is_our_url')) {
      const result = await db.query('SELECT is_our_url($1) as result', [body.p_url]);
      return result.rows[0].result;
    }
    if (method === 'GET' && path.includes('engain_tasks')) {
      const result = await db.query(
        'SELECT * FROM engain_tasks WHERE reddit_url = $1',
        ['https://reddit.com/r/test/comments/def/test/jkl']
      );
      return result.rows;
    }
    return [];
  };
  
  try {
    const result = await transparency.checkForStagedConversation(
      'https://reddit.com/r/test/comments/def/test/jkl',
      'acct_geonode_1',  // Same account
      'def'
    );
    
    // Even same account gets blocked by transparency check
    // Playbook exceptions are handled at workflow level, not here
    assert.strictEqual(result.ok, false, 'Transparency check should flag it');
    assert.ok(result.reason.includes('staged conversation'));
  } finally {
    require('../api/_db.js').sb = originalSb;
  }
});

console.log('✓ Staged conversation tests completed');
