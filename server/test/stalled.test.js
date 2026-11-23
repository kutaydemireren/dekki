import test from 'node:test';
import assert from 'node:assert/strict';
import { markStalled, managerStatus } from '../agents.js';

const mk = (id, o) => ({ id, name: id, state: 'working', status: 'busy', lastActivityAt: 100, parent: null, ...o });
const run = (mgr, workers) => {
  const l = [mgr, ...workers];
  markStalled(l);
  return l[0];
};
const idle = { status: 'idle' };

test('markStalled: idle manager still working with all workers finished is stalled; summary flagged stale', () => {
  const m = run(mk('m', idle), [mk('w', { state: 'done', lastActivityAt: 200, parent: 'm' })]);
  assert.equal(m.stalled, true);
  assert.equal(m.detailStale, true);
  assert.equal(m.workerResult, 'w');
  assert.equal(m.workerResultAt, 200);
});

test('markStalled: blocked, stopped and failed workers count as finished', () => {
  for (const state of ['blocked', 'stopped', 'failed']) assert.equal(run(mk('m', idle), [mk('w', { state, parent: 'm' })]).stalled, true);
});

test('markStalled: not stalled while a worker works, the turn runs, there are no workers, or the manager is done', () => {
  assert.equal(run(mk('m', idle), [mk('w', { parent: 'm' }), mk('x', { state: 'done', parent: 'm' })]).stalled, false);
  assert.equal(run(mk('m', { status: 'busy' }), [mk('w', { state: 'done', parent: 'm' })]).stalled, false);
  assert.equal(run(mk('m', idle), []).stalled, false);
  assert.equal(run(mk('m', { ...idle, state: 'done' }), [mk('w', { state: 'done', parent: 'm' })]).stalled, false);
});

test('markStalled: summary is current when the manager acted after the worker finished', () => {
  const m = run(mk('m', { ...idle, lastActivityAt: 300 }), [mk('w', { state: 'done', lastActivityAt: 200, parent: 'm' })]);
  assert.equal(m.detailStale, false);
});

const ms = (mgr, workers) => run(mk('m', mgr), workers.map((w, i) => mk(`w${i}`, { name: `w${i}`, parent: 'm', ...w }))).managerStatus;

test('managerStatus: idle turn + worker running = waiting, names in tooltip', () => {
  const s = ms(idle, [{}, {}, { state: 'done' }]);
  assert.equal(s.kind, 'waiting');
  assert.equal(s.text, 'Waiting on 2 workers');
  assert.deepEqual(s.names, ['w0', 'w1']);
  assert.equal(ms(idle, [{}]).text, 'Waiting on 1 worker');
});

test('managerStatus: idle turn + all finished = explicit stalled text', () => {
  const s = ms(idle, [{ state: 'done' }, { state: 'blocked' }]);
  assert.equal(s.kind, 'stalled');
  assert.equal(s.text, 'Stalled: all 2 workers finished, nothing will wake it');
});

test('managerStatus: busy turn + worker running = N workers running', () => {
  const s = ms({ status: 'busy' }, [{}, { state: 'done' }]);
  assert.equal(s.kind, 'running');
  assert.equal(s.text, '1 worker running');
});

test('managerStatus: busy turn + all finished = working itself', () => {
  const s = ms({ status: 'busy' }, [{ state: 'done' }, { state: 'blocked' }]);
  assert.equal(s.kind, 'self');
  assert.equal(s.text, 'Working itself: all 2 workers finished');
});

test('managerStatus: tally counts every state; no workers or manager not working gives no line', () => {
  const s = ms(idle, [{}, { state: 'done' }, { state: 'done' }, { state: 'blocked' }, { state: 'failed' }, { state: 'stopped' }]);
  assert.equal(s.tally, '6 workers: 1 running, 2 done, 1 blocked, 1 failed, 1 stopped');
  assert.equal(ms(idle, []), null);
  const d = ms({ ...idle, state: 'done' }, [{ state: 'done' }]);
  assert.equal(d.kind, null);
  assert.equal(d.text, null);
  assert.equal(d.tally, '1 worker: 0 running, 1 done, 0 blocked');
});
