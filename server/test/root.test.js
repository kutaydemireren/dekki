// Per-account working folder: rootOf, set-root validation, scaffold, template hygiene, startAgent, config API, agent list.
// Everything runs on temp dirs, a temp state file and a stub `claude` on PATH. No real account, agent or folder is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dekki-root-test-'));
process.env.DEKKI_STATE = path.join(tmp, 'state.json');
process.env.DEKKI_PROJECTS_DIR = path.join(tmp, 'no-projects');
const workRoot = path.join(tmp, 'work');
const persRoot = path.join(tmp, 'pers');
const persCfg = path.join(tmp, 'cfg-personal');
for (const d of [workRoot, persRoot, persCfg]) fs.mkdirSync(d);
const real = (p) => fs.realpathSync(p);

// Stub claude: `agents` prints $FAKE_AGENTS; `--bg` records cwd + CLAUDE_CONFIG_DIR into $FAKE_REC.
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/bash
case "$1" in
  agents) printf '%s\\n' "\${CLAUDE_CONFIG_DIR:-}" >> "$FAKE_ENVLOG"; cat "$FAKE_AGENTS" ;;
  --bg) printf '{"cwd":"%s","cfg":"%s"}' "$PWD" "\${CLAUDE_CONFIG_DIR:-}" > "$FAKE_REC"; echo "started 0123abcd" ;;
