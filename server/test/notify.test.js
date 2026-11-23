import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transitions, isManager, step, osascriptNotifier, tnArgs, escapeMessage, validId, validPort, focusCommand, FOCUS_SCRIPT, titleOf, createTick, tnCandidates, findTerminalNotifier, clickNotifier, notifyAllowed, notifyEnabled, setNotifyPref, startNotifyPoller } from '../notify.js';
import { readState } from '../state.js';
import { parseHash, buildHash } from '../../web/hash.js';
import { createViewing } from '../viewing.js';

const mk = (id, o = {}) => ({ id, name: `n-${id}`, state: 'working', status: 'busy', needsInput: false, stalled: false, parent: null, mine: true, startedAtRoot: true, ...o });
const kinds = (r) => r.events.map((e) => `${e.id}:${e.kind}`);

test('baseline: first poll never notifies, even for agents already waiting or done', () => {
  const r = transitions(null, [mk('a', { state: 'blocked', needsInput: true }), mk('b', { state: 'done' })]);
  assert.deepEqual(r.events, []);
  assert.equal(r.next.size, 2);
});

test('needs input: blocked, waiting and stalled each fire once on the edge', () => {
  for (const o of [{ state: 'blocked', needsInput: true }, { status: 'waiting', needsInput: true }, { stalled: true }]) {
    const base = transitions(null, [mk('a')]).next;
    const r1 = transitions(base, [mk('a', o)]);
    assert.deepEqual(kinds(r1), ['a:needs-input']);
    assert.deepEqual(transitions(r1.next, [mk('a', o)]).events, []); // still waiting: no repeat
  }
});

test('needs input again after it was answered fires again', () => {
  const w = mk('a', { needsInput: true, state: 'blocked' });
  let t = transitions(null, [mk('a')]).next;
  t = transitions(t, [w]).next;
  t = transitions(t, [mk('a')]).next;
  assert.deepEqual(kinds(transitions(t, [w])), ['a:needs-input']);
});

test('finish: top-level fires, linked worker is silent, repeats do not fire', () => {
  const base = transitions(null, [mk('top'), mk('w', { parent: 'm', mine: false })]).next;
  const done = [mk('top', { state: 'done' }), mk('w', { state: 'done', parent: 'm', mine: false })];
  const r = transitions(base, done);
  assert.deepEqual(kinds(r), ['top:finished']);
  assert.deepEqual(transitions(r.next, done).events, []);
});

test('finish: other end states (failed, stopped) and a worker needing input stay as specified', () => {
  const base = transitions(null, [mk('a'), mk('b')]).next;
  assert.deepEqual(transitions(base, [mk('a', { state: 'failed' }), mk('b', { state: 'stopped' })]).events, []);
});

test('managers only: needs-input and finish fire for a manager; workers, throwaway, worktree, prompts-folder and Other agents never do', () => {
  const quiet = {
    worker: { parent: 'm', mine: false, startedAtRoot: true }, // linked worker (links.tsv)
    throwaway: { mine: false, startedAtRoot: false }, // plain `claude --bg` in the dekki folder
    worktree: { mine: false, startedAtRoot: false, worktreePath: '/p/x/.claude/worktrees/y' },
    prompts: { mine: true, startedAtRoot: false }, // deck-started improver (owned) in the prompts folder
    other: { mine: false, startedAtRoot: true }, // marked Other
  };
  assert.equal(isManager(mk('m')), true);
  for (const [k, o] of Object.entries(quiet)) {
    assert.equal(isManager(mk(k, o)), false, k);
    const base = transitions(null, [mk(k, o)]).next;
    assert.deepEqual(transitions(base, [mk(k, { ...o, state: 'blocked', needsInput: true })]).events, [], `${k} needs-input`);
    assert.deepEqual(transitions(base, [mk(k, { ...o, state: 'done' })]).events, [], `${k} finish`);
  }
  const base = transitions(null, [mk('m'), mk('s')]).next;
  assert.deepEqual(kinds(transitions(base, [mk('m', { stalled: true }), mk('s', { state: 'done' })])), ['m:needs-input', 's:finished']);
});

test('blocked then done fires one finish, not also needs-input', () => {
  const base = transitions(null, [mk('a', { state: 'blocked', needsInput: true })]).next;
  assert.deepEqual(kinds(transitions(base, [mk('a', { state: 'done' })])), ['a:finished']);
});

test('disappearing agent: dropped from the baseline, back again is a fresh baseline (no notification)', () => {
  const base = transitions(null, [mk('a'), mk('b')]).next;
  const gone = transitions(base, [mk('b')]);
  assert.deepEqual(gone.events, []);
  assert.equal(gone.next.has('a'), false);
  assert.deepEqual(transitions(gone.next, [mk('a', { state: 'done' }), mk('b')]).events, []);
});

