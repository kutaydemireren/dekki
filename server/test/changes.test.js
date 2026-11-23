import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import {
  parseNameStatus, parseNumstat, parseUnifiedDiff, validateRelPath, capHunks, addedDiff, countLines,
  gitArgs, GIT_READ, listChanges, fileDiff, gitRoot, _exec,
} from '../changes.js';

// ---------- pure parsers ----------

test('parseNameStatus: add, modify, delete, rename (-z)', () => {
  const out = 'A\0src/new.js\0M\0src/a.js\0D\0old.txt\0R087\0docs/a.md\0docs/b.md\0';
  assert.deepEqual(parseNameStatus(out), [
    { status: 'added', path: 'src/new.js', oldPath: null },
    { status: 'modified', path: 'src/a.js', oldPath: null },
    { status: 'deleted', path: 'old.txt', oldPath: null },
    { status: 'renamed', path: 'docs/b.md', oldPath: 'docs/a.md' },
  ]);
  assert.deepEqual(parseNameStatus(''), []);
});

test('parseNumstat: counts, binary, rename (-z)', () => {
  const out = '12\t3\tsrc/a.js\0-\t-\timg/logo.png\x001\t0\t\0docs/a.md\0docs/b.md\0';
  assert.deepEqual(parseNumstat(out), [
    { path: 'src/a.js', oldPath: null, add: 12, del: 3, binary: false },
    { path: 'img/logo.png', oldPath: null, add: 0, del: 0, binary: true },
    { path: 'docs/b.md', oldPath: 'docs/a.md', add: 1, del: 0, binary: false },
  ]);
});

test('parseUnifiedDiff: hunks, line numbers, no-newline marker, binary', () => {
  const d = parseUnifiedDiff([
    'diff --git a/x b/x', 'index 1..2 100644', '--- a/x', '+++ b/x',
    '@@ -10,3 +10,4 @@ fn()', ' keep', '-gone', '+new1', '+new2', ' tail', '\\ No newline at end of file', '',
  ].join('\n'));
  assert.equal(d.binary, false);
  assert.equal(d.hunks.length, 1);
  assert.equal(d.hunks[0].header, '@@ -10,3 +10,4 @@ fn()');
  assert.deepEqual(d.hunks[0].lines.map((l) => [l.t, l.o, l.n]), [['ctx', 10, 10], ['del', 11, null], ['add', null, 11], ['add', null, 12], ['ctx', 12, 13], ['meta', null, null]]);
  assert.equal(d.hunks[0].lines[1].text, 'gone');
  assert.equal(parseUnifiedDiff('diff --git a/p b/p\nBinary files a/p and b/p differ\n').binary, true);
  // a diff line that itself starts with "--- " or "+++ " inside a hunk is content, not a header
  const h = parseUnifiedDiff('@@ -1,1 +1,1 @@\n--- a\n+++ b\n');
  assert.deepEqual(h.hunks[0].lines.map((l) => l.t), ['del', 'add']);
});

test('capHunks: truncates and counts the rest', () => {
  const lines = (n) => Array.from({ length: n }, (_, i) => ({ t: 'add', text: String(i), o: null, n: i + 1 }));
  const r = capHunks([{ header: '@@ a', lines: lines(5) }, { header: '@@ b', lines: lines(10) }], 8);
  assert.equal(r.hunks.reduce((s, h) => s + h.lines.length, 0), 8);
  assert.deepEqual(r.truncated, { moreLines: 7, atLeast: false });
  assert.equal(capHunks([{ header: '@@ a', lines: lines(3) }], 8).truncated, null);
});

test('addedDiff and countLines', () => {
  assert.equal(addedDiff('a\nb\n').hunks[0].lines.length, 2);
  assert.equal(addedDiff('').hunks.length, 0);
  assert.equal(countLines(Buffer.from('a\nb')), 2);
  assert.equal(countLines(Buffer.from('a\nb\n')), 2);
});

