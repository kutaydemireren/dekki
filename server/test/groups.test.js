import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS, groupAgents, groupOf, localMidnight, nest, chipMarker, workingCount } from '../../web/groups.js';

const now = new Date(2026, 9, 21, 15, 0, 0);
const mid = localMidnight(now);
const a = (id, over) => ({ id, state: 'done', needsInput: false, lastActivityAt: mid + 1000, ...over });

test('groupOf: running, needs input, done today, older, archived', () => {
  assert.equal(groupOf(a('1', { state: 'working' }), {}, now), 'Running');
  assert.equal(groupOf(a('2', { state: 'blocked', needsInput: true }), {}, now), 'Needs input');
  assert.equal(groupOf(a('3'), {}, now), 'Done today');
  assert.equal(groupOf(a('4', { lastActivityAt: mid - 1 }), {}, now), 'Older');
  assert.equal(groupOf(a('5', { state: 'failed', lastActivityAt: mid - 1 }), {}, now), 'Older');
  assert.equal(groupOf(a('6', { state: 'working' }), { archived: ['6'] }, now), 'Archived');
});

test('groupOf: agents that are not mine go to Other agents; archived still wins; a missing flag stays in the main list', () => {
  assert.equal(groupOf(a('1', { mine: false, state: 'working' }), {}, now), 'Other agents');
  assert.equal(groupOf(a('2', { mine: false, state: 'blocked', needsInput: true }), {}, now), 'Other agents');
  assert.equal(groupOf(a('3', { mine: true }), {}, now), 'Done today');
  assert.equal(groupOf(a('4'), {}, now), 'Done today');
  assert.equal(groupOf(a('5', { mine: false }), { archived: ['5'] }, now), 'Archived');
});

test('nest: linked workers go under their manager, running first then newest; orphans, marked-mine and unlinked stay top-level', () => {
  const m = a('m1', { mine: true });
  const w1 = a('w1', { mine: false, parent: 'm1', lastActivityAt: mid + 5 });
  const w2 = a('w2', { mine: false, parent: 'm1', lastActivityAt: mid + 9 });
  const w3 = a('w3', { mine: false, parent: 'm1', state: 'working', lastActivityAt: mid + 1 });
  const grand = a('g1', { mine: false, parent: 'w1', lastActivityAt: mid + 2 }); // a worker's worker is flattened under the top manager
  const kept = a('k1', { mine: true, parent: 'm1' }); // "Show in my list"
  const orphan = a('o1', { mine: false, parent: 'gone' });
  const loose = a('l1', { mine: false });
  const { top, children } = nest([m, w1, w2, w3, grand, kept, orphan, loose]);
  assert.deepEqual(top.map((x) => x.id), ['m1', 'k1', 'o1', 'l1']);
  assert.deepEqual(children.get('m1').map((x) => x.id), ['w3', 'w2', 'w1', 'g1']);
  assert.equal(children.size, 1);
  // a manager archived still owns its workers: they are not in any group
  const g = groupAgents(nest([m, w1]).top, { archived: ['m1'] }, now);
  assert.deepEqual(g.Archived.map((x) => x.id), ['m1']);
  assert.equal(Object.values(g).flat().length, 1);
});

test('groupAgents: pinned agents form the Pinned group, newest first; the others keep newest first', () => {
  const g = groupAgents([a('x', { lastActivityAt: mid + 5 }), a('y', { lastActivityAt: mid + 9 }), a('z', { lastActivityAt: mid + 1 }), a('p', { lastActivityAt: 7 })], { pinned: ['z', 'p'] }, now);
  assert.deepEqual(g.Pinned.map((x) => x.id), ['z', 'p']);
  assert.deepEqual(g['Done today'].map((x) => x.id), ['y', 'x']);
  assert.deepEqual(GROUPS, ['Needs input', 'Pinned', 'Running', 'Done today', 'Older', 'Other agents', 'Archived']);
});

test('groupOf: Pinned precedence (archived, other agents and needs-you win; working, done and old pinned agents land in Pinned)', () => {
  const pin = { pinned: ['1'] };
  assert.equal(groupOf(a('1', { state: 'working' }), pin, now), 'Pinned');
  assert.equal(groupOf(a('1', { lastActivityAt: mid - 1 }), pin, now), 'Pinned');
  assert.equal(groupOf(a('1'), pin, now), 'Pinned');
  assert.equal(groupOf(a('1', { state: 'blocked', needsInput: true }), pin, now), 'Needs input');
  assert.equal(groupOf(a('1', { state: 'working', stalled: true }), pin, now), 'Needs input');
  assert.equal(groupOf(a('1', { mine: false }), pin, now), 'Other agents');
  assert.equal(groupOf(a('1'), { pinned: ['1'], archived: ['1'] }, now), 'Archived');
  assert.equal(groupOf(a('1', { needsInput: false }), pin, now), 'Pinned'); // answered: back to Pinned
});

test('groupOf: a stalled manager goes to Needs input, not Running', () => {
  assert.equal(groupOf({ id: 'm', state: 'working', stalled: true }), 'Needs input');
  assert.equal(groupOf({ id: 'm', state: 'working' }), 'Running');
});

test('chipMarker: working wins, else unread, else none', () => {
  const w = (id, state) => ({ id, state });
  const none = new Set();
  assert.equal(chipMarker([w('a', 'working'), w('b', 'done')], none), 'working');
  assert.equal(chipMarker([w('a', 'working'), w('b', 'done')], new Set(['b'])), 'working');
  assert.equal(chipMarker([w('a', 'blocked'), w('b', 'done')], new Set(['b'])), 'unread');
  assert.equal(chipMarker([w('a', 'blocked'), w('b', 'done')], none), null);
});

test('chipMarker: failed, stopped, missing state and empty list', () => {
  const none = new Set();
  assert.equal(chipMarker([{ id: 'a', state: 'failed' }, { id: 'b', state: 'stopped' }], none), null);
  assert.equal(chipMarker([{ id: 'a' }, { id: 'b', state: undefined }], none), null);
  assert.equal(chipMarker([], none), null);
  assert.equal(chipMarker([{ id: 'a', state: 'failed' }], new Set(['a'])), 'unread');
});

test('workingCount: counts only working workers', () => {
  assert.equal(workingCount([]), 0);
  assert.equal(workingCount([{ state: 'working' }, { state: 'done' }, {}, { state: 'working' }]), 2);
});

test('nest: an archived worker is not nested, so the chip never counts it; it lands in Archived', () => {
  const m = a('m1', { mine: true });
  const w1 = a('w1', { mine: false, parent: 'm1', state: 'working' });
  const w2 = a('w2', { mine: false, parent: 'm1' });
  const { top, children } = nest([m, w1, w2], ['w1']);
  assert.deepEqual(children.get('m1').map((x) => x.id), ['w2']);
  assert.equal(chipMarker(children.get('m1'), new Set()), null); // archived working worker no longer drives the marker
  const g = groupAgents(top, { archived: ['w1'] }, now);
  assert.deepEqual(g.Archived.map((x) => x.id), ['w1']);
});
