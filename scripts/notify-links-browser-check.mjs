// Check of cross-account notifications + deep links, against a THROWAWAY deck it starts itself:
//   node scripts/notify-links-browser-check.mjs [screenshot-dir]
// Everything is temp: state file (DEKKI_STATE), a fake second account (empty config dir), folders, and a stub
// `claude` on PATH that only answers `claude agents --json` from files (one set per account). No real account, agent or
// folder is touched; the deck runs with DEKKI_NOTIFY=0 so no real macOS banner fires.
// Part 1 (in-process): the notify poller over both accounts, through the real clickNotifier with a FAKE execFile, prints
//   the exact terminal-notifier argv per account. The deep link is rebuilt from that argv the way focus-deck.applescript does.
// Part 2 (headless Edge/Chrome): (a) link to the other account's agent -> switch + select, (b) same-account link ->
//   select without reload, (c) old-format link, (d) link with a bogus account stays put, (e) fresh navigation (the
//   `open` fallback) to the other account's agent.
// NOT covered: a real macOS banner click (terminal-notifier / Safari AppleScript).
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const shotDir = process.argv[2];
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4395;
const CDP = 9346;
const BIN = process.env.DECK_TEST_BROWSER || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-notify-links-')));
const rootA = path.join(tmp, 'root-a');
const rootB = path.join(tmp, 'root-b');
const cfgB = path.join(tmp, 'cfg-second');
for (const d of [rootA, rootB, cfgB, path.join(tmp, 'bin'), path.join(tmp, 'prompts')]) fs.mkdirSync(d);
const A1 = 'a1a1a1a1';
const B1 = 'b1b1b1b1';
const B2 = 'b2b2b2b2';
const agent = (id, cwd, state, name) => ({ id, kind: 'background', state, status: state === 'blocked' ? 'waiting' : 'idle', cwd, name });
const setAgents = (a, b) => {
  fs.writeFileSync(path.join(tmp, 'agents-a.json'), JSON.stringify(a));
  fs.writeFileSync(path.join(tmp, 'agents-b.json'), JSON.stringify(b));
};
setAgents([agent(A1, rootA, 'working', 'dekki-throwaway-a1')], [agent(B1, rootB, 'working', 'dekki-throwaway-b1'), agent(B2, rootB, 'working', 'dekki-throwaway-b2')]);
fs.writeFileSync(path.join(tmp, 'bin', 'claude'), `#!/bin/bash
if [ "$1" = agents ]; then
  if [ -n "$CLAUDE_CONFIG_DIR" ]; then cat "${tmp}/agents-b.json"; else cat "${tmp}/agents-a.json"; fi
fi
`, { mode: 0o755 });
const STATE = path.join(tmp, 'state.json');
fs.writeFileSync(STATE, JSON.stringify({ root: rootA, accounts: [{ id: 'second', label: 'Second', configDir: cfgB, root: rootB }], activeAccount: 'default' }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };
const env = { ...process.env, DEKKI_STATE: STATE, DEKKI_PROJECTS_DIR: path.join(tmp, 'none'), DEKKI_PROMPTS: path.join(tmp, 'prompts'), PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}` };
let browser;
let deck;
let profile;
try {
  // ---- Part 1: poller over both accounts, captured notifier argv ----
  Object.assign(process.env, env);
  const { createTick, clickNotifier } = await import('../server/notify.js');
  const calls = [];
  const fakeExec = (bin, args, opts, cb) => { calls.push([bin, args]); queueMicrotask(() => cb(null)); return { stdin: { end() {} } }; };
  const notifier = clickNotifier({ port: PORT, execFileFn: fakeExec, candidates: ['terminal-notifier'] });
  const tick = createTick({ notifier, isViewing: () => false });
  await tick(); // baseline for both accounts
  const sends = () => calls.filter(([, a]) => a[0] === '-title');
  await sleep(50);
  ok(sends().length === 0, 'baseline poll: no notification for either account');
  // A1 (default account) finishes, B2 (second account) needs input; the deck's active account is the default one
  setAgents([agent(A1, rootA, 'done', 'dekki-throwaway-a1')], [agent(B1, rootB, 'working', 'dekki-throwaway-b1'), agent(B2, rootB, 'blocked', 'dekki-throwaway-b2')]);
  await tick();
  await sleep(100);
  const got = sends().map(([bin, args]) => ({ bin, args }));
  console.log(JSON.stringify(got, null, 2));
  ok(got.length === 2, 'two notifications: one per account');
  const forA = got.find((g) => g.args[3].includes('finished'));
  const forB = got.find((g) => g.args[3].includes('needs your input'));
  ok(forA?.args[1] === 'Dekki · Default' && forB?.args[1] === 'Dekki · Second', 'titles carry the account label (2 accounts)');
  ok(/ 4395 a1a1a1a1 default$/.test(forA.args[5]) && / 4395 b2b2b2b2 second$/.test(forB.args[5]), '-execute carries port, agent id and account id');
  // the link focus-deck.applescript builds from those argv: "http://127.0.0.1:<port>/#<account>:<id>"
  const linkOf = (g) => { const [port, id, account] = g.args[5].split("' ")[1].split(' '); return `http://127.0.0.1:${port}/#${account}:${id}`; };
  console.log('links:', linkOf(forA), linkOf(forB));
  ok(linkOf(forB) === `http://127.0.0.1:${PORT}/#second:${B2}`, 'link for the second account agent');
  setAgents([agent(A1, rootA, 'working', 'dekki-throwaway-a1')], [agent(B1, rootB, 'working', 'dekki-throwaway-b1'), agent(B2, rootB, 'working', 'dekki-throwaway-b2')]);

  // ---- Part 2: browser ----
  deck = spawn(process.execPath, ['server/start.js'], { cwd: REPO, env: { ...env, PORT: String(PORT), DEKKI_NOTIFY: '0' }, stdio: 'ignore' });
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-browser-'));
  browser = spawn(BIN, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--window-size=1200,800', 'about:blank'], { stdio: 'ignore' });
  const target = async () => {
    for (let i = 0; i < 120; i++) {
      try { const t = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); const pg = t.find((x) => x.type === 'page'); if (pg) return pg.webSocketDebuggerUrl; } catch {}
      await sleep(250);
    }
    throw new Error('browser did not start');
  };
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/accounts`, { headers: { origin: `http://127.0.0.1:${PORT}` } })).ok) break; } catch {} await sleep(250); }
  const ws = new WebSocket(await target());
  await new Promise((r) => ws.on('open', r));
  let n = 0;
  const pending = new Map();
  ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) pending.get(d.id)(d); });
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const shot = async (name) => { if (!shotDir) return; fs.mkdirSync(shotDir, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shotDir, name), Buffer.from(r.result.data, 'base64')); };
  await cdp('Page.enable');
  const goto = async (url) => { await cdp('Page.navigate', { url }); await sleep(2800); };
  const view = () => ev(`JSON.stringify({ hash: location.hash, account: document.querySelector('select[aria-label="Claude account"]')?.value, selectedRows: [...document.querySelectorAll('.row.selected .row-name')].map(e => e.textContent), title: document.querySelector('.main-head')?.textContent || null, marker: window.__marker || null })`).then(JSON.parse);
  const setHash = async (h, ms = 2800) => { await ev(`location.hash = ${JSON.stringify(h)}`); await sleep(ms); };

  await goto(`http://127.0.0.1:${PORT}/`);
  let v = await view();
  ok(v.account === 'default' && v.selectedRows.length === 0, 'start: deck on the default account, nothing selected');
  await shot('0-start-account-a.png');

  // (a) tab on A; the link for B's agent (what the Safari-reuse path does: only the hash changes)
  await ev('window.__marker = "same-page"');
  await setHash(`#second:${B2}`, 4500);
  v = await view();
  console.log('(a)', JSON.stringify(v));
  ok(v.account === 'second', '(a) switcher shows the second account');
  ok(v.hash === `#${B2}`, '(a) URL hash is #<agent id>');
  ok(v.selectedRows.join() === 'dekki-throwaway-b2', '(a) the agent row is selected');
  ok(v.title?.includes(B2), '(a) the detail header shows the agent');
  ok(v.marker === null, '(a) the page reloaded (account switch)');
  await shot('a-link-other-account.png');

  // (b) same account link: selected, no reload
  await ev('window.__marker = "same-page"');
  await setHash(`#second:${B1}`, 1500);
  v = await view();
  console.log('(b)', JSON.stringify(v));
  ok(v.account === 'second' && v.selectedRows.join() === 'dekki-throwaway-b1' && v.title?.includes(B1) && v.hash === `#${B1}`, '(b) same-account link selects the agent');
  ok(v.marker === 'same-page', '(b) no reload');
  await shot('b-link-same-account.png');

  // (c) old format
  await setHash(`#${B2}`, 1500);
  v = await view();
  console.log('(c)', JSON.stringify(v));
  ok(v.selectedRows.join() === 'dekki-throwaway-b2' && v.title?.includes(B2) && v.marker === 'same-page', '(c) old-format #<id> still selects, no reload');
  await setHash(`#${B1}/history`, 1500);
  v = await view();
  ok(v.selectedRows.join() === 'dekki-throwaway-b1', '(c) old-format #<id>/history selects');
  await shot('c-old-format.png');

  // (d) bogus accounts: stay put (account, selection, page), no crash, no wrong-account selection
  for (const bogus of [`#nosuch:${A1}`, `#Bad Account:${A1}`, `#nosuch:${B2}`]) {
    await setHash(bogus, 1800);
    v = await view();
    console.log('(d)', bogus, JSON.stringify(v));
    ok(v.account === 'second' && v.selectedRows.join() === 'dekki-throwaway-b1' && v.marker === 'same-page' && v.hash === `#${B1}`, `(d) ${bogus}: stays put, nothing re-selected, hash restored`);
  }
  await shot('d-bogus-account.png');
  ok((await ev(`fetch('/api/accounts').then(r => r.json()).then(b => b.active)`)) === 'second', '(d) server active account unchanged');

  // (e) fresh navigation (the `open` fallback when no tab is open) to the OTHER account's agent
  await goto(`http://127.0.0.1:${PORT}/#default:${A1}`);
  await sleep(2500);
  v = await view();
  console.log('(e)', JSON.stringify(v));
  ok(v.account === 'default' && v.selectedRows.join() === 'dekki-throwaway-a1' && v.title?.includes(A1) && v.hash === `#${A1}`, '(e) fresh open of #default:<id> from the second account lands on default with the agent selected');
  await shot('e-fresh-open.png');
  ws.close();
} finally {
  browser?.kill();
  deck?.kill();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}
