// Demo mode (DEKKI_DEMO=1): fictional agents, fake transcripts and a static terminal, for screenshots and GIFs
// without real names. Never calls `claude`, never reads ~/.dekki, ~/.claude or any real agent: index.js points
// the state file, prompts and transcripts at a temp folder before anything is read, and these routes answer first.
// Everything that would change a real agent (start, stop, delete, upload, open) is refused with a plain message.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { normalise, healthFlags, markStalled, isMine } from './agents.js';
import { readState, writeState } from './state.js';
import { publicAccounts } from './accounts.js';
import { demoChanges, demoChangeFile, demoGroupChanges } from './demo-changes.js';

export const demoEnabled = () => process.env.DEKKI_DEMO === '1';
export const DEMO_PORT = 4350;

/** Accounts of the demo deck: one (default, what a new user sees) unless DEKKI_DEMO_ACCOUNTS=2, which adds two
 *  fictional accounts with empty temp config dirs (nothing real is read or written). */
export function demoAccounts(dir, count = process.env.DEKKI_DEMO_ACCOUNTS) {
  if (!(Number(count) >= 2)) return { accounts: [] };
  const configDir = path.join(dir, 'claude-studio');
  fs.mkdirSync(configDir, { recursive: true });
  return { accounts: [{ id: 'default', label: 'Personal' }, { id: 'studio', label: 'Studio', configDir }] };
}

/** Point every path the deck reads at a temp folder and seed it. Call once, before the server starts. */
export function prepareDemo() {
  if (!process.env.DEKKI_STATE) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dekki-demo-'));
    process.env.DEKKI_STATE = path.join(dir, 'state.json');
  }
  const dir = path.dirname(process.env.DEKKI_STATE);
  const root = path.join(dir, 'Projects');
  for (const [folder, files] of Object.entries({
    'lumen-web': ['src', 'package.json', 'README.md'],
    'orbit-api': ['cmd', 'internal', 'go.mod', 'README.md'],
    'atlas-ios': ['Atlas', 'AtlasTests', 'Atlas.xcodeproj'],
    'docs-site': ['content', 'mkdocs.yml'],
  })) {
    fs.mkdirSync(path.join(root, folder), { recursive: true });
    for (const f of files) { const p = path.join(root, folder, f); if (f.includes('.')) fs.writeFileSync(p, ''); else fs.mkdirSync(p, { recursive: true }); }
  }
  process.env.DEKKI_PROMPTS ||= path.join(dir, 'prompts');
  fs.mkdirSync(process.env.DEKKI_PROMPTS, { recursive: true });
  process.env.DEKKI_PROJECTS_DIR ||= path.join(dir, 'no-transcripts');
  fs.mkdirSync(process.env.DEKKI_PROJECTS_DIR, { recursive: true });
  writeState({ ...readState(), root, ...demoAccounts(dir), activeAccount: 'default' });
  return { root };
}

const MIN = 60000;
const HOUR = 60 * MIN;

