// Watch live history events: node scripts/history-live-check.mjs <agentId> [seconds]
import WebSocket from 'ws';

const [id, secs = '25'] = process.argv.slice(2);
const port = process.env.PORT || 4317;
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/history?id=${id}`, { origin: `http://127.0.0.1:${port}` });
const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
ws.on('message', (m) => {
  const j = JSON.parse(m.toString());
  if (j.type === 'init') console.log(at(), 'init', j.entries.length, 'entries');
  else if (j.type === 'entries') for (const e of j.entries) console.log(at(), 'upsert', e.id.slice(0, 12), e.k, (e.text || e.summary || '').slice(0, 60), e.result ? '[result]' : '');
  else console.log(at(), j.type);
});
ws.on('error', (e) => console.log('error', e.message));
setTimeout(() => { ws.close(); process.exit(0); }, Number(secs) * 1000);
