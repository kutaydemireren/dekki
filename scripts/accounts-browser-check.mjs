// Headless Edge/Chrome check of the account switcher, against THROWAWAY decks it starts itself:
//   node scripts/accounts-browser-check.mjs [screenshot-dir]
// Two temp decks with a stub `claude`: the default account has two agents, the second ("personal") has none.
// Expects: the two-account deck shows the switcher and switching changes the agent list; the one-account deck shows none.
// Nothing real is touched (temp state, temp config dir, no real agents). Browser: DECK_TEST_BROWSER.
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [shotDir] = process.argv.slice(2);
const p2 = 4390; // deck with two accounts
const p1 = 4389; // deck with one account
const CDP = 9344;
const BIN = process.env.DECK_TEST_BROWSER || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-accounts-check-')));
const root = path.join(tmp, 'root');
const cfg = path.join(tmp, 'cfg-personal');
for (const d of [root, cfg, path.join(tmp, 'bin'), path.join(tmp, 'prompts')]) fs.mkdirSync(d, { recursive: true });
const row = (id, name) => ({ id, kind: 'background', state: 'working', status: 'busy', cwd: root, name });
fs.writeFileSync(path.join(tmp, 'rows.json'), JSON.stringify([row('aaaa1111', 'fx-one'), row('bbbb2222', 'fx-two')]));
// The stub answers only `claude agents`: agents for the default account, none when CLAUDE_CONFIG_DIR is the second account's.
fs.writeFileSync(path.join(tmp, 'bin', 'claude'), `#!/bin/bash\nif [ "$1" = agents ]; then\n  if [ "$CLAUDE_CONFIG_DIR" = "${cfg}" ]; then echo '[]'; else cat ${path.join(tmp, 'rows.json')}; fi\nfi\n`, { mode: 0o755 });
const stateOne = path.join(tmp, 'state-one.json');
const stateTwo = path.join(tmp, 'state-two.json');
fs.writeFileSync(stateOne, JSON.stringify({ root, accounts: [], activeAccount: 'default' }));
fs.writeFileSync(stateTwo, JSON.stringify({ root, accounts: [{ id: 'personal', label: 'Personal', configDir: cfg }], activeAccount: 'default' }));

const decks = [[p1, stateOne], [p2, stateTwo]].map(([port, state]) => spawn(process.execPath, ['server/start.js'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(port), DEKKI_STATE: state, DEKKI_PROMPTS: path.join(tmp, 'prompts'), DEKKI_PROJECTS_DIR: path.join(tmp, 'none'), DEKKI_NOTIFY: '0', PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}` },
  stdio: 'ignore',
}));
const profile = path.join(tmp, 'profile');
const browser = spawn(BIN, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--window-size=1200,800', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };

async function target() {
  for (let i = 0; i < 120; i++) {
    try { const t = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); const pg = t.find((x) => x.type === 'page'); if (pg) return pg.webSocketDebuggerUrl; if (t.length && i > 8) return (await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()).webSocketDebuggerUrl; } catch {}
    await sleep(250);
  }
  throw new Error('browser did not start');
}

try {
  for (const port of [p1, p2]) for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port}/`); break; } catch { await sleep(250); } }
  const ws = new WebSocket(await target());
  await new Promise((r) => ws.on('open', r));
  let n = 0;
  const pending = new Map();
  ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) pending.get(d.id)(d); });
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const goto = async (url) => { await cdp('Page.navigate', { url }); await sleep(2500); };
  const shot = async (name) => { if (!shotDir) return; fs.mkdirSync(shotDir, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shotDir, name), Buffer.from(r.result.data, 'base64')); };
  await cdp('Page.enable');
  const rows = () => ev(`document.querySelectorAll('.row').length`);

  await goto(`http://127.0.0.1:${p1}/`);
  ok((await ev(`document.querySelectorAll('select[aria-label="Claude account"]').length`)) === 0, 'one account: no switcher');
  await shot('one-account.png');

  await goto(`http://127.0.0.1:${p2}/`);
  ok((await ev(`document.querySelectorAll('select[aria-label="Claude account"]').length`)) === 1, 'two accounts: switcher shown');
  const before = await rows();
  console.log('rows under default:', before);
  await shot('two-accounts-default.png');
  await ev(`(()=>{const s=document.querySelector('select[aria-label="Claude account"]');s.value='personal';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(3500);
  ok((await ev(`document.querySelector('select[aria-label="Claude account"]').value`)) === 'personal', 'after switch: personal selected (page reloaded)');
  const after = await rows();
  console.log('rows under personal:', after);
  ok(before > 0 && after === 0, 'switching changed the agent list');
  await shot('two-accounts-personal.png');
  ws.close();
} finally {
  browser.kill();
  for (const d of decks) d.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
