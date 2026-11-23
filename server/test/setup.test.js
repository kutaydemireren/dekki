// Setup wizard logic (server/setup.js): marked blocks, config, validation, plan/apply/upgrade, health, per-account reuse.
// Everything runs on temp folders and a stub `exec`; the template is the fixture in test/fixtures/setup-template (or a copy
// of it), never the real one. No real account, agent or folder is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dekki-setup-test-')));
process.env.DEKKI_STATE = path.join(tmp, '.dekki', 'state.json'); // the health check looks for this dir name in delegate.sh
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'setup-template');
process.env.DEKKI_TEMPLATE = FIXTURE;

const S = await import('../setup.js');
const { scaffold } = await import('../root.js');

let n = 0;
const dir = (name = 'd') => { const d = path.join(tmp, `${name}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const home = dir('home');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const stateFor = (root, extra = {}) => ({ root, accounts: [], activeAccount: 'default', ...extra });
const ctx = (root, extra = {}) => ({ state: stateFor(root, extra), home, env: process.env });
const answers = (docsDir, extra = {}) => ({ docsDir, ...extra });
/** A fresh working folder + docs folder pair, outside each other. */
const pair = () => { const root = dir('work'); const docs = dir('docs'); return { root, docs }; };
const copyDir = (src, dst) => fs.cpSync(src, dst, { recursive: true });

// ------------------------------------------------------------------ marked blocks

test('markerStatus: ok, missing, broken (duplicate, reversed, lone start)', () => {
  const all = BLOCKS_OK();
  assert.deepEqual(S.markerStatus(all), { preferences: 'ok', guardrails: 'ok', docs: 'ok' });
  assert.deepEqual(S.markerStatus('# plain'), { preferences: 'missing', guardrails: 'missing', docs: 'missing' });
  const dup = `${S.blockText('docs', 'a')}\n${S.blockText('docs', 'b')}`;
  assert.equal(S.markerStatus(dup).docs, 'broken');
  assert.equal(S.markerStatus(`${S.endMarker('docs')}\n${S.startMarker('docs')}`).docs, 'broken');
  assert.equal(S.markerStatus(`${S.startMarker('docs')}\nx`).docs, 'broken');
  assert.equal(S.markerStatus(`x\n${S.endMarker('docs')}`).docs, 'broken');
});
function BLOCKS_OK() { return S.BLOCK_IDS.map((id) => S.blockText(id, `body ${id}`)).join('\n\n'); }

test('fillBlocks rewrites only inside the markers and is idempotent', () => {
  const before = `top line\n\n${S.blockText('preferences', 'old')}\n\nmiddle ${'x'.repeat(50)}\n\n${S.blockText('guardrails', 'old')}\n\n${S.blockText('docs', 'old')}\nlast line`;
  const bodies = { preferences: 'P', guardrails: 'G', docs: 'D' };
  const after = S.fillBlocks(before, bodies);
  assert.ok(after.startsWith('top line\n\n'));
  assert.ok(after.endsWith('\nlast line'));
  assert.ok(after.includes(`middle ${'x'.repeat(50)}`));
  assert.equal(S.markerStatus(after).preferences, 'ok');
  assert.ok(after.includes(`${S.startMarker('preferences')}\nP\n${S.endMarker('preferences')}`));
  assert.equal(S.fillBlocks(after, bodies), after);
  assert.equal(S.stripBlocks(before), S.stripBlocks(after), 'stripping removes exactly the bodies');
});

test('fillBlocks leaves a broken or missing block alone', () => {
  const t = `${S.startMarker('docs')}\nstray\n\n${S.blockText('guardrails', 'g')}\n`;
  assert.equal(S.fillBlocks(t, { docs: 'X', guardrails: 'G', preferences: 'P' }), `${S.startMarker('docs')}\nstray\n\n${S.blockText('guardrails', 'G')}\n`);
});

test('appendBlocksText adds whole blocks at the very end and nothing before them changes', () => {
  const orig = '# Mine\n\nsome text\n';
  const out = S.appendBlocksText(orig, S.BLOCK_IDS, { preferences: 'P', guardrails: 'G', docs: 'D' });
  assert.ok(out.startsWith(orig));
  assert.deepEqual(S.markerStatus(out), { preferences: 'ok', guardrails: 'ok', docs: 'ok' });
  assert.equal(S.appendBlocksText(orig, [], {}), orig);
  assert.ok(S.appendBlocksText('no newline', ['docs'], { docs: 'D' }).startsWith('no newline\n\n<!--'));
  assert.ok(S.appendBlocksText('', ['docs'], { docs: 'D' }).startsWith('<!--'));
});

test('ensureMarkers adds empty shells only for missing blocks; hash of the result is stable', () => {
  const e = S.ensureMarkers('# T\n');
  assert.deepEqual(S.markerStatus(e), { preferences: 'ok', guardrails: 'ok', docs: 'ok' });
  assert.equal(S.ensureMarkers(e), e);
  assert.equal(S.fileHash(Buffer.from(S.fillBlocks(e, { preferences: 'a', guardrails: 'b', docs: 'c' }))), S.fileHash(Buffer.from(e)));
});

test('fillPlaceholders: one pass, unknown names stay, a value with {{x}} is not expanded again', () => {
  assert.equal(S.fillPlaceholders('a {{x}} b {{y}}', { x: '{{y}}', y: 'Y' }), 'a {{y}} b Y');
  assert.equal(S.fillPlaceholders('{{nope}}', {}), '{{nope}}');
});

// ------------------------------------------------------------------ block texts

test('loadTemplate reads blocks.json and the installable files; .claude/setup is not installed', () => {
  const t = S.loadTemplate(FIXTURE);
  assert.deepEqual(t.problems, []);
  const rels = t.files.map((f) => f.rel);
  assert.equal(rels[0], 'CLAUDE.md');
  assert.ok(rels.includes('.claude/scripts/delegate.sh'));
  assert.ok(!rels.some((r) => r.startsWith('.claude/setup/')));
  assert.equal(t.version, 1);
  assert.equal(t.files.find((f) => f.rel === '.claude/scripts/delegate.sh').mode & 0o111, 0o111);
});

test('loadTemplate reports a missing or broken blocks.json and missing keys', () => {
  const d = dir('tpl');
  copyDir(FIXTURE, d);
  fs.rmSync(path.join(d, '.claude/setup/blocks.json'));
  assert.match(S.loadTemplate(d).problems[0], /blocks\.json is missing/);
  fs.writeFileSync(path.join(d, '.claude/setup/blocks.json'), '{nope');
  assert.match(S.loadTemplate(d).problems[0], /cannot be read/);
  fs.writeFileSync(path.join(d, '.claude/setup/blocks.json'), '[]');
  assert.match(S.loadTemplate(d).problems[0], /must be a JSON object/);
  fs.writeFileSync(path.join(d, '.claude/setup/blocks.json'), JSON.stringify({ docs: 'x' }));
  const p = S.loadTemplate(d).problems;
  assert.ok(p.some((x) => /preferences\.replyStyle\.short/.test(x)));
  assert.deepEqual(S.missingBlockKeys(S.loadTemplate(FIXTURE).blocks), []);
  assert.match(S.loadTemplate(path.join(tmp, 'nowhere')).problems.join(' '), /template/i);
});

test('renderBlocks: every choice, custom language, guardrails, branches, docs path', () => {
  const blocks = S.loadTemplate(FIXTURE).blocks;
  const cfg = { docsDir: '/d/docs', protectedBranches: ['main', 'release'], neverTouch: 'billing', secretsDir: '/s', preferences: { replyStyle: 'detailed', autonomy: 'rare', prs: 'workers-draft', language: 'Turkish' } };
  const r = S.renderBlocks(cfg, blocks);
  assert.match(r.preferences, /Reply in detail\./);
  assert.match(r.preferences, /Rarely ask\./);
  assert.match(r.preferences, /Workers open draft/);
  assert.match(r.preferences, /Reply in Turkish\./);
  assert.match(r.preferences, /Protected branches .*: main, release\./);
  assert.match(r.guardrails, /Never touch: billing/);
  assert.match(r.guardrails, /Secrets live in \/s/);
  assert.equal(r.docs, 'Project docs live in /d/docs.');
  const d = S.renderBlocks({ docsDir: '/x', preferences: S.DEFAULT_PREFS }, blocks);
  assert.match(d.preferences, /Reply short/);
  assert.match(d.preferences, /Reply in the language I write in/);
  assert.match(d.preferences, /main, master, develop/);
  assert.match(d.guardrails, /No extra guardrails/);
  const own = S.renderBlocks({ docsDir: '/x', preferences: S.DEFAULT_PREFS }, { ...blocks, preferences: { ...blocks.preferences, branches: 'Never push to {{branches}}.' } });
  assert.match(own.preferences, /Never push to main, master, develop\./);
  // user text that looks like a placeholder is kept as written
  assert.match(S.renderBlocks({ docsDir: '/x', neverTouch: '{{path}}', preferences: S.DEFAULT_PREFS }, blocks).guardrails, /Never touch: \{\{path\}\}/);
});

// ------------------------------------------------------------------ validation

test('normalizeAnswers: defaults, unknown choice, language, branches', () => {
  const d = S.normalizeAnswers({});
  assert.equal(d.ok, true);
  assert.deepEqual(d.value, { preferences: S.DEFAULT_PREFS, protectedBranches: ['main', 'master', 'develop'], neverTouch: null, secretsDir: null });
  assert.equal(S.normalizeAnswers(undefined).ok, true);
  assert.equal(S.normalizeAnswers({ preferences: { replyStyle: 'loud' } }).field, 'replyStyle');
  assert.equal(S.normalizeAnswers({ preferences: { autonomy: 'x' } }).ok, false);
  assert.equal(S.normalizeAnswers({ preferences: { language: 5 } }).ok, false);
  assert.equal(S.normalizeAnswers({ preferences: { language: 'a'.repeat(61) } }).ok, false);
  assert.equal(S.normalizeAnswers({ preferences: { language: '  Dutch  ' } }).value.preferences.language, 'Dutch');
  assert.equal(S.normalizeAnswers({ preferences: { language: 'same', replyStyle: 'detailed' } }).value.preferences.replyStyle, 'detailed');
  const b = S.normalizeAnswers({ protectedBranches: ['main', ' release/1.x ', 'main'] });
  assert.deepEqual(b.value.protectedBranches, ['main', 'release/1.x']);
  assert.deepEqual(S.normalizeAnswers({ protectedBranches: [] }).value.protectedBranches, S.DEFAULT_BRANCHES, 'an empty list means the default');
  for (const bad of ['*', 'a b', '-x', 'a..b', 'x/', 'a.lock', '', 5, 'a;b', 'a*']) assert.equal(S.normalizeAnswers({ protectedBranches: [bad] }).field, 'protectedBranches', `bad: ${bad}`);
  assert.equal(S.normalizeAnswers({ protectedBranches: 'main' }).ok, false);
  assert.equal(S.normalizeAnswers({ protectedBranches: Array(31).fill('a') }).ok, false);
});

test('normalizeAnswers: neverTouch is one clean line, secrets folder must be absolute', () => {
  const n = S.normalizeAnswers({ neverTouch: ' prod <!-- setup:docs:end -->\n billing ' });
  assert.equal(n.value.neverTouch, 'prod setup:docs:end billing');
  assert.equal(S.normalizeAnswers({ neverTouch: '   ' }).value.neverTouch, null);
  assert.equal(S.normalizeAnswers({ neverTouch: 'x'.repeat(S.TEXT_MAX + 1) }).field, 'neverTouch');
  assert.equal(S.normalizeAnswers({ neverTouch: 4 }).ok, false);
  assert.equal(S.normalizeAnswers({ secretsDir: 'relative/x' }).field, 'secretsDir');
  assert.equal(S.normalizeAnswers({ secretsDir: '/a/../b' }).value.secretsDir, '/b');
  assert.equal(S.normalizeAnswers({ secretsDir: '~/keys' }, { home: '/h' }).value.secretsDir, '/h/keys');
  assert.equal(S.normalizeAnswers({ secretsDir: '' }).value.secretsDir, null);
  assert.equal(S.normalizeAnswers({ secretsDir: '/a\u0000b' }).ok, false);
});

test('validateWorkRoot: must exist, quotes/ampersand/backslash refused, spaces fine', () => {
  const ok = path.join(tmp, 'with space');
  fs.mkdirSync(ok);
  assert.equal(S.validateWorkRoot(ok).ok, true);
  assert.equal(S.validateWorkRoot(path.join(tmp, 'nope')).field, 'root');
  for (const ch of ["'", '"', '&', '\\']) {
    const bad = path.join(tmp, `bad${ch}name`);
    fs.mkdirSync(bad);
    const r = S.validateWorkRoot(bad);
    assert.equal(r.ok, false, ch);
    assert.equal(r.field, 'root');
    assert.match(r.error, /quotes, ampersands or backslashes/);
  }
});

test('validateDocsDir: absolute, outside the working folder, writable, create by choice', () => {
  const { root } = pair();
  const bad = (input, re, opts) => { const r = S.validateDocsDir(input, root, { home, ...opts }); assert.equal(r.ok, false, String(input)); assert.equal(r.field, 'docsDir'); assert.match(r.error, re, String(input)); };
  bad('', /Choose a docs folder/);
  bad('   ', /Choose a docs folder/);
  bad(undefined, /Choose a docs folder/);
  bad('docs', /absolute/);
  bad('./docs', /absolute/);
  bad('a\u0000b', /Choose/);
  bad(root, /cannot be the working folder/);
  bad(`${root}/`, /cannot be the working folder/);
  bad(path.join(root, 'docs'), /inside the working folder/);
  bad(path.join(root, 'a', 'b'), /inside the working folder/, { create: true });
  bad(path.dirname(root), /cannot contain the working folder/);
  bad('/', /cannot contain the working folder/);
  bad(path.join(root, 'x', '..'), /cannot be the working folder/);
  // a symlink to the working folder counts as the working folder
  const link = path.join(tmp, `link-${++n}`);
  fs.symlinkSync(root, link);
  bad(link, /cannot be the working folder/);
  bad(path.join(link, 'sub'), /inside the working folder/);
  // a file is not a folder
  const f = path.join(tmp, `afile-${++n}`);
  fs.writeFileSync(f, 'x');
  bad(f, /Not a folder/);
  bad(path.join(f, 'under'), /Not a folder/, { create: true });
  const docs = dir('docs');
  const ok = S.validateDocsDir(docs, root, { home });
  assert.deepEqual(ok, { ok: true, docsDir: docs, exists: true, needsCreate: false });
  // missing: allowed only as "needs create"; with create the parent must be writable
  const missing = path.join(docs, 'new', 'deeper');
  assert.deepEqual(S.validateDocsDir(missing, root, { home }), { ok: true, docsDir: missing, exists: false, needsCreate: true });
  assert.equal(S.validateDocsDir(missing, root, { home, create: true }).ok, true);
  // ~ expansion, spaces
  fs.mkdirSync(path.join(home, 'My Docs'), { recursive: true });
  assert.equal(S.validateDocsDir('~/My Docs', root, { home }).docsDir, path.join(home, 'My Docs'));
});

test('validateDocsDir: a read-only folder is refused (not when running as root)', { skip: process.getuid?.() === 0 }, () => {
  const { root } = pair();
  const ro = dir('ro');
  fs.chmodSync(ro, 0o500);
  try {
    assert.match(S.validateDocsDir(ro, root, { home }).error, /not writable/);
    assert.match(S.validateDocsDir(path.join(ro, 'new'), root, { home, create: true }).error, /Cannot create/);
    assert.equal(S.validateDocsDir(path.join(ro, 'new'), root, { home }).needsCreate, true, 'without the create choice there is nothing to refuse yet');
  } finally { fs.chmodSync(ro, 0o700); }
});

// ------------------------------------------------------------------ config and manifest

test('readConfig: missing, invalid, not an object, newer, ok', () => {
  const root = dir('cfg');
  assert.equal(S.readConfig(root).state, 'missing');
  fs.mkdirSync(path.join(root, '.claude'));
  const f = path.join(root, S.CONFIG_REL);
  fs.writeFileSync(f, '{broken');
  assert.equal(S.readConfig(root).state, 'invalid');
  fs.writeFileSync(f, '[1]');
  assert.match(S.readConfig(root).error, /JSON object/);
  fs.writeFileSync(f, JSON.stringify({ version: 2 }));
  assert.equal(S.readConfig(root).state, 'newer');
  fs.writeFileSync(f, JSON.stringify({ version: 1, docsDir: '/x' }));
  assert.equal(S.readConfig(root).state, 'ok');
});

test('mergeConfig keeps unknown keys, extra preference keys and the projects map; refuses a newer version', () => {
  const old = { version: 1, docsDir: '/old', zebra: { a: 1 }, preferences: { replyStyle: 'short', future: 'x' }, projects: { web: { setupAt: 'd', checks: { build: 'make' } } } };
  const next = S.mergeConfig(old, { docsDir: '/new', protectedBranches: ['main'], neverTouch: 'x', secretsDir: null, preferences: { ...S.DEFAULT_PREFS, replyStyle: 'detailed' } });
  assert.equal(next.docsDir, '/new');
  assert.deepEqual(next.zebra, { a: 1 });
  assert.equal(next.preferences.future, 'x');
  assert.equal(next.preferences.replyStyle, 'detailed');
  assert.deepEqual(next.projects, old.projects);
  assert.deepEqual(Object.keys(next).slice(0, 6), ['version', 'docsDir', 'protectedBranches', 'neverTouch', 'secretsDir', 'preferences']);
  assert.deepEqual(S.mergeConfig(null, { docsDir: '/n', protectedBranches: [], neverTouch: null, secretsDir: null, preferences: S.DEFAULT_PREFS }).projects, {});
  assert.throws(() => S.mergeConfig({ version: 9 }, {}), /newer/);
});

test('writeFileAtomic and createFileExclusive: no temp files left, exclusive never replaces', () => {
  const d = dir('w');
  const f = path.join(d, 'sub', 'a.txt');
  S.writeFileAtomic(f, 'one', 0o600);
  S.writeFileAtomic(f, 'two', 0o600);
  assert.equal(read(f), 'two');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.join(d, 'sub')), ['a.txt']);
  assert.equal(S.createFileExclusive(f, 'three'), false);
  assert.equal(read(f), 'two');
  const g = path.join(d, 'g.sh');
  assert.equal(S.createFileExclusive(g, '#!/bin/sh\n', 0o755), true);
  assert.equal(fs.statSync(g).mode & 0o777, 0o755);
  const dangling = path.join(d, 'dangling');
  fs.symlinkSync(path.join(d, 'nowhere'), dangling);
  assert.equal(S.createFileExclusive(dangling, 'x'), false, 'a dangling symlink counts as existing');
  assert.deepEqual(fs.readdirSync(d).filter((x) => x.includes('.tmp-')), []);
  fs.writeFileSync(path.join(d, 'ro.txt'), 'k');
  assert.throws(() => S.writeFileAtomic(path.join(d, 'ro.txt', 'x'), 'y'), /ENOTDIR|EEXIST|not a directory/i, 'failure path throws and leaves no temp');
});

test('readManifest: missing, broken, and a real one', () => {
  const root = dir('man');
  assert.deepEqual(S.readManifest(root), { version: null, files: {}, present: false });
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, S.MANIFEST_REL), 'not json');
  assert.equal(S.readManifest(root).present, false);
  fs.writeFileSync(path.join(root, S.MANIFEST_REL), JSON.stringify({ version: 3, files: { a: 'h' }, extra: 1 }));
  const m = S.readManifest(root);
  assert.equal(m.version, 3);
  assert.equal(m.extra, 1);
  assert.deepEqual(m.files, { a: 'h' });
});

test('fileState: every combination of manifest, disk and template', () => {
  const st = (o) => S.fileState({ exists: true, ...o });
  assert.deepEqual(S.fileState({ exists: false }), { state: 'new', action: 'create' });
  assert.equal(st({ M: 'a', D: 'a', T: 'a' }).state, 'current');
  assert.equal(st({ M: 'a', D: 'a', T: 'a' }).action, 'none');
  assert.deepEqual([st({ M: 'a', D: 'a', T: 'b' }).state, st({ M: 'a', D: 'a', T: 'b' }).action], ['outdated', 'update']);
  assert.deepEqual([st({ M: 'a', D: 'x', T: 'a' }).state, st({ M: 'a', D: 'x', T: 'a' }).action], ['modified', 'flag']);
  assert.deepEqual([st({ M: 'a', D: 'x', T: 'b' }).state, st({ M: 'a', D: 'x', T: 'b' }).action], ['modified', 'flag']);
  assert.equal(st({ M: 'a', D: 'b', T: 'b' }).action, 'adopt', 'the user already has the new version');
  assert.deepEqual([st({ D: 'a', T: 'a' }).state, st({ D: 'a', T: 'a' }).action], ['current', 'adopt']);
  assert.deepEqual([st({ D: 'old', T: 'new' }).state, st({ D: 'old', T: 'new' }).action], ['outdated', 'flag'], 'no manifest: an old scaffold is flagged, never updated');
});

// ------------------------------------------------------------------ plan, apply, upgrade

const fileEntry = (r, p) => r.files.find((f) => f.path === p);

test('preview on a fresh folder: everything is new, nothing is written', () => {
  const { root, docs } = pair();
  const r = S.previewSetup(answers(docs), ctx(root));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.root, root);
  assert.equal(r.docsDir, docs);
  for (const f of r.files) assert.equal(f.state, 'new', f.path);
  const paths = r.files.map((f) => f.path);
  assert.ok(paths.includes('CLAUDE.md') && paths.includes(S.CONFIG_REL) && paths.includes(S.MANIFEST_REL) && paths.includes(path.join(docs, 'README.md')));
  assert.equal(fileEntry(r, path.join(docs, 'README.md')).where, 'docs');
  assert.equal(r.claude.markers, 'none');
  assert.match(r.claude.blocksText, /setup:preferences:start/);
  assert.deepEqual(fs.readdirSync(root), [], 'preview writes nothing');
  assert.deepEqual(fs.readdirSync(docs), []);
});

test('apply on a fresh folder: files, exec bit, blocks, config, manifest, docs README', () => {
  const { root, docs } = pair();
  const r = S.applySetup(answers(docs, { neverTouch: 'billing', secretsDir: '/keys', protectedBranches: ['main', 'trunk'], preferences: { replyStyle: 'detailed', language: 'German' } }), ctx(root));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.flagged, []);
  assert.ok(r.created.includes('CLAUDE.md') && r.created.includes('.claude/scripts/delegate.sh') && r.created.includes(S.CONFIG_REL) && r.created.includes(S.MANIFEST_REL));
  assert.ok(r.created.includes(path.join(docs, 'README.md')));
  assert.equal(fs.statSync(path.join(root, '.claude/scripts/delegate.sh')).mode & 0o111, 0o111, 'exec bit kept');
  assert.equal(fs.statSync(path.join(root, '.claude/scripts/worker-deny.json')).mode & 0o111, 0);
  assert.ok(!fs.existsSync(path.join(root, '.claude/setup')), 'wizard input is not installed');
  const md = read(root, 'CLAUDE.md');
  assert.match(md, /Reply in detail\./);
  assert.match(md, /Reply in German\./);
  assert.match(md, /Never touch: billing/);
  assert.match(md, /Secrets live in \/keys/);
  assert.ok(md.includes(`Project docs live in ${docs}.`));
  assert.match(md, /Protected branches .*: main, trunk\./);
  assert.ok(md.includes('## Project map'), 'text outside the blocks is the template');
  const cfg = JSON.parse(read(root, S.CONFIG_REL));
  assert.deepEqual(cfg, { version: 1, docsDir: docs, protectedBranches: ['main', 'trunk'], neverTouch: 'billing', secretsDir: '/keys', preferences: { replyStyle: 'detailed', autonomy: 'outward', prs: 'me', language: 'German' }, projects: {} });
  const man = JSON.parse(read(root, S.MANIFEST_REL));
  assert.equal(man.version, 1);
  assert.deepEqual(Object.keys(man.files), ['.claude/docs-templates/START-HERE.md', '.claude/scripts/delegate.sh', '.claude/scripts/worker-deny.json', 'CLAUDE.md']);
  const tplMd = fs.readFileSync(path.join(FIXTURE, 'CLAUDE.md'), 'utf8');
  assert.equal(man.files['CLAUDE.md'], S.sha256(S.stripBlocks(tplMd)), 'block bodies are stripped before hashing');
  assert.equal(man.files['.claude/scripts/delegate.sh'], S.sha256(fs.readFileSync(path.join(FIXTURE, '.claude/scripts/delegate.sh'))));
  assert.match(read(docs, 'README.md'), /START-HERE/);
  assert.deepEqual(fs.readdirSync(root, { recursive: true }).filter((x) => String(x).includes('.tmp-')), []);
});

test('re-running is idempotent: nothing created or updated, bytes and mtimes unchanged', () => {
  const { root, docs } = pair();
  const a = answers(docs, { neverTouch: 'x' });
  assert.equal(S.applySetup(a, ctx(root)).ok, true);
  const snap = () => Object.fromEntries(fs.readdirSync(root, { recursive: true }).filter((p) => fs.statSync(path.join(root, p)).isFile()).map((p) => [p, `${read(root, p)}|${fs.statSync(path.join(root, p)).mtimeMs}`]));
  const before = snap();
  const again = S.applySetup(a, ctx(root));
  assert.equal(again.ok, true);
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.updated, []);
  assert.deepEqual(again.flagged, []);
  assert.ok(again.skipped.includes('CLAUDE.md'));
  assert.deepEqual(snap(), before);
  assert.ok(S.previewSetup(a, ctx(root)).files.every((f) => f.action === 'none'));
});

test('changing an answer rewrites only the marked blocks and the config', () => {
  const { root, docs } = pair();
  S.applySetup(answers(docs), ctx(root));
  const md0 = read(root, 'CLAUDE.md');
  // the user edits outside the blocks and keeps working
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), md0.replace('None yet.', 'web: the website.'));
  const r = S.applySetup(answers(docs, { preferences: { autonomy: 'rare' } }), ctx(root));
  assert.equal(r.ok, true);
  const md1 = read(root, 'CLAUDE.md');
  assert.match(md1, /web: the website\./, 'edits outside the blocks survive');
  assert.match(md1, /Rarely ask\./);
  assert.doesNotMatch(md1, /Ask before outward-facing/);
  assert.ok(r.flagged.some((f) => f.path === 'CLAUDE.md' && f.state === 'modified'), 'an edited playbook is flagged, not replaced');
  assert.deepEqual(r.blocksRefreshed, ['CLAUDE.md'], 'its blocks were refreshed');
  assert.ok(!r.updated.includes('CLAUDE.md'), 'a flagged file is not also listed as updated');
  assert.equal(JSON.parse(read(root, S.CONFIG_REL)).preferences.autonomy, 'rare');
});

test('an existing CLAUDE.md without markers is never modified unless appendBlocks; then only at the end', () => {
  const { root, docs } = pair();
  const mine = '# My own playbook\n\nLots of rules.\n';
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), mine);
  const pv = S.previewSetup(answers(docs), ctx(root));
  const e = fileEntry(pv, 'CLAUDE.md');
  assert.equal(e.state, 'modified', 'the user\'s own playbook is not the template');
  assert.equal(e.action, 'none');
  assert.equal(e.markers, 'unmarked');
  assert.match(e.note, /left as is/);
  assert.equal(pv.claude.appendable, true);
  assert.match(pv.claude.blocksText, /Project docs live in/);
  const r = S.applySetup(answers(docs), ctx(root));
  assert.equal(read(root, 'CLAUDE.md'), mine, 'untouched');
  assert.ok(r.skipped.includes('CLAUDE.md'));
  assert.equal(JSON.parse(read(root, S.MANIFEST_REL)).files['CLAUDE.md'], undefined, 'not recorded: it is not ours');
  const a = S.applySetup(answers(docs, { appendBlocks: true }), ctx(root));
  assert.equal(a.ok, true);
  const md = read(root, 'CLAUDE.md');
  assert.ok(md.startsWith(mine), 'everything before the appended blocks is unchanged');
  assert.deepEqual(S.markerStatus(md), { preferences: 'ok', guardrails: 'ok', docs: 'ok' });
  assert.ok(a.updated.includes('CLAUDE.md'));
  // from now on the blocks are ours to refresh, the rest still is not
  const b = S.applySetup(answers(docs, { preferences: { replyStyle: 'detailed' } }), ctx(root));
  assert.equal(b.ok, true);
  assert.ok(read(root, 'CLAUDE.md').startsWith(mine));
  assert.match(read(root, 'CLAUDE.md'), /Reply in detail/);
});

test('partial and damaged markers: present ones are refreshed, missing need appendBlocks, broken are left alone', () => {
  const { root, docs } = pair();
  const partial = `# Mine\n\n${S.blockText('docs', 'old')}\n`;
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), partial);
  const pv = fileEntry(S.previewSetup(answers(docs), ctx(root)), 'CLAUDE.md');
  assert.equal(pv.markers, 'partial');
  assert.match(pv.note, /No markers for preferences, guardrails/);
  S.applySetup(answers(docs), ctx(root));
  const t = read(root, 'CLAUDE.md');
  assert.match(t, new RegExp(`Project docs live in ${docs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(S.markerStatus(t).preferences, 'missing');
  S.applySetup(answers(docs, { appendBlocks: true }), ctx(root));
  assert.equal(S.markerStatus(read(root, 'CLAUDE.md')).preferences, 'ok');
  assert.equal(S.markerStatus(read(root, 'CLAUDE.md')).docs, 'ok');
  // a damaged block (start without end) is not touched, and not appended again
  const root2 = dir('work');
  const dmg = `# T\n${S.blockText('preferences', 'p')}\n${S.startMarker('docs')}\nstray\n${S.blockText('guardrails', 'g')}\n`;
  fs.writeFileSync(path.join(root2, 'CLAUDE.md'), dmg);
  const e = fileEntry(S.previewSetup(answers(docs), ctx(root2)), 'CLAUDE.md');
  assert.match(e.note, /damaged/);
  S.applySetup(answers(docs, { appendBlocks: true }), ctx(root2));
  assert.ok(read(root2, 'CLAUDE.md').includes(`${S.startMarker('docs')}\nstray\n`));
  assert.equal(countOf(read(root2, 'CLAUDE.md'), S.startMarker('docs')), 1);
});
const countOf = (t, s) => t.split(s).length - 1;