test('step: updates the baseline when disabled, so turning it on later does not replay', () => {
  const sent = [];
  const tracker = { prev: null };
  const notifier = (e) => sent.push(e);
  step(tracker, [mk('a')], { notifier, enabled: true });
  step(tracker, [mk('a', { state: 'done' })], { notifier, enabled: false });
  step(tracker, [mk('a', { state: 'done' })], { notifier, enabled: true });
  assert.deepEqual(sent, []);
  step(tracker, [mk('a', { state: 'done' }), mk('b')], { notifier, enabled: true });
  step(tracker, [mk('a', { state: 'done' }), mk('b', { needsInput: true })], { notifier, enabled: true });
  assert.deepEqual(sent.map((e) => e.kind), ['needs-input']);
});

test('osascript notifier: fixed argv, name and phrase as arguments only, no shell', () => {
  let call;
  osascriptNotifier({ execFileFn: (...a) => (call = a) })({ name: 'x"; do shell script "id', kind: 'finished' });
  assert.equal(call[0], 'osascript');
  const args = call[1];
  const script = args.filter((_, i) => args[i - 1] === '-e').join(' ');
  assert.equal(script, 'on run argv display notification (item 2 of argv) with title (item 1 of argv) end run');
  assert.deepEqual(args.slice(args.indexOf('--') + 1), ['Dekki', 'x"; do shell script "id finished']);
});

test('notifyAllowed: off under test and with DEKKI_NOTIFY=0; poller does not start under node --test', () => {
  assert.equal(notifyAllowed({}), true);
  assert.equal(notifyAllowed({ DEKKI_NOTIFY: '0' }), false);
  assert.equal(notifyAllowed({ NODE_TEST_CONTEXT: 'child' }), false);
  assert.equal(notifyAllowed(), false); // this very process runs under node --test
  assert.equal(startNotifyPoller({ env: { NODE_TEST_CONTEXT: 'child' } }), null);
});

test('toggle: default on, persisted in state.json prefs, other prefs kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-notify-'));
  process.env.DEKKI_STATE = path.join(dir, 'state.json');
  try {
    assert.equal(notifyEnabled(), true);
    setNotifyPref(false);
    assert.equal(readState().prefs.notify, false);
    assert.equal(notifyEnabled(), false);
    setNotifyPref(true);
    assert.equal(notifyEnabled(), true);
  } finally {
    delete process.env.DEKKI_STATE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tnArgs: -execute focus command with port and id, per-agent group, fixed title, no -sender, no -open', () => {
  const a = tnArgs({ id: 'ab12cd34', name: 'my agent', kind: 'finished' }, 4999);
  assert.deepEqual(a, ['-title', 'Dekki', '-message', 'my agent finished', '-execute', focusCommand('ab12cd34', 4999), '-group', 'dekki-ab12cd34']);
  assert.match(a[5], /^\/usr\/bin\/osascript '.*focus-deck\.applescript' 4999 ab12cd34$/);
  assert.ok(!a.includes('-sender') && !a.includes('-open'));
});

test('validation: id must be 8 hex, port an integer; invalid -> no argv (osascript fallback)', () => {
  for (const id of ['ab12', 'AB12CD34', 'ab12cd3g', 'ab12cd34; rm -rf ~', "ab12cd34'", undefined, 12345678]) assert.equal(validId(id), false, String(id));
  assert.equal(validId('ab12cd34'), true);
  for (const p of [0, -1, 70000, 4.5, '4999', '4999; id', NaN, undefined]) assert.equal(validPort(p), false, String(p));
  assert.equal(validPort(4999), true);
  assert.equal(tnArgs({ id: 'ab12cd34; id', name: 'n', kind: 'finished' }, 4999), null);
  assert.equal(tnArgs({ id: 'ab12cd34', name: 'n', kind: 'finished' }, '4999; id'), null);
});

test('focusCommand: script path is single-quoted, embedded quotes escaped', () => {
  assert.equal(focusCommand('ab12cd34', 1, "/a b/it's/x.applescript"), "/usr/bin/osascript '/a b/it'\\''s/x.applescript' 1 ab12cd34");
});

test('parseHash: #id, #id/history, empty (old form, no account)', () => {
  assert.deepEqual(parseHash('#ab12cd34'), { account: null, id: 'ab12cd34', tab: 'session' });
  assert.deepEqual(parseHash('#ab12cd34/history'), { account: null, id: 'ab12cd34', tab: 'history' });
  assert.deepEqual(parseHash('#'), { account: null, id: null, tab: 'session' });
  assert.deepEqual(parseHash(''), { account: null, id: null, tab: 'session' });
  assert.deepEqual(parseHash(undefined), { account: null, id: null, tab: 'session' });
});

