// Pure logic of the setup wizard (web/setup-ui.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as U from '../../web/setup-ui.js';

test('four screens, in the agreed order', () => {
  assert.deepEqual(U.STEPS, ['Folders', 'Preferences', 'Safety', 'Review and create']);
  assert.deepEqual(U.PREF_ROWS.map((r) => r.key), ['replyStyle', 'autonomy', 'prs']);
  for (const r of U.PREF_ROWS) assert.equal(r.options[0].hint, 'Default', `${r.key}: the first option is the default`);
});

test('initialForm: defaults, suggested folder, no default docs folder; saved answers win', () => {
  const f = U.initialForm({ root: null, suggestedRoot: '/h/Projects' });
  assert.equal(f.root, '/h/Projects');
  assert.equal(f.docsDir, '', 'the docs folder has no default');
  assert.deepEqual(f.protectedBranches, ['main', 'master', 'develop']);
  assert.deepEqual(f.preferences, { replyStyle: 'short', autonomy: 'outward', prs: 'me', language: 'same' });
  assert.equal(f.appendBlocks, false);
  assert.equal(U.initialForm({ root: '/w', suggestedRoot: '/h/Projects' }).root, '/w', 'a saved working folder beats the suggestion');
  assert.equal(U.initialForm(null).root, '');
  const saved = U.initialForm({ root: '/w', config: { docsDir: '/d', protectedBranches: ['trunk'], neverTouch: 'x', secretsDir: '/s', preferences: { replyStyle: 'detailed', autonomy: 'rare', prs: 'workers-draft', language: 'Dutch' } } });
  assert.equal(saved.docsDir, '/d');
  assert.deepEqual(saved.protectedBranches, ['trunk']);
  assert.equal(saved.preferences.language, 'custom');
  assert.equal(saved.languageName, 'Dutch');
  assert.equal(saved.neverTouch, 'x');
});

test('buildRequest: trims, nulls the optional fields, custom language only with a name', () => {
  const f = U.initialForm({ root: '/w' });
  const r = U.buildRequest({ ...f, docsDir: ' /d ', neverTouch: '  ', secretsDir: ' /s ' });
  assert.deepEqual(r, { root: '/w', docsDir: '/d', createDocsDir: false, preferences: { replyStyle: 'short', autonomy: 'outward', prs: 'me', language: 'same' }, protectedBranches: ['main', 'master', 'develop'], neverTouch: null, secretsDir: '/s', appendBlocks: false });
  assert.equal(U.buildRequest({ ...f, preferences: { ...f.preferences, language: 'custom' }, languageName: ' French ' }).preferences.language, 'French');
  assert.equal(U.buildRequest({ ...f, preferences: { ...f.preferences, language: 'custom' }, languageName: '  ' }).preferences.language, 'same');
  assert.equal(U.buildRequest({ ...f, createDocsDir: true, appendBlocks: true }).appendBlocks, true);
});

test('isDirty: only a change counts, the prefilled folder does not', () => {
  const a = U.initialForm({ root: null, suggestedRoot: '/h/Projects' });
  assert.equal(U.isDirty({ ...a }, a), false);
  assert.equal(U.isDirty({ ...a, docsDir: '/x' }, a), true);
  assert.equal(U.isDirty({ ...a, protectedBranches: ['main'] }, a), true);
});

test('addBranches: several at once, duplicates ignored, bad names refused, list capped', () => {
  assert.deepEqual(U.addBranches(['main'], 'master, develop  release/1.x'), { list: ['main', 'master', 'develop', 'release/1.x'], error: null });
  assert.deepEqual(U.addBranches(['main'], 'main'), { list: ['main'], error: null });
  assert.deepEqual(U.addBranches(['main'], ''), { list: ['main'], error: null });
  const bad = U.addBranches(['main'], 'ok, bad*name');
  assert.deepEqual(bad.list, ['main']);
  assert.match(bad.error, /bad\*name/);
  assert.ok(U.addBranches(['main'], 'a..b').error);
  assert.ok(U.addBranches(Array.from({ length: 30 }, (_, i) => `b${i}`), 'one-more').error);
  assert.deepEqual(U.removeBranch(['a', 'b'], 'a'), ['b']);
});

