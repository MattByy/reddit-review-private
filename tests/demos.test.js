const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scenarios, timingAnalysis, fixtureReports, redact } = require('../scripts/run_demos');

test('four scenarios preserve account selection, review gates and published reply dependencies', () => {
  const demos = scenarios(['a', 'b', 'c', 'd', 'e'], 'testing');
  assert.deepEqual(demos.map(d => d.account_ids.length), [1, 2, 3, 5]);
  assert.equal(demos[0].steps[1].kind, 'post');
  for (const demo of demos) {
    assert.ok(demo.steps.length <= 30);
    for (let i = 0; i < demo.steps.length; i++) {
      const step = demo.steps[i];
      if (step.type !== 'write') continue;
      assert.equal(demo.steps[i - 1].account_id, step.account_id);
      assert.deepEqual(demo.steps.slice(i + 1, i + 4).map(s => s.type), ['approve', 'send', 'wait_live']);
      if (step.kind === 'reply') {
        assert.ok(step.reply_to_step < i + 1);
        assert.equal(demo.steps[step.reply_to_step - 1].type, 'wait_live');
      }
    }
  }
  assert.equal(demos[2].steps.filter(s => s.type === 'agent_task').length, 3);
});

test('timing does not convert absent or degenerate evidence into variability', () => {
  assert.equal(timingAnalysis([]).coefficient_of_variation, null);
  const analysis = timingAnalysis([{ published_at: null }, { published_at: 'invalid' },
    { published_at: '2026-01-01T00:00:00Z' }, { published_at: '2026-01-01T00:00:00Z' }]);
  assert.equal(analysis.unknown_timestamps, 2);
  assert.equal(analysis.coefficient_of_variation, null);
  const intervals = timingAnalysis([0, 3, 20, 24, 75].map(n => ({ published_at: new Date(Date.UTC(2026, 0, 1) + n * 60000).toISOString() })));
  assert.deepEqual(intervals.intervals_minutes, [3, 17, 4, 51]);
  assert.equal(intervals.mean_minutes, 18.75);
});

test('fixture controls flag shared orchestration and duplicated voices', async () => {
  const reports = await fixtureReports();
  assert.equal(reports.scenarios[0].report.checks.coordination.status, 'insufficient_data');
  for (const item of reports.scenarios.slice(1)) {
    assert.equal(item.report.status, 'review_required');
    assert.equal(item.report.checks.autonomy.status, 'flagged');
    assert.equal(item.report.checks.voice.status, 'no_signal');
  }
  assert.equal(reports.duplicate_voice_control.report.checks.voice.status, 'flagged');
});

test('credential values are removed from nested response and error bodies', () => {
  assert.deepEqual(redact({ error: 'secret-token', nested: ['Bearer secret-token'] }, ['secret-token', undefined]),
    { error: '[REDACTED]', nested: ['Bearer [REDACTED]'] });
});