test('hash links: build and parse with an account; bad account or bad id never parse to a selection', () => {
  assert.equal(buildHash('ab12cd34', 'second'), '#second:ab12cd34');
  assert.equal(buildHash('ab12cd34', 'second', 'history'), '#second:ab12cd34/history');
  assert.equal(buildHash('ab12cd34'), '#ab12cd34');
  assert.deepEqual(parseHash('#second:ab12cd34'), { account: 'second', id: 'ab12cd34', tab: 'session' });
  assert.deepEqual(parseHash('#my-acct-2:ab12cd34/history'), { account: 'my-acct-2', id: 'ab12cd34', tab: 'history' });
  assert.deepEqual(parseHash(buildHash('ab12cd34', 'default')), { account: 'default', id: 'ab12cd34', tab: 'session' });
  for (const bad of ['#Bad:ab12cd34', '#-x:ab12cd34', '#a b:ab12cd34', '#:ab12cd34', '#second:zz', '#second:ab12cd34ff', '#second:', '#a:b:ab12cd34', '#ab12cd3g', '#ab12cd34ff', '#second:ab12cd34;id']) {
    assert.deepEqual(parseHash(bad), { account: null, id: null, tab: 'session' }, bad);
  }
  assert.equal(buildHash('ab12cd3', 'second'), null);
  assert.equal(buildHash('ab12cd34', 'Bad Account'), null);
  assert.equal(buildHash('ab12cd34', 'x'.repeat(40)), null);
});

test('account in the click link: focusCommand/tnArgs carry a validated account; a bad account -> no argv (osascript fallback)', () => {
  assert.equal(focusCommand('ab12cd34', 1, '/s.applescript', 'second'), "/usr/bin/osascript '/s.applescript' 1 ab12cd34 second");
  assert.equal(focusCommand('ab12cd34', 1, '/s.applescript'), "/usr/bin/osascript '/s.applescript' 1 ab12cd34"); // old two-arg form
  const a = tnArgs({ id: 'ab12cd34', name: 'n', kind: 'finished', accountId: 'second', accountLabel: 'Second' }, 4999);
  assert.equal(a[1], 'Dekki · Second');
  assert.match(a[5], /^\/usr\/bin\/osascript '.*focus-deck\.applescript' 4999 ab12cd34 second$/);
  assert.equal(a[7], 'dekki-second-ab12cd34');
  for (const accountId of ['Second', '-x', 'a b', 'a;id', "a'b", '', 'x'.repeat(40)]) {
    assert.equal(tnArgs({ id: 'ab12cd34', name: 'n', kind: 'finished', accountId }, 4999), null, accountId);
  }
});

test('focus command is built only from validated inputs: shell metacharacters never reach it', () => {
  for (const accountId of ['$(id)', '`id`', 'a&&id', 'a|id', 'a\nid', 'a>b', 'a*', 'a$IFS', '"x"']) {
    assert.equal(tnArgs({ id: 'ab12cd34', name: 'n', kind: 'finished', accountId }, 4999), null, accountId);
  }
  for (const id of ['ab12cd34\nid', '$(id)abc', '`id`abcde', 'ab12cd34 ']) {
    assert.equal(tnArgs({ id, name: 'n', kind: 'finished' }, 4999), null, id);
  }
  for (const port of [0, 65536, -1, 4.5, NaN, '4999', '4999 && id', null]) {
    assert.equal(tnArgs({ id: 'ab12cd34', name: 'n', kind: 'finished' }, port), null, String(port));
  }
  const cmd = tnArgs({ id: 'ab12cd34', name: "x'; id #", kind: 'finished', accountId: 'a-1' }, 4999)[5];
  assert.match(cmd, /^\/usr\/bin\/osascript '[^']*' 4999 ab12cd34 a-1$/); // the name never enters the command
});

test('title: label only when the event carries one; osascript gets it as argv', () => {
  assert.equal(titleOf({ kind: 'finished' }), 'Dekki');
  assert.equal(titleOf({ kind: 'finished', accountId: 'a' }), 'Dekki');
  assert.equal(titleOf({ accountLabel: 'Work' }), 'Dekki · Work');
  let call;
  osascriptNotifier({ execFileFn: (...a) => (call = a) })({ name: 'x', kind: 'finished', accountLabel: 'Second"; id' });
  assert.deepEqual(call[1].slice(call[1].indexOf('--') + 1), ['Dekki · Second"; id', 'x finished']);
});

