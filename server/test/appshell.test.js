// Mac app shell support: the attention count (Dock badge, menu bar) and its read-only route.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createAttention } from '../attention.js';
import { appShellRoutes } from '../appshell.js';
import { createServer, listen } from '../index.js';
import { readState } from '../state.js';
import { createTick, startNotifyPoller, testAgentList } from '../notify.js';

const mk = (id, o = {}) => ({ id, name: `n-${id}`, state: 'working', status: 'busy', needsInput: false, stalled: false, parent: null, mine: true, startedAtRoot: true, ...o });
const ACCTS = [{ id: 'default', label: 'Default' }, { id: 'second', label: 'Second' }];

function rig() {
  const attention = createAttention();
  const lists = { default: [], second: [] };
  const cfg = { accounts: ACCTS, missing: new Set() };
  const tick = createTick({
    notifier: () => {}, attention, enabled: () => true,
    list: async (a) => lists[a.id],
    accounts: () => cfg.accounts,
    check: (a) => (cfg.missing.has(a.id) ? 'missing' : null),
  });
  return { attention, lists, cfg, tick };
}

test('attention store: counts across accounts, tags the account, caps long names', () => {
  const a = createAttention();
  assert.deepEqual(a.snapshot(), { count: 0, agents: [] });
  a.set('default', [{ id: 'aaaaaaa1', name: 'x'.repeat(200) }]);
  a.set('second', [{ id: 'bbbbbbb2', name: 'y' }]);
  const s = a.snapshot();
  assert.equal(s.count, 2);
  assert.equal(s.agents[0].name.length, 80);
  assert.deepEqual(s.agents.map((x) => x.accountId), ['default', 'second']);
  a.set('default', []);
  a.drop('second');
  assert.equal(a.snapshot().count, 0);
});

test('poller feeds the count: Needs input group of the list, from every account; nothing else', async () => {
  const r = rig();
  await r.tick();
  assert.equal(r.attention.snapshot().count, 0);
  r.lists.default = [
    mk('aaaaaaa1', { state: 'blocked', needsInput: true }),                  // counts
    mk('aaaaaaa2', { stalled: true }),                                        // counts
    mk('aaaaaaa3', { state: 'blocked', needsInput: true, mine: false }),      // Other agent: no
    mk('aaaaaaa4', { state: 'blocked', needsInput: true, startedAtRoot: false }), // moved into a worktree, no originCwd: counts (list shows it)
    mk('aaaaaaa5', { state: 'done' }),                                        // finished: no
  ];
  r.lists.second = [mk('bbbbbbb1', { state: 'blocked', status: 'waiting', needsInput: true })];
  await r.tick();
  const s = r.attention.snapshot();
  assert.equal(s.count, 4);
  assert.deepEqual(s.agents.map((x) => `${x.accountId}:${x.id}`).sort(), ['default:aaaaaaa1', 'default:aaaaaaa2', 'default:aaaaaaa4', 'second:bbbbbbb1']);
  r.lists.default = [mk('aaaaaaa1')]; // answered
  await r.tick();
  assert.equal(r.attention.snapshot().count, 1);
});

test('count is independent of the notify toggle and of viewing (it is a state, not an event)', async () => {
  const attention = createAttention();
  const sent = [];
  const tick = createTick({
    notifier: (e) => sent.push(e), attention, enabled: () => false, isViewing: () => true,
    list: async () => [mk('aaaaaaa1', { needsInput: true, state: 'blocked' })],
    accounts: () => [ACCTS[0]], check: () => null,
  });
  await tick();
  assert.equal(attention.snapshot().count, 1);
  assert.deepEqual(sent, []);
});

test('count drops with an account that went missing or was removed', async () => {
  const r = rig();
  r.lists.default = [mk('aaaaaaa1', { needsInput: true, state: 'blocked' })];
  r.lists.second = [mk('bbbbbbb1', { needsInput: true, state: 'blocked' })];
  await r.tick();
  assert.equal(r.attention.snapshot().count, 2);
  r.cfg.missing.add('second');
  await r.tick();
  assert.equal(r.attention.snapshot().count, 1);
  r.cfg.accounts = [ACCTS[1]];
  r.cfg.missing.clear();
  await r.tick();
  assert.deepEqual(r.attention.snapshot().agents.map((x) => x.accountId), ['second']);
});

test('a failing account keeps its last count out of the way: other accounts still update', async () => {
  const attention = createAttention();
  const tick = createTick({
    notifier: () => {}, attention, enabled: () => true,
    list: async (a) => { if (a.id === 'default') throw new Error('boom'); return [mk('bbbbbbb1', { needsInput: true, state: 'blocked' })]; },
    accounts: () => ACCTS, check: () => null,
  });
  await tick();
  assert.equal(attention.snapshot().count, 1);
});

