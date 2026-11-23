// Changes tab backend: what an agent changed in its git worktree. STRICTLY READ-ONLY.
// Only the git subcommands in GIT_READ run, always via execFile with an argument array (never a shell string),
// always with --no-optional-locks + GIT_OPTIONAL_LOCKS=0 so reading never rewrites the index or takes a lock, with a
// timeout and output caps. Nothing here writes, checks out, fetches or touches refs. Pure parsers are exported for tests.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const GIT_READ = new Set(['rev-parse', 'symbolic-ref', 'merge-base', 'diff', 'ls-files', 'status', 'log']);
export const GIT_TIMEOUT_MS = 10000;
export const MAX_DIFF_BYTES = 2 * 1024 * 1024; // per diff
export const MAX_DIFF_LINES = 3000; // shown per file; the rest is "diff truncated, N more lines"
export const MAX_FILES = 500;
const MAX_UNTRACKED_BYTES = 1024 * 1024; // an untracked file bigger than this is counted by its first MB only

export const _exec = { fn: execFile }; // test seam: record the argument lists

/** Validate and build the full git argv. Throws for anything that is not a plain read. */
export function gitArgs(sub, rest = []) {
  if (!GIT_READ.has(sub)) throw new Error(`git ${sub} is not allowed (read-only)`);
  for (const a of rest) {
    if (typeof a !== 'string') throw new Error('git arguments must be strings');
    // diff can write a file (--output) and run external programs (--ext-diff, --textconv helpers): never.
    if (/^--(output|ext-diff|textconv|no-index|exec)/.test(a) && a !== '--no-ext-diff' && a !== '--no-textconv') throw new Error(`git option ${a} is not allowed`);
  }
  return ['--no-optional-locks', '-c', 'core.fsmonitor=false', sub, ...rest];
}

function git(cwd, sub, rest, { maxBuffer = 4 * 1024 * 1024 } = {}) {
  let argv;
  try { argv = gitArgs(sub, rest); } catch (e) { return Promise.resolve({ ok: false, code: 'DENIED', stdout: '', stderr: e.message, capped: false }); }
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  delete env.GIT_EXTERNAL_DIFF; delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE;
  return new Promise((resolve) => {
    _exec.fn('git', argv, { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
      const capped = err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), capped });
    });
  });
}

// ---------- pure parsers ----------

const STATUS_NAME = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added', T: 'modified' };

/** `git diff --name-status -z`: "M\0path\0", renames "R100\0old\0new\0". */
export function parseNameStatus(out) {
  const t = String(out || '').split('\0');
  const rows = [];
  for (let i = 0; i < t.length; i++) {
    const code = t[i];
    if (!code) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = t[++i]; const p = t[++i];
      if (p) rows.push({ status: STATUS_NAME[letter], path: p, oldPath: letter === 'R' ? oldPath : null });
    } else {
      const p = t[++i];
      if (p) rows.push({ status: STATUS_NAME[letter] || 'modified', path: p, oldPath: null });
    }
  }
  return rows;
}

/** `git diff --numstat -z`: "12\t3\tpath\0", binary "-\t-\tpath\0", renames "1\t0\t\0old\0new\0". */
export function parseNumstat(out) {
  const t = String(out || '').split('\0');
  const rows = [];
  for (let i = 0; i < t.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(t[i]);
    if (!m) continue;
    const binary = m[1] === '-';
    let p = m[3]; let oldPath = null;
    if (p === '') { oldPath = t[++i]; p = t[++i]; }
    if (!p) continue;
    rows.push({ path: p, oldPath, add: binary ? 0 : Number(m[1]), del: binary ? 0 : Number(m[2]), binary });
  }
  return rows;
}

/** Relative path inside the worktree, or null. No absolute paths, no "..", no empty/"." segments, no NUL. */
export function validateRelPath(p) {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0')) return null;
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) return null;
  const parts = p.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return null;
  return p;
}

