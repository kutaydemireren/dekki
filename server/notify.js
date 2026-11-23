// macOS notifications, fired by the deck server (no browser tab needed). Silent unless something needs the user.
// Text is only the agent display name + a fixed phrase: transcript text may hold internal information.
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listAgents } from './agents.js';
import { attention as defaultAttention } from './attention.js';
import { readState, writeState } from './state.js';
import { viewing } from './viewing.js';
import { subscribers as defaultSubscribers } from './appevents.js';
import { buildHash } from '../web/hash.js';
import { groupOf } from '../web/groups.js';
import { listAccounts, validateAccount, ID_RE as ACCOUNT_ID_RE } from './accounts.js';

const POLL_MS = 3000;

export const needsAttention = (a) => Boolean(a.needsInput || a.stalled);

/** Only manager sessions notify: in the main list (`mine`: not an Other, not a linked worker; includes agents the deck
 *  started) and started in the projects root. A throwaway agent, a worktree agent and the prompts-folder improver
 *  start elsewhere, so they never do. Reuses the agent list's own `mine` / `startedAtRoot`. */
export const isManager = (a) => Boolean(a.mine && a.startedAtRoot);

/** The badge / menu-bar count: exactly the agent list's "Needs input" group (web/groups.js groupOf: not archived, not an
 *  Other agent, stalled or needsInput, not plain working) minus empty drafts (`empty`: placeholder AND no conversation;
 *  a bare `idle` would also drop a session that has history but shows the placeholder). Unlike banners it does NOT
 *  require startedAtRoot (an agent started at the root and moved into a worktree has none). */
export const countsForBadge = (a, archived = []) => groupOf(a, { archived }) === 'Needs input' && !a.empty;

/** Pure. prev: Map id -> {attention, state} from the last poll, or null for the very first poll (baseline only).
 *  Returns { events: [{id, name, kind: 'needs-input'|'finished'}], next }. One edge = one event, so a steady
 *  state never repeats. An agent not seen before (first sight, or back after disappearing) only records. */
export function transitions(prev, agents) {
  const next = new Map();
  const events = [];
  for (const a of agents) {
    if (!isManager(a)) continue;
    const cur = { attention: needsAttention(a), state: a.state };
    next.set(a.id, cur);
    const was = prev?.get(a.id);
    if (!was) continue;
    if (a.state === 'done' && was.state !== 'done') {
      events.push({ id: a.id, name: a.name, kind: 'finished' });
    } else if (cur.attention && !was.attention) {
      events.push({ id: a.id, name: a.name, kind: 'needs-input' });
    }
  }
  return { events, next };
}

export const PHRASES = { 'needs-input': 'needs your input', finished: 'finished' };

export const bodyOf = ({ name, kind }) => `${String(name).slice(0, 80)} ${PHRASES[kind]}`;

/** Title: fixed "Dekki", plus the account label only when an event carries one (the poller sets it with 2+ accounts). */
export const titleOf = (ev) => (ev.accountLabel ? `Dekki · ${String(ev.accountLabel).slice(0, 40)}` : 'Dekki');

/** The osascript notifier: title and body passed as argv (never spliced into script text). Click opens Script Editor
 *  (osascript has no click action), which is why terminal-notifier is preferred when it works. */
export function osascriptNotifier({ execFileFn = execFile } = {}) {
  return (ev) => {
    const script = ['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv)', 'end run'];
    const args = script.flatMap((l) => ['-e', l]).concat(['--', titleOf(ev), bodyOf(ev)]);
    execFileFn('osascript', args, { timeout: 5000 }, () => {}); // best effort: macOS settings may suppress it
  };
}

/** terminal-notifier reads `-message -x` as a missing message and `[` as special: a leading backslash is stripped
 *  and fixes both (verified with 2.0.0 and `-list`). */