// ---- poller over all accounts ----
const ACCTS = [{ id: 'default', label: 'Default' }, { id: 'second', label: 'Second' }];
function rig({ accounts = ACCTS, view = () => false } = {}) {
  const lists = { default: [mk('aaaaaaa1')], second: [mk('bbbbbbb2')] };
  const calls = [];
  const sent = [];
  const cfg = { accounts, missing: new Set(), fail: new Set() };
  const tickFn = createTick({
    notifier: (e) => sent.push(e),
    list: async (a) => { calls.push(a.id); if (cfg.fail.has(a.id)) throw new Error('boom'); return lists[a.id]; },
    accounts: () => cfg.accounts,
    check: (a) => (cfg.missing.has(a.id) ? 'missing' : null),
    isViewing: view,
    enabled: () => true,
  });
  return { lists, calls, sent, cfg, tick: tickFn };
}

test('poller: lists each account with its own account object; both accounts notify', async () => {
  const r = rig();
  await r.tick();
  assert.deepEqual(r.calls.sort(), ['default', 'second']);
  assert.deepEqual(r.sent, []); // baseline per account
  r.lists.default = [mk('aaaaaaa1', { state: 'done' })];
  r.lists.second = [mk('bbbbbbb2', { state: 'blocked', needsInput: true })];
  await r.tick();
  assert.deepEqual(r.sent.map((e) => `${e.accountId}:${e.id}:${e.kind}:${e.accountLabel}`).sort(), ['default:aaaaaaa1:finished:Default', 'second:bbbbbbb2:needs-input:Second']);
});

test('poller: one account only -> no account label (text exactly as before), accountId still set for the link', async () => {
  const r = rig({ accounts: [ACCTS[0]] });
  await r.tick();
  r.lists.default = [mk('aaaaaaa1', { state: 'done' })];
  await r.tick();
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].accountId, 'default');
  assert.equal(r.sent[0].accountLabel, undefined);
  assert.equal(titleOf(r.sent[0]), 'Dekki');
});

test('poller: a freshly added account gets its own baseline (no flood); the other account keeps its state', async () => {
  const r = rig({ accounts: [ACCTS[0]] });
  await r.tick();
  r.lists.second = [mk('bbbbbbb2', { state: 'done' }), mk('bbbbbbb3', { state: 'blocked', needsInput: true })];
  r.cfg.accounts = ACCTS;
  r.lists.default = [mk('aaaaaaa1', { state: 'done' })];
  await r.tick();
  assert.deepEqual(r.sent.map((e) => e.id), ['aaaaaaa1']); // only the old account's real transition
});

test('poller: the deck active account is irrelevant (all accounts polled every tick, no re-baseline, no replay)', async () => {
  const r = rig();
  r.lists.second = [mk('bbbbbbb2', { state: 'done' })]; // already done at baseline
  await r.tick();
  await r.tick();
  await r.tick();
  assert.deepEqual(r.sent, []);
});

test('poller: missing config dir is skipped, not fatal; it re-baselines when it returns', async () => {
  const r = rig();
  await r.tick();
  r.cfg.missing.add('second');
  r.calls.length = 0;
  r.lists.second = [mk('bbbbbbb2', { state: 'done' })];
  await r.tick();
  assert.deepEqual(r.calls, ['default']);
  r.cfg.missing.clear();
  await r.tick(); // back: fresh baseline, the done state is not an edge
  assert.deepEqual(r.sent, []);
});

test('poller: one account failing does not stop the other', async () => {
  const r = rig();
  await r.tick();
  r.cfg.fail.add('default');
  r.lists.second = [mk('bbbbbbb2', { state: 'done' })];
  await r.tick();
  assert.deepEqual(r.sent.map((e) => e.accountId), ['second']);
});

test('poller: removed account drops its tracker (re-adding baselines again)', async () => {
  const r = rig();
  await r.tick();
  r.cfg.accounts = [ACCTS[0]];
  await r.tick();
  r.cfg.accounts = ACCTS;
  r.lists.second = [mk('bbbbbbb2', { state: 'done' })];
  await r.tick();
  assert.deepEqual(r.sent, []);
});

