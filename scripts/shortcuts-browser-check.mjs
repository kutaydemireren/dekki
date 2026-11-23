// Headless Edge/Chrome check of Cmd/Ctrl+B, Cmd/Ctrl+Shift+S and Cmd/Ctrl+Shift+P, against a THROWAWAY demo-mode deck it starts itself:
//   node scripts/shortcuts-browser-check.mjs
// Demo mode (fake agents), temp state file and prompts folder, own port. No real agent is read or touched.
// Checks: each shortcut toggles its sidebar button (aria-pressed), skills and prompts exclude each other, the shortcuts
// work while a text field has focus, and do nothing while a dialog is open.
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4394;
const CDP = 9347;
const BIN = process.env.DECK_TEST_BROWSER || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-shortcuts-')));
fs.mkdirSync(path.join(tmp, 'prompts'));
fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({ accounts: [], activeAccount: 'default' }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };
const deck = spawn(process.execPath, ['server/start.js'], {
  cwd: REPO,
  env: { ...process.env, DEKKI_DEMO: '1', PORT: String(PORT), DEKKI_STATE: path.join(tmp, 'state.json'), DEKKI_PROMPTS: path.join(tmp, 'prompts'), DEKKI_PROJECTS_DIR: path.join(tmp, 'none'), DEKKI_NOTIFY: '0' },
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
  const MOD = process.platform === 'darwin' ? 4 : 2; // CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8
  const press = async (key, shift = false) => {
    const base = { modifiers: MOD | (shift ? 8 : 0), key: shift ? key.toUpperCase() : key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) };
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(300);
  };
  const pressed = (label) => ev(`document.querySelector('.sb-foot button[aria-label^="${label}"]')?.getAttribute('aria-pressed')`);
  const state = async () => [await pressed('Folder tree'), await pressed('Skill usage'), await pressed('Saved prompts')].join(',');
  const expect = async (want, msg) => { const got = await state(); ok(got === want, `${msg} (${got})`); };
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(3000);
  await expect('false,false,false', 'start: all panels hidden');
  await press('b'); await expect('true,false,false', 'Mod+B shows the folder tree');
  await press('b'); await expect('false,false,false', 'Mod+B hides it');
  await press('s', true); await expect('false,true,false', 'Mod+Shift+S shows skill usage');
  await press('p', true); await expect('false,false,true', 'Mod+Shift+P swaps to saved prompts');
  await press('p', true); await expect('false,false,false', 'Mod+Shift+P hides them');
  await press('s', false); await expect('false,false,false', 'Mod+S without Shift does nothing');
  await ev(`(() => { const i = document.createElement('input'); i.id = 'tmp-input'; document.body.appendChild(i); i.focus(); })()`);
  await press('b'); await expect('true,false,false', 'Mod+B works with a text field focused');
  await ev(`document.getElementById('tmp-input').remove()`);
  await ev(`document.activeElement?.blur?.()`);
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true }))`); // opens the shortcut sheet
  await sleep(300);
  ok(await ev(`!!document.querySelector('.sheet')`), 'shortcut sheet opened');
  ok(await ev(`/folder tree/i.test(document.querySelector('.sheet')?.innerText || '')`), 'sheet lists the folder tree shortcut');
  await press('s', true); await expect('true,false,false', 'Mod+Shift+S ignored while a dialog is open');
  ws.close();
} finally {
  browser.kill();
  deck.kill();
  fs.rmSync(profile, { recursive: true, force: true });
  if (!process.env.KEEP_TMP) fs.rmSync(tmp, { recursive: true, force: true });
}
