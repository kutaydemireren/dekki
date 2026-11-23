// Fixes from the end-to-end run of the harness: file states, the rendered worker settings listed by apply,
// and the folder-trust helpers of the wizard. Temp folders and a temp HOME only; the real template is used where
// its own scripts matter (it is read, never written), a copy of the fixture template everywhere else.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dekki-setupfix-test-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.DEKKI_STATE = path.join(tmp, 'state.json');
delete process.env.DEKKI_TEMPLATE; // the real template unless a test passes its own env
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'setup-template');

const S = await import('../setup.js');

let n = 0;
const dir = (name = 'd') => { const d = path.join(tmp, `${name}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const home = dir('home');
const stateFor = (root, extra = {}) => ({ root, accounts: [], activeAccount: 'default', ...extra });
const ctx = (root, env = process.env, extra = {}) => ({ state: stateFor(root, extra), home, env });
const pair = () => ({ root: dir('work'), docs: dir('docs') });
const entry = (r, p) => r.files.find((f) => f.path === p);
const WS = S.WORKER_SETTINGS_REL;

// ---------------------------------------------------------------- file states

test('every file state is one of new, current, outdated, modified, in preview and in GET /api/setup', () => {
  const tpl = dir('tpl');
  fs.cpSync(FIXTURE, tpl, { recursive: true });
  const env = { ...process.env, DEKKI_TEMPLATE: tpl };
  const { root, docs } = pair();
  const c = ctx(root, env);
  const ans = { docsDir: docs };

  // fresh folder: all new
  let pv = S.previewSetup(ans, c);
  assert.equal(pv.ok, true, pv.error);
  assert.ok(pv.files.length > 4);
  for (const f of pv.files) assert.equal(f.state, 'new', f.path);

  // after apply: all current, in the preview and in the status the GET route returns
  assert.equal(S.applySetup(ans, c).ok, true);
  pv = S.previewSetup(ans, c);
  for (const f of pv.files) assert.equal(f.state, 'current', f.path);
  let st = S.setupStatus({ state: stateFor(root), home, env });
  assert.ok(st.files.length > 3);
  for (const f of st.files) assert.equal(f.state, 'current', f.path);

  // one file removed (new again), one edited by the user (modified), one whose template moved on while untouched (outdated)
  const A = '.claude/docs-templates/START-HERE.md';
  const B = '.claude/scripts/delegate.sh';
  const D = '.claude/scripts/worker-deny.json';
  fs.rmSync(path.join(root, A));
  fs.appendFileSync(path.join(root, B), '# my edit\n');
  fs.writeFileSync(path.join(tpl, D), `${fs.readFileSync(path.join(tpl, D), 'utf8')}\n`);
  for (const view of [S.previewSetup(ans, c).files, S.setupStatus({ state: stateFor(root), home, env }).files]) {
    assert.equal(view.find((f) => f.path === A).state, 'new');
    assert.equal(view.find((f) => f.path === B).state, 'modified');
    assert.equal(view.find((f) => f.path === D).state, 'outdated');
    assert.equal(view.find((f) => f.path === 'CLAUDE.md').state, 'current');
    for (const f of view) assert.ok(S.FILE_STATES.includes(f.state), `${f.path}: ${f.state}`);
  }
  // the user's own CLAUDE.md (no markers, not the template) is modified; a symlink is modified too (left alone)
  const own = pair();
  fs.writeFileSync(path.join(own.root, 'CLAUDE.md'), '# Mine\n');
  assert.equal(entry(S.previewSetup({ docsDir: own.docs }, ctx(own.root, env)), 'CLAUDE.md').state, 'modified');
  assert.deepEqual(S.FILE_STATES, ['new', 'current', 'outdated', 'modified']);
});

test('an old scaffold without a manifest is outdated, never overwritten (the contract)', () => {
  const { root, docs } = pair();
  fs.mkdirSync(path.join(root, '.claude/scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude/scripts/delegate.sh'), '#!/bin/sh\n# old\n', { mode: 0o755 });
  const r = S.previewSetup({ docsDir: docs }, ctx(root));
  assert.equal(entry(r, '.claude/scripts/delegate.sh').state, 'outdated');
  assert.equal(entry(r, '.claude/scripts/delegate.sh').action, 'flag');
});

// ---------------------------------------------------------------- .claude/worker-settings.json

test('apply renders worker-settings.json and lists it: created, then skipped, then updated when the branches change', () => {
  const { root, docs } = pair();
  const ans = { docsDir: docs, protectedBranches: ['main', 'release/9'] };
  const r1 = S.applySetup(ans, ctx(root));
  assert.equal(r1.ok, true, r1.error);
  assert.ok(r1.created.includes(WS), 'first run: created');
  assert.ok(!r1.updated.includes(WS) && !r1.skipped.includes(WS));
  const rendered = JSON.parse(fs.readFileSync(path.join(root, WS), 'utf8'));
  assert.ok(rendered.permissions.deny.some((d) => d.includes('release/9')), 'rendered from the chosen branches');
  assert.ok(rendered.permissions.deny.every((d) => !d.includes('__BRANCH__') && !d.includes('__MANAGER_ROOT__')));

  const r2 = S.applySetup(ans, ctx(root));
  assert.ok(r2.skipped.includes(WS), 'unchanged re-run: skipped');
  assert.ok(!r2.created.includes(WS) && !r2.updated.includes(WS));

  const r3 = S.applySetup({ docsDir: docs, protectedBranches: ['main', 'trunk'] }, ctx(root));
  assert.ok(r3.updated.includes(WS), 'changed branches: updated');
  assert.ok(fs.readFileSync(path.join(root, WS), 'utf8').includes('trunk'));
  assert.ok(!r3.created.includes(WS));

  fs.rmSync(path.join(root, WS));
  const r4 = S.applySetup({ docsDir: docs, protectedBranches: ['main', 'trunk'] }, ctx(root));
  assert.ok(r4.created.includes(WS), 'removed file: created again');
});

test('a template without a render helper (the fixture) lists nothing and writes nothing, no warning', () => {
  const { root, docs } = pair();
  const r = S.applySetup({ docsDir: docs }, ctx(root, { ...process.env, DEKKI_TEMPLATE: FIXTURE }));
  assert.equal(r.ok, true, r.error);
  for (const l of [r.created, r.updated, r.skipped]) assert.ok(!l.includes(WS));
  assert.equal(fs.existsSync(path.join(root, WS)), false);
  assert.deepEqual(r.warnings, []);
});

test('a render failure is a warning, not a failed setup', () => {
  const { root, docs } = pair();
  const tpl = dir('tpl');
  fs.cpSync(path.join(HERE, '..', '..', 'templates', 'manager-root'), tpl, { recursive: true });
  fs.writeFileSync(path.join(tpl, '.claude/scripts/worker-deny.json'), 'not json');
  const r = S.applySetup({ docsDir: docs }, ctx(root, { ...process.env, DEKKI_TEMPLATE: tpl }));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes(WS)), JSON.stringify(r.warnings));
});

// ---------------------------------------------------------------- trust

test('trust: apply lists the docs folder first, then the git repos only, each with a copyable cd + claude line', () => {
  const root = dir('work with space');
  const docs = dir('docs');
  fs.mkdirSync(path.join(root, 'app/.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'site/.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'assets'));
  const r = S.applySetup({ docsDir: docs }, ctx(root));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.trust.dirs.map((d) => [d.kind, d.name]), [['docs', docs], ['project', 'app'], ['project', 'site']]);
  assert.equal(r.trust.dirs[0].command, `cd "${docs}" && claude`);
  assert.equal(r.trust.dirs[1].command, `cd "${path.join(root, 'app')}" && claude`);
  assert.equal(r.trust.dirs[1].path, path.join(root, 'app'));
  assert.equal(r.trust.more, 0);
  assert.equal(r.trust.accountLabel, null);
});

test('trust: a re-run still lists them, a non-default account puts its config dir on the command, a long list is capped', () => {
  const root = dir('work');
  const docs = dir('docs');
  for (let i = 0; i < 13; i++) fs.mkdirSync(path.join(root, `r${String(i).padStart(2, '0')}/.git`), { recursive: true });
  const cfg = dir('cfg');
  const state = stateFor(root, { accounts: [{ id: 'w', label: 'Work', configDir: cfg, root }], activeAccount: 'w' });
  const first = S.applySetup({ docsDir: docs }, { state, home, env: process.env });
  const again = S.applySetup({ docsDir: docs }, { state, home, env: process.env });
  for (const r of [first, again]) {
    assert.equal(r.trust.dirs.length, 1 + S.TRUST_REPO_MAX);
    assert.equal(r.trust.more, 3);
    assert.equal(r.trust.accountLabel, 'Work');
    assert.equal(r.trust.dirs[0].command, `cd "${docs}" && CLAUDE_CONFIG_DIR="${cfg}" claude`);
  }
});

test('trust: dq escapes what a double-quoted shell word needs', () => {
  assert.equal(S.dq('/a b/c'), '"/a b/c"');
  assert.equal(S.dq('/x"y$z`w\\v'), '"/x\\"y\\$z\\`w\\\\v"');
  const t = S.trustTargets(dir('w'), '/tmp/d "1"', null, home);
  assert.equal(t.dirs[0].command, 'cd "/tmp/d \\"1\\"" && claude');
});

test('trust: the health check adds a non-failing note and never reads the Claude global config', async () => {
  const { root, docs } = pair();
  assert.equal(S.applySetup({ docsDir: docs }, ctx(root)).ok, true);
  const bin = dir('bin');
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  // a canary global config in the temp HOME: its content must not influence or appear in the result
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'canary@example.invalid' }, projects: { [root]: { hasTrustDialogAccepted: true } } }));
  const r = await S.runHealth({ state: stateFor(root), home, exec: (f, a, o, cb) => cb(null, 'ok: fine\n', ''), pathEnv: bin });
  const t = r.items.find((i) => i.id === 'trust');
  assert.equal(t.status, 'info');
  assert.equal(t.fix, undefined);
  assert.match(t.detail, /run `claude` once in the docs folder and in each project folder/);
  assert.ok(!JSON.stringify(r).includes('canary'));
  assert.equal(r.ok, true, 'a note never fails the check');
  const src = fs.readFileSync(path.join(HERE, '..', 'setup.js'), 'utf8');
  assert.doesNotMatch(src, /\.claude\.json|hasTrustDialogAccepted/, 'server/setup.js never touches the global config');
});