test('validateRelPath: only relative paths inside the worktree', () => {
  for (const ok of ['a.js', 'src/a/b.js', 'dir with space/f.txt', '.github/x.yml', '-weird']) assert.equal(validateRelPath(ok), ok);
  for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a/..', './a', 'a//b', 'a/./b', 'C:\\x', '\\x', 'a\0b', null, undefined, 5, 'a'.repeat(5000)]) assert.equal(validateRelPath(bad), null, String(bad));
});

test('gitArgs: only read subcommands, never a write or an output option', () => {
  for (const s of GIT_READ) assert.deepEqual(gitArgs(s, ['x']).slice(0, 4), ['--no-optional-locks', '-c', 'core.fsmonitor=false', s]);
  for (const bad of ['checkout', 'fetch', 'pull', 'push', 'commit', 'add', 'reset', 'update-ref', 'gc', 'config', 'stash', 'branch', 'clean', 'rm', 'mv', 'restore', 'switch', 'merge', 'rebase', 'tag', 'worktree', 'remote', 'apply', 'prune', 'repack', 'init']) {
    assert.throws(() => gitArgs(bad, []), /not allowed/, bad);
  }
  for (const opt of ['--output=/tmp/x', '--output', '--ext-diff', '--textconv', '--no-index']) assert.throws(() => gitArgs('diff', [opt]), /not allowed/, opt);
});

// ---------- a throwaway repo ----------

const sh = (cwd, ...a) => execFileSync('git', a, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'changes-test-')));
const repo = path.join(tmp, 'repo');
const notRepo = path.join(tmp, 'plain');
fs.mkdirSync(repo); fs.mkdirSync(notRepo);
const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };

const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
sh(repo, 'init', '-q', '-b', 'main');
w('keep.txt', 'keep\n'); w('src/app.js', 'a\nb\nc\n'); w('docs/old-name.md', body); w('gone.txt', 'bye\n'); w('img/pic.png', Buffer.from([0x89, 0x50, 0, 1, 2, 3]));
sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'base');
sh(repo, 'checkout', '-q', '-b', 'feature');
w('src/app.js', 'a\nB\nc\nd\n'); // committed modify
sh(repo, 'mv', 'docs/old-name.md', 'docs/new-name.md');
sh(repo, 'rm', '-q', 'gone.txt');
sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'feature work');
w('src/app.js', 'a\nB\nc\nd\ne\n'); // uncommitted modify on top
w('src/fresh.js', 'x\ny\n'); // untracked text
w('img/pic.png', Buffer.from([0x89, 0x50, 0, 9, 9, 9, 9])); // uncommitted binary change
w('img/new.bin', Buffer.from([0, 0, 0, 1])); // untracked binary
const mainSha = sh(repo, 'rev-parse', 'main').trim();

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const snapshot = () => sh(repo, 'status', '--porcelain=v1') + sh(repo, 'rev-parse', 'HEAD') + fs.readFileSync(path.join(repo, '.git', 'index')).toString('hex');

test('listChanges all: committed + uncommitted + untracked vs merge-base', async () => {
  const before = snapshot();
  const r = await listChanges(repo, 'all');
  assert.equal(r.status, 'ok');
  assert.equal(r.branch, 'feature');
  assert.equal(r.base.name, 'main');
  assert.equal(r.base.sha, mainSha);
  const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
  assert.equal(by['src/app.js'].status, 'modified');
  assert.equal(by['src/app.js'].add, 3); // B, d, e relative to the base (a b c)
  assert.equal(by['src/app.js'].del, 1);
  assert.equal(by['docs/new-name.md'].status, 'renamed');
  assert.equal(by['docs/new-name.md'].oldPath, 'docs/old-name.md');
  assert.equal(by['gone.txt'].status, 'deleted');
  assert.equal(by['gone.txt'].del, 1);
  assert.equal(by['src/fresh.js'].status, 'added');
  assert.equal(by['src/fresh.js'].untracked, true);
  assert.equal(by['src/fresh.js'].add, 2);
  assert.equal(by['img/pic.png'].binary, true);
  assert.equal(by['img/new.bin'].binary, true);
  assert.equal(r.totals.files, r.files.length);
  assert.equal(r.totals.add, r.files.reduce((s, f) => s + f.add, 0));
  assert.equal(snapshot(), before, 'reading must not change the repo, index included');
});

