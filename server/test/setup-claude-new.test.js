// Upgrade of an edited CLAUDE.md: the marked blocks are refreshed, the rest is kept, and the new template playbook is saved
// as CLAUDE.md.new (blocks rendered) so the user can compare. Plus the preview listing worker-settings.json.
// Temp folders and a temp HOME only; a copy of the fixture template, the real template read-only for the preview test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dekki-claudenew-test-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.DEKKI_STATE = path.join(tmp, 'state.json');
delete process.env.DEKKI_TEMPLATE;
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'setup-template');
const S = await import('../setup.js');

let n = 0;
const dir = (name = 'd') => { const d = path.join(tmp, `${name}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const home = dir('home');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const stateFor = (root) => ({ root, accounts: [], activeAccount: 'default' });
const NEW = S.CLAUDE_NEW_REL;

/** A working folder set up from a private copy of the fixture template; `bump()` moves the template on one version. */
function setup() {
  const tpl = dir('tpl');
  fs.cpSync(FIXTURE, tpl, { recursive: true });
  const root = dir('work');
  const docs = dir('docs');
  const env = { ...process.env, DEKKI_TEMPLATE: tpl };
  const c = { state: stateFor(root), home, env };
  const ans = (extra = {}) => ({ docsDir: docs, ...extra });
  assert.equal(S.applySetup(ans(), c).ok, true);
  let v = 1;
  const bump = () => {
    v += 1;
    const f = path.join(tpl, 'CLAUDE.md');
    fs.writeFileSync(f, `${fs.readFileSync(f, 'utf8')}\nPlaybook fix v${v}.\n`);
    const bf = path.join(tpl, '.claude/setup/blocks.json');
    fs.writeFileSync(bf, JSON.stringify({ ...JSON.parse(fs.readFileSync(bf, 'utf8')), version: v }));
  };
  return { root, docs, c, ans, bump, tpl };
}
const edit = (root) => fs.writeFileSync(path.join(root, 'CLAUDE.md'), read(root, 'CLAUDE.md').replace('None yet.', 'web: the website.'));
const entry = (r, p) => r.files.find((f) => f.path === p);

test('edited CLAUDE.md + newer template: blocks refreshed, rest kept, CLAUDE.md.new written with the new playbook and our blocks', () => {
  const { root, ans, c, bump } = setup();
  edit(root);
  bump();
  const pv = S.previewSetup(ans({ preferences: { autonomy: 'rare' } }), c);
  const e = entry(pv, 'CLAUDE.md');
  assert.equal(e.state, 'modified');
  assert.equal(e.action, 'flag');
  assert.equal(e.newPlaybook, NEW);
  assert.match(e.note, /CLAUDE\.md\.new/);
  assert.equal(fs.existsSync(path.join(root, NEW)), false, 'preview writes nothing');
  const r = S.applySetup(ans({ preferences: { autonomy: 'rare' } }), c);
  assert.equal(r.ok, true);
  const md = read(root, 'CLAUDE.md');
  assert.match(md, /web: the website\./, 'the user\'s edit stays');
  assert.doesNotMatch(md, /Playbook fix v2/, 'the new playbook text is NOT merged into CLAUDE.md');
  assert.match(md, /Rarely ask\./, 'blocks refreshed');
  const nw = read(root, NEW);
  assert.match(nw, /Playbook fix v2\./);
  assert.match(nw, /None yet\./, 'the user\'s edit is not in the new file');
  assert.match(nw, /Rarely ask\./, 'our blocks are rendered into it');
  assert.deepEqual(S.markerStatus(nw), { preferences: 'ok', guardrails: 'ok', docs: 'ok' });
  // result entries: distinct, never both flagged and updated
  assert.deepEqual(r.blocksRefreshed, ['CLAUDE.md']);
  assert.ok(!r.updated.includes('CLAUDE.md'));
  assert.ok(r.flagged.some((f) => f.path === 'CLAUDE.md'));
  assert.ok(r.created.includes(NEW));
  assert.equal(r.newPlaybook, NEW);
  assert.equal(r.newPlaybookNote, 'Your CLAUDE.md has your edits, so the new playbook text was saved as CLAUDE.md.new. Compare the two and copy over what you want.');
  // the blocks are identical in both files, so a diff shows only real playbook changes
  for (const id of S.BLOCK_IDS) {
    const grab = (t) => t.slice(t.indexOf(S.startMarker(id)), t.indexOf(S.endMarker(id)));
    assert.equal(grab(md), grab(nw), id);
  }
  // CLAUDE.md.new is never tracked: not in the manifest, never "outdated"
  assert.equal(JSON.parse(read(root, S.MANIFEST_REL)).files[NEW], undefined);
  assert.ok(S.MANIFEST_EXEMPT.includes(NEW));
  assert.equal(S.previewSetup(ans({ preferences: { autonomy: 'rare' } }), c).files.some((f) => f.path === NEW), false);
});

test('only a block edited (nothing outside): not flagged, the new template is applied, no .new', () => {
  const { root, ans, c, bump } = setup();
  const md = read(root, 'CLAUDE.md');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), md.replace('<!-- setup:docs:start -->\n', '<!-- setup:docs:start -->\nmy own docs words\n'));
  bump();
  const r = S.applySetup(ans(), c);
  assert.equal(r.ok, true);
  assert.deepEqual(r.flagged.filter((f) => f.path === 'CLAUDE.md'), []);
  assert.ok(r.updated.includes('CLAUDE.md'));
  assert.match(read(root, 'CLAUDE.md'), /Playbook fix v2\./);
  assert.doesNotMatch(read(root, 'CLAUDE.md'), /my own docs words/, 'the block is ours to rewrite');
  assert.equal(fs.existsSync(path.join(root, NEW)), false);
  assert.equal(r.newPlaybook, null);
  assert.equal(r.newPlaybookNote, null);
});

test('unedited CLAUDE.md, template unchanged or newer: no .new file, no note', () => {
  const { root, ans, c, bump } = setup();
  let r = S.applySetup(ans(), c);
  assert.equal(fs.existsSync(path.join(root, NEW)), false);
  assert.equal(r.newPlaybook, null);
  bump();
  r = S.applySetup(ans(), c);
  assert.ok(r.updated.includes('CLAUDE.md'));
  assert.equal(fs.existsSync(path.join(root, NEW)), false);
  assert.equal(r.newPlaybook, null);
});

test('edited CLAUDE.md, template not newer: left alone and no .new', () => {
  const { root, ans, c } = setup();
  edit(root);
  const r = S.applySetup(ans(), c);
  assert.equal(fs.existsSync(path.join(root, NEW)), false);
  assert.equal(r.newPlaybook, null);
  assert.ok(r.flagged.some((f) => f.path === 'CLAUDE.md'));
});

test('repeat apply is idempotent; the next template upgrade overwrites CLAUDE.md.new', () => {
  const { root, ans, c, bump } = setup();
  edit(root);
  bump();
  S.applySetup(ans(), c);
  const mdBytes = read(root, 'CLAUDE.md');
  const newBytes = read(root, NEW);
  const mt = fs.statSync(path.join(root, NEW)).mtimeMs;
  const again = S.applySetup(ans(), c);
  assert.deepEqual([again.created, again.updated, again.blocksRefreshed], [[], [], []]);
  assert.equal(read(root, 'CLAUDE.md'), mdBytes);
  assert.equal(read(root, NEW), newBytes);
  assert.equal(fs.statSync(path.join(root, NEW)).mtimeMs, mt, 'not rewritten');
  assert.equal(again.newPlaybook, NEW, 'the note is still shown while the file stays flagged');
  fs.writeFileSync(path.join(root, NEW), 'scribbles');
  bump();
  const up = S.applySetup(ans(), c);
  assert.ok(up.updated.includes(NEW), 'overwritten, listed as updated');
  const nw = read(root, NEW);
  assert.match(nw, /Playbook fix v3\./);
  assert.match(nw, /Playbook fix v2\./);
  assert.doesNotMatch(nw, /scribbles/);
  assert.match(read(root, 'CLAUDE.md'), /web: the website\./);
});

test('other flagged files stay flagged and left alone: no .new for them', () => {
  const { root, ans, c, bump } = setup();
  const sh = '.claude/docs-templates/START-HERE.md';
  fs.writeFileSync(path.join(root, sh), '# mine\n');
  fs.writeFileSync(path.join(c.env.DEKKI_TEMPLATE, sh), '# Start here v2\n');
  bump();
  const r = S.applySetup(ans(), c);
  assert.deepEqual(r.flagged.map((f) => f.path), [sh]);
  assert.equal(read(root, sh), '# mine\n');
  assert.equal(fs.existsSync(path.join(root, `${sh}.new`)), false);
  assert.equal(r.newPlaybook, null);
});

test('preview lists .claude/worker-settings.json like apply: new before the first apply, current after', () => {
  const root = dir('work');
  const docs = dir('docs');
  fs.mkdirSync(path.join(root, 'app/.git'), { recursive: true });
  const c = { state: stateFor(root), home, env: { ...process.env, DEKKI_TEMPLATE: '' } };
  const pv = S.previewSetup({ docsDir: docs }, c);
  const e = entry(pv, S.WORKER_SETTINGS_REL);
  assert.deepEqual([e.state, e.action], ['new', 'create']);
  const a = S.applySetup({ docsDir: docs }, c);
  assert.ok(a.created.includes(S.WORKER_SETTINGS_REL));
  const after = entry(S.previewSetup({ docsDir: docs }, c), S.WORKER_SETTINGS_REL);
  assert.deepEqual([after.state, after.action], ['current', 'none']);
  // apply still lists it once, not twice
  const b = S.applySetup({ docsDir: docs }, c);
  assert.equal(b.skipped.filter((p) => p === S.WORKER_SETTINGS_REL).length, 1);
  // a template without a render helper (the fixture) lists nothing
  const fx = S.previewSetup({ docsDir: dir('docs') }, { state: stateFor(dir('work')), home, env: { ...process.env, DEKKI_TEMPLATE: FIXTURE } });
  assert.equal(entry(fx, S.WORKER_SETTINGS_REL), undefined);
});
