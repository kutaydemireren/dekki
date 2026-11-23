// Confirms a running deck rejects bad WebSocket upgrades: node scripts/ws-reject-check.mjs
import WebSocket from 'ws';

const port = process.env.PORT || 4317;
const u = `ws://127.0.0.1:${port}/ws/attach?id=e4f3ad73`;
const cases = [
  ['bad origin', { origin: 'http://evil.com' }],
  ['no origin', {}],
  ['bad host', { origin: `http://127.0.0.1:${port}`, headers: { Host: 'evil.com' } }],
];
for (const [name, opts] of cases) {
  await new Promise((resolve) => {
    const w = new WebSocket(u, opts);
    w.on('unexpected-response', (_q, s) => { console.log(name, s.statusCode); resolve(); });
    w.on('open', () => { console.log(name, 'OPENED (BAD)'); w.close(); resolve(); });
    w.on('error', () => {});
  });
}