test('listChanges uncommitted: against HEAD only', async () => {
  const r = await listChanges(repo, 'uncommitted');
  const paths = r.files.map((f) => f.path);
  assert.ok(paths.includes('src/app.js') && paths.includes('src/fresh.js') && paths.includes('img/pic.png'));
  assert.ok(!paths.includes('gone.txt') && !paths.includes('docs/new-name.md'));
  assert.equal(r.files.find((f) => f.path === 'src/app.js').add, 1);
});

test('no base branch: only uncommitted changes, with a note', async () => {
  const solo = path.join(tmp, 'solo');
  fs.mkdirSync(solo);
  sh(solo, 'init', '-q', '-b', 'trunk');
  fs.writeFileSync(path.join(solo, 'a.txt'), '1\n'); sh(solo, 'add', '-A'); sh(solo, 'commit', '-q', '-m', 'one');
  fs.writeFileSync(path.join(solo, 'a.txt'), '1\n2\n');
  const r = await listChanges(solo, 'all');
  assert.equal(r.base, null);
  assert.match(r.note, /only uncommitted/);
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].add, 1);
});

test('not a git directory: none, no error', async () => {
  assert.equal(await gitRoot(notRepo), null);
  assert.deepEqual(await listChanges(notRepo), { status: 'none', reason: 'not-git' });
  assert.equal((await listChanges(path.join(tmp, 'missing'))).status, 'none');
});

test('fileDiff: tracked, renamed, deleted, untracked, binary', async () => {
  const app = await fileDiff(repo, 'src/app.js', 'all');
  assert.equal(app.status, 'ok');
  assert.equal(app.hunks.length, 1);
  assert.deepEqual(app.hunks[0].lines.filter((l) => l.t !== 'ctx').map((l) => `${l.t}:${l.text}`), ['del:b', 'add:B', 'add:d', 'add:e']);
  const ren = await fileDiff(repo, 'docs/new-name.md', 'all');
  assert.equal(ren.fileStatus, 'renamed');
  assert.equal(ren.oldPath, 'docs/old-name.md');
  assert.equal(ren.hunks.length, 0); // pure rename: no content change
  const del = await fileDiff(repo, 'gone.txt', 'all');
  assert.deepEqual(del.hunks[0].lines.map((l) => l.t), ['del']);
  const fresh = await fileDiff(repo, 'src/fresh.js', 'all');
  assert.deepEqual(fresh.hunks[0].lines.map((l) => l.text), ['x', 'y']);
  const bin = await fileDiff(repo, 'img/pic.png', 'all');
  assert.equal(bin.binary, true);
  assert.deepEqual(bin.hunks, []);
  assert.equal((await fileDiff(repo, 'img/new.bin', 'all')).binary, true);
  assert.equal((await fileDiff(repo, 'keep.txt', 'all')).status, 'unchanged');
});

test('fileDiff: bad paths are refused, untracked symlink out of the tree is not followed', async () => {
  for (const bad of ['../x', '/etc/passwd', 'a/../../b', '']) assert.equal((await fileDiff(repo, bad)).status, 'bad-path', bad);
  fs.writeFileSync(path.join(tmp, 'outside.txt'), 'secret\n');
  fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(repo, 'link.txt'));
  const d = await fileDiff(repo, 'link.txt', 'all');
  assert.equal(d.status, 'ok');
  assert.ok(!JSON.stringify(d).includes('secret'), 'symlink content must not be read');
  fs.symlinkSync(tmp, path.join(repo, 'linkdir'));
  assert.ok(!JSON.stringify(await listChanges(repo, 'all')).includes('secret'));
  fs.rmSync(path.join(repo, 'link.txt')); fs.rmSync(path.join(repo, 'linkdir'));
});

