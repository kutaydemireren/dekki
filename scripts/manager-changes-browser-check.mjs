// Headless Edge/Chrome check of the manager's Changes tab, against a THROWAWAY demo deck it starts itself (DEKKI_DEMO=1:
// fictional agents, temp state; no real agent is read or touched):
//   node scripts/manager-changes-browser-check.mjs [screenshot-dir]
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const shotDir = process.argv[2];
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4396;
const CDP = 9347;
const BIN = process.env.DECK_TEST_BROWSER || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mgrchg-check-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };
const deck = spawn(process.execPath, ['server/start.js'], { cwd: REPO, env: { ...process.env, DEKKI_DEMO: '1', PORT: String(PORT), DEKKI_STATE: path.join(tmp, 'state.json') }, stdio: 'ignore' });
const browser = spawn(BIN, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(tmp, 'profile')}`, '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 120; i++) {
    try { const t = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); const pg = t.find((x) => x.type === 'page'); if (pg) return pg.webSocketDebuggerUrl; if (t.length && i > 8) return (await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()).webSocketDebuggerUrl; } catch {}
    await sleep(250);
  }
  throw new Error('browser did not start');
}

try {
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/`); break; } catch { await sleep(250); } }
  const ws = new WebSocket(await target());
  await new Promise((r) => ws.on('open', r));
  let n = 0;
  const pending = new Map();
  ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) pending.get(d.id)(d); });
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  // the hash only carries History, so select the row in the sidebar and click the tab
  const go = async (name, tab) => {
    await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }); await sleep(2500);
    await ev(`[...document.querySelectorAll('.row')].find((e) => e.textContent.includes(${JSON.stringify(name)}))?.click()`); await sleep(600);
    await ev(`[...document.querySelectorAll('.main-head [role=tab]')].find((b) => b.textContent.startsWith(${JSON.stringify(tab)}))?.click()`); await sleep(1500);
  };
  const tabs = () => ev(`[...document.querySelectorAll('.main-head [role=tab]')].map((b) => b.textContent.trim())`);
  const shot = async (name) => { if (!shotDir) return; fs.mkdirSync(shotDir, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shotDir, name), Buffer.from(r.result.data, 'base64')); console.log(`shot ${path.join(shotDir, name)}`); };

  // manager ship-checkout-v2 (a1b2c3d4): tab shown, grouped by worker
  await go('ship-checkout-v2', 'Changes');
  ok((await tabs()).some((t) => t.startsWith('Changes')), 'manager shows the Changes tab');
  const names = await ev(`[...document.querySelectorAll('.ch-gname')].map((e) => e.textContent)`);
  ok(JSON.stringify(names) === JSON.stringify(['checkout-api', 'checkout-web']), `groups: ${JSON.stringify(names)}`);
  ok(await ev(`document.querySelectorAll('.ch-glist .ch-fi').length`) === 5, '5 files listed under the 2 workers');
  ok(await ev(`document.querySelector('.main-head .seg-n') === null`), 'no badge or totals on the manager header');
  await shot('manager-changes.png');

  // click a worker: opens that worker's own Changes tab (per-file cards)
  await ev(`document.querySelector('.ch-ghead').click()`);
  await sleep(1500);
  ok(await ev(`location.hash.startsWith('#b1000001')`), 'worker click selects checkout-api');
  ok(await ev(`document.querySelectorAll('.ch-card').length`) === 3, "worker's own Changes tab shows its 3 file cards");
  await shot('worker-changes.png');

  // manager whose workers changed nothing: new empty state (weekly-triage a6b7c8d9)
  await go('weekly-triage', 'Changes');
  ok((await tabs()).some((t) => t.startsWith('Changes')), 'manager without changes still shows the tab');
  ok((await ev(`document.querySelector('.ch-empty-t')?.textContent`)) === "Workers haven't changed anything yet", 'manager empty state');
  await shot('manager-empty.png');

  // (hidden tab for a session with neither: covered by the unit test hasChangesTab; the demo has no such agent)

  // a worker with a worktree and no changes: tab visible, old empty state
  await go('release-notes-draft', 'Changes');
  ok((await tabs()).some((t) => t.startsWith('Changes')), 'worktree session shows the tab');
  ok((await ev(`document.querySelector('.ch-empty-t')?.textContent`)) === 'Nothing changed yet', 'non-manager empty state unchanged');
  ws.close();
} finally {
  browser.kill();
  deck.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
