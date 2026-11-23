import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createServer, listen } from '../index.js';
import { checkRequest } from '../security.js';

const P = 4399;
const base = { host: `127.0.0.1:${P}`, method: 'GET', path: '/', isUpgrade: false, port: P };

test('checkRequest: host', () => {
  assert.equal(checkRequest(base).ok, true);
  assert.equal(checkRequest({ ...base, host: `localhost:${P}` }).ok, true);
  assert.equal(checkRequest({ ...base, host: `evil.com:${P}` }).ok, false);
  assert.equal(checkRequest({ ...base, host: '127.0.0.1:1' }).ok, false);
  assert.equal(checkRequest({ ...base, host: undefined }).ok, false);
});

test('checkRequest: origin', () => {
  assert.equal(checkRequest({ ...base, path: '/api/agents', origin: `http://127.0.0.1:${P}` }).ok, true);
  assert.equal(checkRequest({ ...base, path: '/api/agents', origin: 'http://evil.com' }).ok, false);
  assert.equal(checkRequest({ ...base, origin: 'null' }).ok, false);
  assert.equal(checkRequest({ ...base, isUpgrade: true, origin: 'http://evil.com' }).ok, false);
  assert.equal(checkRequest({ ...base, isUpgrade: true }).ok, false); // no Origin on upgrade
  assert.equal(checkRequest({ ...base, isUpgrade: true, origin: `http://localhost:${P}` }).ok, true);
});

test('checkRequest: missing Origin', () => {
  assert.equal(checkRequest(base).ok, true); // static GET
  assert.equal(checkRequest({ ...base, path: '/api/agents' }).ok, false);
  assert.equal(checkRequest({ ...base, path: '/api/agents', secFetchSite: 'cross-site' }).ok, false);
  assert.equal(checkRequest({ ...base, path: '/api/agents', secFetchSite: 'same-origin' }).ok, true);
  assert.equal(checkRequest({ ...base, method: 'POST', path: '/api/x', secFetchSite: 'same-origin' }).ok, false);
});

function req(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', reject);
    r.end();
  });
}

function upgrade(port, headers) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      const h = { Host: `127.0.0.1:${port}`, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', ...headers };
      s.write(`GET /ws HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    });
    let data = '';
    s.on('data', (d) => (data += d));
    s.on('close', () => resolve(data.split('\r\n')[0]));
  });
}

test('http + ws server enforces Host/Origin', async () => {
  let upgraded = 0;
  const server = createServer({ port: P, onUpgrade: (_r, socket) => { upgraded++; socket.destroy(); } });
  await listen(server, P);
  try {
    assert.equal(await req(P), 200);
    assert.equal(await req(P, { headers: { Host: 'evil.com' } }), 403);
    assert.equal(await req(P, { path: '/api/agents', headers: { Origin: 'http://evil.com' } }), 403);
    assert.equal(await req(P, { path: '/api/agents' }), 403);
    assert.equal(await req(P, { method: 'POST', path: '/api/x' }), 403);
    assert.notEqual(await req(P, { path: '/api/agents', headers: { Origin: `http://127.0.0.1:${P}` } }), 403);
    // WebSocket upgrade: rejected before the handler runs
    assert.match(await upgrade(P, { Origin: 'http://evil.com' }), /403/);
    assert.match(await upgrade(P, { Origin: `http://127.0.0.1:${P}`, Host: 'evil.com' }), /403/);
    assert.match(await upgrade(P, {}), /403/);
    assert.equal(upgraded, 0);
    await upgrade(P, { Origin: `http://127.0.0.1:${P}` });
    assert.equal(upgraded, 1);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