test('foldersError: both folders are needed', () => {
  assert.match(U.foldersError({ root: '', docsDir: '/d' }), /working folder/);
  assert.match(U.foldersError({ root: '/w', docsDir: '  ' }), /docs folder/);
  assert.equal(U.foldersError({ root: '/w', docsDir: '/d' }), null);
});

test('resetScreen (Skip) restores the defaults of that screen only', () => {
  const f = { ...U.initialForm({ root: '/w' }), docsDir: '/d', neverTouch: 'x', secretsDir: '/s', protectedBranches: ['x'], languageName: 'Y', preferences: { replyStyle: 'detailed', autonomy: 'rare', prs: 'workers-draft', language: 'custom' } };
  const p = U.resetScreen(f, 1);
  assert.deepEqual(p.preferences, U.DEFAULT_PREFS);
  assert.deepEqual(p.protectedBranches, U.DEFAULT_BRANCHES);
  assert.equal(p.neverTouch, 'x', 'Safety untouched');
  const s = U.resetScreen(f, 2);
  assert.equal(s.neverTouch, '');
  assert.equal(s.secretsDir, '');
  assert.equal(s.preferences.replyStyle, 'detailed', 'Preferences untouched');
  assert.equal(U.resetScreen(f, 0), f);
});

test('applyReuse copies preferences and guardrails, never the docs folder', () => {
  const f = { ...U.initialForm({ root: '/w' }), docsDir: '/mine' };
  const r = U.applyReuse(f, { id: 'x', docsDir: '/theirs', protectedBranches: ['trunk'], neverTouch: 'prod', secretsDir: '/k', preferences: { replyStyle: 'detailed', autonomy: 'rare', prs: 'workers-draft', language: 'Turkish' } });
  assert.equal(r.docsDir, '/mine');
  assert.deepEqual(r.protectedBranches, ['trunk']);
  assert.equal(r.neverTouch, 'prod');
  assert.equal(r.preferences.language, 'custom');
  assert.equal(r.languageName, 'Turkish');
  assert.equal(U.applyReuse(f, null), f);
  assert.equal(U.applyReuse(f, { preferences: { language: 'same' } }).preferences.language, 'same');
});

test('resultLines: counts, blocks refreshed, flagged files and the CLAUDE.md.new sentence', () => {
  const base = { created: [], updated: [], blocksRefreshed: [], flagged: [], newPlaybook: null, newPlaybookNote: null };
  assert.deepEqual(U.resultLines(base), ['Nothing to change: everything was already in place.']);
  assert.deepEqual(U.resultLines({ ...base, created: ['a', 'b'], updated: ['c'] }), ['Created 2 files, updated 1.']);
  const note = 'Your CLAUDE.md has your edits, so the new playbook text was saved as CLAUDE.md.new. Compare the two and copy over what you want.';
  const l = U.resultLines({ ...base, blocksRefreshed: ['CLAUDE.md'], flagged: [{ path: 'CLAUDE.md' }], newPlaybook: 'CLAUDE.md.new', newPlaybookNote: note });
  assert.deepEqual(l, ['Setup blocks refreshed in CLAUDE.md; the rest of the file was kept.', 'Left alone because you edited them or they are older: CLAUDE.md', note]);
  assert.ok(!l.join('\n').includes('Nothing to change'), 'blocks refreshed is a change');
});

