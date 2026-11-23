import test from 'node:test';
import assert from 'node:assert/strict';
import { keyMode, stepId, nextNeedingId, pinnedOrder } from '../../web/shortcuts.js';

const el = (tagName, extra = {}) => ({ tagName, ...extra });
const ev = (key, o = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: el('BODY'), ...o });

test('plain keys act on the page, not in inputs, textareas, selects, contenteditable or the terminal', () => {
  assert.equal(keyMode(ev('j')), 'plain');
  assert.equal(keyMode(ev('?', { shiftKey: true })), 'plain');
  for (const t of [el('INPUT'), el('TEXTAREA'), el('SELECT'), el('DIV', { isContentEditable: true }), el('CANVAS', { closest: (s) => (s === '.xterm' ? {} : null) })]) {
    assert.equal(keyMode(ev('j', { target: t })), null, t.tagName);
  }
});
test('plain keys never act with Cmd, Ctrl or Alt held', () => {
  assert.equal(keyMode(ev('j', { altKey: true })), null);
  assert.equal(keyMode(ev('c', { ctrlKey: true })), null); // Mac: Ctrl+C is not ours
  assert.equal(keyMode(ev('c', { metaKey: true, ctrlKey: true })), null);
});
test('Cmd (Mac) / Ctrl (other) shortcuts act even while typing, but Ctrl stays with the terminal', () => {
  assert.equal(keyMode(ev('k', { metaKey: true, target: el('INPUT') })), 'mod');
  assert.equal(keyMode(ev('k', { ctrlKey: true }), { isMac: false }), 'mod');
  assert.equal(keyMode(ev('k', { ctrlKey: true, target: el('TEXTAREA', { closest: () => ({}) }) }), { isMac: false }), null);
  assert.equal(keyMode(ev('k', { metaKey: true }), { isMac: false }), null);
  assert.equal(keyMode(ev('k', { metaKey: true, altKey: true })), null);
});
test('composing or already handled events are ignored', () => {
  assert.equal(keyMode({ ...ev('j'), isComposing: true }), null);
  assert.equal(keyMode({ ...ev('j'), defaultPrevented: true }), null);
});

test('stepId moves without wrapping; nothing selected starts at the ends', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(stepId(ids, 'a', 1), 'b');
  assert.equal(stepId(ids, 'c', 1), 'c');
  assert.equal(stepId(ids, 'a', -1), 'a');
  assert.equal(stepId(ids, null, 1), 'a');
  assert.equal(stepId(ids, null, -1), 'c');
  assert.equal(stepId([], 'a', 1), null);
});

const mk = (id, o = {}) => ({ id, name: id, state: 'idle', lastActivityAt: 100, ...o });
test('nextNeedingId cycles through top-level agents that need you', () => {
  const agents = [mk('a', { needsInput: true, lastActivityAt: 300 }), mk('b'), mk('c', { needsInput: true, lastActivityAt: 200 }), mk('w', { needsInput: true, parent: 'a', mine: false })];
  assert.equal(nextNeedingId(agents, {}, null), 'a');
  assert.equal(nextNeedingId(agents, {}, 'a'), 'c');
  assert.equal(nextNeedingId(agents, {}, 'c'), 'a');
  assert.equal(nextNeedingId([mk('b')], {}, null), null);
});
test('pinnedOrder follows the list order, pinned agents only', () => {
  const agents = [mk('old', { lastActivityAt: 1 }), mk('run', { state: 'working' }), mk('ask', { needsInput: true }), mk('x')];
  assert.deepEqual(pinnedOrder(agents, { pinned: ['old', 'run', 'ask', 'gone'] }), ['ask', 'run', 'old']);
  assert.deepEqual(pinnedOrder(agents, {}), []);
});
