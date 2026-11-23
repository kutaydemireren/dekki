import test from 'node:test';
import assert from 'node:assert/strict';
import { paletteAgents, paletteActions, paletteItems, moveIndex } from '../../web/palette.js';

const ag = (id, name, o = {}) => ({ id, name, label: 'proj', state: 'idle', lastActivityAt: 1, ...o });
const agents = [ag('1', 'old-job'), ag('2', 'run-job', { state: 'working', lastActivityAt: 5 }), ag('3', 'ask-job', { needsInput: true }), ag('4', 'worker-x', { label: 'web', parent: '3', mine: false })];

test('no query: needs you first, then working, then the rest; workers included', () => {
  assert.deepEqual(paletteAgents(agents, '').map((a) => a.id), ['3', '2', '1', '4']);
});
test('query uses the list search: name, project label or id', () => {
  assert.deepEqual(paletteAgents(agents, 'run job').map((a) => a.id), ['2']);
  assert.deepEqual(paletteAgents(agents, 'web').map((a) => a.id), ['4']);
});
const actions = [{ id: 'new', label: 'New agent' }, { id: 'sw', label: 'Switch account: Work', keywords: 'account' }, { id: 'off', label: 'Hidden', disabled: true }];
test('actions match every word, skip disabled', () => {
  assert.deepEqual(paletteActions(actions, '').map((a) => a.id), ['new', 'sw']);
  assert.deepEqual(paletteActions(actions, 'acc work').map((a) => a.id), ['sw']);
  assert.deepEqual(paletteActions(actions, 'zzz'), []);
});
test('items list agents then actions with unique keys', () => {
  const all = paletteItems(agents, actions, '');
  assert.equal(new Set(all.map((i) => i.key)).size, all.length);
  assert.equal(all.at(-1).kind, 'action');
  assert.equal(all[0].kind, 'agent');
});
test('moveIndex wraps', () => {
  assert.equal(moveIndex(0, 3, -1), 2);
  assert.equal(moveIndex(2, 3, 1), 0);
  assert.equal(moveIndex(0, 0, 1), 0);
});