esac
`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.FAKE_REC = path.join(tmp, 'rec.json');
process.env.FAKE_AGENTS = path.join(tmp, 'agents.json');
process.env.FAKE_ENVLOG = path.join(tmp, 'env.log'); // one line per `agents` call: the CLAUDE_CONFIG_DIR it ran with

const { readState, writeState } = await import('../state.js');
const { rootOf, activeRoot, setActiveAccount, listAccounts, cleanAccounts } = await import('../accounts.js');
const { checkRootPath, setRoot, scaffold, setupActiveRoot, rootStatus, rootConfig, pickFolder, TEMPLATE_DIR } = await import('../root.js');
const { startAgent } = await import('../projects.js');
const { listAgents } = await import('../agents.js');
const { createServer, listen } = await import('../index.js');
const { apiRoutes } = await import('../routes.js');

const twoAccounts = (extra = {}) => ({
  ...readState(),
  root: workRoot,
  accounts: [{ id: 'personal', label: 'Personal', configDir: persCfg, ...extra }],
  activeAccount: 'default',
});
function reset(extra, active = 'default') {
  writeState({ ...twoAccounts(extra), activeAccount: active });
}

test('rootOf: default = state.root, other account = its own root or null (no fallback)', () => {
  const st = { ...twoAccounts(), root: '~/proj' };
  assert.equal(rootOf({ id: 'default', label: 'D' }, st, '/home/u'), '/home/u/proj');
  assert.equal(rootOf({ id: 'personal', label: 'P' }, st, '/home/u'), null);
  const st2 = { ...st, accounts: [{ id: 'personal', label: 'P', configDir: '/c', root: '~/mine' }] };
  assert.equal(rootOf({ id: 'personal', label: 'P' }, st2, '/home/u'), '/home/u/mine');
  assert.equal(rootOf({ id: 'default', label: 'D' }, st2, '/home/u'), '/home/u/proj');
});

test('rootOf: a fresh default account has no working folder (null), like any other account', () => {
  assert.equal(rootOf({ id: 'default', label: 'D' }, { accounts: [], root: '' }, '/home/u'), null);
  assert.equal(rootOf({ id: 'default', label: 'D' }, { accounts: [] }, '/home/u'), null);
});

test('cleanAccounts keeps root; listAccounts/activeRoot follow the active account', () => {
  assert.equal(cleanAccounts([{ id: 'p', label: 'P', configDir: '/c', root: ' /r ' }])[0].root, '/r');
  reset({ root: persRoot });
  assert.equal(activeRoot(), workRoot);
  assert.equal(setActiveAccount('personal').ok, true);
  assert.equal(activeRoot(), persRoot);
  assert.equal(listAccounts().length, 2);
});

test('checkRootPath: relative, missing, file, ~ expansion, symlink resolve', () => {
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'afile'), 'x');
  fs.symlinkSync(path.join(home, 'projects'), path.join(tmp, 'link'));
  assert.equal(checkRootPath('relative/dir', home).ok, false);
  assert.equal(checkRootPath('', home).ok, false);
  assert.equal(checkRootPath(null, home).ok, false);
  assert.match(checkRootPath(path.join(tmp, 'nope'), home).error, /does not exist/);
  assert.match(checkRootPath(path.join(tmp, 'afile'), home).error, /Not a folder/);
  assert.equal(checkRootPath('~/projects', home).root, real(path.join(home, 'projects')));
  assert.equal(checkRootPath(path.join(tmp, 'link'), home).root, real(path.join(home, 'projects'))); // symlink resolved
});

test('setRoot: default account writes state.root; other account writes only its own entry', () => {
  reset({ root: persRoot });
  const other = fs.mkdtempSync(path.join(tmp, 'other-'));
  assert.equal(setRoot(other).ok, true);
  assert.equal(readState().root, real(other));
  assert.equal(readState().accounts[0].root, persRoot);
  setActiveAccount('personal');
  const third = fs.mkdtempSync(path.join(tmp, 'third-'));
  assert.equal(setRoot(third).ok, true);
  assert.equal(readState().root, real(other)); // default untouched
  assert.equal(readState().accounts[0].root, real(third));
  assert.equal(readState().accounts[0].configDir, persCfg); // other fields kept
  assert.equal(setRoot(path.join(tmp, 'missing')).ok, false);
});

test('scaffold: creates files in an empty dir, exec bit kept, idempotent, never overwrites', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'scaf-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'MINE');
  const r1 = scaffold(dir);
  assert.deepEqual(r1.skipped, ['CLAUDE.md']);
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), 'MINE');
  for (const f of ['.gitignore', '.claude/settings.local.json', '.claude/scripts/delegate.sh', '.claude/scripts/wait-worker.sh', '.claude/scripts/worker-deny.json', '.claude/scripts/check-report.sh', '.claude/scripts/voice-metrics.py', '.claude/skills/delegate/SKILL.md']) {
    assert.ok(r1.created.includes(f), f);
    assert.ok(fs.existsSync(path.join(dir, f)), f);
  }
  assert.ok(fs.statSync(path.join(dir, '.claude/scripts/delegate.sh')).mode & 0o100, 'delegate.sh executable');
  for (const f of ['wait-worker.sh', 'check-report.sh', 'voice-metrics.py']) assert.ok(fs.statSync(path.join(dir, '.claude/scripts', f)).mode & 0o100, `${f} executable`);
  const r2 = scaffold(dir);
  assert.deepEqual(r2.created, []);
  assert.equal(r2.skipped.length, r1.created.length + 1);
});

test('rootStatus / rootConfig: missing list, ready after setup, null root for a non-default account', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'stat-'));
  assert.deepEqual(rootStatus(dir).missing, ['CLAUDE.md', '.claude/scripts/delegate.sh']);
  assert.equal(rootStatus(null).ready, false);
  reset({}, 'personal'); // no root for personal
  let c = rootConfig();
  assert.equal(c.root, null);
  assert.equal(c.rootReady, false);
  assert.equal(c.rootAccount, 'Personal');
  assert.equal(setupActiveRoot().ok, false); // nothing to set up into
  reset({ root: dir }, 'personal');
  assert.equal(rootConfig().rootReady, false);
  const s = setupActiveRoot();
  assert.equal(s.ok, true);
  assert.ok(s.created.length > 0);
  c = rootConfig();
  assert.equal(c.rootReady, true);
  assert.deepEqual(c.rootMissing, []);
  assert.equal(setupActiveRoot().created.length, 0);
});

test('template: no work leakage, delegate.sh parses and is config-dir aware', () => {
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk : (p) => files.push(p))(path.join(d, e.name)); })(TEMPLATE_DIR);
  assert.ok(files.length >= 9);
  const bad = /XcodeBuildMCP|\/Users\/|account config dir/;
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), bad, f);
  const sh = path.join(TEMPLATE_DIR, '.claude/scripts/delegate.sh');
  execFileSync('bash', ['-n', sh]);
  execFileSync('bash', ['-n', path.join(TEMPLATE_DIR, '.claude/scripts/wait-worker.sh')]);
  execFileSync('bash', ['-n', path.join(TEMPLATE_DIR, '.claude/scripts/check-report.sh')]);
  execFileSync('python3', ['-I', '-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', path.join(TEMPLATE_DIR, '.claude/scripts/voice-metrics.py')]);
  const src = fs.readFileSync(sh, 'utf8');
  assert.ok(src.includes('"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/'));
  assert.doesNotMatch(src, /"\$HOME"\/\.claude\/projects/);
  assert.ok(src.includes('links.tsv'));
  JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, '.claude/scripts/worker-deny.json'), 'utf8'));
  JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, '.claude/settings.local.json'), 'utf8'));
});

// Scaffold a root with spaces in its path, run the real delegate.sh against a stub `claude`, and check the rendered settings.
function scaffoldedRoot() {
  const dir = fs.mkdtempSync(path.join(tmp, 'deleg root-'));
  scaffold(dir);
  fs.mkdirSync(path.join(dir, 'proj'));
  fs.writeFileSync(path.join(dir, 'proj', 'CLAUDE.md'), 'x');
  return dir;
}
const stubDir = path.join(tmp, 'stub2');
fs.mkdirSync(stubDir);
fs.writeFileSync(path.join(stubDir, 'claude'), `#!/bin/bash
if [ "$1" = agents ]; then echo '[]'; exit 0; fi
printf '%s\\n' "$@" > "$FAKE_ARGS"
echo "claude attach 0123abcd"
`, { mode: 0o755 });

test('delegate.sh renders per-root worker settings (hook path = this root) for new workers and --resume copies', () => {
  const dir = scaffoldedRoot();
  const env = { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, FAKE_ARGS: path.join(tmp, 'args.txt'), CLAUDE_CONFIG_DIR: persCfg, CLAUDE_JOB_DIR: '' };
  const tplText = fs.readFileSync(path.join(dir, '.claude/scripts/worker-deny.json'), 'utf8');
  assert.ok(tplText.includes('__MANAGER_ROOT__'));
  execFileSync(path.join(dir, '.claude/scripts/delegate.sh'), ['proj', 'do a thing', '--name', 'x'], { env, cwd: dir, stdio: 'pipe' });
  const rendered = path.join(dir, '.claude/worker-settings.json');
  let args = fs.readFileSync(env.FAKE_ARGS, 'utf8').split('\n');
  assert.equal(args[args.indexOf('--settings') + 1], rendered);
  const j = JSON.parse(fs.readFileSync(rendered, 'utf8'));
  const cmd = j.hooks.Stop[0].hooks[0].command;
  assert.ok(cmd.includes(`'${dir}/.claude/scripts/check-report.sh'`), cmd);
  assert.doesNotMatch(JSON.stringify(j), /__MANAGER_ROOT__/);
  assert.ok(j.permissions.deny.includes('Bash(git push)'));
  const brief = args.join('\n');
  assert.match(brief, /Report contract/);
  assert.match(brief, /\n---\n<details:/);
  assert.match(brief, /CLAUDE_CONFIG_DIR:-\$HOME\/\.claude\}\/skills\/unslop/);
  assert.match(brief, /skip this step silently/);
  // --resume: needs a transcript
  fs.mkdirSync(path.join(persCfg, 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(persCfg, 'projects', 'p', '0123abcd-full.jsonl'), '');
  fs.rmSync(rendered);
  execFileSync(path.join(dir, '.claude/scripts/delegate.sh'), ['--resume', '0123abcd', 'proj', 'again', '--effort', 'high'], { env, cwd: dir, stdio: 'pipe' });
  args = fs.readFileSync(env.FAKE_ARGS, 'utf8').split('\n');
  assert.equal(args[args.indexOf('--settings') + 1], rendered);
  assert.ok(fs.existsSync(rendered));
  // the rendered file is not committed: the template .gitignore hides it, but lets the scripts through
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const ignored = (f) => { try { execFileSync('git', ['check-ignore', '-q', f], { cwd: dir }); return true; } catch { return false; } };
  assert.equal(ignored('.claude/worker-settings.json'), true);
  for (const f of ['.claude/scripts/check-report.sh', '.claude/scripts/voice-metrics.py', '.claude/scripts/delegate.sh', '.claude/scripts/worker-deny.json']) assert.equal(ignored(f), false, f);
});

test('check-report.sh: blocks once on a long headline or missing ---, passes needs input/failed, stop_hook_active, bad input', () => {
  const dir = scaffoldedRoot();
  const sh = path.join(dir, '.claude/scripts/check-report.sh');
  const run = (payload) => {
    try { execFileSync(sh, { input: typeof payload === 'string' ? payload : JSON.stringify(payload), stdio: 'pipe' }); return 0; } catch (e) { return e.status; }
  };
  const ok = 'result: done\nAct: none\n---\ndetails '.concat('word '.repeat(500));
  assert.equal(run({ last_assistant_message: ok }), 0);
  assert.equal(run({ last_assistant_message: 'result: done\nAct: none\nno separator' }), 2);
  assert.equal(run({ last_assistant_message: 'result: ' + 'w '.repeat(140) + '\n---\nd' }), 2);
  assert.equal(run({ last_assistant_message: 'result: ' + 'w '.repeat(140), stop_hook_active: true }), 0);
  assert.equal(run({ last_assistant_message: 'needs input: ' + 'w '.repeat(300) }), 0);
  assert.equal(run({ last_assistant_message: 'failed: no' }), 0);
  assert.equal(run('not json'), 0);
  assert.equal(run({}), 0);
});

test('pickFolder: cancel, error, non-macOS, trailing slash trimmed', async () => {
  const exec = (err, out = '', se = '') => (_c, _a, _o, cb) => cb(err, out, se);
  assert.deepEqual(await pickFolder({ platform: 'darwin', exec: exec(null, '/a/b/\n') }), { ok: true, path: '/a/b' });
  assert.deepEqual(await pickFolder({ platform: 'darwin', exec: exec(new Error('x'), '', 'execution error: User canceled. (-128)') }), { ok: true, cancelled: true });
  assert.equal((await pickFolder({ platform: 'darwin', exec: exec(new Error('boom')) })).ok, false);
  assert.match((await pickFolder({ platform: 'linux' })).error, /macOS/);
});

test('startAgent: uses the active account root and refuses a non-default account without one', async () => {
  reset({ root: persRoot });
  let r = await startAgent({});
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(process.env.FAKE_REC, 'utf8')).cwd, real(workRoot));
  assert.equal(JSON.parse(fs.readFileSync(process.env.FAKE_REC, 'utf8')).cfg, '');
  setActiveAccount('personal');
  r = await startAgent({});
  assert.equal(r.ok, true);
  const rec = JSON.parse(fs.readFileSync(process.env.FAKE_REC, 'utf8'));
  assert.equal(rec.cwd, real(persRoot));
  assert.equal(rec.cfg, persCfg);
  // no root for personal: refused, nothing started in the work folder
  reset({}, 'personal');
  fs.rmSync(process.env.FAKE_REC);
  r = await startAgent({});
  assert.equal(r.ok, false);
  assert.equal(r.noRoot, true);
  assert.match(r.error, /Choose a working folder for Personal first/);
  assert.equal(fs.existsSync(process.env.FAKE_REC), false);
});

test('listAgents: manager context (startedAtRoot, label) follows the active account root', async () => {
  fs.writeFileSync(process.env.FAKE_AGENTS, JSON.stringify([
    { id: 'aaaaaaaa', kind: 'background', state: 'idle', cwd: workRoot, name: 'w' },
    { id: 'bbbbbbbb', kind: 'background', state: 'idle', cwd: persRoot, name: 'p' },
  ]));
  reset({ root: persRoot }, 'default');
  let a = await listAgents();
  assert.deepEqual(a.map((x) => [x.id, x.startedAtRoot]), [['aaaaaaaa', true], ['bbbbbbbb', false]]);
  setActiveAccount('personal');
  a = await listAgents();
  assert.deepEqual(a.map((x) => [x.id, x.startedAtRoot]), [['aaaaaaaa', false], ['bbbbbbbb', true]]);
  reset({}, 'personal'); // no root: nothing is a manager, nothing crashes
  a = await listAgents();
  assert.deepEqual(a.map((x) => x.startedAtRoot), [false, false]);
});

test('listAgents(account): explicit account uses ITS config dir env, jobs/ and root, whatever the active one is', async () => {
  fs.writeFileSync(process.env.FAKE_AGENTS, JSON.stringify([{ id: 'bbbbbbbb', kind: 'background', state: 'blocked', cwd: persRoot, name: 'p' }]));
  fs.mkdirSync(path.join(persCfg, 'jobs', 'bbbbbbbb'), { recursive: true });
  fs.writeFileSync(path.join(persCfg, 'jobs', 'bbbbbbbb', 'state.json'), JSON.stringify({ needs: 'answer: from the second account job' }));
  reset({ root: persRoot }, 'default'); // the deck shows the default account
  fs.rmSync(process.env.FAKE_ENVLOG, { force: true });
  const second = listAccounts().find((x) => x.id === 'personal');
  const a = await listAgents(second);
  assert.equal(a[0].startedAtRoot, true); // the second account's root, not the active (default) one
  assert.equal(a[0].detail, 'answer: from the second account job'); // read from the second account's jobs/
  assert.equal(fs.readFileSync(process.env.FAKE_ENVLOG, 'utf8').trim(), persCfg); // claude ran with that account's CLAUDE_CONFIG_DIR
  assert.equal(readState().activeAccount, 'default'); // nothing switched
  fs.rmSync(process.env.FAKE_ENVLOG, { force: true });
  await listAgents(); // no argument: the active (default) account, CLAUDE_CONFIG_DIR unset
  assert.equal(fs.readFileSync(process.env.FAKE_ENVLOG, 'utf8').trim(), '');
});

const P = 4398; // fixed port (Host/Origin check needs it); security.test.js uses 4399
function call(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: P, method, path: p, headers: { origin: `http://127.0.0.1:${P}`, 'content-type': 'application/json' } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    r.on('error', reject);
    r.end(data);
  });
}

