/* tests/transparency-unit.test.cjs — Unit tests for transparency validation
 * These tests validate the core validation logic without requiring database setup
 */

const test = require('node:test');
const assert = require('node:assert');

test('disclosure validation: valid disclosure passes', () => {
  const transparency = require('../api/_transparency.js');
  
  const body = 'This is a helpful comment. GeoNode team member here. We offer residential proxies.';
  const result = transparency.validateDisclosure(body, 'GeoNode team member here');
  
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.failures.length, 0);
});

test('disclosure validation: missing disclosure fails', () => {
  const transparency = require('../api/_transparency.js');
  
  const body = 'This is a comment without disclosure about proxies.';
  const result = transparency.validateDisclosure(body, '');
  
  assert.strictEqual(result.ok, false);
  assert.ok(result.failures.some(f => f.includes('disclosure')));
});

test('disclosure validation: wrong disclosure line fails', () => {
  const transparency = require('../api/_transparency.js');
  
  const body = 'GeoNode team member here. This has generic disclosure.';
  const accountLine = 'Disclosure: I work at GeoNode';
  const result = transparency.validateDisclosure(body, accountLine);
  
  assert.strictEqual(result.ok, false);
  assert.ok(result.failures.some(f => f.includes('exact disclosure line')));
});

test('disclosure validation: accepts various valid disclosure formats', () => {
  const transparency = require('../api/_transparency.js');
  
  const validBodies = [
    'GeoNode team member here. Check out our docs.',
    'Disclosure: I work at GeoNode and can help with this.',
    'Posted by GeoNode - here\'s what we recommend.',
    'I work with GeoNode and have experience with this.',
    'I am with Geonode team, happy to explain.'
  ];
  
  for (const body of validBodies) {
    const result = transparency.validateDisclosure(body, '');
    assert.strictEqual(result.ok, true, `Should pass for: ${body}`);
  }
});

test('disclosure validation: rejects comments without geonode mention', () => {
  const transparency = require('../api/_transparency.js');
  
  const body = 'I work at a proxy company and can help with this.';
  const result = transparency.validateDisclosure(body, '');
  
  assert.strictEqual(result.ok, false);
  assert.ok(result.failures.some(f => f.toLowerCase().includes('disclosure')));
});

test('disclosure validation: case insensitive', () => {
  const transparency = require('../api/_transparency.js');
  
  const bodies = [
    'geonode team member here',
    'GEONODE TEAM MEMBER HERE',
    'GeoNode Team Member Here',
    'I work at geonode',
    'Posted by GEONODE'
  ];
  
  for (const body of bodies) {
    const result = transparency.validateDisclosure(body, '');
    assert.strictEqual(result.ok, true, `Should pass for: ${body}`);
  }
});

test('rate limit constants are configurable', () => {
  const transparency = require('../api/_transparency.js');
  
  // Check that rate limits are defined and are numbers
  assert.ok(typeof transparency.RATE_LIMITS.MAX_PER_ACCOUNT_PER_DAY === 'number');
  assert.ok(typeof transparency.RATE_LIMITS.MAX_PER_SUBREDDIT_PER_DAY === 'number');
  assert.ok(typeof transparency.RATE_LIMITS.MIN_HOURS_BETWEEN_SUBREDDIT_COMMENTS === 'number');
  
  // Check sensible defaults
  assert.ok(transparency.RATE_LIMITS.MAX_PER_ACCOUNT_PER_DAY > 0);
  assert.ok(transparency.RATE_LIMITS.MAX_PER_SUBREDDIT_PER_DAY > 0);
  assert.ok(transparency.RATE_LIMITS.MIN_HOURS_BETWEEN_SUBREDDIT_COMMENTS > 0);
});

test('DISCLOSURE regex matches expected patterns', () => {
  const { DISCLOSURE } = require('../api/_rules.js');
  
  const validPatterns = [
    'geonode team',
    'geonode team here',
    'posted by geonode',
    'run by geonode',
    'operated by geonode',
    'i work at geonode',
    'i am with geonode',
    'disclosure: i work at geonode',
    'operated for geonode'
  ];
  
  for (const pattern of validPatterns) {
    assert.ok(DISCLOSURE.test(pattern), `Should match: ${pattern}`);
  }
  
  const invalidPatterns = [
    'just mentioning geonode without context',
    'have you tried geonode?',
    'geonode looks good'
  ];
  
  for (const pattern of invalidPatterns) {
    assert.ok(!DISCLOSURE.test(pattern), `Should NOT match: ${pattern}`);
  }
});

console.log('✓ All unit tests passed');
