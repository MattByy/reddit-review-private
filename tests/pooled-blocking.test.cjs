/* tests/pooled-blocking.test.cjs — Tests proving pooled accounts are dead
 * 
 * Verifies that:
 * 1. ENGAIN_DELIVERY=pool throws errors
 * 2. No delivery function can reach /api/v1/tasks/* endpoints
 * 3. All pool mode paths are blocked
 */

const test = require('node:test');
const assert = require('node:assert');

test('pooled blocking: ENGAIN_DELIVERY=pool throws error in capabilities()', async () => {
  // Set environment to pool mode
  const originalDelivery = process.env.ENGAIN_DELIVERY;
  process.env.ENGAIN_DELIVERY = 'pool';
  
  // Clear module cache to force reload with new env
  delete require.cache[require.resolve('../api/_delivery.js')];
  delete require.cache[require.resolve('../api/_db.js')];
  
  const delivery = require('../api/_delivery.js');
  
  // Mock engain to succeed
  const originalEngain = require('../api/_db.js').engain;
  require('../api/_db.js').engain = async () => ({
    status: 200,
    json: { projects: [{ id: 'proj_test', name: 'geonode.com' }] }
  });
  
  try {
    await delivery.capabilities();
    assert.fail('Should have thrown error for pool mode');
  } catch (err) {
    assert.ok(err.message.includes('TRANSPARENCY VIOLATION'), 'Should mention transparency violation');
    assert.ok(err.message.includes('Pooled accounts are disabled'), 'Should mention pooled accounts');
    assert.ok(err.message.includes('owned'), 'Should mention owned accounts');
  } finally {
    process.env.ENGAIN_DELIVERY = originalDelivery;
    require('../api/_db.js').engain = originalEngain;
    delete require.cache[require.resolve('../api/_delivery.js')];
    delete require.cache[require.resolve('../api/_db.js')];
  }
});

test('pooled blocking: ENGAIN_DELIVERY=pooled also throws error', async () => {
  const originalDelivery = process.env.ENGAIN_DELIVERY;
  process.env.ENGAIN_DELIVERY = 'pooled';
  
  delete require.cache[require.resolve('../api/_delivery.js')];
  delete require.cache[require.resolve('../api/_db.js')];
  
  const delivery = require('../api/_delivery.js');
  
  require('../api/_db.js').engain = async () => ({
    status: 200,
    json: { projects: [{ id: 'proj_test', name: 'test' }] }
  });
  
  try {
    await delivery.capabilities();
    assert.fail('Should have thrown error for pooled mode');
  } catch (err) {
    assert.ok(err.message.includes('TRANSPARENCY VIOLATION'));
  } finally {
    process.env.ENGAIN_DELIVERY = originalDelivery;
    delete require.cache[require.resolve('../api/_delivery.js')];
    delete require.cache[require.resolve('../api/_db.js')];
  }
});

test('pooled blocking: choose() rejects pool mode', async () => {
  delete require.cache[require.resolve('../api/_delivery.js')];
  const delivery = require('../api/_delivery.js');
  
  const poolCaps = {
    mode: 'pool',
    project_id: 'proj_test',
    available: true
  };
  
  try {
    await delivery.choose(poolCaps, null);
    assert.fail('Should have thrown error for pool mode in choose()');
  } catch (err) {
    assert.ok(err.message.includes('TRANSPARENCY VIOLATION'));
    assert.ok(err.message.includes('Pool mode disabled'));
  }
});

test('pooled blocking: submit() rejects non-owned transport', async () => {
  delete require.cache[require.resolve('../api/_delivery.js')];
  const delivery = require('../api/_delivery.js');
  
  const message = {
    id: 'msg_test',
    experiment_id: 'exp_test',
    target_url: 'https://reddit.com/r/test/comments/abc',
    body: 'Test comment. GeoNode team member here.',
    kind: 'comment'
  };
  
  const poolTransport = {
    mode: 'pool',
    project_id: 'proj_test'
  };
  
  try {
    await delivery.submit(message, poolTransport);
    assert.fail('Should have thrown error for pool transport in submit()');
  } catch (err) {
    assert.ok(err.message.includes('TRANSPARENCY VIOLATION'));
    assert.ok(err.message.includes('owned accounts'));
  }
});