test('fileLabel and reviewCounts cover every state', () => {
  const L = (action, state = 'new', where = 'root', p = 'x') => U.fileLabel({ action, state, where, path: p }).text;
  assert.equal(L('create'), 'Create');
  assert.equal(L('append'), 'Setup blocks added at the end');
  assert.equal(L('update', 'outdated'), 'Outdated, will be updated');
  assert.equal(L('update', 'current', 'root', '.claude/harness.json'), 'Update');
  assert.equal(L('blocks', 'current'), 'Setup blocks refreshed');
  assert.equal(L('flag', 'modified'), 'Edited by you, left alone');
  assert.equal(L('flag', 'outdated'), 'Outdated, left alone');
  assert.equal(L('none', 'current'), 'Already there, left alone');
  assert.equal(L('adopt', 'current'), 'Already there, left alone');
  assert.equal(U.fileLabel({ action: 'flag', state: 'modified' }).tone, 'am');
  assert.deepEqual(U.reviewCounts([{ action: 'create' }, { action: 'append' }, { action: 'none' }, { action: 'adopt' }, { action: 'flag' }, { action: 'update' }, { action: 'blocks' }]), { create: 2, left: 2, update: 2, flagged: 1 });
  assert.equal(U.fileName({ where: 'docs', path: '/abs/README.md' }, '/d'), '/d/README.md');
  assert.equal(U.fileName({ where: 'root', path: 'CLAUDE.md' }, '/d'), 'CLAUDE.md');
});

test('claudeNotice: only when the blocks cannot be written; plain wording', () => {
  assert.equal(U.claudeNotice(null), null);
  assert.equal(U.claudeNotice({ claude: { markers: 'marked' } }), null);
  assert.equal(U.claudeNotice({ claude: { markers: 'none' } }), null);
  const n = U.claudeNotice({ claude: { markers: 'unmarked' } });
  assert.equal(n.text, 'Your CLAUDE.md is left as is.');
  assert.equal(n.option, 'Add the setup blocks to the end');
  assert.equal(n.copy, true);
  assert.ok(U.claudeNotice({ claude: { markers: 'partial', appendable: true } }));
  assert.equal(U.claudeNotice({ claude: { markers: 'partial', appendable: false } }), null);
});

test('healthMark and wizardTitle', () => {
  assert.equal(U.healthMark({ status: 'ok' }).glyph, '✓');
  assert.equal(U.healthMark({ status: 'fail' }).tone, 'rd');
  assert.equal(U.healthMark({ status: 'info' }).glyph, 'i');
  assert.equal(U.wizardTitle({ account: { label: 'Work' }, multi: true }, 'setup'), 'Set up (Work)');
  assert.equal(U.wizardTitle({ account: { label: 'Default' }, multi: false }, 'setup'), 'Set up');
  assert.equal(U.wizardTitle(null, 'check'), 'Check setup');
});

test('trustView: docs row first, one sentence, the commands as given, an overflow line, null when empty', () => {
  assert.equal(U.trustView(null), null);
  assert.equal(U.trustView({ dirs: [] }), null);
  const v = U.trustView({
    dirs: [{ kind: 'docs', name: '/d', path: '/d', command: 'cd "/d" && claude' }, { kind: 'project', name: 'app', path: '/w/app', command: 'cd "/w/app" && claude' }],
    more: 3,
  });
  assert.equal(v.title, 'Trust these folders once');
  assert.equal(v.text, 'Run each once, accept the trust prompt, then /exit.');
  assert.deepEqual(v.rows.map((r) => [r.label, r.command]), [['Docs folder', 'cd "/d" && claude'], ['app', 'cd "/w/app" && claude']]);
  assert.match(v.more, /^3 more git repos in the working folder/);
  assert.equal(U.trustView({ dirs: [{ kind: 'docs', name: '/d', path: '/d', command: 'x' }], more: 0 }).more, null);
  assert.match(U.trustView({ dirs: [{ kind: 'docs', name: '/d', path: '/d', command: 'x' }], more: 1 }).more, /^1 more git repo in/);
});

test('BASELINE_NOTE: calm line with the public README link, shown on the result screen', async () => {
  assert.equal(U.BASELINE_NOTE.href, 'https://github.com/kutaydemireren/dekki#make-it-yours');
  assert.equal(U.BASELINE_NOTE.linkText, 'Make it yours');
  assert.match(U.BASELINE_NOTE.text, /baseline/);
  const fs = await import('node:fs');
  const jsx = fs.readFileSync(new URL('../../web/SetupWizard.jsx', import.meta.url), 'utf8');
  const result = jsx.slice(jsx.indexOf('step === 3 && result'));
  assert.ok(result.includes('BASELINE_NOTE.text') && result.includes('BASELINE_NOTE.href'));
});
