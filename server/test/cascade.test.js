import test from 'node:test';
import assert from 'node:assert/strict';
import { planWorkers, workerOutcome } from '../../web/cascade.js';

const w = (id, over = {}) => ({ id, name: `worker-${id}`, state: 'done', needsInput: false, ...over });

test('planWorkers: only finished, clean workers are ticked by default', () => {
  const plan = planWorkers(
    [w('a'), w('b', { state: 'blocked', needsInput: true }), w('c'), w('d', { state: 'working' }), w('e'), w('f', { state: 'blocked', needsInput: true })],
    {
      a: { running: false, dirty: [] },
      b: { running: false, dirty: [] },
      c: { running: false, dirty: [' M a.js', '?? b.js'] },
      d: { running: false, dirty: [] },
      e: undefined, // the check failed
      f: { running: false, dirty: [' M x'] },
    },
  );
  const by = Object.fromEntries(plan.map((p) => [p.id, p]));
  assert.deepEqual([by.a.defaultOn, by.a.disabled, by.a.reason], [true, false, '']);
  assert.deepEqual([by.b.defaultOn, by.b.disabled, by.b.reason], [false, false, 'waiting for your answer']);
  assert.equal(by.c.defaultOn, false);
  assert.equal(by.c.disabled, false); // tickable: Delete would keep the worktree
  assert.match(by.c.reason, /uncommitted changes \(2\)/);
  assert.deepEqual([by.d.defaultOn, by.d.disabled, by.d.reason], [false, true, 'running: stop it first']);
  assert.deepEqual([by.e.defaultOn, by.e.disabled], [false, false]); // unknown: kept unless the user ticks it
  assert.match(by.e.reason, /could not check/);
  assert.match(by.f.reason, /waiting for your answer; uncommitted changes/); // reasons add up
});

test('workerOutcome: deleted, kept by claude, already gone (404) and real errors', () => {
  assert.equal(workerOutcome({ ok: true, status: 200, kept: false }), 'deleted');
  assert.equal(workerOutcome({ ok: true, status: 200, kept: true, output: 'kept: unpushed commits' }), 'kept');
  assert.equal(workerOutcome({ ok: false, status: 404, error: 'Agent not found.' }), 'gone'); // someone removed it already: done
  assert.equal(workerOutcome({ ok: false, status: 409, error: 'Agent is running.' }), 'error'); // stops the cascade
  assert.equal(workerOutcome({ ok: false, status: 500, error: 'claude rm failed' }), 'error');
  assert.equal(workerOutcome(undefined), 'error');
});

test('planWorkers: a running worker is disabled even if only the check says so; empty list and missing checks are fine', () => {
  assert.equal(planWorkers([w('a')], { a: { running: true, dirty: [] } })[0].disabled, true);
  assert.deepEqual(planWorkers([]), []);
  assert.equal(planWorkers([w('a')])[0].defaultOn, false); // no checks at all: nothing ticked
});