/** Parse one file's unified diff into hunks. Returns { binary, hunks:[{ header, lines:[{ t:'add'|'del'|'ctx'|'meta', text, o, n }] }] }. */
export function parseUnifiedDiff(text) {
  const out = { binary: false, hunks: [] };
  let h = null; let o = 0; let n = 0;
  for (const raw of String(text || '').split('\n')) {
    if (!h && (/^Binary files .* differ$/.test(raw) || raw === 'GIT binary patch')) { out.binary = true; break; }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (m) { h = { header: raw, lines: [] }; out.hunks.push(h); o = Number(m[1]); n = Number(m[2]); continue; }
    if (!h) continue; // file header lines (diff --git, index, ---, +++)
    const c = raw[0];
    if (c === '+') h.lines.push({ t: 'add', text: raw.slice(1), o: null, n: n++ });
    else if (c === '-') h.lines.push({ t: 'del', text: raw.slice(1), o: o++, n: null });
    else if (c === ' ') h.lines.push({ t: 'ctx', text: raw.slice(1), o: o++, n: n++ });
    else if (c === '\\') h.lines.push({ t: 'meta', text: raw.slice(2), o: null, n: null });
    // anything else (blank line at the end of the output) is ignored
  }
  return out;
}

/** Cap a parsed diff at `max` lines. Returns { hunks, truncated: null | { moreLines, atLeast } }. */
export function capHunks(hunks, max = MAX_DIFF_LINES, atLeast = false) {
  let left = max; let dropped = 0; const kept = [];
  for (const h of hunks) {
    if (left <= 0) { dropped += h.lines.length + 1; continue; }
    if (h.lines.length <= left) { kept.push(h); left -= h.lines.length; continue; }
    kept.push({ header: h.header, lines: h.lines.slice(0, left) });
    dropped += h.lines.length - left; left = 0;
  }
  return { hunks: kept, truncated: dropped || atLeast ? { moreLines: dropped, atLeast } : null };
}

/** Synthetic diff for an untracked file (all lines added). */
export function addedDiff(content) {
  const lines = String(content).split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length) return { binary: false, hunks: [] };
  return { binary: false, hunks: [{ header: `@@ -0,0 +1,${lines.length} @@`, lines: lines.map((text, i) => ({ t: 'add', text, o: null, n: i + 1 })) }] };
}

export const countLines = (buf) => {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  return buf.length && buf[buf.length - 1] !== 10 ? n + 1 : n;
};
const looksBinary = (buf) => buf.subarray(0, 8000).includes(0);

// ---------- git state ----------

const BASE_CANDIDATES = ['develop', 'origin/develop', 'main', 'origin/main', 'master', 'origin/master'];

async function revOk(cwd, ref) {
  const r = await git(cwd, 'rev-parse', ['--verify', '--quiet', `${ref}^{commit}`]);
  return r.ok ? r.stdout.trim() : null;
}

