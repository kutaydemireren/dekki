// Agent list: `claude agents --json --all`, background only, normalised, plus optional jobs/<id>/state.json detail.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './claude.js';
import { findTranscript, conversationState, lastRealActivity, lastAssistantText, hasWorkerReport, projectsTouched } from './transcript.js';
import { readState } from './state.js';
import { activeAccount, configDirOf, rootOf } from './accounts.js';
import { readLinks } from './links.js';

export const IDLE_DETAIL = '(idle — send a prompt to start)'; // Claude's placeholder for a session with no prompt yet

export const QUIET_MINUTES = 15; // a working agent with no real transcript record for this long gets the 'quiet' badge

function readJob(id, jobsDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(jobsDir, id, 'state.json'), 'utf8'));
  } catch {
    return null; // jobs/ is not a stable interface: tolerate absence and bad JSON
  }
}

const ms = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

const WORKTREES_DIR = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
const base =(p) => (p ? path.basename(p) : '');

/** Normalise one `agents --json` row (+ optional job state). Exported for tests. */
export function normalise(row, job, transcriptMtime, ctx = {}) {
  const worktreePath = job?.worktreePath || null;
  const worktreeBranch = job?.worktreeBranch || null;
  // Project = the repo the worktree belongs to (<repo>/.claude/worktrees/<name>), else where the agent started.
  const inWorktree = [worktreePath, row.cwd].find((p) => typeof p === 'string' && p.includes(WORKTREES_DIR));
  const needsInput = row.state === 'blocked' || row.status === 'waiting';
  const startDir = job?.originCwd || row.cwd;
  const startedAtRoot = Boolean(ctx.root) && path.resolve(startDir) === path.resolve(ctx.root);
  const atRoot = !inWorktree && startedAtRoot;
  // Started in the projects root (manager, or a session that moved into a project later): name the projects
  // it actually worked on (ctx.touched), else just the root folder.
  const project = inWorktree ? base(inWorktree.split(WORKTREES_DIR)[0]) : atRoot && ctx.touched?.length ? ctx.touched.join(', ') : base(startDir);
  return {
    id: row.id,
    name: ctx.names?.[row.id] || row.name || job?.name || row.id,
    claudeName: row.name || job?.name || row.id, // what claude agents shows (the deck name can be reset to it)
    state: row.state || 'unknown',
    status: row.status || null,
    needsInput,
    cwd: row.cwd,
    sessionId: row.sessionId || job?.sessionId || null,
    startedAt: row.startedAt ?? null,
    // Last real conversation record first. lastTerminalAt and the transcript's mtime also move when Claude starts or
    // stops a process for the session (attach, stop), so they are only fallbacks, e.g. for a chat nobody talked in.
    lastActivityAt: ctx.lastReal ?? ms(job?.lastTerminalAt) ?? transcriptMtime ?? row.startedAt ?? null,
    // The description claude agents shows: what the agent is waiting for while it needs input (job `needs`,
    // e.g. "answer: Which project…?"), else its latest status line (`detail`, which goes stale while blocked).
    detail: (needsInput && job?.needs) || job?.detail || null,
    needs: job?.needs ?? null,
    idle: job?.detail === IDLE_DETAIL, // Claude's "no prompt yet" placeholder, read raw (`detail` above may show `needs`)
    worktreePath,
    worktreeBranch,
    label: worktreeBranch ? `${project} / ${worktreeBranch}` : project,
    startedAtRoot, // even if it moved into a worktree later (a chat you started at the root and let work on a repo)
  };
}

/** Health badges. `noReport`: a linked worker (has a manager) that is done/stopped and whose last assistant text has
 *  no `result:` / `needs input:` / `failed:` line (lastText null = transcript unreadable: no verdict).
 *  `quiet`: state working but the last real transcript record (lastReal, ms; null = unknown) is older than QUIET_MINUTES. */
export function healthFlags(a, lastReal, lastText, now = Date.now()) {
  const noReport = Boolean(a.parent) && (a.state === 'done' || a.state === 'stopped') && lastText !== null && lastText !== undefined && !hasWorkerReport(lastText);
  const quiet = a.state === 'working' && Number.isFinite(lastReal) && now - lastReal > QUIET_MINUTES * 60000;
  return { noReport, quiet, quietMinutes: QUIET_MINUTES };
}

/** "Mine" = shown in the main list: your Other mark wins, then your Mine mark / deck-started, then a worker
 *  linked to a manager is not (it nests under it), then started at the root. */
export function isMine(agent, { owned = [], others = [] } = {}) {
  if (others.includes(agent.id)) return false;
  if (owned.includes(agent.id)) return true;
  return !agent.parent && agent.startedAtRoot;
}

