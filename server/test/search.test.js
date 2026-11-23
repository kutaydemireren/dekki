import test from 'node:test';
import assert from 'node:assert/strict';
import { matchAgent, parseQuery, searchVisible } from '../../web/search.js';

const uuid = '3b60872f-1a2b-4c3d-8e9f-0123456789ab';
const a = { id: '3b60872f', sessionId: uuid, name: 'acme-devices-row-list', label: 'web-app', detail: 'Reading the pelican file' };

test('empty query matches all', () => {
  assert.equal(matchAgent(a, ''), true);
  assert.equal(matchAgent(a, '   '), true);
});
test('name words, case-insensitive substring', () => {
  assert.equal(matchAgent(a, 'devices'), true);
  assert.equal(matchAgent(a, 'DEVIC'), true);
  assert.equal(matchAgent(a, 'devices nope'), false);
});
test('- and _ act as separators', () => {
  assert.equal(matchAgent(a, 'acme list'), true);
  assert.equal(matchAgent(a, 'acme-devices'), true);
  assert.equal(matchAgent(a, 'devices_row'), true);
  assert.equal(matchAgent(a, 'list row devices'), true);
});
test('pasted full uuid, with quotes and spaces', () => {
  assert.equal(matchAgent(a, uuid), true);
  assert.equal(matchAgent(a, `  "${uuid.toUpperCase()}" `), true);
  assert.equal(matchAgent(a, uuid.replace(/.$/, 'c')), false);
});
test('short job id and fragments (>= 4 chars)', () => {
  assert.equal(matchAgent(a, '3b60872f'), true);
  assert.equal(matchAgent(a, '0872'), true);
  assert.equal(matchAgent(a, '4c3d-8e9f'), true);
  assert.equal(matchAgent(a, 'dead'), false);
});
test('queries under 4 chars never match ids', () => {
  const b = { id: 'dd11ee22', sessionId: 'aaaa-bbbb', name: 'zzz', label: '', detail: '' };
  assert.equal(matchAgent(b, 'dd'), false);
  assert.equal(matchAgent(b, 'a'), false);
  assert.equal(matchAgent(b, 'dd1'), false);
  assert.equal(matchAgent(b, 'dd11'), true);
  assert.equal(parseQuery('dd').idFrag, null);
});
test('null sessionId is fine', () => {
  assert.equal(matchAgent({ id: 'abcd1234', sessionId: null, name: 'x' }, 'abcd'), true);
  assert.equal(matchAgent({ id: 'abcd1234', sessionId: null, name: 'x' }, 'beef'), false);
});
test('name and label match, detail does not; words may span name and label', () => {
  assert.equal(matchAgent(a, 'web'), true);
  assert.equal(matchAgent(a, 'pelican'), false);
  assert.equal(matchAgent(a, 'devices web'), true);
  assert.equal(matchAgent(a, 'devices pelican'), false);
  assert.equal(matchAgent(a, 'mobile'), false);
});
const m = { id: 'aaaa0001', name: 'mgr' };
const w1 = { id: 'bbbb0002', name: 'login-flow' };
const w2 = { id: 'cccc0003', name: 'other' };
const solo = { id: 'dddd0004', name: 'solo' };
const children = new Map([[m.id, [w1, w2]]]);
const run = (q) => { const r = searchVisible([m, solo], children, q); return { v: [...r.visible].sort(), w: (r.workers.get(m.id) || []).map((x) => x.id) }; };

test('searchVisible: manager-only hit lists the manager and NO workers', () => {
  assert.deepEqual(run('mgr'), { v: [m.id], w: [] });
});
test('searchVisible: worker-only hit lists parent with just that worker', () => {
  assert.deepEqual(run('login'), { v: [m.id, w1.id].sort(), w: [w1.id] });
});
test('searchVisible: manager and worker both hit lists manager + only matching workers', () => {
  const kids = new Map([[m.id, [{ id: 'bbbb0002', name: 'mgr-login' }, w2]]]);
  const r = searchVisible([m], kids, 'mgr');
  assert.deepEqual([...r.visible].sort(), [m.id, 'bbbb0002'].sort());
  assert.deepEqual(r.workers.get(m.id).map((x) => x.id), ['bbbb0002']);
});
test('searchVisible: non-matching worker never listed; standalone hit and miss', () => {
  assert.equal(run('login').v.includes(w2.id), false);
  assert.deepEqual(run('solo'), { v: [solo.id], w: [] });
  assert.deepEqual(run('zzzz'), { v: [], w: [] });
});