/** The repo's default branch ref: origin/HEAD's target, then develop, main, master (local, then origin/). */
export async function defaultBaseRef(cwd) {
  const s = await git(cwd, 'symbolic-ref', ['-q', 'refs/remotes/origin/HEAD']);
  if (s.ok) {
    const name = s.stdout.trim().replace(/^refs\/remotes\//, '');
    if (name && await revOk(cwd, name)) return name;
  }
  for (const c of BASE_CANDIDATES) if (await revOk(cwd, c)) return c;
  return null;
}

/** Work tree root of `dir`, or null when it is not inside a git work tree. */
export async function gitRoot(dir) {
  if (!dir || typeof dir !== 'string') return null;
  try { if (!fs.statSync(dir).isDirectory()) return null; } catch { return null; }
  const r = await git(dir, 'rev-parse', ['--is-inside-work-tree', '--show-toplevel']);
  if (!r.ok) return null;
  const [inside, top] = r.stdout.split('\n');
  return inside === 'true' && top ? top.trim() : null;
}

/**
 * Summary for one worktree. scope 'all' = since the merge-base with the default branch (committed + uncommitted +
 * untracked); 'uncommitted' = against HEAD. Shape: { status:'ok', branch, base:{name,sha}|null, note, scope, files, totals, truncatedFiles }
 * or { status:'none', reason } when `dir` is no git work tree.
 */
export async function listChanges(dir, scope = 'all') {
  const top = await gitRoot(dir);
  if (!top) return { status: 'none', reason: 'not-git' };
  const head = await git(top, 'log', ['-n', '1', '--format=%H%x09%h%x09%s']);
  if (!head.ok || !head.stdout.trim()) {
    return { status: 'ok', branch: await branchName(top), base: null, note: 'This repository has no commits yet.', scope, files: [], totals: { files: 0, add: 0, del: 0 }, truncatedFiles: false, head: null };
  }
  const [headSha, headShort, ...subj] = head.stdout.trim().split('\t');
  let base = null; let note = null;
  if (scope === 'all') {
    const ref = await defaultBaseRef(top);
    if (ref) {
      const mb = await git(top, 'merge-base', ['HEAD', ref]);
      if (mb.ok && mb.stdout.trim()) base = { name: ref, sha: mb.stdout.trim() };
    }
    if (!base) note = 'No base branch found (develop, main or master), so only uncommitted changes are shown.';
  }
  const against = base?.sha || 'HEAD';
  const common = ['-M', '--no-ext-diff', '--no-textconv', '-z', against];
  const [ns, nu, un] = await Promise.all([
    git(top, 'diff', ['--name-status', ...common]),
    git(top, 'diff', ['--numstat', ...common]),
    git(top, 'ls-files', ['--others', '--exclude-standard', '-z']),
  ]);
  const stats = new Map(parseNumstat(nu.stdout).map((r) => [r.path, r]));
  const files = [];
  for (const r of parseNameStatus(ns.stdout)) {
    const s = stats.get(r.path);
    files.push({ path: r.path, oldPath: r.oldPath, status: r.status, add: s?.add ?? 0, del: s?.del ?? 0, binary: Boolean(s?.binary), untracked: false });
  }
  const seen = new Set(files.map((f) => f.path));
  const untracked = un.stdout.split('\0').filter((p) => p && !seen.has(p));
  let truncatedFiles = files.length > MAX_FILES || untracked.length + files.length > MAX_FILES;
  files.length = Math.min(files.length, MAX_FILES);
  for (const p of untracked.slice(0, Math.max(0, MAX_FILES - files.length))) {
    const info = readUntracked(top, p);
    files.push({ path: p, oldPath: null, status: 'added', add: info.add, del: 0, binary: info.binary, untracked: true });
  }
  for (const f of files) f.mtime = statMtime(top, f.path, f.status);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const totals = { files: files.length, add: files.reduce((s, f) => s + f.add, 0), del: files.reduce((s, f) => s + f.del, 0) };
  return { status: 'ok', branch: await branchName(top), base, note, scope, files, totals, truncatedFiles, head: { sha: headShort, subject: subj.join('\t') } };
}

async function branchName(top) {
  const b = await git(top, 'symbolic-ref', ['--short', '-q', 'HEAD']);
  if (b.ok && b.stdout.trim()) return b.stdout.trim();
  const s = await git(top, 'rev-parse', ['--short', 'HEAD']);
  return s.ok ? `detached at ${s.stdout.trim()}` : null;
}

function statMtime(top, rel, status) {
  if (status === 'deleted') return 0;
  try { return Math.round(fs.lstatSync(path.join(top, rel)).mtimeMs); } catch { return 0; }
}

/** Resolve an untracked file inside the work tree without following symlinks out of it. Returns the absolute path or null. */
function safeFile(top, rel) {
  if (!validateRelPath(rel)) return null;
  const abs = path.join(top, rel);
  try {
    const realTop = fs.realpathSync(top);
    const realDir = fs.realpathSync(path.dirname(abs));
    if (realDir !== realTop && !realDir.startsWith(realTop + path.sep)) return null;
    return path.join(realDir, path.basename(abs));
  } catch { return null; }
}

function readUntracked(top, rel) {
  const abs = safeFile(top, rel);
  if (!abs) return { add: 0, binary: false };
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return { add: 1, binary: false, symlink: true };
    if (!st.isFile()) return { add: 0, binary: false };
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, MAX_UNTRACKED_BYTES));
      fs.readSync(fd, buf, 0, buf.length, 0);
      if (looksBinary(buf)) return { add: 0, binary: true };
      return { add: countLines(buf), binary: false, buf, size: st.size };
    } finally { fs.closeSync(fd); }
  } catch { return { add: 0, binary: false }; }
}