test('never overwrites: an old scaffold is "outdated" and flagged, every file keeps its bytes', () => {
  const { root, docs } = pair();
  fs.mkdirSync(path.join(root, '.claude/scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# old scaffold playbook\n');
  fs.writeFileSync(path.join(root, '.claude/scripts/delegate.sh'), '#!/bin/sh\necho old\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, '.claude/scripts/worker-deny.json'), '{"old":true}');
  const pv = S.previewSetup(answers(docs), ctx(root));
  assert.equal(fileEntry(pv, '.claude/scripts/delegate.sh').state, 'outdated');
  assert.equal(fileEntry(pv, '.claude/scripts/delegate.sh').action, 'flag');
  const r = S.applySetup(answers(docs), ctx(root));
  assert.equal(r.ok, true);
  assert.equal(read(root, '.claude/scripts/delegate.sh'), '#!/bin/sh\necho old\n');
  assert.equal(read(root, '.claude/scripts/worker-deny.json'), '{"old":true}');
  assert.equal(read(root, 'CLAUDE.md'), '# old scaffold playbook\n');
  assert.deepEqual(r.flagged.map((f) => f.path).sort(), ['.claude/scripts/delegate.sh', '.claude/scripts/worker-deny.json']);
  assert.ok(r.created.includes('.claude/docs-templates/START-HERE.md'), 'what is missing is still added');
  const man = JSON.parse(read(root, S.MANIFEST_REL));
  assert.equal(man.files['.claude/scripts/delegate.sh'], undefined, 'a flagged file is not recorded as ours');
});

test('a real old scaffold (root.js scaffold of any template) is never overwritten by the wizard', () => {
  const { root, docs } = pair();
  const oldTpl = dir('oldtpl');
  fs.mkdirSync(path.join(oldTpl, '.claude/scripts'), { recursive: true });
  fs.writeFileSync(path.join(oldTpl, 'CLAUDE.md'), '# older playbook\n');
  fs.writeFileSync(path.join(oldTpl, '.claude/scripts/delegate.sh'), '#!/bin/sh\n:\n', { mode: 0o755 });
  scaffold(root, oldTpl);
  const hashes = () => Object.fromEntries(['CLAUDE.md', '.claude/scripts/delegate.sh'].map((p) => [p, S.sha256(fs.readFileSync(path.join(root, p)))]));
  const h0 = hashes();
  const r = S.applySetup(answers(docs), ctx(root));
  assert.equal(r.ok, true);
  assert.deepEqual(hashes(), h0);
});

test('upgrade: unedited files update, edited ones are flagged and left alone, new template files are added', () => {
  const { root, docs } = pair();
  const tpl = dir('tpl');
  copyDir(FIXTURE, tpl);
  const env = { ...process.env, DEKKI_TEMPLATE: tpl };
  const c = { state: stateFor(root), home, env };
  assert.equal(S.applySetup(answers(docs), c).ok, true);
  // the user edits one installed file
  fs.writeFileSync(path.join(root, '.claude/docs-templates/START-HERE.md'), '# my start\n');
  // the template moves on: delegate.sh and START-HERE change, a new file appears, CLAUDE.md text changes
  fs.writeFileSync(path.join(tpl, '.claude/scripts/delegate.sh'), `${fs.readFileSync(path.join(tpl, '.claude/scripts/delegate.sh'), 'utf8')}# v2\n`);
  fs.writeFileSync(path.join(tpl, '.claude/docs-templates/START-HERE.md'), '# Start here v2\n');
  fs.writeFileSync(path.join(tpl, '.claude/scripts/new.sh'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(tpl, 'CLAUDE.md'), fs.readFileSync(path.join(tpl, 'CLAUDE.md'), 'utf8').replace('None yet.', 'Template v2 text.'));
  const b = JSON.parse(fs.readFileSync(path.join(tpl, '.claude/setup/blocks.json'), 'utf8'));
  b.version = 2;
  fs.writeFileSync(path.join(tpl, '.claude/setup/blocks.json'), JSON.stringify(b));
  const st = S.setupStatus({ state: stateFor(root), home, env });
  assert.equal(st.upgradeAvailable, true);
  assert.equal(st.installedVersion, 1);
  assert.equal(st.templateVersion, 2);
  const pv = S.previewSetup(answers(docs), c);
  assert.equal(fileEntry(pv, '.claude/scripts/delegate.sh').state, 'outdated');
  assert.equal(fileEntry(pv, '.claude/docs-templates/START-HERE.md').state, 'modified');
  assert.equal(fileEntry(pv, '.claude/scripts/new.sh').state, 'new');
  const r = S.applySetup(answers(docs), c);
  assert.equal(r.ok, true);
  assert.ok(r.updated.includes('.claude/scripts/delegate.sh'));
  assert.ok(r.updated.includes('CLAUDE.md'));
  assert.ok(r.created.includes('.claude/scripts/new.sh'));
  assert.deepEqual(r.flagged.map((f) => f.path), ['.claude/docs-templates/START-HERE.md']);
  assert.equal(read(root, '.claude/docs-templates/START-HERE.md'), '# my start\n', 'the edited file is untouched');
  assert.match(read(root, '.claude/scripts/delegate.sh'), /# v2/);
  assert.equal(fs.statSync(path.join(root, '.claude/scripts/delegate.sh')).mode & 0o111, 0o111, 'exec bit kept on update');
  assert.match(read(root, 'CLAUDE.md'), /Template v2 text\./);
  assert.equal(JSON.parse(read(root, S.MANIFEST_REL)).version, 2);
  // and again: quiet, the flagged file stays flagged
  const again = S.applySetup(answers(docs), c);
  assert.deepEqual([again.created, again.updated], [[], []]);
  assert.equal(again.flagged.length, 1);
});

test('a symlinked file is left alone, never replaced', () => {
  const { root, docs } = pair();
  fs.mkdirSync(path.join(root, '.claude/scripts'), { recursive: true });
  const target = path.join(dir('t'), 'real.sh');
  fs.writeFileSync(target, 'real');
  fs.symlinkSync(target, path.join(root, '.claude/scripts/delegate.sh'));
  const real = path.join(dir('t'), 'CLAUDE.md');
  fs.writeFileSync(real, '# linked\n');
  fs.symlinkSync(real, path.join(root, 'CLAUDE.md'));
  const r = S.applySetup(answers(docs, { appendBlocks: true }), ctx(root));
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'real');
  assert.equal(fs.readFileSync(real, 'utf8'), '# linked\n');
  assert.ok(fs.lstatSync(path.join(root, 'CLAUDE.md')).isSymbolicLink());
});

test('failure paths: bad json config, newer config, missing template, missing blocks, missing docs choice', () => {
  const { root, docs } = pair();
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, S.CONFIG_REL), '{broken');
  const bad = S.applySetup(answers(docs), ctx(root));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /will not overwrite/);
  assert.equal(read(root, S.CONFIG_REL), '{broken');
  assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.md')), 'a refused apply writes nothing');
  fs.writeFileSync(path.join(root, S.CONFIG_REL), JSON.stringify({ version: 7 }));
  assert.match(S.applySetup(answers(docs), ctx(root)).error, /version 7/);
  fs.rmSync(path.join(root, S.CONFIG_REL));
  const tpl = dir('tpl');
  copyDir(FIXTURE, tpl);
  fs.rmSync(path.join(tpl, '.claude/setup/blocks.json'));
  const r = S.applySetup(answers(docs), { state: stateFor(root), home, env: { DEKKI_TEMPLATE: tpl } });
  assert.equal(r.status, 500);
  assert.match(r.error, /template is incomplete/);
  // no docs folder given, a relative one, a missing one without the create choice
  assert.equal(S.applySetup({}, ctx(root)).field, 'docsDir');
  assert.equal(S.applySetup(answers('rel/docs'), ctx(root)).field, 'docsDir');
  const missing = path.join(docs, 'later');
  const m = S.applySetup(answers(missing), ctx(root));
  assert.equal(m.ok, false);
  assert.match(m.error, /Tick "Create it"/);
  assert.ok(!fs.existsSync(missing));
  assert.equal(S.previewSetup(answers(missing), ctx(root)).docs.needsCreate, true, 'preview still works for a folder to create');
  const ok = S.applySetup(answers(missing, { createDocsDir: true }), ctx(root));
  assert.equal(ok.ok, true);
  assert.ok(ok.created.includes(missing));
  assert.ok(fs.existsSync(path.join(missing, 'README.md')));
  // no working folder at all; a body that is not an object
  assert.equal(S.applySetup(answers(docs), { state: stateFor(''), home, env: process.env }).field, 'root');
  assert.equal(S.previewSetup(null, ctx(root)).field, 'docsDir');
});

