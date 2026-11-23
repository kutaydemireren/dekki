import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createViewing, STALE_MS } from '../viewing.js';
import { step } from '../notify.js';
import { createServer, listen } from '../index.js';
import { apiRoutes } from '../routes.js';

const clock = () => { const c = { t: 1000, now: () => c.t }; return c; };
const A = 'aaaaaaa1';
const B = 'bbbbbbb2';

test('viewing: fresh active report counts, stale does not', () => {
  const c = clock();
  const v = createViewing({ now: c.now });
  assert.equal(v.report('p1', A, true), true);
  assert.equal(v.isViewing(A), true);
  assert.equal(v.isViewing(B), false);
  c.t += STALE_MS - 1;
  assert.equal(v.isViewing(A), true);
  c.t += 2;
  assert.equal(v.isViewing(A), false);
});

test('viewing: heartbeat refreshes; inactive page and null selection do not count', () => {
  const c = clock();
  const v = createViewing({ now: c.now });
  v.report('p1', A, true);
  c.t += 20_000;
  v.report('p1', A, true);
  c.t += 20_000;
  assert.equal(v.isViewing(A), true);
  v.report('p1', A, false);
  assert.equal(v.isViewing(A), false);
  v.report('p1', null, true);
  assert.equal(v.isViewing(A), false);
});

test('viewing: several pages, any fresh active one counts; one page moving away drops only its claim', () => {
  const c = clock();
  const v = createViewing({ now: c.now });
  v.report('p1', A, true);
  v.report('p2', A, true);
  v.report('p1', B, true);
  assert.equal(v.isViewing(A), true); // p2 still on A
  assert.equal(v.isViewing(B), true);
  c.t += STALE_MS + 1;
  v.report('p1', B, true);
  assert.equal(v.isViewing(A), false); // p2 went stale (crashed tab)
  assert.equal(v.isViewing(B), true);
});

test('viewing: invalid reports rejected', () => {
  const v = createViewing();
  for (const [p, id, a] of [['', A, true], [undefined, A, true], ['p', 'AAAAAAA1', true], ['p', 'abc', true], ['p', A, 'yes'], ['p', undefined, true], ['p', 'aaaaaaa1; id', true], ['p'.repeat(65), A, true]]) {
    assert.equal(v.report(p, id, a), false, String([p, id, a]));
  }
  assert.equal(v.isViewing(A), false);
});

test('step: viewed agent is skipped (not queued); not viewed or stale notifies', () => {
  const c = clock();
  const v = createViewing({ now: c.now });
  const sent = [];
  const opts = { notifier: (e) => sent.push(`${e.id}:${e.kind}`), enabled: true, isViewing: (id) => v.isViewing(id) };
  const mk = (id, o = {}) => ({ id, name: id, state: 'working', status: 'busy', needsInput: false, stalled: false, parent: null, mine: true, startedAtRoot: true, ...o });
  const tracker = { prev: null };
  step(tracker, [mk(A), mk(B)], opts);
  v.report('p1', A, true);
  step(tracker, [mk(A, { state: 'done' }), mk(B, { state: 'done' })], opts);
  assert.deepEqual(sent, [`${B}:finished`]); // A viewed: skipped
  // not queued: once the user looks away, A does not fire retroactively
  v.report('p1', null, true);
  step(tracker, [mk(A, { state: 'done' }), mk(B, { state: 'done' })], opts);
  assert.deepEqual(sent, [`${B}:finished`]);
  // stale report no longer suppresses
  step(tracker, [mk(A), mk(B)], opts);
  v.report('p1', A, true);
  c.t += STALE_MS + 1;
  step(tracker, [mk(A, { needsInput: true, state: 'blocked' }), mk(B)], opts);
  assert.deepEqual(sent, [`${B}:finished`, `${A}:needs-input`]);
});

function post(port, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/viewing', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject);
    r.end(JSON.stringify(body));
  });
}

test('POST /api/viewing: bad Origin 403, good Origin accepted, bad body 400', async () => {
  const P = 4398;
  const server = createServer({ port: P, routes: [apiRoutes()] });
  await listen(server, P);
  try {
    const ok = { Origin: `http://127.0.0.1:${P}` };
    assert.equal(await post(P, { Origin: 'http://evil.com' }, { page: 'p', id: A, active: true }), 403);
    assert.equal(await post(P, {}, { page: 'p', id: A, active: true }), 403); // no Origin
    assert.equal(await post(P, ok, { page: 'p', id: A, active: true }), 200);
    assert.equal(await post(P, ok, { page: 'p', id: null, active: false }), 200);
    assert.equal(await post(P, ok, { page: 'p', id: 'nope', active: true }), 400);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