test('pooled blocking: owned mode is required and works', async () => {
  delete require.cache[require.resolve('../api/_delivery.js')];
  delete require.cache[require.resolve('../api/_db.js')];
  
  const delivery = require('../api/_delivery.js');
  
  // Mock engain to return owned accounts
  const mockEngain = async (method, path) => {
    if (path === '/api/v1/me') {
      return {
        status: 200,
        json: { projects: [{ id: 'proj_test', name: 'geonode.com' }] }
      };
    }
    if (path === '/api/v1/accounts-beta/accounts') {
      return {
        status: 200,
        json: {
          accounts: [
            { userAccountId: 'acct_001', profileUsername: 'u/geonode_test', usable: true }
          ]
        }
      };
    }
    return { status: 404, json: {} };
  };
  
  const originalEngain = require('../api/_db.js').engain;
  require('../api/_db.js').engain = mockEngain;
  
  try {
    const caps = await delivery.capabilities();
    assert.strictEqual(caps.mode, 'owned', 'Should use owned mode');
    assert.strictEqual(caps.requested, 'owned', 'Should request owned mode');
    assert.strictEqual(caps.available, true, 'Should be available with owned accounts');
    assert.ok(caps.accounts.length > 0, 'Should have accounts');
  } finally {
    require('../api/_db.js').engain = originalEngain;
    delete require.cache[require.resolve('../api/_delivery.js')];
    delete require.cache[require.resolve('../api/_db.js')];
  }
});

test('pooled blocking: no /api/v1/tasks/* endpoints can be reached', async () => {
  delete require.cache[require.resolve('../api/_delivery.js')];
  const delivery = require('../api/_delivery.js');
  
  const message = {
    id: 'msg_test',
    experiment_id: 'exp_test',
    target_url: 'https://reddit.com/r/test/comments/abc',
    body: 'Test. GeoNode team member here.',
    kind: 'comment',
    transport: { mode: 'owned', account_id: 'acct_001' }
  };
  
  // Track which endpoints are called
  const calledEndpoints = [];
  const originalEngain = require('../api/_db.js').engain;
  require('../api/_db.js').engain = async (method, path) => {
    calledEndpoints.push({ method, path });
    if (path === '/api/v1/accounts-beta/comments') {
      return { status: 200, json: { id: 'cmt_test', status: 'in_queue' } };
    }
    return { status: 404, json: {} };
  };
  
  try {
    const transport = { mode: 'owned', account_id: 'acct_001' };
    await delivery.submit(message, transport);
    
    // Verify no /api/v1/tasks/* endpoints were called
    const taskEndpoints = calledEndpoints.filter(e => e.path.includes('/api/v1/tasks/'));
    assert.strictEqual(taskEndpoints.length, 0, 'Should not call any /api/v1/tasks/* endpoints');
    
    // Verify accounts-beta endpoint WAS called
    const betaEndpoints = calledEndpoints.filter(e => e.path.includes('/api/v1/accounts-beta/'));
    assert.ok(betaEndpoints.length > 0, 'Should call accounts-beta endpoints');
  } finally {
    require('../api._db.js').engain = originalEngain;
    delete require.cache[require.resolve('../api/_delivery.js')];
    delete require.cache[require.resolve('../api/_db.js')];
  }
});

test('pooled blocking: task() rejects pool mode messages', async () => {
  delete require.cache[require.resolve('../api/_delivery.js')];
  const delivery = require('../api/_delivery.js');
  
  const poolMessage = {
    task_id: 'task_001',
    transport: { mode: 'pool', project_id: 'proj_test' }
  };
  
  try {
    await delivery.task(poolMessage, new Map());
    assert.fail('Should have thrown error for pool mode in task()');
  } catch (err) {
    assert.ok(err.message.includes('TRANSPARENCY VIOLATION'));
    assert.ok(err.message.includes('owned account'));
  }
});

test('pooled blocking: findAttempt() rejects pool mode', async () => {
  delete require.cache[require.resolve('../api/_delivery.js')];
  const delivery = require('../api/_delivery.js');
  
  const poolAttempt = {
    transport: { mode: 'pool', project_id: 'proj_test' },
    created_at: new Date().toISOString(),
    body: 'Test',
    target_url: 'https://reddit.com/r/test/comments/abc'
  };
  
  try {
    await delivery.findAttempt(poolAttempt, new Map());
    assert.fail('Should have thrown error for pool mode in findAttempt()');
  } catch (err) {
    assert.ok(err.message.includes('TRANSPARENCY VIOLATION'));
  }
});

test('pooled blocking: cancel() rejects pool mode', async () => {
  delete require.cache[require.resolve('../api/_delivery.js')];
  const delivery = require('../api/_delivery.js');
  
  const poolMessage = {
    task_id: 'task_001',
    transport: { mode: 'pool' }
  };
  
  try {
    await delivery.cancel(poolMessage);
    assert.fail('Should have thrown error for pool mode in cancel()');
  } catch (err) {
    assert.ok(err.message.includes('TRANSPARENCY VIOLATION'));
  }
});

console.log('✓ All pooled-blocking tests passed - pooled accounts are completely dead');
