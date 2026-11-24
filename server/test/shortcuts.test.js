import test from 'node:test';
import assert from 'node:assert/strict';
import { keyMode, panelFor, stepId, nextNeedingId, shortcutOrder } from '../../web/shortcuts.js';

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
test('shortcutOrder: every Needs-you row first, then the Pinned section, nothing else', () => {
  const agents = [mk('old', { lastActivityAt: 1 }), mk('run', { state: 'working' }), mk('ask', { needsInput: true }), mk('ask2', { needsInput: true, lastActivityAt: 50 }), mk('x')];
  // ask is pinned and needs you: it stays in Needs you; the plain Needs-you row follows; then Pinned, newest first
  assert.deepEqual(shortcutOrder(agents, { pinned: ['old', 'run', 'ask', 'gone'] }), ['ask', 'ask2', 'run', 'old']);
  assert.deepEqual(shortcutOrder(agents, {}), ['ask', 'ask2']);
  assert.deepEqual(shortcutOrder(agents, { pinned: ['x'], archived: ['x'] }), ['ask', 'ask2']);
});
test('shortcutOrder: at most 9 ids', () => {
  const agents = Array.from({ length: 12 }, (_, i) => mk(`a${i}`, { lastActivityAt: 100 + i }));
  assert.equal(shortcutOrder(agents, { pinned: agents.map((x) => x.id) }).length, 9);
});

test('panelFor maps Cmd+B / Shift+S / Shift+P to the tree, skills and prompts panels only', () => {
  assert.equal(panelFor('b', false), 'tree');
  assert.equal(panelFor('B', false), 'tree');
  assert.equal(panelFor('s', true), 'skills');
  assert.equal(panelFor('S', true), 'skills');
  assert.equal(panelFor('p', true), 'prompts');
  for (const [k, s] of [['b', true], ['s', false], ['p', false], ['k', true], ['Enter', false], [undefined, false]]) assert.equal(panelFor(k, s), null, `${k} ${s}`);
});