test('a docs folder equal to, inside or containing the working folder is refused by apply too', () => {
  const { root } = pair();
  for (const d of [root, path.join(root, 'docs'), path.dirname(root)]) {
    const r = S.applySetup(answers(d, { createDocsDir: true }), ctx(root));
    assert.equal(r.ok, false, d);
    assert.equal(r.field, 'docsDir');
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test('paths with spaces work end to end; non-git folders are fine', () => {
  const root = path.join(dir('sp'), 'My Work Folder');
  const docs = path.join(dir('sp'), 'My Docs');
  fs.mkdirSync(root);
  fs.mkdirSync(docs);
  fs.mkdirSync(path.join(root, 'plain-folder'));
  const r = S.applySetup(answers(docs, { neverTouch: 'the "live" site' }), ctx(root));
  assert.equal(r.ok, true, r.error);
  assert.ok(read(root, 'CLAUDE.md').includes(`Project docs live in ${docs}.`));
  assert.deepEqual(S.listRepos(root).repos, [{ name: 'plain-folder', git: false }]);
});

test('config keys written by someone else survive a re-run, including projects', () => {
  const { root, docs } = pair();
  S.applySetup(answers(docs), ctx(root));
  const f = path.join(root, S.CONFIG_REL);
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  c.projects = { web: { setupAt: '2026-01-01', checks: { build: 'make' } } };
  c.custom = { keep: true };
  fs.writeFileSync(f, JSON.stringify(c));
  assert.equal(S.applySetup(answers(docs, { neverTouch: 'prod' }), ctx(root)).ok, true);
  const n = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(n.projects, c.projects);
  assert.deepEqual(n.custom, { keep: true });
  assert.equal(n.neverTouch, 'prod');
});

test('docs README: never overwritten; own text from blocks.json or the template is used when present', () => {
  const { root, docs } = pair();
  fs.writeFileSync(path.join(docs, 'README.md'), 'mine');
  const r = S.applySetup(answers(docs), ctx(root));
  assert.equal(read(docs, 'README.md'), 'mine');
  assert.ok(r.skipped.includes(path.join(docs, 'README.md')));
  const tpl = S.loadTemplate(FIXTURE);
  assert.match(S.docsReadme(tpl), /Read START-HERE and the newest LOG entry/);
  assert.equal(S.docsReadme({ blocks: { docsReadme: 'Own' }, files: [] }), 'Own\n');
  assert.equal(S.docsReadme({ blocks: {}, files: [{ rel: '.claude/docs-templates/README.md', buf: Buffer.from('From template') }] }), 'From template');
});

// ------------------------------------------------------------------ per account

test('per account: each account keeps its own config in its own working folder; reuse never carries the docs folder', () => {
  const rootA = dir('workA');
  const rootB = dir('workB');
  const docsA = dir('docsA');
  const docsB = dir('docsB');
  const cfgB = dir('cfgB');
  const both = (active) => ({ root: rootA, accounts: [{ id: 'second', label: 'Second', configDir: cfgB, root: rootB }], activeAccount: active });
  const cA = { state: both('default'), home, env: process.env };
  const cB = { state: both('second'), home, env: process.env };
  assert.equal(S.applySetup(answers(docsA, { neverTouch: 'prod A', secretsDir: '/keys/a', preferences: { replyStyle: 'detailed' } }), cA).ok, true);
  assert.ok(fs.existsSync(path.join(rootA, S.CONFIG_REL)));
  assert.ok(!fs.existsSync(path.join(rootB, S.CONFIG_REL)), 'the other account is untouched');
  // the second account's wizard can prefill from the first, but never its docs folder
  const st = S.setupStatus({ ...cB });
  assert.equal(st.account.id, 'second');
  assert.equal(st.root, rootB);
  assert.equal(st.config, null);
  assert.equal(st.reuse.length, 1);
  assert.equal(st.reuse[0].id, 'default');
  assert.equal(st.reuse[0].neverTouch, 'prod A');
  assert.equal(st.reuse[0].secretsDir, '/keys/a');
  assert.equal(st.reuse[0].preferences.replyStyle, 'detailed');
  assert.ok(!JSON.stringify(st.reuse).includes(docsA));
  assert.ok(!('docsDir' in st.reuse[0]));
  const r = S.applySetup(answers(docsB), cB);
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(read(rootB, S.CONFIG_REL)).docsDir, docsB);
  assert.equal(JSON.parse(read(rootA, S.CONFIG_REL)).docsDir, docsA);
  // account A sees B as a reuse source and its own config as saved answers
  const stA = S.setupStatus({ ...cA });
  assert.equal(stA.config.docsDir, docsA);
  assert.equal(stA.reuse[0].id, 'second');
  // an account without a working folder is not a source; a broken config is not either
  fs.writeFileSync(path.join(rootB, S.CONFIG_REL), '{bad');
  assert.deepEqual(S.reuseCandidates(both('default'), home), []);
  assert.deepEqual(S.reuseCandidates({ root: rootA, accounts: [{ id: 'third', label: 'Third', configDir: cfgB }], activeAccount: 'default' }, home), []);
});

test('setupStatus: no root yet suggests the first existing candidate; candidate lists repos; broken config is reported', () => {
  const h = dir('home2');
  assert.equal(S.suggestRoot(h), null);
  fs.mkdirSync(path.join(h, 'code'));
  fs.mkdirSync(path.join(h, 'Documents/Projects'), { recursive: true });
  assert.equal(S.suggestRoot(h), path.join(h, 'code'));
  fs.mkdirSync(path.join(h, 'Projects'));
  assert.equal(S.suggestRoot(h), path.join(h, 'Projects'));
  const proj = path.join(h, 'Projects');
  fs.mkdirSync(path.join(proj, 'app/.git'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'notes'));
  fs.mkdirSync(path.join(proj, '.hidden'));
  fs.writeFileSync(path.join(proj, 'afile'), '');
  const s = S.setupStatus({ state: stateFor(''), home: h, env: process.env, candidate: proj, demo: true });
  assert.equal(s.root, null);
  assert.equal(s.suggestedRoot, proj);
  assert.equal(s.demo, true);
  assert.deepEqual(s.candidate.repos, [{ name: 'app', git: true }, { name: 'notes', git: false }]);
  assert.equal(s.configState, 'missing');
  assert.deepEqual(s.defaults.protectedBranches, S.DEFAULT_BRANCHES);
  assert.equal(S.setupStatus({ state: stateFor(''), home: h, env: process.env, candidate: path.join(h, 'nope') }).candidate.ok, false);
  const { root, docs } = pair();
  S.applySetup(answers(docs), ctx(root));
  assert.equal(S.setupStatus(ctx(root)).rootReady, true);
  assert.equal(S.setupStatus(ctx(root)).files.length > 0, true);
  fs.writeFileSync(path.join(root, S.CONFIG_REL), '{x');
  const bad = S.setupStatus(ctx(root));
  assert.equal(bad.configState, 'invalid');
  assert.match(bad.configError, /not valid JSON/);
});

test('listRepos caps a huge folder', () => {
  const root = dir('many');
  for (let i = 0; i < 205; i++) fs.mkdirSync(path.join(root, `p${String(i).padStart(3, '0')}`));
  const r = S.listRepos(root);
  assert.equal(r.repos.length, 200);
  assert.equal(r.more, 5);
  assert.deepEqual(S.listRepos(path.join(tmp, 'nowhere')), { repos: [], more: 0 });
});

// ------------------------------------------------------------------ health

const okExec = (out = 'ok: fine\n') => (file, args, opts, cb) => cb(null, out, '');
const badExec = (msg) => (file, args, opts, cb) => cb(Object.assign(new Error('x'), { code: 1 }), '', msg);

async function healthyRoot(extra = {}) {
  const { root, docs } = pair();
  assert.equal(S.applySetup(answers(docs), ctx(root)).ok, true);
  // render the deny rules the way delegate.sh --check does
  fs.copyFileSync(path.join(root, '.claude/scripts/worker-deny.json'), path.join(root, '.claude/worker-settings.json'));
  const bin = dir('bin');
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  return { root, docs, bin, ctx: { ...ctx(root), exec: okExec(), pathEnv: bin, ...extra } };
}
const item = (h, id) => h.items.find((i) => i.id === id);

test('health: all green on a set-up folder, unslop is only an info', async () => {
  const h = await healthyRoot();
  const r = await S.runHealth(h.ctx);
  assert.equal(r.ok, true, JSON.stringify(r.items.filter((i) => i.status === 'fail')));
  assert.deepEqual(r.items.map((i) => i.id), ['playbook', 'scripts', 'config', 'docs', 'claude', 'delegate', 'links', 'deny', 'unslop', 'trust']);
  assert.equal(item(r, 'unslop').status, 'info');
  assert.match(item(r, 'delegate').detail, /ok: fine/);
  assert.equal(item(r, 'deny').status, 'ok');
});

test('health runs delegate.sh --check for real with execFile (fixture script), in the working folder', async () => {
  const { root, docs } = pair();
  S.applySetup(answers(docs), ctx(root));
  const bin = dir('bin');
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  const r = await S.runHealth({ ...ctx(root), pathEnv: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(item(r, 'delegate').status, 'ok', JSON.stringify(item(r, 'delegate')));
  assert.equal(item(r, 'deny').status, 'ok', 'the script rendered the deny rules');
  assert.equal(r.ok, true);
});

test('health: skill present is ok', async () => {
  const cfg = dir('cfg');
  fs.mkdirSync(path.join(cfg, 'skills/unslop'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'skills/unslop/SKILL.md'), '');
  const h = await healthyRoot();
  const state = { ...h.ctx.state, accounts: [{ id: 'x', label: 'X', configDir: cfg, root: h.root }], activeAccount: 'x' };
  const r = await S.runHealth({ ...h.ctx, state });
  assert.equal(item(r, 'unslop').status, 'ok');
});

test('health failures come with a one-line fix', async () => {
  const h = await healthyRoot();
  fs.rmSync(path.join(h.root, 'CLAUDE.md'));
  fs.chmodSync(path.join(h.root, '.claude/scripts/delegate.sh'), 0o644);
  fs.rmSync(h.docs, { recursive: true });
  const r = await S.runHealth({ ...h.ctx, pathEnv: '/nonexistent' , exec: badExec('usage: delegate.sh <project>') });
  assert.equal(r.ok, false);
  for (const id of ['playbook', 'scripts', 'docs', 'claude', 'delegate']) {
    assert.equal(item(r, id).status, 'fail', id);
    assert.ok(item(r, id).fix && !item(r, id).fix.includes('\n'), `${id} has a one-line fix`);
  }
  assert.match(item(r, 'scripts').fix, /chmod \+x \.claude\/scripts\/delegate\.sh/);
  assert.match(item(r, 'delegate').fix, /older than the wizard/);
});

test('health: config problems, missing script, missing or weak deny rules, no root', async () => {
  const h = await healthyRoot();
  fs.writeFileSync(path.join(h.root, S.CONFIG_REL), '{x');
  assert.match(item(await S.runHealth(h.ctx), 'config').detail, /not valid JSON/);
  fs.writeFileSync(path.join(h.root, S.CONFIG_REL), JSON.stringify({ version: 1 }));
  assert.match(item(await S.runHealth(h.ctx), 'config').detail, /docs folder is not set/);
  fs.writeFileSync(path.join(h.root, S.CONFIG_REL), JSON.stringify({ version: 1, docsDir: h.docs, protectedBranches: [] }));
  assert.match(item(await S.runHealth(h.ctx), 'config').detail, /No protected branches/);
  fs.rmSync(path.join(h.root, S.CONFIG_REL));
  assert.equal(item(await S.runHealth(h.ctx), 'config').status, 'fail');
  fs.writeFileSync(path.join(h.root, S.CONFIG_REL), JSON.stringify({ version: 1, docsDir: h.docs, protectedBranches: ['main', 'trunk'] }));
  const weak = await S.runHealth(h.ctx);
  assert.match(item(weak, 'deny').detail, /Not blocked: trunk/);
  fs.rmSync(path.join(h.root, '.claude/worker-settings.json'));
  assert.match(item(await S.runHealth(h.ctx), 'deny').detail, /missing/);
  fs.rmSync(path.join(h.root, '.claude/scripts/delegate.sh'));
  assert.match(item(await S.runHealth(h.ctx), 'delegate').detail, /missing/);
  const none = await S.runHealth({ state: stateFor(''), home, exec: okExec() });
  assert.equal(none.ok, false);
  assert.equal(none.items[0].id, 'root');
  const gone = await S.runHealth({ state: stateFor(path.join(tmp, 'gone')), home, exec: okExec() });
  assert.match(gone.items[0].detail, /Missing/);
});

test('health: delegate.sh that records links elsewhere fails with a fix; the right path passes', async () => {
  const h = await healthyRoot();
  assert.equal(item(await S.runHealth(h.ctx), 'links').status, 'ok');
  const script = path.join(h.root, '.claude/scripts/delegate.sh');
  fs.writeFileSync(script, '#!/bin/sh\necho "$1" >> "$HOME/.old-place/links.tsv"\n', { mode: 0o755 });
  const r = await S.runHealth(h.ctx);
  assert.equal(item(r, 'links').status, 'fail');
  assert.match(item(r, 'links').detail, /does not read, so workers will not nest/);
  assert.match(item(r, 'links').fix, /current template.*links\.tsv/);
  assert.ok(!item(r, 'links').fix.includes('\n'));
  fs.writeFileSync(script, '#!/bin/sh\necho "$1" >> "$HOME/.dekki/links.tsv"\n', { mode: 0o755 });
  assert.equal(item(await S.runHealth(h.ctx), 'links').status, 'ok');
});

test('globToRegExp and unprotectedBranches', () => {
  assert.ok(S.globToRegExp('git push * main').test('git push origin main'));
  assert.ok(!S.globToRegExp('git push * main').test('git push origin main2'));
  assert.ok(S.globToRegExp('a.b(c)').test('a.b(c)'), 'regex characters are literal');
  assert.ok(!S.globToRegExp('a.b').test('axb'));
  const deny = ['Bash(git push origin main)', 'Bash(git push * develop *)', 'Bash(git * push *)', 'Read(x)'];
  assert.deepEqual(S.unprotectedBranches(deny, ['main']), ['main'], 'one push form missing counts as not blocked');
  assert.deepEqual(S.unprotectedBranches(['Bash(git push *)'], ['main', 'release/1']), []);
  assert.deepEqual(S.unprotectedBranches(['Bash(git push origin *)'], ['main']), ['main'], '-u origin main slips past this one');
  assert.deepEqual(S.unprotectedBranches(undefined, ['main']), ['main']);
  assert.deepEqual(S.unprotectedBranches(['Bash(git push * main)'], ['main']), [], 'git push origin main and -u origin main both match');
});

// ------------------------------------------------------------------ shipped text hygiene

test('the wizard files carry no product, company or personal names', () => {
  const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const files = ['server/setup.js', 'web/SetupWizard.jsx', 'web/setup-ui.js'].filter((f) => fs.existsSync(path.join(repo, f)));
  assert.ok(files.length >= 1);
  const banned = /canyon|strava|eclips|jira|lokalise|apidog|contentful|kdemireren|kutay|\/Users\//i;
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(repo, f), 'utf8'), banned, f);
});