// id, name, project, branch, state, status, detail/needs, started/last activity (minutes ago), manager (parent id)
const SPECS = [
  { id: 'a1b2c3d4', name: 'ship-checkout-v2', manager: true, state: 'working', status: 'idle', detail: 'Waiting on checkout-api and checkout-ios', last: 3, touched: ['lumen-web', 'orbit-api'] },
  { id: 'b1000001', name: 'checkout-api', parent: 'a1b2c3d4', project: 'orbit-api', branch: 'checkout-api', state: 'working', status: 'busy', detail: 'Running the payments tests', last: 1 },
  { id: 'b1000002', name: 'checkout-ios', parent: 'a1b2c3d4', project: 'atlas-ios', branch: 'checkout-ios', state: 'blocked', status: 'waiting', needs: 'answer: Use the Apple Pay sandbox or a mocked token?', last: 6 },
  { id: 'b1000003', name: 'checkout-web', parent: 'a1b2c3d4', project: 'lumen-web', branch: 'checkout-web', state: 'done', detail: 'result: new checkout form behind a flag', last: 42 },
  { id: 'b1000004', name: 'checkout-docs', parent: 'a1b2c3d4', project: 'docs-site', branch: 'checkout-docs', state: 'failed', detail: 'failed: docs build needs mkdocs 1.6', last: 55 },
  { id: 'c2d3e4f5', long: true, name: 'fix-login-timeout', project: 'lumen-web', branch: 'fix-login-timeout', state: 'working', status: 'busy', detail: 'Editing src/auth/session.ts', last: 0 },
  { id: 'd3e4f5a6', name: 'refactor-search-index', project: 'orbit-api', branch: 'search-index', state: 'blocked', status: 'waiting', needs: 'answer: Keep the old /v1/search route for one more release?', last: 14 },
  { id: 'e4f5a6b7', name: 'release-notes-draft', project: 'docs-site', branch: 'release-notes', state: 'done', detail: 'result: drafted notes for 2.4.0', last: 95 },
  { id: 'f5a6b7c8', name: 'migrate-db-schema', project: 'orbit-api', branch: 'migrate-schema', state: 'failed', detail: 'failed: migration 0042 is not reversible', last: 180 },
  { id: 'a6b7c8d9', name: 'weekly-triage', manager: true, state: 'working', status: 'idle', detail: 'Triaged 12 issues', last: 25, touched: ['lumen-web'] },
  { id: 'b2000001', name: 'triage-bugs', parent: 'a6b7c8d9', project: 'lumen-web', branch: 'triage-bugs', state: 'done', detail: 'result: 7 bugs labelled', last: 30 },
  { id: 'b2000002', name: 'triage-requests', parent: 'a6b7c8d9', project: 'lumen-web', branch: 'triage-requests', state: 'done', detail: 'result: 5 requests grouped', last: 28 },
  { id: 'c8d9e0f1', name: 'old-spike-websocket', project: 'orbit-api', branch: 'ws-spike', state: 'done', detail: 'result: spike works, not merged', last: 60 * 52 },
];

// Demo-only state change for the motion screenshots (POST /api/demo/advance): step 1 finishes checkout-api and makes
// fix-login-timeout ask a question, so rows change group while the page is open.
// Step 2 (POST /api/demo/advance?step=2): nothing is working any more (every working agent, managers included, is done),
// for the zero-count screenshots. Blocked agents stay, so the Needs you tile keeps a count.
let demoStep = 0;
const STEP1 = {
  b1000001: { state: 'done', status: null, detail: 'result: payments tests green', last: 0 },
  c2d3e4f5: { state: 'blocked', status: 'waiting', needs: 'answer: Should the new setting also apply to refresh tokens?', detail: undefined, last: 0 },
};

/** The fictional agent list, shaped like listAgents() output. Times are relative to now so groups stay realistic. */
export function demoAgents(root, st = readState(), now = Date.now(), step = demoStep) {
  let specs = step >= 1 ? SPECS.map((s) => (STEP1[s.id] ? { ...s, ...STEP1[s.id] } : s)) : SPECS;
  if (step >= 2) specs = specs.map((s) => (s.state === 'working' ? { ...s, state: 'done', status: null, detail: 'result: finished', last: Math.max(s.last, 1) } : s));
  const rows = specs.map((s) => {
    const cwd = s.manager ? root : path.join(root, s.project, '.claude', 'worktrees', s.name);
    const row = { id: s.id, kind: 'background', name: s.name, state: s.state, status: s.status || null, cwd, sessionId: `${s.id}-0000-4000-8000-000000000000`, startedAt: now - (s.last + 40) * MIN };
    const job = s.manager ? { detail: s.detail } : { detail: s.detail, needs: s.needs, worktreePath: cwd, worktreeBranch: s.branch };
    const a = normalise(row, job, now - s.last * MIN, { root, touched: s.touched || [], lastReal: now - s.last * MIN, names: st.names });
    a.empty = false;
    a.parent = s.parent || null;
    return a;
  });
  const owned = rows.filter((a) => !a.parent).map((a) => a.id); // started from the deck: top level; workers nest
  for (const a of rows) a.mine = isMine(a, { owned, others: [] });
  for (const a of rows) Object.assign(a, healthFlags(a, a.lastActivityAt, a.detail ?? '', now));
  markStalled(rows);
  return rows;
}

// ---- fake transcripts ----
const p = (id, text, ts) => ({ id: `u:${id}`, k: 'user', ts, text });
const t = (id, text, ts) => ({ id: `a:${id}`, k: 'text', ts, text });
const tool = (id, name, summary, input, ts, result = 'ok', extra = {}) => ({ id: `t:${id}`, k: 'tool', ts, name, summary, input, result: { text: result, isError: false, truncated: false }, diff: null, agentId: null, ...extra });
const diff = (filePath, lines) => ({ filePath, hunks: [{ header: '@@ -12,6 +12,9 @@', lines }] });

