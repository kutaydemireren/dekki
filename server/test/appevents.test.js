// Notification events for the Mac app (SSE) and the rule "subscriber connected -> no OS banner".
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { createSubscribers, appEventsRoute } from '../appevents.js';
import { appAwareNotifier, appPayload, createTick, titleOf, bodyOf } from '../notify.js';
import { createAttention } from '../attention.js';
import { createServer, listen } from '../index.js';
import { parseHash } from '../../web/hash.js';

const mk = (id, o = {}) => ({ id, name: `n-${id}`, state: 'working', status: 'busy', needsInput: false, stalled: false, parent: null, mine: true, startedAtRoot: true, ...o });

/** A stand-in for http.ServerResponse. */
function fakeRes({ failWrites = false } = {}) {
  const r = new EventEmitter();
  r.chunks = [];
  r.destroyed = false;
  r.writeHead = (status, headers) => { r.status = status; r.headers = headers; };
  r.write = (t) => { if (failWrites) throw new Error('EPIPE'); r.chunks.push(t); return true; };
  r.end = () => {};
  return r;
}

test('subscribers: add counts and says hello, close removes, keepalive pings, capped', async () => {
  const subs = createSubscribers({ keepAliveMs: 10 });
  assert.equal(subs.count(), 0);
  const a = fakeRes();
  assert.equal(subs.add(a), true);
  assert.equal(a.status, 200);
  assert.equal(a.headers['Content-Type'], 'text/event-stream');
  assert.match(a.chunks[0], /^event: hello\n/);
  assert.equal(subs.count(), 1);
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(a.chunks.some((c) => c.startsWith(': ping')));
  a.emit('close');
  assert.equal(subs.count(), 0);
  const many = Array.from({ length: 8 }, fakeRes);
  for (const r of many) assert.equal(subs.add(r), true);
  assert.equal(subs.add(fakeRes()), false); // 9th refused
  for (const r of many) r.emit('close');
  assert.equal(subs.count(), 0);
});

test('broadcast: one data line of JSON per event to every subscriber; counts only those that took it', () => {
  const subs = createSubscribers({ keepAliveMs: 60_000 });
  const a = fakeRes(); const b = fakeRes(); const dead = fakeRes();
  subs.add(a); subs.add(b); subs.add(dead);
  dead.write = () => { throw new Error('EPIPE'); };
  const n = subs.broadcast({ id: 'aaaaaaa1', title: 'T' });
  assert.equal(n, 2);
  assert.equal(a.chunks.at(-1), 'event: notify\ndata: {"id":"aaaaaaa1","title":"T"}\n\n');
  assert.equal(b.chunks.at(-1), a.chunks.at(-1));
  for (const r of [a, b, dead]) r.emit('close');
  assert.equal(subs.broadcast({}), 0);
});

test('appPayload: finished text and deep link come from the server; no transcript text; bad ids give no link', () => {
  const ev = { id: 'ab12cd34', name: 'Plan', kind: 'needs-input', accountId: 'second', accountLabel: 'Second' };
  const p = appPayload(ev);
  assert.deepEqual(p, { id: 'ab12cd34', accountId: 'second', kind: 'needs-input', title: 'Dekki · Second', body: 'Plan needs your input', hash: '#second:ab12cd34' });
  assert.equal(p.title, titleOf(ev));
  assert.equal(p.body, bodyOf(ev));
  assert.deepEqual(parseHash(p.hash), { account: 'second', id: 'ab12cd34', tab: 'session' });
  assert.equal(appPayload({ id: 'ab12cd34', name: 'x', kind: 'finished' }).hash, '#ab12cd34'); // no account: old form
  assert.equal(appPayload({ id: 'nope', name: 'x', kind: 'finished', accountId: 'a' }).hash, null);
  assert.equal(appPayload({ id: 'ab12cd34', name: 'x'.repeat(200), kind: 'finished' }).body.length, 80 + ' finished'.length);
});