test('isViewing is per account: a page on account A does not suppress the same id on account B', async () => {
  const v = createViewing();
  v.report('p1', 'cccccccc', true, 'default');
  assert.equal(v.isViewing('cccccccc', 'default'), true);
  assert.equal(v.isViewing('cccccccc', 'second'), false);
  assert.equal(v.report('p2', 'cccccccc', true, 'Bad Account'), false);
  v.report('old', 'dddddddd', true); // a page that sends no account matches any
  assert.equal(v.isViewing('dddddddd', 'second'), true);
  const r = rig({ view: (id, account) => v.isViewing(id, account) });
  r.lists.default = [mk('cccccccc')];
  r.lists.second = [mk('cccccccc')];
  await r.tick();
  r.lists.default = [mk('cccccccc', { state: 'done' })];
  r.lists.second = [mk('cccccccc', { state: 'done' })];
  await r.tick();
  assert.deepEqual(r.sent.map((e) => e.accountId), ['second']); // default is being looked at
});

test('focus AppleScript: exists, reads port and id from argv only', () => {
  const src = fs.readFileSync(FOCUS_SCRIPT, 'utf8');
  assert.match(src, /on run argv/);
  assert.match(src, /item 1 of argv/);
  assert.match(src, /item 2 of argv/);
});

test('escapeMessage: leading - [ \\ get a backslash, others untouched', () => {
  assert.equal(escapeMessage('-x y'), '\\-x y');
  assert.equal(escapeMessage('[x] y'), '\\[x] y');
  assert.equal(escapeMessage('\\x'), '\\\\x');
  assert.equal(escapeMessage('plain -x'), 'plain -x');
  assert.equal(tnArgs({ id: 'aaaaaaa1', name: '-rf', kind: 'finished' }, 1)[3], '\\-rf finished');
});

test('tnCandidates: PATH name plus explicit homebrew, /usr/local and rbenv shim', () => {
  assert.deepEqual(tnCandidates('/h'), ['terminal-notifier', '/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier', '/h/.rbenv/shims/terminal-notifier']);
});

// fake execFile: bins in `works` succeed (sends too unless failSend); everything else errors; records calls
const fakeExec = (works, calls = [], failSend = false) => (bin, args, opts, cb) => {
  calls.push([bin, args]);
  const ok = works.includes(bin) && (args[0] === '-help' || !failSend);
  queueMicrotask(() => cb(ok ? null : Object.assign(new Error('x'), { code: 1 })));
};
const tick = () => new Promise((r) => setTimeout(r, 10));
const base = { id: 'aaaaaaa1', name: 'n', kind: 'finished' };

test('findTerminalNotifier: skips a broken candidate, picks first that runs, null when none', async () => {
  const c = ['a', 'b', 'c'];
  assert.equal(await findTerminalNotifier({ execFileFn: fakeExec(['b', 'c']), candidates: c }), 'b');
  assert.equal(await findTerminalNotifier({ execFileFn: fakeExec([]), candidates: c }), null);
});

test('clickNotifier: terminal-notifier via execFile argv, probes once, no shell', async () => {
  const calls = [];
  const n = clickNotifier({ port: 4500, execFileFn: fakeExec(['tn'], calls), candidates: ['tn'] });
  n(base);
  n({ ...base, id: 'aaaaaaa2' });
  await tick();
  assert.equal(calls.filter(([, a]) => a[0] === '-help').length, 1);
  const sends = calls.filter(([, a]) => a[0] === '-title');
  assert.equal(sends.length, 2);
  assert.equal(sends[0][0], 'tn');
  assert.ok(sends[0][1].some((x) => x.endsWith("' 4500 aaaaaaa1")));
  assert.ok(!calls.some(([b]) => ['osascript', 'sh', 'bash', 'zsh'].includes(b)));
});

test('stdin of the probe and of the send is closed (terminal-notifier hangs on an open stdin pipe)', async () => {
  let ended = 0;
  const exec = (bin, args, opts, cb) => { queueMicrotask(() => cb(null)); return { stdin: { end: () => ended++ } }; };
  clickNotifier({ port: 4500, execFileFn: exec, candidates: ['tn'] })(base);
  await tick();
  assert.equal(ended, 2); // probe + send
});

test('clickNotifier: none available -> osascript', async () => {
  const calls = [];
  clickNotifier({ port: 1, execFileFn: fakeExec([], calls), candidates: ['tn'] })(base);
  await tick();
  assert.equal(calls.at(-1)[0], 'osascript');
});

test('clickNotifier: send failure falls back to osascript and logs once', async () => {
  const calls = [];
  const logs = [];
  const n = clickNotifier({ port: 4500, execFileFn: fakeExec(['tn'], calls, true), candidates: ['tn'], log: (m) => logs.push(m) });
  n(base);
  n({ ...base, id: 'aaaaaaa2' });
  await tick();
  assert.equal(calls.filter(([b]) => b === 'osascript').length, 2);
  assert.equal(logs.length, 1);
});