/** One file's diff. `relPath` must be validated by the caller (and is checked against the current change list). */
export async function fileDiff(dir, relPath, scope = 'all') {
  const rel = validateRelPath(relPath);
  if (!rel) return { status: 'bad-path' };
  const list = await listChanges(dir, scope);
  if (list.status !== 'ok') return { status: 'none', reason: list.reason };
  const f = list.files.find((x) => x.path === rel);
  if (!f) return { status: 'unchanged' };
  const meta = { path: f.path, oldPath: f.oldPath, fileStatus: f.status, add: f.add, del: f.del };
  if (f.binary) return { status: 'ok', ...meta, binary: true, hunks: [], truncated: null };
  const top = await gitRoot(dir);
  if (f.untracked) {
    const info = readUntracked(top, f.path);
    if (info.binary) return { status: 'ok', ...meta, binary: true, hunks: [], truncated: null };
    if (info.symlink) {
      let target = '';
      try { target = fs.readlinkSync(path.join(top, f.path)); } catch { /* gone */ }
      return { status: 'ok', ...meta, binary: false, ...capHunks(addedDiff(target).hunks) };
    }
    const d = capHunks(addedDiff(info.buf ? info.buf.toString('utf8') : '').hunks, MAX_DIFF_LINES, info.size > MAX_UNTRACKED_BYTES);
    if (d.truncated && info.size > MAX_UNTRACKED_BYTES) d.truncated.moreLines = Math.max(0, f.add - MAX_DIFF_LINES);
    return { status: 'ok', ...meta, binary: false, ...d };
  }
  const against = list.base?.sha || 'HEAD';
  const specs = f.oldPath ? [f.oldPath, f.path] : [f.path];
  const r = await git(top, 'diff', ['-M', '--no-ext-diff', '--no-textconv', '--unified=3', against, '--', ...specs], { maxBuffer: MAX_DIFF_BYTES });
  if (!r.ok && !r.capped) return { status: 'error', error: 'git diff failed' };
  const parsed = parseUnifiedDiff(r.stdout);
  if (parsed.binary) return { status: 'ok', ...meta, binary: true, hunks: [], truncated: null };
  if (r.capped && parsed.hunks.length) parsed.hunks.at(-1).lines.pop(); // the last line may be cut in half
  return { status: 'ok', ...meta, binary: false, ...capHunks(parsed.hunks, MAX_DIFF_LINES, r.capped) };
}

/** Directory to inspect for an agent: its worktree, else its cwd. */
export const agentDir = (agent) => agent?.worktreePath || agent?.cwd || null;

export const MAX_WORKERS = 30;

/**
 * Manager view: one read-only listChanges() pass per entry. `entries` = [{ id, name, role:'manager'|'worker', dir }].
 * Entries whose dir is no git work tree are left out. Returns { status:'ok', scope, groups:[{ id, name, role, branch, base,
 * totals, files, truncatedFiles }] } with the manager's own group first, then workers in the given order.
 * `list` is a test seam (default: listChanges).
 */
export async function listGroupChanges(entries, scope = 'all', list = listChanges) {
  const rows = await Promise.all(entries.slice(0, MAX_WORKERS).map(async (e) => ({ e, r: await list(e.dir, scope) })));
  const groups = rows.filter(({ r }) => r.status === 'ok').map(({ e, r }) => ({
    id: e.id, name: e.name, role: e.role, branch: r.branch, base: r.base, totals: r.totals, files: r.files, truncatedFiles: r.truncatedFiles,
  }));
  groups.sort((a, b) => (b.role === 'manager') - (a.role === 'manager')); // stable: workers keep their order
  return { status: 'ok', scope, groups };
}