test('test seam: DEKKI_TEST_AGENTS file feeds the list; missing/invalid file means none', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-attn-'));
  try {
    const f = path.join(dir, 'agents.json');
    const list = testAgentList(f);
    assert.deepEqual(await list(), []);
    fs.writeFileSync(f, 'not json');
    assert.deepEqual(await list(), []);
    fs.writeFileSync(f, '{"a":1}');
    assert.deepEqual(await list(), []);
    fs.writeFileSync(f, JSON.stringify([mk('aaaaaaa1')]));
    assert.equal((await list()).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('poller starts outside node --test even with DEKKI_NOTIFY=0 (it feeds the count), banners stay off', async () => {
  const attention = createAttention();
  const sent = [];
  const t = startNotifyPoller({
    env: { DEKKI_NOTIFY: '0' }, intervalMs: 60_000, notifier: (e) => sent.push(e), attention,
    list: async () => [mk('aaaaaaa1', { needsInput: true, state: 'blocked' })], accounts: () => [ACCTS[0]], check: () => null, enabled: () => true,
  });
  try {
    assert.ok(t);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(attention.snapshot().count, 1);
    assert.deepEqual(sent, []);
  } finally { clearInterval(t); }
});

// ---- the route, over real HTTP with the shared security check ----
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const get = (port, p, headers = {}) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (r) => {
    let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b, headers: r.headers }));
  }).on('error', rej);
});

test('GET /api/attention: JSON snapshot with the Origin header the app sends; Host/Origin rules unchanged; read-only', async () => {
  const attention = createAttention();
  attention.set('default', [{ id: 'aaaaaaa1', name: 'Plan' }]);
  const port = await freePort();
  const server = createServer({ port, routes: [appShellRoutes({ attention })] });
  await listen(server, port);
  const origin = `http://127.0.0.1:${port}`;
  try {
    const ok = await get(port, '/api/attention', { Origin: origin });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(ok.body), { count: 1, agents: [{ id: 'aaaaaaa1', name: 'Plan', accountId: 'default' }] });
    assert.equal((await get(port, '/api/attention')).status, 403);                                  // no Origin, not same-origin
    assert.equal((await get(port, '/api/attention', { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await get(port, '/api/attention', { Origin: origin, Host: 'evil.example' })).status, 403);
    assert.equal((await get(port, '/api/attention', { 'Sec-Fetch-Site': 'same-origin' })).status, 200); // the page's own read
    const post = await new Promise((res) => { const q = http.request({ host: '127.0.0.1', port, path: '/api/attention', method: 'POST', headers: { Host: `127.0.0.1:${port}`, Origin: origin } }, (r) => { r.resume(); res(r.statusCode); }); q.end(); });
    assert.equal(post, 404);
  } finally { server.close(); server.closeAllConnections?.(); }
});

test('count = list "Needs input" group minus drafts; banners keep the manager rule', async () => {
  const r = rig();
  let archived = [];
  const sent = [];
  const tick = createTick({
    notifier: (e) => sent.push(e), attention: r.attention, enabled: () => true, isViewing: () => false,
    list: async () => r.lists.default, accounts: () => [ACCTS[0]], check: () => null, archived: () => archived,
  });
  const base = [
    mk('aaaaaaa1', { state: 'blocked', needsInput: true, startedAtRoot: false }), // started at root, moved to worktree
    mk('aaaaaaa2', { stalled: true }),                                            // stalled (still state working)
    mk('aaaaaaa3', { state: 'blocked', needsInput: true }),                       // archived below
    mk('aaaaaaa4', { state: 'blocked', needsInput: true, idle: true, empty: true }), // empty draft
    mk('aaaaaaa5', { state: 'blocked', needsInput: true, idle: true, empty: false }), // placeholder but has a conversation
    mk('aaaaaaa6'),                                                                // plain working
    mk('aaaaaaa7', { state: 'blocked', needsInput: true, mine: false }),           // linked worker
  ];
  r.lists.default = base.map((a) => ({ ...a, needsInput: false, stalled: false, state: 'working' })); // baseline: nothing waiting
  await tick();
  archived = ['aaaaaaa3'];
  r.lists.default = base;
  await tick();
  assert.deepEqual(r.attention.snapshot().agents.map((x) => x.id).sort(), ['aaaaaaa1', 'aaaaaaa2', 'aaaaaaa5']);
  // banners: only managers started at the root (a3 is archived but still a manager: banner rules unchanged)
  assert.deepEqual(sent.map((e) => e.id).sort(), ['aaaaaaa2', 'aaaaaaa3', 'aaaaaaa4', 'aaaaaaa5']);
});

test('GET /api/attention sums ALL accounts (2 in default + 4 in personal => 6), whichever account the web list shows', async () => {
  const attention = createAttention();
  attention.set('default', [1, 2].map((i) => ({ id: `aaaaaaa${i}`, name: `D${i}` })));
  attention.set('personal', [1, 2, 3, 4].map((i) => ({ id: `bbbbbbb${i}`, name: `P${i}` })));
  const port = await freePort();
  const server = createServer({ port, routes: [appShellRoutes({ attention })] });
  await listen(server, port);
  try {
    const body = JSON.parse((await get(port, '/api/attention', { Origin: `http://127.0.0.1:${port}` })).body);
    assert.equal(body.count, 6);
    assert.deepEqual(body.agents.map((a) => a.accountId).sort(), ['default', 'default', 'personal', 'personal', 'personal', 'personal']);
  } finally { server.close(); server.closeAllConnections?.(); }
});