function script(spec, now) {
  const at = (m) => new Date(now - m * MIN).toISOString();
  const e = [];
  e.push(p('1', `Work on "${spec.name}" in ${spec.project || 'the projects folder'}. Keep the change small and tell me when it needs a decision.`, at(spec.last + 38)));
  e.push(t('2', `Starting with a look at the current code.\n\nI will read the entry points first, then change as little as possible.`, at(spec.last + 37)));
  e.push(tool('3', 'Grep', 'handleSession in src', { pattern: 'handleSession', path: 'src' }, at(spec.last + 36), 'src/auth/session.ts:41\nsrc/auth/index.ts:9'));
  e.push(tool('4', 'Read', 'src/auth/session.ts', { file_path: 'src/auth/session.ts' }, at(spec.last + 35), '41  export async function handleSession(req) {\n42    const token = req.cookies.get("sid");\n43    return verify(token, { maxAge: 900 });\n44  }'));
  e.push(tool('5', 'Edit', 'src/auth/session.ts', { file_path: 'src/auth/session.ts' }, at(spec.last + 30), 'The file src/auth/session.ts has been updated.', {
    diff: diff('src/auth/session.ts', ['  export async function handleSession(req) {', '    const token = req.cookies.get("sid");', '-   return verify(token, { maxAge: 900 });', '+   const maxAge = Number(process.env.SESSION_MAX_AGE ?? 3600);', '+   return verify(token, { maxAge });', '  }']),
  }));
  e.push(tool('6', 'Bash', 'npm test -- session', { command: 'npm test -- session' }, at(spec.last + 26), 'PASS src/auth/session.test.ts\n  handleSession\n    ✓ accepts a fresh token (4 ms)\n    ✓ rejects an expired token (2 ms)\n\nTests: 2 passed, 2 total'));
  e.push(t('7', `## What I found\n\n- The timeout was hard-coded to **15 minutes** in \`src/auth/session.ts\`.\n- It now reads \`SESSION_MAX_AGE\` (seconds), default one hour.\n\n| File | Change |\n|---|---|\n| \`src/auth/session.ts\` | configurable max age |\n| \`src/auth/session.test.ts\` | two new cases |\n\n\`\`\`diff\n- return verify(token, { maxAge: 900 });\n+ return verify(token, { maxAge });\n\`\`\``, at(spec.last + 20)));
  if (spec.long) {
    // a longer session (two more turns, several paragraphs each) so History scrolls and the pinned prompt can be seen
    e.push(p('9', 'Good. Now check where else the old 15-minute value is used and list every place, with the file and line.', at(spec.last + 22)));
    for (let i = 0; i < 6; i++) {
      e.push(t(`10${i}`, `### Place ${i + 1}\n\n\`src/${['auth/refresh', 'auth/cookies', 'api/middleware', 'jobs/cleanup', 'web/session-banner', 'docs/auth'][i]}.ts\` still mentions the old limit.\n\nIt reads the value in one place and passes it down to two helpers. Replacing it with the shared setting keeps the three call sites in step, and the existing tests already cover the helper that formats the remaining time. I would change this one in the same commit, so the limit never differs between the cookie and the server check.`, at(spec.last + 21 - i)));
    }
    e.push(p('11', 'Update all of them, then run the whole suite once and tell me the count.', at(spec.last + 12)));
    for (let i = 0; i < 5; i++) {
      e.push(t(`12${i}`, `Step ${i + 1} of 5 done: the setting is read from one helper and the call site passes it on unchanged. I kept the diff small and left the formatting alone so the review stays short.\n\n- the helper has one new line\n- the call site lost its constant\n- the test for this path still passes`, at(spec.last + 11 - i)));
    }
  }
  if (spec.state === 'blocked') e.push(t('8', spec.needs.replace(/^answer: /, 'needs input: '), at(spec.last)));
  else if (spec.state === 'done') e.push(t('8', spec.detail, at(spec.last)));
  else if (spec.state === 'failed') e.push(t('8', spec.detail, at(spec.last)));
  else e.push(t('8', 'Next: run the full suite, then open the branch for review.', at(spec.last)));
  return e;
}