test('large diff is truncated with a count of the remaining lines', async () => {
  const big = Array.from({ length: 5000 }, (_, i) => `row ${i}`).join('\n') + '\n';
  w('big.txt', big); sh(repo, 'add', 'big.txt');
  const d = await fileDiff(repo, 'big.txt', 'uncommitted');
  const shown = d.hunks.reduce((s, h) => s + h.lines.length, 0);
  assert.equal(shown, 3000);
  assert.deepEqual(d.truncated, { moreLines: 2000, atLeast: false });
  sh(repo, 'rm', '-q', '--cached', 'big.txt'); fs.rmSync(path.join(repo, 'big.txt'));
});

test('every git call is a read subcommand, array form, with no-optional-locks', async () => {
  const seen = [];
  const real = _exec.fn;
  _exec.fn = (file, argv, opts, cb) => { seen.push({ file, argv, env: opts.env }); return real(file, argv, opts, cb); };
  try {
    await listChanges(repo, 'all'); await listChanges(repo, 'uncommitted'); await fileDiff(repo, 'src/app.js'); await fileDiff(repo, 'docs/new-name.md');
  } finally { _exec.fn = real; }
  assert.ok(seen.length > 10);
  for (const c of seen) {
    assert.equal(c.file, 'git');
    assert.ok(Array.isArray(c.argv));
    assert.equal(c.argv[0], '--no-optional-locks');
    assert.ok(GIT_READ.has(c.argv[3]), `subcommand ${c.argv[3]}`);
    assert.equal(c.env.GIT_OPTIONAL_LOCKS, '0');
  }
});

// ---------- routes, against a fake `claude` that lists one agent working in the repo ----------

test('routes: /changes and /changes/file through the real router', async () => {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const rows = [
    { id: 'aaaaaaa1', kind: 'background', name: 'in-repo', state: 'done', cwd: repo, sessionId: null },
    { id: 'aaaaaaa2', kind: 'background', name: 'no-git', state: 'done', cwd: notRepo, sessionId: null },
  ];
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(rows))});\n`, { mode: 0o755 });
  const oldPath = process.env.PATH; const oldState = process.env.DEKKI_STATE;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  process.env.DEKKI_STATE = path.join(tmp, 'state.json');
  const { apiRoutes } = await import('../routes.js');
  const handler = apiRoutes();
  const server = http.createServer(async (rq, rs) => { if (!(await handler(rq, rs, new URL(rq.url, 'http://x')))) { rs.writeHead(404); rs.end(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const get = (p) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ code: res.statusCode, json: JSON.parse(b) })); }).on('error', reject));
  try {
    const list = await get('/api/agents/aaaaaaa1/changes');
    assert.equal(list.code, 200);
    assert.equal(list.json.branch, 'feature');
    assert.ok(list.json.files.length >= 6);
    const one = await get('/api/agents/aaaaaaa1/changes/file?path=src%2Fapp.js');
    assert.equal(one.code, 200);
    assert.equal(one.json.hunks.length, 1);
    assert.equal((await get('/api/agents/aaaaaaa1/changes?scope=uncommitted')).json.scope, 'uncommitted');
    assert.equal((await get('/api/agents/aaaaaaa1/changes/file?path=..%2Fx')).code, 400);
    assert.equal((await get('/api/agents/aaaaaaa1/changes/file?path=%2Fetc%2Fpasswd')).code, 400);
    assert.equal((await get('/api/agents/aaaaaaa1/changes/file')).code, 400);
    assert.equal((await get('/api/agents/zzzzzzzz/changes')).code, 400);
    assert.equal((await get('/api/agents/bbbbbbb1/changes')).code, 404);
    const none = await get('/api/agents/aaaaaaa2/changes');
    assert.equal(none.code, 200);
    assert.deepEqual(none.json, { status: 'none', reason: 'not-git' });
  } finally {
    server.close();
    process.env.PATH = oldPath;
    if (oldState === undefined) delete process.env.DEKKI_STATE; else process.env.DEKKI_STATE = oldState;
  }
});
