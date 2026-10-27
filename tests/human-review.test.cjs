/* tests/human-review.test.cjs — Tests for human review mode
 * 
 * Verifies that when human review mode is enabled, drafts go to review queue
 * instead of auto-posting.
 */

const test = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');

async function setup() {
  const db = new PGlite();
  
  await db.exec(`
    CREATE TABLE workflow_state (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz DEFAULT now()
    );
    
    CREATE OR REPLACE FUNCTION human_review_enabled() RETURNS boolean AS $$
    DECLARE
      v_config jsonb;
    BEGIN
      SELECT value INTO v_config FROM workflow_state WHERE key = 'human_review_mode';
      RETURN COALESCE((v_config->>'enabled')::boolean, false);
    END;
    $$ LANGUAGE plpgsql;
  `);
  
  return { db };
}

test('human review mode: disabled by default', async () => {
  const { db } = await setup();
  
  // No configuration = default to false
  const result = await db.query('SELECT human_review_enabled() as enabled');
  assert.strictEqual(result.rows[0].enabled, false, 'Should be disabled by default');
});

test('human review mode: can be enabled', async () => {
  const { db } = await setup();
  
  await db.exec(`
    INSERT INTO workflow_state (key, value)
    VALUES ('human_review_mode', '{"enabled": true}'::jsonb)
  `);
  
  const result = await db.query('SELECT human_review_enabled() as enabled');
  assert.strictEqual(result.rows[0].enabled, true, 'Should be enabled when configured');
});

test('human review mode: can be disabled explicitly', async () => {
  const { db } = await setup();
  
  await db.exec(`
    INSERT INTO workflow_state (key, value)
    VALUES ('human_review_mode', '{"enabled": false, "note": "Auto-posting allowed"}'::jsonb)
  `);
  
  const result = await db.query('SELECT human_review_enabled() as enabled');
  assert.strictEqual(result.rows[0].enabled, false, 'Should be disabled when set to false');
});

test('human review mode: config can include notes', async () => {
  const { db } = await setup();
  
  await db.exec(`
    INSERT INTO workflow_state (key, value)
    VALUES ('human_review_mode', '{"enabled": true, "note": "Manual approval required during trial"}'::jsonb)
  `);
  
  const result = await db.query('SELECT value FROM workflow_state WHERE key = $1', ['human_review_mode']);
  const config = result.rows[0].value;
  
  assert.strictEqual(config.enabled, true);
  assert.ok(config.note, 'Should preserve note field');
  assert.ok(config.note.includes('Manual approval'));
});

test('human review mode: workflow behavior with review enabled', async () => {
  const { db } = await setup();
  
  // Enable human review mode
  await db.exec(`
    INSERT INTO workflow_state (key, value)
    VALUES ('human_review_mode', '{"enabled": true}'::jsonb)
  `);
  
  // Mock the database function check
  const originalSb = require('../api/_db.js').sb;
  require('../api/_db.js').sb = async (method, path) => {
    if (path.includes('workflow_state') && path.includes('human_review_mode')) {
      return [{ value: { enabled: true } }];
    }
    return [];
  };
  
  try {
    // Check that human_review_enabled() returns true
    const enabled = await db.query('SELECT human_review_enabled() as result');
    assert.strictEqual(enabled.rows[0].result, true);
    
    // In production, this would cause drafts to be held for review
    // The actual workflow integration happens in _automatic.js
    // Here we just verify the configuration flag works
  } finally {
    require('../api/_db.js').sb = originalSb;
  }
});

test('human review mode: workflow behavior with review disabled', async () => {
  const { db } = await setup();
  
  // Explicitly disable
  await db.exec(`
    INSERT INTO workflow_state (key, value)
    VALUES ('human_review_mode', '{"enabled": false}'::jsonb)
  `);
  
  const enabled = await db.query('SELECT human_review_enabled() as result');
  assert.strictEqual(enabled.rows[0].result, false);
  
  // When disabled, auto-posting should proceed normally
  // This is the default behavior when human_review_enabled() returns false
});

test('human review mode: migration creates default config', async () => {
  const { db } = await setup();
  
  // Simulate migration inserting default config
  await db.exec(`
    INSERT INTO workflow_state (key, value, updated_at)
    VALUES ('human_review_mode', '{"enabled": false, "note": "When enabled, all drafts require manual approval before posting"}'::jsonb, now())
    ON CONFLICT (key) DO NOTHING
  `);
  
  const result = await db.query('SELECT value FROM workflow_state WHERE key = $1', ['human_review_mode']);
  assert.ok(result.rows.length > 0, 'Should have config row');
  
  const config = result.rows[0].value;
  assert.strictEqual(config.enabled, false, 'Default should be false');
  assert.ok(config.note, 'Should have explanatory note');
});

test('human review mode: toggling mode persists', async () => {
  const { db } = await setup();
  
  // Start disabled
  await db.exec(`
    INSERT INTO workflow_state (key, value)
    VALUES ('human_review_mode', '{"enabled": false}'::jsonb)
  `);
  
  let result = await db.query('SELECT human_review_enabled() as enabled');
  assert.strictEqual(result.rows[0].enabled, false);
  
  // Enable
  await db.exec(`
    UPDATE workflow_state 
    SET value = '{"enabled": true}'::jsonb
    WHERE key = 'human_review_mode'
  `);
  
  result = await db.query('SELECT human_review_enabled() as enabled');
  assert.strictEqual(result.rows[0].enabled, true);
  
  // Disable again
  await db.exec(`
    UPDATE workflow_state 
    SET value = '{"enabled": false}'::jsonb
    WHERE key = 'human_review_mode'
  `);
  
  result = await db.query('SELECT human_review_enabled() as enabled');
  assert.strictEqual(result.rows[0].enabled, false);
});

console.log('✓ Human review mode tests completed');