/** The agent list of one account (default: the active one): its own `claude agents` env, jobs/ and transcripts. */
export async function listAgents(account) {
  const st = readState();
  account ??= activeAccount(st);
  const configDir = configDirOf(account);
  const jobsDir = path.join(configDir, 'jobs');
  const r = await run(['agents', '--json', '--all'], { account });
  if (!r.ok) throw new Error(`claude agents failed: ${r.stderr.trim() || r.code}`);
  let rows;
  try {
    rows = JSON.parse(r.stdout);
  } catch {
    throw new Error('claude agents returned invalid JSON');
  }
  if (!Array.isArray(rows)) throw new Error('claude agents returned unexpected JSON');
  const out = [];
  const root = rootOf(account, st); // the account's working folder (null: a non-default account without one)
  let folders = null; // project folders under the root, read lazily
  const rootFolders = () => (folders ??= (() => {
    if (!root) return [];
    try { return fs.readdirSync(root).filter((n) => !n.startsWith('.') && fs.statSync(path.join(root, n)).isDirectory()); } catch { return []; }
  })());
  for (const row of rows) {
    if (row?.kind !== 'background' || typeof row.id !== 'string') continue;
    const job = readJob(row.id, jobsDir);
    const f = row.sessionId ? findTranscript(row.sessionId, configDir) : null;
    let mtime = null;
    if (f) try { mtime = fs.statSync(f).mtimeMs; } catch {}
    let touched = [];
    const startsAtRoot = Boolean(root) && path.resolve(job?.originCwd || row.cwd || '') === path.resolve(root);
    if (f && startsAtRoot && !job?.worktreePath) touched = projectsTouched(f, root, rootFolders());
    const a = normalise(row, job, mtime, { root, touched, lastReal: f ? lastRealActivity(f) : null, names: st.names });
    // Agents still showing the "no prompt yet" placeholder: is the chat really empty? (drives the draft badge)
    // Only a chat that still shows the placeholder can be empty; false otherwise so the badge goes once a prompt is sent.
    a.empty = Boolean(a.idle && row.sessionId && ['missing', 'empty'].includes(conversationState(f)));
    a._lastReal = f ? lastRealActivity(f) : null;
    a._lastText = f ? lastAssistantText(f) : null;
    out.push(a);
  }
  const links = readLinks();
  const ids = new Set(out.map((a) => a.id));
  for (const a of out) {
    a.parent = linkedParent(a.id, links, ids);
    a.mine = isMine(a, st);
  }
  const now = Date.now();
  for (const a of out) {
    Object.assign(a, healthFlags(a, a._lastReal, a._lastText, now));
    delete a._lastReal;
    delete a._lastText;
  }
  markStalled(out);
  return out;
}

/** A manager whose turn ended (status idle) but whose state is still `working` is waiting for something. If every
 *  worker linked to it has stopped working (done/blocked/stopped/failed) nothing will wake it: `stalled`.
 *  Also sets `workerResultAt` (newest finish among its workers that are not working) and `detailStale` (its summary
 *  line predates that result), so the row does not show an old line as current. Mutates `agents`. */
export function markStalled(agents) {
  const workers = new Map();
  for (const a of agents) {
    if (!a.parent) continue;
    if (!workers.has(a.parent)) workers.set(a.parent, []);
    workers.get(a.parent).push(a);
  }
  for (const a of agents) {
    const ws = workers.get(a.id) || [];
    const finished = ws.filter((w) => w.state !== 'working');
    const latest = finished.reduce((m, w) => Math.max(m, w.lastActivityAt ?? 0), 0);
    a.workerResultAt = latest || null;
    a.workerResult = latest ? finished.find((w) => (w.lastActivityAt ?? 0) === latest).name : null;
    a.detailStale = Boolean(latest) && latest > (a.lastActivityAt ?? 0);
    a.stalled = ws.length > 0 && finished.length === ws.length && a.state === 'working' && a.status === 'idle';
    a.managerStatus = managerStatus(a, ws);
  }
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** What a manager is doing relative to its workers, for its row. Null when it has no workers or is not itself active
 *  (state not `working`). `kind`: waiting (turn ended, workers running), stalled (turn ended, all finished),
 *  running (turn running, workers running), self (turn running, all finished: processing results). Also `tally`
 *  ("6 workers: 0 running, 5 done, 1 blocked") and `names` (running workers, else all, for the tooltip). Pure. */
export function managerStatus(manager, workers) {
  const n = workers.length;
  if (!n) return null;
  const running = workers.filter((w) => w.state === 'working');
  const count = (s) => workers.filter((w) => w.state === s).length;
  const parts = [`${running.length} running`, `${count('done')} done`, `${count('blocked')} blocked`];
  for (const s of ['failed', 'stopped']) if (count(s)) parts.push(`${count(s)} ${s}`);
  const tally = `${plural(n, 'worker')}: ${parts.join(', ')}`;
  const names = (running.length ? running : workers).map((w) => w.name);
  const base = { tally, names };
  if (manager.state !== 'working') return { ...base, kind: null, text: null };
  const idle = manager.status === 'idle';
  if (running.length) return { ...base, kind: idle ? 'waiting' : 'running', text: idle ? `Waiting on ${plural(running.length, 'worker')}` : `${plural(running.length, 'worker')} running` };
  if (idle) return { ...base, kind: 'stalled', text: `Stalled: all ${plural(n, 'worker')} finished, nothing will wake it` };
  return { ...base, kind: 'self', text: `Working itself: all ${plural(n, 'worker')} finished` };
}

/** The manager that started `id`, if the link is usable: the manager is still listed and the chain has no loop. */
export function linkedParent(id, links, ids) {
  const manager = links.get(id);
  if (!manager || manager === id || !ids.has(manager)) return null;
  for (let cur = manager, depth = 0; links.has(cur) && depth < 10; depth++) {
    cur = links.get(cur);
    if (cur === id) return null;
  }
  return manager;
}
