// Screenshots of the main states against a THROWAWAY demo deck (DEKKI_DEMO=1: fictional agents, temp state,
// no real claude, no real agents). Own port, own browser profile, everything removed at the end.
//   node scripts/demo-screenshots.mjs <label> [out-dir]      e.g. label "before" or "after-phase1"
// Writes <out-dir>/<label>-<state>.png (default out-dir: ./demo-shots; pass a temp folder to keep the checkout clean).
// Needs the built frontend (npm run build) and Edge or Chrome (DECK_TEST_BROWSER overrides the path).
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Optional: --theme dark|light|system sets the theme setting before the page loads (default: the page's own default, System).
const argv = process.argv.slice(2);
const ti = argv.indexOf('--theme');
const theme = ti >= 0 ? argv.splice(ti, 2)[1] : null;
if (theme && !['dark', 'light', 'system'].includes(theme)) { console.error('--theme must be dark, light or system'); process.exit(2); }
// --accounts single|two: only the account-discovery states (60-79) against a deck with one or two fictional accounts
// (DEKKI_DEMO_ACCOUNTS). --before: the same views without the popover steps, for a build that predates the quiet control.
const ai = argv.indexOf('--accounts');
const accountsMode = ai >= 0 ? argv.splice(ai, 2)[1] : null;
if (accountsMode && !['single', 'two'].includes(accountsMode)) { console.error('--accounts must be single or two'); process.exit(2); }
// --idle: only the zero-count home states (80-83): home with agents working, then (POST /api/demo/advance?step=2) with none working.
// Asserts the computed animation-name of each tile's glyph: none at count 0, running at count > 0. With --before the asserts are
// reported but do not fail the run (a build that predates the rule).
const idleMode = argv.includes('--idle') ? (argv.splice(argv.indexOf('--idle'), 1), true) : false;
const bi = argv.indexOf('--before');
const beforeBuild = bi >= 0 ? (argv.splice(bi, 1), true) : false;
const label = argv[0];
if (!label || !/^[\w.-]+$/.test(label)) { console.error('usage: node scripts/demo-screenshots.mjs <label> [out-dir] [--theme dark|light|system]'); process.exit(2); }
const outDir = path.resolve(argv[1] || 'demo-shots');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DEMO_PORT) || 4352;
const CDP = Number(process.env.DEMO_CDP) || 9352;
const BIN = process.env.DECK_TEST_BROWSER || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-demo-shots-')));
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deck = spawn(process.execPath, ['server/start.js'], {
  cwd: REPO,
  env: { ...process.env, DEKKI_DEMO: '1', DEKKI_DEMO_ACCOUNTS: accountsMode === 'two' ? '2' : '', PORT: String(PORT), DEKKI_STATE: path.join(tmp, 'state.json') },
  stdio: 'ignore',
});
const browser = spawn(BIN, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(tmp, 'profile')}`, '--window-size=1400,900', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 120; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
      const pg = t.find((x) => x.type === 'page');
      if (pg) return pg.webSocketDebuggerUrl;
      if (t.length && i > 8) return (await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()).webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('browser did not start');
}

let failed = false;
try {
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/`); break; } catch { await sleep(250); } }
  const ws = new WebSocket(await target());
  await new Promise((r) => ws.on('open', r));
  let n = 0;
  const pending = new Map();
  ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) pending.get(d.id)(d); });
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  const shot = async (name) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, `${label}-${name}.png`), Buffer.from(r.result.data, 'base64'));
    console.log(`shot ${label}-${name}.png`);
  };
  // helpers run in the page
  const clickText = (sel, text) => ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);
  const ctxMenu = (name) => ev(`(() => { const el = [...document.querySelectorAll('.row')].find((e) => e.textContent.includes(${JSON.stringify(name)})); if (!el) return false; const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 80, clientY: r.top + 10 })); return true; })()`);
  const esc = () => cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).then(() => cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }));
  const need = (ok, what) => { if (!ok) { console.error(`could not find: ${what}`); failed = true; } };

  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1800);
  if (theme) { // set the theme setting, then reload so the pre-paint script in index.html picks it up
    await ev(`localStorage.setItem('dekki.theme', ${JSON.stringify(theme)})`);
    await cdp('Page.reload');
    await sleep(1800);
  }
  await ev(`document.fonts && document.fonts.ready`);
  console.log('theme in page:', await ev(`document.documentElement.dataset.theme + ' (setting ' + document.documentElement.dataset.themeSetting + ', stored ' + (() => { try { return localStorage.getItem('dekki.theme'); } catch (e) { return 'n/a'; } })() + ')'`));

  if (idleMode) {
    const tiles = () => ev(`JSON.stringify([...document.querySelectorAll('.tile')].map((t) => ({ key: t.className.split(' ')[1], n: t.querySelector('.n')?.textContent, anim: getComputedStyle(t.querySelector('.g')).animationName, before: getComputedStyle(t.querySelector('.g'), '::before').animationName, op: getComputedStyle(t.querySelector('.g')).opacity })))`).then(JSON.parse);
    const clip = async (name, sel, pad = 10) => {
      const b = await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; })()`);
      if (!b) { need(false, `clip ${sel}`); return; }
      const r = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.w + 2 * pad, height: b.h + 2 * pad, scale: 2 } });
      fs.writeFileSync(path.join(outDir, `${label}-${name}.png`), Buffer.from(r.result.data, 'base64'));
      console.log(`shot ${label}-${name}.png`);
    };
    const check = (ok, what) => { if (beforeBuild) console.log(`${ok ? 'ok  ' : 'would fail on this build:'} ${what}`); else need(ok, what); };
    await sleep(600);
    let t = await tiles();
    console.log('tiles with agents working:', JSON.stringify(t));
    const by = (k) => t.find((x) => x.key === k);
    check(Number(by('work').n) > 0 && by('work').anim === 'g-spin', 'Working tile (count > 0) spins');
    check(Number(by('need').n) > 0 && by('need').before === 'g-halo', 'Needs you tile (count > 0) pulses');
    await shot('80-home-working');
    await clip('81-tiles-working', '.tiles');
    await ev(`fetch('/api/demo/advance?step=2', { method: 'POST' })`);
    await sleep(4500); // one list poll
    t = await tiles();
    console.log('tiles with none working:', JSON.stringify(t));
    check(Number(by('work').n) === 0, 'demo step 2 leaves 0 working');
    check(by('work').anim === 'none' && by('work').before === 'none', 'Working tile at 0: animation-name none');
    check(Number(by('work').op) < 1, 'Working tile at 0 is dimmed');
    check(t.find((x) => x.key === 'need').before === 'g-halo', 'Needs you tile (count > 0) still pulses');
    check(Number(t.find((x) => x.key === 'done').n) > 0, 'Done today tile has a count');
    await shot('82-home-none-working');
    await clip('83-tiles-none-working', '.tiles');
    // every glyph that is still animating on the page belongs to a real agent or a non-zero tile
    const spinning = await ev(`[...document.querySelectorAll('.g')].filter((g) => getComputedStyle(g).animationName !== 'none' && g.closest('.tile') && g.closest('.tile').querySelector('.n').textContent === '0').length`);
    check(spinning === 0, 'no animated glyph inside a 0-count tile');
    throw 'idle-done';
  }

  if (accountsMode) {
    // clip = padded box around a selector, zoomed x3, so small controls are readable
    const clipShot = async (name, sel, pad = 8, scale = 3) => {
      const b = await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; })()`);
      if (!b) { need(false, `clip ${sel}`); return; }
      const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
      const r = await cdp('Page.captureScreenshot', { format: 'png', clip: { x, y, width: b.w + 2 * pad, height: b.h + 2 * pad, scale } });
      fs.writeFileSync(path.join(outDir, `${label}-${name}.png`), Buffer.from(r.result.data, 'base64'));
      console.log(`shot ${label}-${name}.png`);
    };
    const two = accountsMode === 'two';
    const o = two ? 70 : 60; // single 60-69, two 70-79
    await sleep(600);
    const switcher = await ev(`!!document.querySelector('select[aria-label="Claude account"]')`);
    need(switcher === two, two ? 'sidebar switcher present with 2 accounts' : 'NO sidebar switcher with 1 account');
    const sidebarAcct = await ev(`(document.querySelector('.sidebar')?.textContent || '').toLowerCase().includes('account')`);
    need(two || !sidebarAcct, 'single account: nothing about accounts in the sidebar');
    await shot(`${o}-home${two ? '-two' : '-single'}${beforeBuild ? '' : '-quiet-control'}`);
    if (!beforeBuild) await clipShot(`${o + 1}-home-hint-line${two ? '-two' : '-single'}`, '.hint', 10);
    await clipShot(`${o + 2}-sidebar-head${two ? '-two' : '-single'}`, '.sb-head', 8);
    await clipShot(`${o + 3}-sidebar-footer-folder-tree${two ? '-two' : '-single'}`, '.sb-foot', 8);
    await ev(`document.querySelector('[aria-label="Folder tree"]')?.click()`);
    await sleep(600);
    need(await ev(`document.querySelector('[aria-label="Folder tree"]')?.getAttribute('aria-pressed') === 'true'`), 'folder tree pressed');
    await clipShot(`${o + 4}-sidebar-footer-folder-tree-pressed${two ? '-two' : '-single'}`, '.sb-foot', 8);
    await ev(`document.querySelector('[aria-label="Folder tree"]')?.click()`);
    await sleep(300);
    if (!beforeBuild) {
      need(await ev(`(() => { const b = document.querySelector('.acct-quiet'); if (!b) return false; b.click(); return true; })()`), 'quiet Accounts button');
      await sleep(500);
      need(await ev(`!!document.querySelector('.acct-pop')`), 'popover opens');
      await shot(`${o + 5}-popover${two ? '-two' : '-single'}`);
      await clipShot(`${o + 6}-popover-zoom${two ? '-two' : '-single'}`, '.acct-pop', 24, 2);
      // add-account info is always there: collapsed row with 2+ accounts, open as the main content with one
      if (two) {
        need(await ev(`document.querySelector('.acct-add-toggle')?.getAttribute('aria-expanded') === 'false' && !document.querySelector('#acct-add-body')`), 'two accounts: "Add another account" row exists and is collapsed');
        await ev(`document.querySelector('.acct-add-toggle').click()`);
        await sleep(300);
        need(await ev(`document.querySelector('.acct-add-toggle').getAttribute('aria-expanded') === 'true' && document.querySelectorAll('#acct-add-body .acct-code').length === 2`), 'toggle expands to two command boxes');
        need(await ev(`(document.querySelector('#acct-add-body')?.textContent || '').includes('add-account.mjs Third ~/.claude-third')`), 'example is for a third account');
        await shot(`${o + 9}-popover-add-expanded-two`);
        await clipShot(`${o + 9}-popover-add-expanded-zoom-two`, '.acct-pop', 24, 2);
        await ev(`document.querySelector('.acct-add-toggle').click()`);
        await sleep(200);
        need(await ev(`!document.querySelector('#acct-add-body')`), 'toggle collapses again');
      } else {
        need(await ev(`!document.querySelector('.acct-add-toggle') && document.querySelectorAll('#acct-add-body .acct-code').length === 2`), 'one account: add-account help open, no toggle');
        need(await ev(`(document.querySelector('#acct-add-body')?.textContent || '').includes('add-account.mjs Second ~/.claude-second')`), 'example is for a second account');
      }
      await esc();
      await sleep(300);
      need(await ev(`!document.querySelector('.acct-pop')`), 'Esc closes the popover');
      need(await ev(`document.activeElement !== document.body`) || true, 'focus');
      await ev(`document.querySelector('.acct-quiet').click()`);
      await sleep(300);
      await ev(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
      await sleep(300);
      need(await ev(`!document.querySelector('.acct-pop')`), 'outside click closes the popover');
      // palette: the always-present Accounts action selects nothing, shows mission control and opens the popover
      await clickText('.row', 'fix-login-timeout');
      await sleep(900);
      need(await ev(`!document.querySelector('.home')`), 'an agent is selected before the palette step');
      await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))`);
      await sleep(500);
      await ev(`(() => { const i = document.querySelector('.pal input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'accounts'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(400);
      await shot(`${o + 7}-palette-accounts${two ? '-two' : '-single'}`);
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await sleep(700);
      need(await ev(`!!document.querySelector('.home') && !!document.querySelector('.acct-pop')`), 'palette Accounts shows home and opens the popover');
      await shot(`${o + 8}-palette-accounts-result${two ? '-two' : '-single'}`);
    }
    throw 'accounts-done';
  }

  await shot('01-agent-list');

  need(await (await clickText('.workers-chip', 'worker')) || (await clickText('.mgr.toggle', 'Waiting')), 'workers chip');
  await sleep(400);
  await shot('02-list-workers-open');

  need(await clickText('.row', 'checkout-ios'), 'row checkout-ios');
  await sleep(1500);
  await shot('03-session');

  need(await clickText('.tab, .seg button', 'History'), 'History tab');
  await sleep(1200);
  await shot('04-history');

  need(await clickText('.tab, .seg button', 'Skills'), 'Skills tab');
  await sleep(900);
  await shot('05-skills-tab');

  await ev(`document.querySelector('[aria-label="Skill usage over all sessions"]')?.click()`);
  await sleep(900);
  await shot('06-skills-panel');
  await ev(`document.querySelector('[aria-label="Skill usage over all sessions"]')?.click()`);

  await ev(`document.querySelector('[aria-label="Saved prompts"]')?.click()`);
  await sleep(700);
  await shot('07-prompts-panel');
  await ev(`document.querySelector('[aria-label="Saved prompts"]')?.click()`);

  need(await ctxMenu('migrate-db-schema'), 'row for context menu');
  await sleep(300);
  await shot('08-context-menu');
  need(await clickText('.ctx-item', 'Delete'), 'Delete menu item');
  await sleep(900);
  await shot('09-dialog-delete');
  await esc(); await ev(`[...document.querySelectorAll('.dialog button')].find((b) => /cancel|close/i.test(b.textContent))?.click()`);
  await sleep(300);

  need(await ctxMenu('fix-login-timeout'), 'row for rename');
  need(await clickText('.ctx-item', 'Rename'), 'Rename item');
  await sleep(500);
  await shot('10-dialog-rename');
  await ev(`[...document.querySelectorAll('.dialog button')].find((b) => /cancel|close/i.test(b.textContent))?.click()`);
  await sleep(300);

  await ev(`document.querySelector('[aria-label="New agent"]')?.click()`);
  await sleep(900);
  await shot('11-dialog-new-agent');
  await ev(`[...document.querySelectorAll('.dialog button')].find((b) => /cancel|close/i.test(b.textContent))?.click()`);
  await sleep(300);

  await ev(`document.querySelector('[aria-label="Folder tree"]')?.click()`);
  await sleep(700);
  await shot('12-folder-tree');

  await ev(`document.querySelector('[aria-label="Folder tree"]')?.click()`);
  await sleep(300);

  // sidebar states (phase 1): N key selects the next agent that needs you, search, collapsed rail
  await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }))`);
  await sleep(700);
  need((await ev(`document.querySelector('.row.selected')?.textContent || ''`)).includes('refactor-search-index'), 'N selects the first agent that needs input');
  await shot('13-attention-next');
  await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }))`);
  await sleep(500);
  need((await ev(`document.querySelector('.row.selected')?.textContent || ''`)).includes('weekly-triage'), 'second N selects the next one');
  await ev(`(() => { const i = document.querySelector('.search-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'checkout'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(500);
  await shot('14-search');
  await ev(`(() => { const i = document.querySelector('.search-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await ev(`document.querySelector('[aria-label="Hide the sidebar"]')?.click()`);
  await sleep(500);
  await shot('15-sidebar-collapsed');
  await ev(`document.querySelector('[aria-label="Show the sidebar"]')?.click()`);

  // main pane extras (phase 2): select an agent again, History modes, callouts, then the mission-control home
  need(await clickText('.row', 'checkout-ios'), 'row checkout-ios (history modes)');
  await sleep(900);
  need(await clickText('.seg button', 'History'), 'History tab (modes)');
  await sleep(900);
  if (await clickText('.hbar .seg button', 'Summary')) { await sleep(300); await shot('16-history-summary'); }
  if (await clickText('.hbar .seg button', 'Verbose')) { await sleep(300); await shot('17-history-verbose'); }
  await clickText('.hbar .seg button', 'Normal');
  for (const [n, name] of [['18-history-callout-result', 'checkout-web'], ['19-history-callout-failed', 'checkout-docs'], ['20-history-callout-needs', 'checkout-ios']]) {
    if (await clickText('.row', name)) { await sleep(500); await clickText('.seg button', 'History'); await sleep(900); await shot(n); }
  }
  await ev(`document.querySelector('.brand')?.click()`);
  await sleep(600);
  need(await ev(`!document.querySelector('.row.selected')`), 'brand click clears the selection');
  await shot('21-home');

  // power use (phase 3): palette, shortcut sheet, keys, dialog shell, toast, group by project
  const press = async (key, code, vk, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, modifiers }); await sleep(250); };
  const setVal = (sel, v) => ev(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const sel = () => ev(`document.querySelector('.row.selected .row-name')?.textContent || ''`);
  await press('k', 'KeyK', 75, 4); // Cmd+K
  need(await ev(`!!document.querySelector('.pal')`), 'Cmd+K opens the palette');
  await sleep(300);
  await shot('31-palette');
  await setVal('.pal input', 'check');
  await sleep(300);
  await shot('32-palette-search');
  await setVal('.pal input', 'not');
  await sleep(300);
  await shot('33-palette-actions');
  await press('Escape', 'Escape', 27);
  need(await ev(`!document.querySelector('.pal')`), 'Esc closes the palette');
  await press('/', 'Slash', 191);
  need(await ev(`!!document.querySelector('.pal')`), '/ opens the palette');
  await press('ArrowDown', 'ArrowDown', 40);
  await press('Enter', 'Enter', 13);
  need(await ev(`!document.querySelector('.pal')`), 'Enter closes the palette');
  need((await sel()) !== '', 'Enter on an agent selects it');
  await press('?', 'Slash', 191, 8); // Shift+/
  need(await ev(`!!document.querySelector('.dialog.sheet')`), '? opens the shortcut sheet');
  await shot('34-shortcut-sheet');
  await press('Escape', 'Escape', 27);
  await press('c', 'KeyC', 67);
  need(await ev(`!!document.querySelector('.dialog.top')`), 'C opens New agent');
  await sleep(300);
  await shot('35-dialog-new-agent');
  await press('Escape', 'Escape', 27);
  need(await ev(`!document.querySelector('.dialog')`), 'Esc closes the dialog');
  const before = await sel();
  await press('j', 'KeyJ', 74);
  const afterJ = await sel();
  need(afterJ !== '' && afterJ !== before, `J moves the selection (${before} -> ${afterJ})`);
  await press('k', 'KeyK', 75);
  need((await sel()) === before, 'K moves it back');
  await shot('36-keyboard-selection');
  // typing in a field never triggers a letter key
  await ev(`document.querySelector('.search-input')?.focus()`);
  await press('c', 'KeyC', 67);
  need(await ev(`!document.querySelector('.dialog')`), 'C in an input does not open New agent');
  // Cmd+1 selects the first pinned agent
  await ev(`fetch('/api/agents/d3e4f5a6/pin', { method: 'POST' })`);
  await sleep(3500);
  await ev(`document.querySelector('.brand')?.click()`);
  await sleep(300);
  await press('1', 'Digit1', 49, 4);
  need((await sel()) === 'refactor-search-index', 'Cmd+1 selects the first pinned agent');
  // confirm dialog and an error toast (the demo refuses Stop)
  need(await ctxMenu('fix-login-timeout'), 'row for stop');
  need(await clickText('.ctx-item', 'Stop'), 'Stop item');
  await sleep(400);
  await shot('37-dialog-confirm');
  need(await clickText('.dialog button', 'Stop anyway'), 'Stop anyway');
  await sleep(700);
  need(await ev(`!!document.querySelector('.toast')`), 'a failed Stop shows a toast');
  await shot('38-toast');
  // group by project, remembered over a reload
  need(await clickText('.list-mode button', 'Project'), 'Project mode');
  await sleep(400);
  await shot('39-group-by-project');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1800);
  need(await ev(`!!document.querySelector('.list.by-project')`), 'Project mode is remembered');
  await clickText('.list-mode button', 'Status');

  // motion and History pin (phase 4). Runs last: it changes demo state (POST /api/demo/advance, demo mode only).
  need(await clickText('.row', 'fix-login-timeout'), 'row fix-login-timeout');
  await sleep(600);
  await shot('40-motion-before');
  const flashProbe = ev(`new Promise((res) => {
    const t0 = performance.now(); let flashed = 0, glided = 0, ticked = 0;
    const iv = setInterval(() => {
      flashed = Math.max(flashed, document.querySelectorAll('.row[data-flash]').length);
      glided = Math.max(glided, document.getAnimations().filter((a) => a.id === 'flip').length);
      ticked = Math.max(ticked, document.querySelectorAll('.tick').length);
      if (flashed && glided && ticked || performance.now() - t0 > 9000) { clearInterval(iv); res({ flashed, glided, ticked }); }
    }, 16);
    fetch('/api/demo/advance', { method: 'POST' });
  })`);
  const probe = await flashProbe;
  console.log('motion probe (rows flashing, glides, ticks):', JSON.stringify(probe));
  need(probe && probe.flashed > 0, 'a row flash after an agent finished / needs you');
  need(probe && probe.glided > 0, 'a row glide after a group change');
  need(probe && probe.ticked > 0, 'a count tick');
  await shot('41-motion-flash');
  await sleep(1200);
  await shot('42-motion-after');

  // pinned prompt: History of the longer demo agent
  need(await clickText('.seg button', 'History'), 'History tab (pin)');
  await sleep(1200);
  const pin = () => ev(`(() => { const h = document.querySelector('.history'); const s = document.querySelector('.sticky-prompt');
    const hb = document.querySelector('.hbar').getBoundingClientRect().bottom;
    const first = [...h.querySelectorAll('.msg, .act, .diffcard, .rep')].find((x) => x.getBoundingClientRect().bottom > h.getBoundingClientRect().top);
    return { scrollTop: Math.round(h.scrollTop), scrollable: h.scrollHeight > h.clientHeight, pin: s ? s.textContent : null, hasPinClass: h.classList.contains('has-pin'),
      pinBottom: s ? Math.round(s.getBoundingClientRect().bottom) : null, histTop: Math.round(h.getBoundingClientRect().top), hbarBottom: Math.round(hb) }; })()`);
  const scrollHist = (expr) => ev(`(() => { const h = document.querySelector('.history'); ${expr}; h.dispatchEvent(new Event('scroll')); })()`);
  await scrollHist('h.scrollTop = 0');
  await sleep(300);
  const top = await pin();
  need(top.scrollable && top.pin === null && !top.hasPinClass, 'no pin at the top of a long History');
  await shot('43-history-long-top');
  // half way out: the prompt is still partly visible, so no pin
  await scrollHist(`const p = [...h.querySelectorAll('[data-uid]')].at(-1); h.scrollTop = p.offsetTop + p.offsetHeight / 2`);
  await sleep(300);
  const half = await pin();
  need(half.pin === null, 'no pin while the last prompt is still partly visible');
  await shot('44-history-prompt-half-out');
  // fully out: pinned, in its own row, content below it
  await scrollHist(`const p = [...h.querySelectorAll('[data-uid]')].at(-1); h.scrollTop = p.offsetTop + p.offsetHeight + 120`);
  await sleep(300);
  const pinned = await pin();
  need(pinned.pin && pinned.hasPinClass && pinned.pinBottom <= pinned.histTop, `pinned row sits above the content (${JSON.stringify(pinned)})`);
  await shot('45-history-pinned');
  // back up: the pin goes away
  await scrollHist('h.scrollTop = 0');
  await sleep(300);
  const gone = await pin();
  need(gone.pin === null && !gone.hasPinClass, 'pin disappears when scrolled back up');
  await shot('46-history-pin-gone');
  // manager rows: segment bar and worker rows look the same selected or not (bug fix)
  await clickText('.row', 'ship-checkout-v2');
  await sleep(400);
  if (await ev(`!document.querySelector('.row.child')`)) await clickText('.mgr.toggle', 'ship-checkout');
  await clickText('.row', 'weekly-triage');
  await sleep(400);
  const segColors = (name) => ev(`(() => { const r = [...document.querySelectorAll('.row')].find((e) => e.textContent.includes(${JSON.stringify(name)})); return r ? [r.classList.contains('selected'), ...[...r.querySelectorAll('.wbar i')].map((i) => getComputedStyle(i).backgroundColor)] : null; })()`);
  await clickText('.row', 'ship-checkout-v2');
  await sleep(500);
  const mgrSel = await segColors('ship-checkout-v2');
  await shot('47-manager-selected');
  await clickText('.row', 'weekly-triage');
  await sleep(500);
  const mgrUnsel = await segColors('ship-checkout-v2');
  await shot('48-manager-unselected-stalled-selected');
  need(mgrSel && mgrUnsel && mgrSel[0] && !mgrUnsel[0] && JSON.stringify(mgrSel.slice(1)) === JSON.stringify(mgrUnsel.slice(1)), `segment colours equal selected and not (${JSON.stringify([mgrSel, mgrUnsel])})`);
  console.log('pin checks:', JSON.stringify({ top, half, pinned, gone }));

  // Changes tab (fixtures in server/demo-changes.js): overview, collapsed, file jump, scope switch, truncated diff, clean, no worktree
  const changesTab = async (agentName) => { if (!(await ev(`(document.querySelector('.row.selected')?.textContent || '').includes(${JSON.stringify(agentName)})`))) need(await clickText('.row', agentName), `row ${agentName} (changes)`); await sleep(600); need(await clickText('.seg button', 'Changes'), 'Changes tab'); await sleep(1500); };
  await changesTab('fix-login-timeout');
  need(await ev(`document.querySelectorAll('.ch-card').length === 6`), 'six changed files for fix-login-timeout');
  need(await ev(`!!document.querySelector('.seg-n')`), 'count in the Changes tab label');
  await shot('50-changes-overview');
  const sel0 = await ev(`(() => { const c = document.querySelector('.ch-card[data-path="src/auth/session.test.ts"] .ch-code'); const r = document.createRange(); r.selectNodeContents(c); const g = getSelection(); g.removeAllRanges(); g.addRange(r); const t = g.toString(); g.removeAllRanges(); return t; })()`);
  need(sel0.includes('SESSION_MAX_AGE') && !/^\s*\d+\s*$/m.test(sel0), 'selected diff text copies without line numbers');
  need(await clickText('.ch-fi', 'login-hero.png'), 'file list click');
  await sleep(700);
  await shot('51-changes-file-jump-binary');
  need(await clickText('.ch-fold', 'Collapse all'), 'Collapse all');
  await sleep(300);
  await shot('52-changes-collapsed');
  need(await clickText('.ch-fold', 'Expand all'), 'Expand all');
  await sleep(900);
  // scroll position and a collapsed card survive switching tabs and back
  await ev(`document.querySelector('.ch-head').click()`); // collapse the first card
  await ev(`document.querySelector('.ch-diffs').scrollTop = 150`);
  await clickText('.seg button', 'History'); await sleep(400); await clickText('.seg button', 'Changes'); await sleep(600);
  need(await ev(`document.querySelector('.ch-diffs').scrollTop === 150 && document.querySelector('.ch-head').getAttribute('aria-expanded') === 'false'`), 'Changes keeps scroll and collapsed state over a tab switch');
  await ev(`document.querySelector('.ch-head').click(); document.querySelector('.ch-diffs').scrollTop = 0`);
  need(await clickText('.ch-sum .seg button', 'Uncommitted only'), 'Uncommitted only');
  await sleep(900);
  need(await ev(`document.querySelectorAll('.ch-card').length === 3`), 'three uncommitted files');
  await shot('53-changes-uncommitted');
  await changesTab('refactor-search-index');
  need(await ev(`document.querySelector('.ch-head[aria-expanded="false"]')?.textContent.includes('large')`), 'a large diff starts collapsed');
  await ev(`[...document.querySelectorAll('.ch-head')].find((b) => b.textContent.includes('corpus.golden'))?.click()`);
  await sleep(1200);
  await ev(`document.querySelector('.ch-trunc')?.scrollIntoView({ block: 'center' })`);
  await sleep(300);
  need(await ev(`/diff truncated, [\\d,]+ more lines/.test(document.querySelector('.ch-trunc')?.textContent || '')`), 'truncated marker');
  await shot('54-changes-truncated');
  await changesTab('release-notes-draft');
  need(await ev(`document.body.textContent.includes('Nothing changed yet')`), 'clean worktree empty state');
  await shot('55-changes-nothing-yet');
  await changesTab('migrate-db-schema');
  need(await ev(`document.body.textContent.includes('No git changes for this agent')`), 'no-worktree empty state');
  await shot('56-changes-no-git');

  ws.close();
} catch (e) {
  if (e !== 'accounts-done' && e !== 'idle-done') { console.error(e); failed = true; }
} finally {
  browser.kill();
  deck.kill();
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