export function demoHistory(id, now = Date.now()) {
  const spec = SPECS.find((s) => s.id === id);
  if (!spec) return null;
  return {
    meta: { title: spec.name, cwd: spec.manager ? '' : `${spec.project}`, gitBranch: spec.branch || null, sessionId: `${id}-0000-4000-8000-000000000000` },
    entries: script(spec, now),
  };
}

function demoStats(id, now = Date.now()) {
  const spec = SPECS.find((s) => s.id === id);
  if (!spec) return null;
  const iso = (m) => new Date(now - m * MIN).toISOString();
  return {
    sessionId: id, cwd: spec.project || '', firstTs: iso(spec.last + 38), lastTs: iso(spec.last), durationMs: 38 * MIN, toolCalls: 34, subagents: spec.manager ? 4 : 1,
    topTools: [['Read', 12], ['Edit', 8], ['Bash', 7], ['Grep', 5], ['Skill', 2]],
    mcp: { 'build-tools': { calls: 3, tools: { compile: 2, lint: 1 } } },
    skills: { 'code-review': { count: 2, slash: 1, sub: 0, first: iso(spec.last + 20), last: iso(spec.last + 5) }, 'write-tests': { count: 1, slash: 0, sub: 1, first: iso(spec.last + 15), last: iso(spec.last + 15) } },
    available: ['code-review', 'write-tests', 'release-notes', 'summarise-pr', 'triage'],
    fromSubagents: { files: 1, toolCalls: 4, skillCalls: 1, mcpCalls: 0 }, live: false,
  };
}

const DEMO_SKILLS = {
  sessions: 13, sessionsWithListing: 13, projects: ['atlas-ios', 'docs-site', 'lumen-web', 'orbit-api'], rootProject: 'Projects',
  skills: [
    { name: 'code-review', uses: 41, sessions: 11, availableIn: 13, lastUsed: new Date(Date.now() - 20 * MIN).toISOString() },
    { name: 'write-tests', uses: 27, sessions: 9, availableIn: 13, lastUsed: new Date(Date.now() - 3 * HOUR).toISOString() },
    { name: 'summarise-pr', uses: 12, sessions: 6, availableIn: 13, lastUsed: new Date(Date.now() - 26 * HOUR).toISOString() },
    { name: 'release-notes', uses: 4, sessions: 2, availableIn: 13, lastUsed: new Date(Date.now() - 72 * HOUR).toISOString() },
    { name: 'triage', uses: 0, sessions: 0, availableIn: 13, lastUsed: null },
  ],
};

const refuse = (what) => `Demo mode: ${what} is switched off. Nothing was changed.`;

