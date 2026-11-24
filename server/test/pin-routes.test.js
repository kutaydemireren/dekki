// POST/DELETE /api/agents/:id/(pin|archive): archiving drops the pin, pinning an archived agent un-archives it.
// Temp state file only; no real agent is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dekki-pin-test-'));
process.env.DEKKI_STATE = path.join(tmp, 'state.json');
const { readState } = await import('../state.js');
const { createServer, listen } = await import('../index.js');
const { apiRoutes } = await import('../routes.js');

const P = 4396;
function call(method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: P, method, path: p, headers: { origin: `http://127.0.0.1:${P}` } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    r.on('error', reject);
    r.end();
  });
}

test('pin and archive routes keep "archived means never pinned"', async () => {
  const server = createServer({ port: P, routes: [apiRoutes()] });
  await listen(server, P);
  try {
    let r = await call('POST', '/api/agents/aaaaaaaa/pin');
    assert.deepEqual(r.body, { pinned: ['aaaaaaaa'], archived: [] });
    r = await call('POST', '/api/agents/aaaaaaaa/archive'); // archive drops the pin
    assert.deepEqual(r.body, { pinned: [], archived: ['aaaaaaaa'] });
    r = await call('DELETE', '/api/agents/aaaaaaaa/archive'); // un-archive does not restore it
    assert.deepEqual(r.body, { pinned: [], archived: [] });
    await call('POST', '/api/agents/bbbbbbbb/archive');
    r = await call('POST', '/api/agents/bbbbbbbb/pin'); // pin un-archives
    assert.deepEqual(r.body, { pinned: ['bbbbbbbb'], archived: [] });
    r = await call('DELETE', '/api/agents/bbbbbbbb/pin');
    assert.deepEqual(r.body, { pinned: [], archived: [] });
    assert.deepEqual(readState().pinned, []);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
