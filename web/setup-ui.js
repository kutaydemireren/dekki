// Pure logic of the setup wizard (web/SetupWizard.jsx): form defaults, the request body, chips, labels, Esc-confirm.
// No React, no fetch: tested in server/test/setup-ui.test.js.

export const STEPS = ['Folders', 'Preferences', 'Safety', 'Review and create'];
export const DEFAULT_BRANCHES = ['main', 'master', 'develop'];
export const DEFAULT_PREFS = { replyStyle: 'short', autonomy: 'outward', prs: 'me', language: 'same' };

// Copy for the Preferences screen. The first option of each row is the default.
export const PREF_ROWS = [
  { key: 'replyStyle', label: 'Reply style', options: [
    { value: 'short', label: 'Short, answer first', hint: 'Default' },
    { value: 'detailed', label: 'Detailed' },
  ] },
  { key: 'autonomy', label: 'Autonomy', options: [
    { value: 'outward', label: 'Ask before anything outward-facing or irreversible', hint: 'Default' },
    { value: 'ask-all', label: 'Ask before any change' },
    { value: 'rare', label: 'Rarely ask' },
  ] },
  { key: 'prs', label: 'Pull requests', options: [
    { value: 'me', label: 'I open them', hint: 'Default' },
    { value: 'workers-draft', label: 'Workers open drafts' },
  ] },
];

/** The form of a fresh wizard. `status` is GET /api/setup; saved answers win over defaults, then the suggested folder. */
export function initialForm(status) {
  const s = status || {};
  const c = s.config || null;
  const prefs = { ...DEFAULT_PREFS, ...(c?.preferences || {}) };
  const custom = prefs.language !== 'same';
  return {
    root: s.root || s.suggestedRoot || '',
    docsDir: c?.docsDir || '',
    createDocsDir: false,
    preferences: { ...prefs, language: custom ? 'custom' : 'same' },
    languageName: custom ? prefs.language : '',
    protectedBranches: c?.protectedBranches?.length ? [...c.protectedBranches] : [...DEFAULT_BRANCHES],
    neverTouch: c?.neverTouch || '',
    secretsDir: c?.secretsDir || '',
    appendBlocks: false,
  };
}

/** The body of POST /api/setup/preview and /apply. An empty custom language means "same as I write". */
export function buildRequest(form) {
  const name = form.languageName.trim();
  const language = form.preferences.language === 'custom' && name ? name : 'same';
  return {
    root: form.root.trim(),
    docsDir: form.docsDir.trim(),
    createDocsDir: form.createDocsDir === true,
    preferences: { replyStyle: form.preferences.replyStyle, autonomy: form.preferences.autonomy, prs: form.preferences.prs, language },
    protectedBranches: form.protectedBranches,
    neverTouch: form.neverTouch.trim() || null,
    secretsDir: form.secretsDir.trim() || null,
    appendBlocks: form.appendBlocks === true,
  };
}

/** Did the user type or change anything since the wizard opened? (Esc asks before closing only then.) */
export const isDirty = (form, initial) => JSON.stringify(form) !== JSON.stringify(initial);

/** Add a protected branch from the chip input. Returns {list, error}; a comma or space separates several. */
export function addBranches(list, text) {
  const next = [...list];
  for (const raw of String(text).split(/[,\s]+/).filter(Boolean)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(raw) || raw.includes('..')) return { list, error: `"${raw}" is not a plain branch name.` };
    if (!next.includes(raw)) next.push(raw);
  }
  if (next.length > 30) return { list, error: 'That is a lot of branches. Keep it under 30.' };
  return { list: next, error: null };
}
export const removeBranch = (list, name) => list.filter((b) => b !== name);

/** Screen 1 needs both folders typed. Returns an error line or null (the server checks the rest). */
export function foldersError(form) {
  if (!form.root.trim()) return 'Choose a working folder.';
  if (!form.docsDir.trim()) return 'Choose a docs folder: type a path or use Choose folder.';
  return null;
}

/** Skip on Preferences / Safety: back to the defaults of that screen. */
export function resetScreen(form, step) {
  if (step === 1) return { ...form, preferences: { ...DEFAULT_PREFS }, languageName: '', protectedBranches: [...DEFAULT_BRANCHES] };
  if (step === 2) return { ...form, neverTouch: '', secretsDir: '' };
  return form;
}

/** "Reuse my choices from <account>": preferences and guardrails only, never the docs folder. */
export function applyReuse(form, source) {
  if (!source) return form;
  const lang = source.preferences?.language || 'same';
  return {
    ...form,
    preferences: { ...DEFAULT_PREFS, ...source.preferences, language: lang === 'same' ? 'same' : 'custom' },
    languageName: lang === 'same' ? '' : lang,
    protectedBranches: source.protectedBranches?.length ? [...source.protectedBranches] : [...DEFAULT_BRANCHES],
    neverTouch: source.neverTouch || '',
    secretsDir: source.secretsDir || '',
  };
}