/** Routes that run before the real ones. Anything that could reach a real agent or file is answered or refused here. */
export function demoRoutes(root) {
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  return async (req, res, url) => {
    const pth = url.pathname;
    if (req.method === 'POST' && pth === '/api/demo/advance') { demoStep = url.searchParams.get('step') === '2' ? 2 : 1; json(res, 200, { ok: true, step: demoStep }); return true; }
    if (req.method === 'GET' && pth === '/api/agents') {
      const st = readState();
      json(res, 200, { agents: demoAgents(root, st), pinned: st.pinned, archived: st.archived, account: publicAccounts(st).active });
      return true;
    }
    const sub = /^\/api\/agents\/([^/]+)\/(history|stats|remove-check|stop)$/.exec(pth);
    if (sub) {
      if (sub[2] === 'history' && req.method === 'GET') { const h = demoHistory(sub[1]); json(res, h ? 200 : 404, h ? { status: 'ok', ...h } : { status: 'unknown' }); return true; }
      if (sub[2] === 'stats' && req.method === 'GET') { const s = demoStats(sub[1]); json(res, 200, s ? { status: 'ok', stats: s } : { status: 'expired' }); return true; }
      if (sub[2] === 'stop') { json(res, 400, { ok: false, status: 400, error: refuse('Stop') }); return true; }
      if (sub[2] === 'remove-check') {
        const a = demoAgents(root).find((x) => x.id === sub[1]);
        json(res, a ? 200 : 404, a ? { id: a.id, name: a.name, running: a.state === 'working', worktreePath: a.worktreePath, dirty: a.state === 'failed' ? ['src/db/migrations/0042_split_orders.sql', 'src/db/schema.ts'] : [] } : { error: 'Agent not found.' });
        return true;
      }
    }
    const cgw = /^\/api\/agents\/([^/]+)\/changes\/workers$/.exec(pth);
    if (cgw && req.method === 'GET') {
      const scope = url.searchParams.get('scope') === 'uncommitted' ? 'uncommitted' : 'all';
      const ids = (url.searchParams.get('ids') || '').split(',');
      json(res, 200, demoGroupChanges(ids.map((id) => SPECS.find((s) => s.id === id)).filter(Boolean), scope));
      return true;
    }
    const chg = /^\/api\/agents\/([^/]+)\/changes(\/file)?$/.exec(pth);
    if (chg && req.method === 'GET') {
      const spec = SPECS.find((s) => s.id === chg[1]);
      if (!spec) { json(res, 400, { error: 'bad agent id' }); return true; }
      const scope = url.searchParams.get('scope') === 'uncommitted' ? 'uncommitted' : 'all';
      json(res, 200, chg[2] ? demoChangeFile(spec, url.searchParams.get('path'), scope) : demoChanges(spec.manager ? null : spec, scope));
      return true;
    }
    if (req.method === 'GET' && pth === '/api/skills') { json(res, 200, DEMO_SKILLS); return true; }
    if (req.method === 'POST' && pth === '/api/agents') { json(res, 400, { ok: false, error: refuse('starting agents') }); return true; }
    if (req.method === 'DELETE' && /^\/api\/agents\//.test(pth)) { json(res, 400, { ok: false, status: 400, error: refuse('Delete') }); return true; }
    if (req.method === 'POST' && (pth === '/api/open' || pth === '/api/upload' || pth === '/api/prompts/improve' || pth === '/api/root/pick' || pth === '/api/docs/pick' || pth === '/api/setup/apply' || pth === '/api/setup/health')) { json(res, 400, { ok: false, error: refuse('this action') }); return true; }
    return false;
  };
}

// ---- WebSocket stand-ins: History (/ws/history) and Session (/ws/attach) ----
const wss = new WebSocketServer({ noServer: true });
const idOf = (req) => new URL(req.url, 'http://x').searchParams.get('id');
const refuseSocket = (socket) => { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); socket.destroy(); };

export function demoHistoryUpgrade(req, socket, head) {
  const h = demoHistory(idOf(req));
  if (!h) return refuseSocket(socket);
  wss.handleUpgrade(req, socket, head, (ws) => ws.send(JSON.stringify({ type: 'init', meta: h.meta, entries: h.entries })));
}

const ESC = '\x1b[';
const c = (n, s) => `${ESC}${n}m${s}${ESC}0m`;
function demoScreen(id) {
  const spec = SPECS.find((s) => s.id === id);
  const lines = [
    `${c('38;5;105', '✻')} ${c('1', 'Claude Code')} ${c('2', '(demo screen: nothing here is real)')}`,
    '',
    `${c('2', 'agent')}  ${spec?.name ?? id}      ${c('2', 'state')}  ${spec?.state ?? '?'}`,
    '',
    `${c('2', '>')} Work on "${spec?.name ?? id}". Keep the change small.`,
    '',
    `${c('32', '●')} I will read the entry points first.`,
    `  ${c('2', '⎿')} Read(src/auth/session.ts)`,
    `${c('32', '●')} Update(src/auth/session.ts)`,
    `  ${c('2', '⎿')} ${c('32', '+ const maxAge = Number(process.env.SESSION_MAX_AGE ?? 3600);')}`,
    `  ${c('2', '⎿')} ${c('31', '- return verify(token, { maxAge: 900 });')}`,
    `${c('33', '●')} ${c('33', 'Needs a decision:')} keep the old route for one release?`,
    '',
    `${c('2', 'ANSI palette')}`,
    [30, 31, 32, 33, 34, 35, 36, 37].map((n) => `${ESC}${n}m██${ESC}0m`).join(' ') + '   ' + [90, 91, 92, 93, 94, 95, 96, 97].map((n) => `${ESC}${n}m██${ESC}0m`).join(' '),
    '',
    `${c('2', '─'.repeat(60))}`,
    `> ${c('7', ' ')}`,
  ];
  return `${ESC}2J${ESC}H${lines.join('\r\n')}`;
}

export function demoAttachUpgrade(req, socket, head) {
  const id = idOf(req);
  if (!SPECS.some((s) => s.id === id)) return refuseSocket(socket);
  wss.handleUpgrade(req, socket, head, (ws) => ws.send(JSON.stringify({ type: 'output', data: demoScreen(id) }))); // input is ignored
}