export const escapeMessage = (m) => (/^[-[\\]/.test(m) ? `\\${m}` : m);

export const validId = (id) => typeof id === 'string' && /^[0-9a-f]{8}$/.test(id);
export const validAccountId = (a) => typeof a === 'string' && ACCOUNT_ID_RE.test(a);
export const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65536;
export const FOCUS_SCRIPT = fileURLToPath(new URL('./scripts/focus-deck.applescript', import.meta.url));

/** Pure. The `-execute` command: terminal-notifier hands it to a shell, so it is built only from a fixed, quoted
 *  script path plus a validated integer port, a validated 8-hex agent id and (optional) a validated account id
 *  ([a-z0-9-], never starts with '-'). The AppleScript reuses an open Safari deck tab, else `open`s the deep link. */
export const focusCommand = (id, port, script = FOCUS_SCRIPT, account = null) =>
  `/usr/bin/osascript '${script.replaceAll("'", "'\\''")}' ${port} ${id}${account ? ` ${account}` : ''}`;

/** Pure. argv for terminal-notifier, or null when id/port fail validation (caller then uses osascript).
 *  No -sender: it replaces the sending app's identity and is known to break click actions in some versions, so the
 *  banner shows terminal-notifier's own icon instead. No -open: it always opens a NEW tab. */
export function tnArgs(ev, port) {
  const { id, name, kind, accountId = null } = ev;
  if (!validId(id) || !validPort(port) || !(accountId === null || validAccountId(accountId))) return null;
  return ['-title', titleOf(ev), '-message', escapeMessage(bodyOf({ name, kind })),
    '-execute', focusCommand(id, port, FOCUS_SCRIPT, accountId), '-group', `dekki-${accountId ? `${accountId}-` : ''}${id}`];
}

/** Pure. What the Mac app gets for one event: the finished text (title/body, so the wording lives only here) and the deep
 *  link hash (web/hash.js, account-aware). `hash` is null when id/account do not validate (the app then just shows it). */
export const appPayload = (ev) => ({
  id: ev.id, accountId: ev.accountId ?? null, kind: ev.kind, title: titleOf(ev), body: bodyOf(ev),
  hash: buildHash(ev.id, ev.accountId ?? null),
});

/** While the Mac app (or any client of GET /api/app/events) is subscribed, it shows the notification and the OS notifier
 *  is NOT used (no double banners). With no subscriber, or when none took the event, `fallback` runs exactly as before. */
export const appAwareNotifier = ({ subscribers = defaultSubscribers, fallback }) => (ev) => {
  if (subscribers.count() > 0 && subscribers.broadcast(appPayload(ev)) > 0) return;
  fallback(ev);
};

/** terminal-notifier reads stdin when it is a pipe (it takes piped message data), so an open pipe makes it hang until
 *  the timeout kills it. Close our end right away. */
const closeStdin = (child) => child?.stdin?.end();

/** Where terminal-notifier may live. The deck can start with a PATH lacking rbenv shims, so look explicitly. */
export const tnCandidates = (home = os.homedir()) =>
  ['terminal-notifier', '/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier', path.join(home, '.rbenv/shims/terminal-notifier')];

/** Resolves to the first candidate that really runs (`-help` exits 0; a shim can fail at runtime), else null. */
export async function findTerminalNotifier({ execFileFn = execFile, candidates = tnCandidates() } = {}) {
  for (const bin of candidates) {
    const ok = await new Promise((res) => closeStdin(execFileFn(bin, ['-help'], { timeout: 4000 }, (err) => res(!err))));
    if (ok) return bin;
  }
  return null;
}

/** Notifier preferring terminal-notifier (click opens the deck at the agent), osascript otherwise. The probe runs once,
 *  at first use. If a send fails, that notification goes through osascript and the failure is logged once. */
export function clickNotifier({ port, execFileFn = execFile, candidates, log = console.warn } = {}) {
  const fallback = osascriptNotifier({ execFileFn });
  let probe = null;
  let warned = false;
  return (ev) => {
    probe ??= findTerminalNotifier({ execFileFn, candidates });
    probe.then((bin) => {
      const args = bin && tnArgs(ev, port);
      if (!args) return fallback(ev);
      closeStdin(execFileFn(bin, args, { timeout: 5000 }, (err) => {
        if (!err) return;
        if (!warned) { warned = true; log(`Dekki: terminal-notifier failed (${err.code ?? err.message}); using osascript`); }
        fallback(ev);
      }));
    });
  };
}

/** Real notifications are on unless DEKKI_NOTIFY=0 or we run under `node --test`. */
export const notifyAllowed = (env = process.env) => env.DEKKI_NOTIFY !== '0' && !env.NODE_TEST_CONTEXT;

export const notifyEnabled = (state = readState()) => state.prefs?.notify !== false;

export function setNotifyPref(on) {
  const s = readState();
  s.prefs = { ...s.prefs, notify: Boolean(on) };
  writeState(s);
  return s;
}

/** One poll step for one account. `tracker` = { prev }. Always updates the baseline; notifies only when `enabled`.
 *  `account` = { id, label }: events carry accountId, and accountLabel only when `multi` (2+ accounts). An event for an
 *  agent the user is looking at (`isViewing(id, accountId)`) is dropped, not queued. */
export function step(tracker, agents, { notifier, enabled, isViewing = () => false, account = null, multi = false }) {
  const { events, next } = transitions(tracker.prev, agents);
  tracker.prev = next;
  const tagged = events.map((e) => (account ? { ...e, accountId: account.id, ...(multi ? { accountLabel: account.label } : {}) } : e));
  if (enabled) for (const e of tagged) if (!isViewing(e.id, e.accountId ?? null)) notifier(e);
  return tagged;
}

/** One poll over EVERY account (each with its own env, jobs/ and transcripts via list(account)), one tracker per account:
 *  its own first-poll baseline, so a new account or a switch of the deck's active account never floods. An account whose
 *  config dir is missing is skipped (and re-baselined when it returns); one failing account never blocks the others. */
export function createTick({ notifier, list = listAgents, isViewing = (id, account) => viewing.isViewing(id, account), accounts = () => listAccounts(), check = validateAccount, enabled = () => notifyEnabled(), attention = defaultAttention, archived = () => readState().archived } = {}) {
  const trackers = new Map(); // account id -> { prev }
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const all = accounts();
      const multi = all.length > 1;
      for (const id of trackers.keys()) if (!all.some((a) => a.id === id)) { trackers.delete(id); attention.drop(id); }
      await Promise.all(all.map(async (account) => {
        if (check(account)) { trackers.delete(account.id); attention.drop(account.id); return; } // config dir missing: skip, re-baseline later
        try {
          const agents = await list(account);
          if (!trackers.has(account.id)) trackers.set(account.id, { prev: null });
          step(trackers.get(account.id), agents, { notifier, enabled: enabled(), isViewing, account, multi });
          attention.set(account.id, agents.filter((a) => countsForBadge(a, archived()))) /* archived: shared state, as the web list */; // list's Needs input minus drafts; banners keep isManager
        } catch { /* claude hiccup for this account: try next tick */ }
      }));
    } finally { busy = false; }
  };
  return tick;
}

/** Test seam, never set in normal use: DEKKI_TEST_AGENTS=<file> makes the poller read its agent list from that JSON
 *  file (an array of agent objects; a missing or invalid file means none) instead of `claude agents`, and silences the
 *  OS notifier. */
export const testAgentList = (file) => async () => {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; }
};

/** The poller runs everywhere except under `node --test`, because it also feeds the attention count that the Mac app
 *  shows. Banners go out only when notifyAllowed (DEKKI_NOTIFY is not 0): to a subscribed Mac app, else the OS
 *  notifier. Test-agents mode never uses the OS notifier. */
export function startNotifyPoller({ port, notifier, intervalMs = POLL_MS, env = process.env, subscribers = defaultSubscribers, ...rest } = {}) {
  if (env.NODE_TEST_CONTEXT) return null;
  const testFile = env.DEKKI_TEST_AGENTS;
  const base = notifier ?? appAwareNotifier({ subscribers, fallback: testFile ? () => {} : clickNotifier({ port }) });
  const tick = createTick({ notifier: notifyAllowed(env) ? base : () => {}, ...(testFile ? { list: testAgentList(testFile) } : {}), ...rest });
  tick();
  const t = setInterval(tick, intervalMs);
  t.unref();
  return t;
}
