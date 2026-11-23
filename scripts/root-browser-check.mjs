// Headless Edge/Chrome check of the per-account working folder, against a THROWAWAY deck it starts itself:
//   node scripts/root-browser-check.mjs [screenshot-dir]
// Everything is temp: state file, folders, a fake second account (empty config dir), and a stub `claude` on PATH that
// only answers `claude agents --json` (one fake agent per account). No real account, agent or folder is touched.
// Checks: the setup wizard replaces the start form when the second account has no folder; walking it (folders, three Next,
// Create) creates the files from a fixture template (DEKKI_TEMPLATE); switching accounts switches the shown folder and the "Manager sessions" grouping.
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const shotDir = process.argv[2];
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4396;
const CDP = 9345;
const BIN = process.env.DECK_TEST_BROWSER || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-root-check-')));
const workRoot = path.join(tmp, 'workroot');
const persRoot = path.join(tmp, 'persroot');
const persCfg = path.join(tmp, 'cfg-personal');
const persDocs = path.join(tmp, 'pers-docs');
for (const d of [workRoot, persRoot, persCfg, persDocs, path.join(tmp, 'bin'), path.join(tmp, 'prompts')]) fs.mkdirSync(d);
// stub claude: default account -> agent aaaaaaaa started in workroot; CLAUDE_CONFIG_DIR set -> agent bbbbbbbb in persroot
fs.writeFileSync(path.join(tmp, 'bin', 'claude'), `#!/bin/bash
if [ "$1" = agents ]; then
  if [ -n "$CLAUDE_CONFIG_DIR" ]; then echo '[{"id":"bbbbbbbb","kind":"background","state":"idle","cwd":"${persRoot}","name":"dekki-throwaway-pers"}]';
  else echo '[{"id":"aaaaaaaa","kind":"background","state":"idle","cwd":"${workRoot}","name":"dekki-throwaway-work"}]'; fi
fi
`, { mode: 0o755 });
fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({ root: workRoot, accounts: [{ id: 'personal', label: 'Personal', configDir: persCfg }], activeAccount: 'default' }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };
const deck = spawn(process.execPath, ['server/start.js'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(PORT), DEKKI_STATE: path.join(tmp, 'state.json'), DEKKI_PROMPTS: path.join(tmp, 'prompts'), DEKKI_PROJECTS_DIR: path.join(tmp, 'none'), PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`, DEKKI_TEMPLATE: path.join(REPO, 'server/test/fixtures/setup-template') },
  stdio: 'ignore',
});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-browser-'));
const browser = spawn(BIN, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--window-size=1200,800', 'about:blank'], { stdio: 'ignore' });

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
  const shot = async (name) => { if (!shotDir) return; fs.mkdirSync(shotDir, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shotDir, name), Buffer.from(r.result.data, 'base64')); };
  const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
  const click = (expr) => ev(`(()=>{const b=${expr};if(b)b.click();return !!b})()`);
  // the fake agent has no activity, so it sits in the collapsed Older group: open it, then read the label
  const label = async () => { await ev(`(()=>{const h=document.querySelector('.group-head.clickable');if(h&&!document.querySelector('.row'))h.click();})()`); await sleep(300); return text('.row-label'); };
  const btn = (label) => `[...document.querySelectorAll('button,a')].find((x)=>x.innerText.trim().startsWith(${JSON.stringify(label)}))`;
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(2500);

  // default account: start form shows the work folder with a Change link; the agent is a manager session
  ok((await label()).includes('Manager sessions'), 'default: agent grouped as Manager sessions');
  await click(`document.querySelector('button[aria-label="New agent"]')`);
  await sleep(800);
  ok((await text('.dialog')).includes(workRoot) && (await text('.dialog')).includes('Change'), 'default: New agent shows the work folder + Change');
  await shot('1-default-new-agent.png');
  await click(`document.querySelector('.dialog button')`); // Cancel is the first button? fall back to Escape
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  await sleep(300);

  // switch to Personal (page reloads)
  await ev(`(()=>{const s=document.querySelector('select[aria-label="Claude account"]');s.value='personal';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(3500);
  ok((await ev(`document.querySelector('select[aria-label="Claude account"]').value`)) === 'personal', 'switched to Personal');
  ok(!(await label()).includes('Manager sessions'), 'personal without a folder: its agent is not a Manager session');
  await click(`document.querySelector('button[aria-label="New agent"]')`);
  await sleep(800);
  const d1 = await text('.dialog');
  ok(d1.includes('Set up (Personal)') && d1.includes('Working folder') && !d1.includes('Starts the manager'), 'personal: the setup wizard replaces the start form');
  await shot('2-personal-no-folder.png');

  // wizard: type both folders, Next x3, Create
  const typeIn = (n, v) => ev(`(()=>{const i=document.querySelectorAll('.dialog input[type=text]')[${n}];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(v)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await typeIn(0, persRoot);
  await typeIn(1, persDocs);
  await sleep(700);
  await click(btn('Next'));
  await sleep(800);
  await click(btn('Next'));
  await sleep(400);
  await click(btn('Next'));
  await sleep(800);
  await shot('3-personal-review.png');
  await click(btn('Create'));
  await sleep(2500);
  const d3 = await text('.dialog');
  ok(d3.includes('Created') && d3.includes('Manager playbook'), 'setup: created summary and health check shown');
  await shot('4-personal-setup-done.png');
  for (const f of ['CLAUDE.md', '.claude/scripts/delegate.sh', '.claude/harness.json', '.claude/harness.manifest.json']) ok(fs.existsSync(path.join(persRoot, f)), `file exists in personal folder: ${f}`);
  ok(!fs.existsSync(path.join(workRoot, 'CLAUDE.md')), 'work folder untouched by the personal setup');
  await click(btn('Done'));
  await sleep(800);
  ok((await text('.dialog')).includes(persRoot) && (await text('.dialog')).includes('Starts the manager'), 'after Close: start form now shows the personal folder');
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  await sleep(2500);
  ok((await label()).includes('Manager sessions'), 'personal: agent in its folder is now a Manager session');

  // back to default: work folder, work agent
  await ev(`(()=>{const s=document.querySelector('select[aria-label="Claude account"]');s.value='default';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(3500);
  await click(`document.querySelector('button[aria-label="New agent"]')`);
  await sleep(800);
  ok((await text('.dialog')).includes(workRoot) && !(await text('.dialog')).includes(persRoot), 'back on default: work folder shown again');
  ws.close();
} finally {
  browser.kill();
  deck.kill();
  fs.rmSync(profile, { recursive: true, force: true });
  if (!process.env.KEEP_TMP) fs.rmSync(tmp, { recursive: true, force: true });
}