test('appAwareNotifier: subscriber present -> only the app gets it; none -> the OS notifier exactly as before', () => {
  const subs = createSubscribers({ keepAliveMs: 60_000 });
  const fallback = [];
  const n = appAwareNotifier({ subscribers: subs, fallback: (e) => fallback.push(e) });
  const ev = { id: 'ab12cd34', name: 'Plan', kind: 'finished', accountId: 'default' };
  n(ev);                                   // browser-only use: nobody subscribed
  assert.deepEqual(fallback, [ev]);        // the very same event object, untouched
  const app = fakeRes();
  subs.add(app);
  n(ev);
  assert.equal(fallback.length, 1);        // no second (double) banner
  assert.equal(JSON.parse(app.chunks.at(-1).split('data: ')[1]).body, 'Plan finished');
  app.emit('close');                       // the app quit
  n(ev);
  assert.equal(fallback.length, 2);        // fallback back on
});

test('appAwareNotifier: a subscriber that cannot be written to does not swallow the event', () => {
  const subs = createSubscribers({ keepAliveMs: 60_000 });
  const fallback = [];
  const dead = fakeRes(); subs.add(dead); dead.write = () => { throw new Error('EPIPE'); };
  appAwareNotifier({ subscribers: subs, fallback: (e) => fallback.push(e) })({ id: 'ab12cd34', name: 'x', kind: 'finished' });
  assert.equal(fallback.length, 1);
  dead.emit('close');
});

test('through the poller: manager rules and dedupe unchanged, delivery goes to the app only while subscribed', async () => {
  const subs = createSubscribers({ keepAliveMs: 60_000 });
  const fallback = [];
  const lists = { default: [mk('aaaaaaa1'), mk('aaaaaaa2'), mk('wwwwwww1', { parent: 'aaaaaaa1', mine: false })] };
  const tick = createTick({
    notifier: appAwareNotifier({ subscribers: subs, fallback: (e) => fallback.push(e) }), attention: createAttention(), enabled: () => true,
    list: async (a) => lists[a.id], accounts: () => [{ id: 'default', label: 'Default' }], check: () => null,
  });
  await tick(); // baseline
  const app = fakeRes(); subs.add(app);
  const events = () => app.chunks.filter((c) => c.startsWith('event: notify')).map((c) => JSON.parse(c.split('data: ')[1]));
  lists.default = [mk('aaaaaaa1', { state: 'blocked', needsInput: true }), mk('aaaaaaa2'), mk('wwwwwww1', { parent: 'aaaaaaa1', mine: false, state: 'blocked', needsInput: true })];
  await tick();
  assert.deepEqual(events().map((e) => `${e.id}:${e.kind}:${e.hash}`), ['aaaaaaa1:needs-input:#default:aaaaaaa1']); // worker silent
  assert.deepEqual(fallback, []);
  await tick(); // still waiting: no repeat to either path
  assert.equal(events().length, 1);
  app.emit('close');
  lists.default = [mk('aaaaaaa1', { state: 'blocked', needsInput: true }), mk('aaaaaaa2', { state: 'done' })];
  await tick();
  assert.deepEqual(fallback.map((e) => `${e.id}:${e.kind}`), ['aaaaaaa2:finished']); // browser-only path as before
  assert.equal(events().length, 1);
});

// ---- the route over real HTTP ----
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const open = (port, headers) => new Promise((res, rej) => {
  const q = http.get({ host: '127.0.0.1', port, path: '/api/app/events', headers: { Host: `127.0.0.1:${port}`, ...headers } }, res);
  q.on('error', rej);
});
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };

test('GET /api/app/events: needs the same Host/Origin as every API call; streams hello then events; close unsubscribes', async () => {
  const subs = createSubscribers({ keepAliveMs: 60_000 });
  const port = await freePort();
  const server = createServer({ port, routes: [appEventsRoute({ subscribers: subs })] });
  await listen(server, port);
  const origin = `http://127.0.0.1:${port}`;
  try {
    for (const h of [{}, { Origin: 'http://evil.example' }, { Origin: origin, Host: 'evil.example' }]) {
      const r = await open(port, h); r.resume();
      assert.equal(r.statusCode, 403);
    }
    assert.equal(subs.count(), 0);
    const res = await open(port, { Origin: origin });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/event-stream');
    let body = '';
    res.on('data', (c) => (body += c));
    assert.ok(await until(() => body.includes('event: hello')));
    assert.equal(subs.count(), 1);
    subs.broadcast({ id: 'ab12cd34', title: 'Dekki', body: 'Plan finished', hash: '#ab12cd34' });
    assert.ok(await until(() => body.includes('"body":"Plan finished"')));
    res.destroy();
    assert.ok(await until(() => subs.count() === 0), 'closed connection must unsubscribe');
  } finally { server.close(); server.closeAllConnections?.(); }
});
