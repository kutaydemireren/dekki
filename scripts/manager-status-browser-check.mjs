// Headless Edge/Chrome check of the manager status line, against a THROWAWAY deck it starts itself:
//   node scripts/manager-status-browser-check.mjs [screenshot-dir]
// Temp state/links, and a stub `claude` that answers only `claude agents --json` with four fixture managers
// (waiting, stalled, running, working itself) and their workers. No real agent is read or touched.
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const shotDir = process.argv[2];
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4397;
const CDP = 9346;
const BIN = process.env.DECK_TEST_BROWSER || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mgr-check-')));
const root = path.join(tmp, 'root');
for (const d of [root, path.join(tmp, 'bin'), path.join(tmp, 'prompts')]) fs.mkdirSync(d);
const rows = [];
const links = [];
const H = (s) => createHash('md5').update(s).digest('hex').slice(0, 8); // agent ids are 8 hex chars
const mgr = (id, name, status) => rows.push({ id: H(id), kind: 'background', state: 'working', status, cwd: root, name });
const wk = (id, mid, name, state) => { rows.push({ id: H(id), kind: 'background', state, status: state === 'working' ? 'busy' : 'idle', cwd: root, name }); links.push(`${H(id)}\t${H(mid)}\t0`); };
mgr('m1', 'fx-waiting', 'idle'); wk('w1a', 'm1', 'fx-w1a', 'working'); wk('w1b', 'm1', 'fx-w1b', 'working'); wk('w1c', 'm1', 'fx-w1c', 'done');
mgr('m2', 'fx-stalled', 'idle'); wk('w2a', 'm2', 'fx-w2a', 'done'); wk('w2b', 'm2', 'fx-w2b', 'blocked');
mgr('m3', 'fx-running', 'busy'); wk('w3a', 'm3', 'fx-w3a', 'working'); wk('w3b', 'm3', 'fx-w3b', 'done');
mgr('m4', 'fx-working-itself', 'busy'); for (const [i, s] of ['done', 'done', 'done', 'done', 'done', 'blocked'].entries()) wk(`w4${i}`, 'm4', `fx-w4${i}`, s);
fs.writeFileSync(path.join(tmp, 'rows.json'), JSON.stringify(rows));
fs.writeFileSync(path.join(tmp, 'links.tsv'), links.join('\n') + '\n');
fs.writeFileSync(path.join(tmp, 'bin', 'claude'), `#!/bin/bash\n[ "$1" = agents ] && cat ${path.join(tmp, 'rows.json')}\n`, { mode: 0o755 });
fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({ root, accounts: [], activeAccount: 'default' }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };
const deck = spawn(process.execPath, ['server/start.js'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(PORT), DEKKI_STATE: path.join(tmp, 'state.json'), DEKKI_PROMPTS: path.join(tmp, 'prompts'), DEKKI_PROJECTS_DIR: path.join(tmp, 'none'), PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}` },
  stdio: 'ignore',
});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-browser-'));
const browser = spawn(BIN, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--window-size=1000,800', 'about:blank'], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 120; i++) {
    try { const t = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); const pg = t.find((x) => x.type === 'page'); if (pg) return pg.webSocketDebuggerUrl; if (t.length && i > 8) return (await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()).webSocketDebuggerUrl; } catch {}
    await sleep(250);
  }
  throw new Error('browser did not start');
}

try {
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/`); break; } catch { await sleep(250); } }
  const ws = new WebSocket(await target());
  await new Promise((r) => ws.on('open', r));
  let n = 0;
  const pending = new Map();
  ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) pending.get(d.id)(d); });
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(3000);
  const rowsText = await ev(`[...document.querySelectorAll('.row')].map((r)=>r.innerText.replace(/\\n+/g,' | ') + ' | ' + (r.querySelector('.mgr')?.title || ''))`); // the worker tally is in the manager line's tooltip
  console.log(rowsText.join('\n'));
  const has = (name, s) => ok(rowsText.some((t) => t.includes(name) && t.includes(s)), `${name}: ${s}`);
  has('fx-waiting', 'Waiting on 2 workers'); has('fx-waiting', '3 workers: 2 running, 1 done, 0 blocked');
  has('fx-stalled', 'Stalled: all 2 workers finished, nothing will wake it'); has('fx-stalled', '2 workers: 0 running, 1 done, 1 blocked');
  has('fx-running', '1 worker running');
  has('fx-working-itself', 'Working itself: all 6 workers finished'); has('fx-working-itself', '6 workers: 0 running, 5 done, 1 blocked');
  if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shotDir, 'manager-status.png'), Buffer.from(r.result.data, 'base64')); }
  ws.close();
} finally {
  browser.kill();
  deck.kill();
  fs.rmSync(profile, { recursive: true, force: true });
  if (!process.env.KEEP_TMP) fs.rmSync(tmp, { recursive: true, force: true });
}