test('API: /api/config root fields, POST /api/root, /api/root/setup, per-account switch', async () => {
  const server = createServer({ port: P, routes: [apiRoutes()] });
  await listen(server, P);
  try {
    reset({}, 'default');
    const empty = fs.mkdtempSync(path.join(tmp, 'api-'));
    let c = await call('GET', '/api/config');
    assert.equal(c.status, 200);
    assert.equal(c.body.root, workRoot);
    assert.equal(c.body.rootReady, false);
    assert.deepEqual(c.body.rootMissing, ['CLAUDE.md', '.claude/scripts/delegate.sh']);
    assert.equal(typeof c.body.notify, 'boolean');
    // switch to personal: no root, start refused with 400 + noRoot
    assert.equal((await call('POST', '/api/accounts/active', { id: 'personal' })).status, 200);
    c = await call('GET', '/api/config');
    assert.equal(c.body.root, null);
    assert.equal(c.body.rootAccount, 'Personal');
    const start = await call('POST', '/api/agents', {});
    assert.equal(start.status, 400);
    assert.equal(start.body.noRoot, true);
    assert.equal((await call('POST', '/api/root/setup', {})).status, 400);
    assert.equal((await call('POST', '/api/root', { path: 'rel' })).status, 400);
    assert.equal((await call('POST', '/api/root', { path: path.join(tmp, 'nope') })).status, 400);
    // choose + setup
    const set = await call('POST', '/api/root', { path: empty });
    assert.equal(set.status, 200);
    assert.equal(set.body.root, real(empty));
    assert.equal(set.body.rootReady, false);
    const setup = await call('POST', '/api/root/setup', {});
    assert.equal(setup.status, 200);
    assert.ok(setup.body.created.includes('CLAUDE.md'));
    assert.equal(setup.body.rootReady, true);
    assert.equal((await call('POST', '/api/root/setup', {})).body.created.length, 0);
    // switching back shows the work root again
    await call('POST', '/api/accounts/active', { id: 'default' });
    assert.equal((await call('GET', '/api/config')).body.root, workRoot);
    // browser-origin rule still applies
    const bad = await new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: P, method: 'POST', path: '/api/root/pick', headers: { origin: 'http://evil.com' } }, (res) => { res.resume(); resolve(res.statusCode); });
      r.end('{}');
    });
    assert.equal(bad, 403);
  } finally {
    server.close();
  }
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