/** One review row: {text, tone: 'gr'|'am'|'' } from a preview file entry. */
export function fileLabel(f) {
  if (f.action === 'create') return { text: 'Create', tone: 'gr' };
  if (f.action === 'append') return { text: 'Setup blocks added at the end', tone: 'gr' };
  if (f.action === 'update') return { text: f.state === 'outdated' ? 'Outdated, will be updated' : 'Update', tone: 'am' };
  if (f.action === 'blocks') return { text: 'Setup blocks refreshed', tone: 'gr' };
  if (f.action === 'flag') return { text: f.state === 'modified' ? 'Edited by you, left alone' : 'Outdated, left alone', tone: 'am' };
  return { text: 'Already there, left alone', tone: '' };
}

/** Short name for a path in the review list: docs README shows as "<docs folder>/README.md". */
export const fileName = (f, docsDir) => (f.where === 'docs' ? `${docsDir || 'docs folder'}/README.md` : f.path);

/** Counts for the review heading. */
export function reviewCounts(files) {
  const c = { create: 0, left: 0, update: 0, flagged: 0 };
  for (const f of files) {
    if (f.action === 'create' || f.action === 'append') c.create++;
    else if (f.action === 'update' || f.action === 'blocks') c.update++;
    else if (f.action === 'flag') c.flagged++;
    else c.left++;
  }
  return c;
}

/** The text of the result screen's first block (plain lines): what was written, what was left alone, the CLAUDE.md.new sentence. */
export function resultLines(r) {
  const c = r.created.length, u = r.updated.length, b = (r.blocksRefreshed || []).length;
  const plural = (n) => `${n} file${n === 1 ? '' : 's'}`;
  const lines = [];
  if (c) lines.push(`Created ${plural(c)}${u ? `, updated ${u}` : ''}.`);
  else if (u) lines.push(`Updated ${plural(u)}.`);
  else if (!b) lines.push('Nothing to change: everything was already in place.');
  if (b) lines.push('Setup blocks refreshed in CLAUDE.md; the rest of the file was kept.');
  const flagged = r.flagged.map((f) => f.path);
  if (flagged.length) lines.push(`Left alone because you edited them or they are older: ${flagged.join(', ')}`);
  if (r.newPlaybook && r.newPlaybookNote) lines.push(r.newPlaybookNote);
  return lines;
}

/** The calm line under the result screen: the setup is a baseline, with a pointer to the README section. */
export const BASELINE_NOTE = {
  text: 'This setup is a baseline to adapt to the way you work.',
  linkText: 'Make it yours',
  href: 'https://github.com/kutaydemireren/dekki#make-it-yours',
};

/** The CLAUDE.md heads-up to show, or null: only when the file exists and the setup blocks cannot be written into it. */
export function claudeNotice(preview) {
  const m = preview?.claude?.markers;
  if (m === 'unmarked') return { text: 'Your CLAUDE.md is left as is.', option: 'Add the setup blocks to the end', copy: true };
  if (m === 'partial' && preview.claude.appendable) return { text: 'Some setup blocks have no markers in your CLAUDE.md, so they are not written.', option: 'Add the missing blocks to the end', copy: true };
  return null;
}

/** Glyph and tone of a health item. */
export const healthMark = (item) => (item.status === 'ok' ? { glyph: '✓', tone: 'gr' } : item.status === 'info' ? { glyph: 'i', tone: '' } : { glyph: '✕', tone: 'rd' });

/** Title for the dialog, with the account name when there are several. */
export const wizardTitle = (status, mode) => `${mode === 'check' ? 'Check setup' : 'Set up'}${status?.account?.label && status.multi ? ` (${status.account.label})` : ''}`;

export const TRUST_TITLE = 'Trust these folders once';
export const TRUST_TEXT = 'Run each once, accept the trust prompt, then /exit.';

/** The "Trust these folders once" block of the result screen, from the apply answer's `trust`; null when there is nothing to show. */
export function trustView(trust) {
  const dirs = Array.isArray(trust?.dirs) ? trust.dirs : [];
  if (!dirs.length) return null;
  return {
    title: TRUST_TITLE,
    text: TRUST_TEXT,
    rows: dirs.map((d) => ({ key: d.path, label: d.kind === 'docs' ? 'Docs folder' : d.name, command: d.command })),
    more: trust.more > 0 ? `${trust.more} more git repo${trust.more === 1 ? '' : 's'} in the working folder: run the same command in each.` : null,
  };
}
