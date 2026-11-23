// Setup wizard logic: everything the wizard needs, apart from HTTP. Works on ONE working folder at a time, the
// active account's. Writes only inside that folder (template files, CLAUDE.md blocks, .claude/harness.json and
// .claude/harness.manifest.json), plus the docs folder the user chose (the folder itself and a README.md). Never
// overwrites a file that exists, except to update an unedited installed file or the marked blocks of CLAUDE.md.
// The shapes (config, markers, manifest, API) are the "Harness contract" in PUBLIC-RELEASE.md. Pure helpers come first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readState } from './state.js';
import { activeAccount, rootOf, expandHome, listAccounts, configDirOf, claudeEnv } from './accounts.js';
import { checkRootPath } from './root.js';

export const CONFIG_REL = '.claude/harness.json';
export const MANIFEST_REL = '.claude/harness.manifest.json';
export const WORKER_SETTINGS_REL = '.claude/worker-settings.json';
export const CLAUDE_NEW_REL = 'CLAUDE.md.new';
/** Files the wizard writes itself that are never tracked in the manifest, so they are never "outdated" or "modified". */
export const MANIFEST_EXEMPT = [CLAUDE_NEW_REL, WORKER_SETTINGS_REL];
export const NEW_PLAYBOOK_NOTE = 'Your CLAUDE.md has your edits, so the new playbook text was saved as CLAUDE.md.new. Compare the two and copy over what you want.';
export const CONFIG_VERSION = 1;
export const BLOCK_IDS = ['preferences', 'guardrails', 'docs'];
export const DEFAULT_BRANCHES = ['main', 'master', 'develop'];
export const DEFAULT_PREFS = { replyStyle: 'short', autonomy: 'outward', prs: 'me', language: 'same' };
export const PREF_CHOICES = { replyStyle: ['short', 'detailed'], autonomy: ['outward', 'ask-all', 'rare'], prs: ['me', 'workers-draft'] };
export const ROOT_CANDIDATES = ['Projects', 'Developer', 'code', 'Documents/Projects'];
export const TEXT_MAX = 2000;
const SETUP_DIR = '.claude/setup/'; // wizard input inside the template: read, never installed
const REPO_LIST_MAX = 200;

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The template folder. DEKKI_TEMPLATE overrides it (test seam: throwaway templates). */
export const templateDir = (env = process.env) => env.DEKKI_TEMPLATE || path.join(REPO_ROOT, 'templates', 'manager-root');

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const err = (error, field, status = 400) => ({ ok: false, status, error, ...(field ? { field } : {}) });

// ---------------------------------------------------------------- marked blocks

export const startMarker = (id) => `<!-- setup:${id}:start -->`;
export const endMarker = (id) => `<!-- setup:${id}:end -->`;
export const blockText = (id, body) => `${startMarker(id)}\n${body}\n${endMarker(id)}`;

const countOf = (text, needle) => { let n = 0; for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) n++; return n; };

/** Per block: 'ok' (one start, one end, in order), 'missing' (neither) or 'broken' (anything else). */
export function markerStatus(text) {
  const out = {};
  for (const id of BLOCK_IDS) {
    const s = countOf(text, startMarker(id));
    const e = countOf(text, endMarker(id));
    if (s === 0 && e === 0) out[id] = 'missing';
    else if (s === 1 && e === 1 && text.indexOf(startMarker(id)) < text.indexOf(endMarker(id))) out[id] = 'ok';
    else out[id] = 'broken';
  }
  return out;
}

/** Replace the body between the markers of every 'ok' block named in `bodies` ({id: text}). Nothing else is touched. */
export function fillBlocks(text, bodies) {
  const st = markerStatus(text);
  let out = text;
  for (const id of BLOCK_IDS) {
    if (st[id] !== 'ok' || typeof bodies[id] !== 'string') continue;
    const a = out.indexOf(startMarker(id)) + startMarker(id).length;
    const b = out.indexOf(endMarker(id));
    out = `${out.slice(0, a)}\n${bodies[id]}\n${out.slice(b)}`;
  }
  return out;
}

/** The text with every well-formed block body removed (what gets hashed, so block edits never count as file edits). */
export function stripBlocks(text) {
  return fillBlocks(text, Object.fromEntries(BLOCK_IDS.map((id) => [id, ''])));
}

/** Append whole blocks (markers included) at the very end of `text`. Nothing before them changes. */
export function appendBlocksText(text, ids, bodies) {
  if (!ids.length) return text;
  const lead = text.length === 0 ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${lead}${ids.map((id) => blockText(id, bodies[id] ?? '')).join('\n\n')}\n`;
}

/** Our own template text always carries the three markers; a template without them gets empty ones at the end. */
export function ensureMarkers(text) {
  const st = markerStatus(text);
  return appendBlocksText(text, BLOCK_IDS.filter((id) => st[id] === 'missing'), {});
}

// ---------------------------------------------------------------- template and block texts

/** Read blocks.json and the installable files of the template. `problems` lists what is missing or unreadable. */
export function loadTemplate(dir = templateDir()) {
  const problems = [];
  let blocks = null;
  try { blocks = JSON.parse(fs.readFileSync(path.join(dir, SETUP_DIR, 'blocks.json'), 'utf8')); } catch (e) {
    problems.push(e.code === 'ENOENT' ? `${SETUP_DIR}blocks.json is missing from the template.` : `${SETUP_DIR}blocks.json cannot be read: ${e.message}`);
  }
  if (blocks && !isObj(blocks)) { problems.push(`${SETUP_DIR}blocks.json must be a JSON object.`); blocks = null; }
  if (blocks) problems.push(...missingBlockKeys(blocks).map((k) => `blocks.json has no text for ${k}.`));
  const files = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (`${r}/` !== SETUP_DIR) walk(r); } else if (e.isFile() && e.name !== '.DS_Store') {
        files.push({ rel: r, buf: fs.readFileSync(path.join(dir, r)), mode: fs.statSync(path.join(dir, r)).mode & 0o777 });
      }
    }
  };
  try { walk(''); } catch (e) { problems.push(`The template folder cannot be read: ${e.message}`); }
  files.sort((a, b) => (a.rel === 'CLAUDE.md' ? -1 : b.rel === 'CLAUDE.md' ? 1 : a.rel < b.rel ? -1 : 1));
  if (!files.some((f) => f.rel === 'CLAUDE.md')) problems.push('The template has no CLAUDE.md.');
  const version = blocks && Number.isFinite(blocks.version) ? blocks.version : 1;
  return { dir, blocks, files, version, problems };
}

const BLOCK_KEYS = [
  'preferences.replyStyle.short', 'preferences.replyStyle.detailed',
  'preferences.autonomy.outward', 'preferences.autonomy.ask-all', 'preferences.autonomy.rare',
  'preferences.prs.me', 'preferences.prs.workers-draft',
  'preferences.language.same', 'preferences.language.custom',
  'guardrails.neverTouch', 'guardrails.secretsDir', 'docs',
];
const textAt = (blocks, key) => {
  let v = blocks;
  for (const k of key.split('.')) v = isObj(v) ? v[k] : undefined;
  if (Array.isArray(v)) v = v.join('\n');
  return typeof v === 'string' ? v : null;
};
export const missingBlockKeys = (blocks) => BLOCK_KEYS.filter((k) => textAt(blocks, k) === null);

/** One pass, so a value that itself contains {{x}} is never expanded again. */
export const fillPlaceholders = (text, values) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.hasOwn(values, k) ? String(values[k]) : m));

/** Bodies of the three blocks (no markers) for a config. Needs a complete blocks.json (see missingBlockKeys). */
export function renderBlocks(config, blocks) {
  const t = (key, values = {}) => fillPlaceholders(textAt(blocks, key) ?? '', values);
  const p = config.preferences || DEFAULT_PREFS;
  const branches = config.protectedBranches?.length ? config.protectedBranches : DEFAULT_BRANCHES;
  const branchLine = textAt(blocks, 'preferences.branches');
  const prefs = [
    t(`preferences.replyStyle.${p.replyStyle}`),
    t(`preferences.autonomy.${p.autonomy}`),
    branchLine !== null ? fillPlaceholders(branchLine, { branches: branches.join(', ') }) : `- Protected branches (never push to them, never merge): ${branches.join(', ')}.`,
    t(`preferences.prs.${p.prs}`),
    p.language === 'same' ? t('preferences.language.same') : t('preferences.language.custom', { language: p.language }),
  ];
  const guard = [];
  if (config.neverTouch) guard.push(t('guardrails.neverTouch', { text: config.neverTouch }));
  if (config.secretsDir) guard.push(t('guardrails.secretsDir', { path: config.secretsDir }));
  if (!guard.length) guard.push(textAt(blocks, 'guardrails.none') ?? '- No extra guardrails were set in the setup.');
  return { preferences: prefs.join('\n'), guardrails: guard.join('\n'), docs: t('docs', { docsDir: config.docsDir }) };
}

// ---------------------------------------------------------------- validation

const cleanLine = (s) => String(s).replace(/<!--|-->/g, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** Check and normalise the wizard answers. Docs folder and working folder are checked separately (they need the disk). */
export function normalizeAnswers(input, { home = os.homedir() } = {}) {
  const body = isObj(input) ? input : {};
  const pIn = isObj(body.preferences) ? body.preferences : {};
  const preferences = { ...DEFAULT_PREFS };
  for (const key of Object.keys(PREF_CHOICES)) {
    if (pIn[key] === undefined || pIn[key] === null || pIn[key] === '') continue;
    if (!PREF_CHOICES[key].includes(pIn[key])) return err(`Unknown choice for ${key}.`, key);
    preferences[key] = pIn[key];
  }
  if (pIn.language !== undefined && pIn.language !== null && pIn.language !== '') {
    if (typeof pIn.language !== 'string') return err('The language must be text.', 'language');
    const l = cleanLine(pIn.language);
    if (!l || l.length > 60) return err('Give a language name of up to 60 characters, or pick "same as I write".', 'language');
    preferences.language = l === 'same' ? 'same' : l;
  }
  let protectedBranches = DEFAULT_BRANCHES.slice();
  if (body.protectedBranches !== undefined && body.protectedBranches !== null) {
    if (!Array.isArray(body.protectedBranches) || body.protectedBranches.length > 30) return err('Protected branches must be a short list of names.', 'protectedBranches');
    const out = [];
    for (const raw of body.protectedBranches) {
      const b = typeof raw === 'string' ? raw.trim() : '';
      if (!BRANCH_RE.test(b) || b.includes('..') || b.endsWith('/') || b.endsWith('.lock')) return err(`"${String(raw).slice(0, 40)}" is not a plain branch name (letters, digits, . _ - /).`, 'protectedBranches');
      if (!out.includes(b)) out.push(b);
    }
    if (out.length) protectedBranches = out;
  }
  let neverTouch = null;
  if (body.neverTouch !== undefined && body.neverTouch !== null) {
    if (typeof body.neverTouch !== 'string') return err('"Never touch" must be text.', 'neverTouch');
    neverTouch = cleanLine(body.neverTouch) || null;
    if (neverTouch && neverTouch.length > TEXT_MAX) return err(`Keep "never touch" under ${TEXT_MAX} characters.`, 'neverTouch');
  }
  let secretsDir = null;
  if (body.secretsDir !== undefined && body.secretsDir !== null && String(body.secretsDir).trim() !== '') {
    if (typeof body.secretsDir !== 'string' || /[\u0000-\u001f]/.test(body.secretsDir)) return err('The secrets folder must be a plain path.', 'secretsDir');
    const p = expandHome(body.secretsDir.trim(), home);
    if (!path.isAbsolute(p)) return err('The secrets folder must be an absolute path (or start with ~/).', 'secretsDir');
    secretsDir = path.resolve(p);
  }
  return { ok: true, value: { preferences, protectedBranches, neverTouch, secretsDir } };
}

/** Nearest existing ancestor of p (p itself when it exists), with its real path; and the missing tail below it. */
function nearestExisting(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try { return { dir: fs.realpathSync(cur), tail: tail.reverse() }; } catch { /* keep walking up */ }
    const up = path.dirname(cur);
    if (up === cur) return { dir: cur, tail: tail.reverse() };
    tail.push(path.basename(cur));
    cur = up;
  }
}
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** The working folder: an existing folder whose path has no quotes, ampersands or backslashes (delegate.sh refuses those). */
export function validateWorkRoot(input, home = os.homedir()) {
  const c = checkRootPath(input, home);
  if (!c.ok) return { ...c, field: 'root' };
  if (/['"\\&]/.test(c.root)) return err('The working folder path must not contain quotes, ampersands or backslashes (the delegate script cannot handle them). Pick another folder.', 'root');
  return c;
}

/**
 * The docs folder. It must be absolute, not equal to, inside or containing the working folder (the working folder's
 * subfolders are listed as projects), and writable. A missing folder is fine only when the user chose to create it
 * (`create`); the nearest existing parent must then be writable. Returns {ok, docsDir, exists, needsCreate}.
 */
export function validateDocsDir(input, workRoot, { create = false, home = os.homedir() } = {}) {
  if (typeof input !== 'string' || !input.trim() || /[\u0000-\u001f]/.test(input)) return err('Choose a docs folder: type a path or use Choose folder.', 'docsDir');
  const p = expandHome(input.trim(), home);
  if (!path.isAbsolute(p)) return err('The docs folder must be an absolute path (or start with ~/).', 'docsDir');
  const resolved = path.resolve(p);
  const { dir: base, tail } = nearestExisting(resolved);
  const real = path.join(base, ...tail);
  const rootReal = (() => { try { return fs.realpathSync(workRoot); } catch { return path.resolve(workRoot); } })();
  if (real === rootReal) return err('The docs folder cannot be the working folder. Pick a separate folder.', 'docsDir');
  if (inside(real, rootReal)) return err('The docs folder cannot be inside the working folder: its subfolders are listed as projects. Pick a folder outside it.', 'docsDir');
  if (inside(rootReal, real)) return err('The docs folder cannot contain the working folder. Pick a folder outside it.', 'docsDir');
  const exists = tail.length === 0;
  if (exists) {
    if (!fs.statSync(base).isDirectory()) return err(`Not a folder: ${resolved}`, 'docsDir');
    try { fs.accessSync(base, fs.constants.W_OK | fs.constants.X_OK); } catch { return err(`The docs folder is not writable: ${resolved}`, 'docsDir'); }
    return { ok: true, docsDir: resolved, exists: true, needsCreate: false };
  }
  if (!fs.statSync(base).isDirectory()) return err(`Not a folder: ${base}`, 'docsDir');
  if (!create) return { ok: true, docsDir: resolved, exists: false, needsCreate: true };
  try { fs.accessSync(base, fs.constants.W_OK | fs.constants.X_OK); } catch { return err(`Cannot create the docs folder: ${base} is not writable.`, 'docsDir'); }
  return { ok: true, docsDir: resolved, exists: false, needsCreate: true };
}

// ---------------------------------------------------------------- config and manifest files

/** Write a file by temp + rename, so a reader never sees half of it. Dir is created. */
export function writeFileAtomic(file, data, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
}

/** Create a file only when nothing (not even a dangling symlink) is there. Returns false when it already existed. */
export function createFileExclusive(file, data, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.chmodSync(tmp, mode);
    fs.linkSync(tmp, file); // fails with EEXIST instead of replacing
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
}

const lstatOrNull = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const readTextOrNull = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const ser = (o) => `${JSON.stringify(o, null, 2)}\n`;

/** {state:'missing'|'ok'|'invalid'|'newer', config?, error?} for <root>/.claude/harness.json. */
export function readConfig(root) {
  const txt = readTextOrNull(path.join(root, CONFIG_REL));
  if (txt === null) return { state: 'missing' };
  let v;
  try { v = JSON.parse(txt); } catch (e) { return { state: 'invalid', error: `harness.json is not valid JSON (${e.message}).` }; }
  if (!isObj(v)) return { state: 'invalid', error: 'harness.json must hold a JSON object.' };
  if (typeof v.version === 'number' && v.version > CONFIG_VERSION) return { state: 'newer', config: v, error: `harness.json is version ${v.version}; this deck understands version ${CONFIG_VERSION}. Update Dekki.` };
  return { state: 'ok', config: v };
}

/** The next config: the wizard's answers over what is there. Unknown keys, unknown preference keys and `projects` survive. */
export function mergeConfig(existing, { docsDir, protectedBranches, neverTouch, secretsDir, preferences }) {
  const old = isObj(existing) ? existing : {};
  if (typeof old.version === 'number' && old.version > CONFIG_VERSION) throw new Error(`harness.json is version ${old.version}, newer than this deck understands.`);
  const known = ['version', 'docsDir', 'protectedBranches', 'neverTouch', 'secretsDir', 'preferences', 'projects'];
  const next = {
    version: CONFIG_VERSION,
    docsDir,
    protectedBranches,
    neverTouch,
    secretsDir,
    preferences: { ...(isObj(old.preferences) ? old.preferences : {}), ...preferences },
    projects: isObj(old.projects) ? old.projects : {},
  };
  for (const [k, v] of Object.entries(old)) if (!known.includes(k)) next[k] = v;
  return next;
}

/** Atomic write of the config. */
export function writeConfig(root, config) { writeFileAtomic(path.join(root, CONFIG_REL), ser(config), 0o644); }

/** {version, files:{rel: sha256}, ...unknown}; a missing or unreadable manifest is an empty one. */
export function readManifest(root) {
  const txt = readTextOrNull(path.join(root, MANIFEST_REL));
  let v = null;
  try { v = txt === null ? null : JSON.parse(txt); } catch { v = null; }
  if (!isObj(v)) return { version: null, files: {}, present: false };
  return { ...v, files: isObj(v.files) ? v.files : {}, present: true };
}

// ---------------------------------------------------------------- plan: what apply would do

/** Hash of an installed file with block bodies stripped (binary files: the raw bytes). */
export function fileHash(buf) {
  const text = buf.toString('utf8');
  return text.includes('<!-- setup:') ? sha256(stripBlocks(text)) : sha256(buf);
}

/**
 * State of one installed file. M = manifest hash or undefined, D = disk hash, T = template hash.
 * `state` is one of FILE_STATES: new (not there yet), current (matches the template or the manifest), outdated (the template
 * changed and the file was not edited, or an old scaffold with no manifest), modified (the user edited it).
 */
export const FILE_STATES = ['new', 'current', 'outdated', 'modified'];
export function fileState({ exists, M, D, T }) {
  if (!exists) return { state: 'new', action: 'create' };
  if (M === undefined) {
    if (D === T) return { state: 'current', action: 'adopt', note: 'Same as the template.' };
    return { state: 'outdated', action: 'flag', note: 'Already there from an earlier setup; left alone.' };
  }
  if (D === M) return T === M ? { state: 'current', action: 'none' } : { state: 'outdated', action: 'update', note: 'The template changed; this file was not edited, so it is updated.' };
  if (D === T) return { state: 'current', action: 'adopt', note: 'Same as the template.' };
  return { state: 'modified', action: 'flag', note: T === M ? 'You edited it; left alone.' : 'You edited it and the template changed; left alone.' };
}

const CLAUDE = 'CLAUDE.md';

/** Docs folder README: blocks.json "docsReadme", else the template's docs-templates/README.md, else a short built-in one. */
export function docsReadme(tpl) {
  const own = textAt(tpl.blocks || {}, 'docsReadme');
  if (own) return own.endsWith('\n') ? own : `${own}\n`;
  const f = tpl.files.find((x) => x.rel === '.claude/docs-templates/README.md');
  if (f) return f.buf.toString('utf8');
  return [
    '# Project docs',
    '',
    'One folder per project, created the first time the manager delegates to it. Five files each:',
    '',
    '- START-HERE.md: what the project is, how to run and test it, where to look next',
    '- SPEC.md: what it does now (present tense, edited in place)',
    '- DECISIONS.md: why, as dated one-liners',
    '- LOG.md: what happened, per session',
    '- INBOX.md: bugs and ideas, each with a status',
    '',
    'Read START-HERE and the newest LOG entry before changing a project. Update SPEC, DECISIONS and LOG in the same session as the change. A fact lives in one place.',
    '',
  ].join('\n');
}

/** Plan the CLAUDE.md step. Returns the file entry plus the text to write (or null). */
function planClaude({ root, tpl, tplText, bodies, manifest, appendBlocks }) {
  const dst = path.join(root, CLAUDE);
  const T = fileHash(Buffer.from(tplText));
  const ls = lstatOrNull(dst);
  const entry = { path: CLAUDE, where: 'root' };
  const blockTexts = Object.fromEntries(BLOCK_IDS.map((id) => [id, blockText(id, bodies[id])]));
  const copyText = BLOCK_IDS.map((id) => blockTexts[id]).join('\n\n');
  if (!ls) {
    return { entry: { ...entry, state: 'new', action: 'create', markers: 'none' }, write: fillBlocks(tplText, bodies), hash: T, copyText, newBlocks: true };
  }
  if (ls.isSymbolicLink() || !ls.isFile()) return { entry: { ...entry, state: 'modified', action: 'none', markers: 'unknown', note: 'Not a plain file; left alone.' }, write: null, copyText };
  const D = fs.readFileSync(dst, 'utf8');
  const st = markerStatus(D);
  const present = BLOCK_IDS.filter((id) => st[id] !== 'missing');
  const markers = present.length === 0 ? 'unmarked' : BLOCK_IDS.every((id) => st[id] === 'ok') ? 'marked' : 'partial';
  if (markers === 'unmarked') {
    const base = { ...entry, state: sha256(D) === T ? 'current' : 'modified', action: 'none', markers, note: 'Your CLAUDE.md is left as is.' };
    if (!appendBlocks) return { entry: base, write: null, copyText, appendable: true };
    return { entry: { ...base, action: 'append', note: 'The setup blocks are added at the end. Nothing else changes.' }, write: appendBlocksText(D, BLOCK_IDS, bodies), copyText, appendable: true, newBlocks: true };
  }
  const M = manifest.files[CLAUDE];
  const fs_ = fileState({ exists: true, M, D: sha256(stripBlocks(D)), T });
  const withBlocks = (b) => { // our blocks into a text; blocks without markers are appended only when allowed
    let t = fillBlocks(b, bodies);
    const miss = BLOCK_IDS.filter((id) => markerStatus(t)[id] === 'missing');
    if (miss.length && appendBlocks) t = appendBlocksText(t, miss, bodies);
    return t;
  };
  const base = fs_.action === 'update' ? tplText : D; // unedited and outdated: the new template, then our blocks
  const next = withBlocks(base);
  const missing = BLOCK_IDS.filter((id) => markerStatus(next)[id] === 'missing');
  // An edited file with a newer template: the playbook fixes cannot be merged for the user, so the new template text (our
  // blocks rendered, so a diff shows only playbook changes) is saved beside it. CLAUDE.md itself changes only in the blocks.
  const wantsNew = fs_.action === 'flag' && (M === undefined || T !== M);
  const newText = wantsNew ? withBlocks(tplText) : null;
  const newFile = newText !== null && newText !== next ? { rel: CLAUDE_NEW_REL, text: newText } : null;
  const broken = BLOCK_IDS.filter((id) => st[id] === 'broken');
  const note = [fs_.note, newFile ? `The new playbook text is saved as ${CLAUDE_NEW_REL}.` : '', broken.length ? `Markers of ${broken.join(', ')} are damaged; those blocks are left alone.` : '', missing.length && !appendBlocks ? `No markers for ${missing.join(', ')}; those blocks are not written.` : ''].filter(Boolean).join(' ');
  const write = next !== D ? next : null;
  // a refresh of the blocks alone is not an edit of the file: the file-level action stays "none" (or "flag" when edited)
  const action = fs_.action === 'none' && write ? 'blocks' : fs_.action;
  return {
    entry: { ...entry, state: fs_.state, action, markers, ...(note ? { note } : {}), ...(write ? { blocksChange: true } : {}), ...(newFile ? { newPlaybook: CLAUDE_NEW_REL } : {}) },
    write, newFile, hash: T, copyText, appendable: missing.length > 0, newBlocks: write !== null,
  };
}

/**
 * Work out everything apply would do, without writing. `input` is the wizard request:
 * {root?, docsDir, createDocsDir?, preferences?, protectedBranches?, neverTouch?, secretsDir?, appendBlocks?}.
 * Returns {ok:false,...} or {ok:true, plan}; the plan holds file texts (internal) and is turned into JSON by describe().
 */
export function planSetup(input, { state = readState(), home = os.homedir(), env = process.env } = {}) {
  const body = isObj(input) ? input : {};
  const account = activeAccount(state);
  const wantRoot = typeof body.root === 'string' && body.root.trim() ? body.root : rootOf(account, state, home);
  if (!wantRoot) return err('Choose a working folder first.', 'root');
  const r = validateWorkRoot(wantRoot, home);
  if (!r.ok) return r;
  const root = r.root;
  const a = normalizeAnswers(body, { home });
  if (!a.ok) return a;
  const d = validateDocsDir(body.docsDir, root, { create: body.createDocsDir === true, home });
  if (!d.ok) return d;
  const tpl = loadTemplate(templateDir(env));
  if (tpl.problems.length) return err(`The setup template is incomplete: ${tpl.problems[0]}`, null, 500);
  const cfg = readConfig(root);
  if (cfg.state === 'newer') return err(cfg.error, null);
  if (cfg.state === 'invalid') return err(`${cfg.error} Fix or remove .claude/harness.json first; the wizard will not overwrite a file it cannot read.`, null);
  let nextConfig;
  try { nextConfig = mergeConfig(cfg.config, { docsDir: d.docsDir, ...a.value }); } catch (e) { return err(e.message); }
  const manifest = readManifest(root);
  const claudeTpl = tpl.files.find((f) => f.rel === CLAUDE);
  const tplText = ensureMarkers(claudeTpl.buf.toString('utf8'));
  const bodies = renderBlocks(nextConfig, tpl.blocks);
  const warnings = [];
  if (nextConfig.secretsDir && !fs.existsSync(nextConfig.secretsDir)) warnings.push(`The secrets folder does not exist yet: ${nextConfig.secretsDir}`);

  const files = [];
  const writes = []; // {rel, buf|text, mode, kind:'create'|'update'|'blocks'|'append'}
  const nextManifest = { ...manifest, files: { ...manifest.files } };
  delete nextManifest.present;

  const c = planClaude({ root, tpl, tplText, bodies, manifest, appendBlocks: body.appendBlocks === true });
  files.push(c.entry);
  if (c.write !== null) writes.push({ rel: CLAUDE, text: c.write, mode: claudeTpl.mode, kind: c.entry.action === 'create' ? 'create' : c.entry.action === 'append' ? 'append' : c.entry.action === 'update' ? 'update' : 'blocks' });
  if (c.entry.action === 'create' || c.entry.action === 'update' || c.entry.action === 'adopt') nextManifest.files[CLAUDE] = c.hash;
  if (c.newFile) writes.push({ rel: c.newFile.rel, text: c.newFile.text, mode: 0o644, kind: 'newfile' });

  for (const f of tpl.files) {
    if (f.rel === CLAUDE || MANIFEST_EXEMPT.includes(f.rel)) continue;
    const dst = path.join(root, f.rel);
    const ls = lstatOrNull(dst);
    const T = fileHash(f.buf);
    const exists = Boolean(ls);
    let D = null;
    let special = false;
    if (ls && (ls.isSymbolicLink() || !ls.isFile())) special = true; else if (ls) D = fileHash(fs.readFileSync(dst));
    const s = special ? { state: 'modified', action: 'none', note: 'Not a plain file; left alone.' } : fileState({ exists, M: manifest.files[f.rel], D, T });
    files.push({ path: f.rel, where: 'root', ...s });
    if (s.action === 'create' || s.action === 'update') { writes.push({ rel: f.rel, buf: f.buf, mode: f.mode, kind: s.action }); nextManifest.files[f.rel] = T; }
    else if (s.action === 'adopt') nextManifest.files[f.rel] = T;
  }

  // the rendered deny rules: written by apply through the root's harness.mjs (listed here like apply lists it). Whether an
  // existing file would change depends on the saved answers, so it is shown as current; apply reports "updated" when it does.
  if (tpl.files.some((f) => f.rel === '.claude/scripts/harness.mjs') || lstatOrNull(path.join(root, '.claude/scripts/harness.mjs'))) {
    const had = lstatOrNull(path.join(root, WORKER_SETTINGS_REL));
    files.push(had ? { path: WORKER_SETTINGS_REL, where: 'root', state: 'current', action: 'none', note: 'Rendered again from your answers; rewritten only when the rules change.' } : { path: WORKER_SETTINGS_REL, where: 'root', state: 'new', action: 'create', note: 'Rendered from your answers.' });
  }

  // docs folder README (never overwritten, not tracked in the manifest)
  const readmePath = path.join(d.docsDir, 'README.md');
  const readmeExists = Boolean(lstatOrNull(readmePath));
  files.push({ path: readmePath, where: 'docs', state: readmeExists ? 'current' : 'new', action: readmeExists ? 'none' : 'create', ...(readmeExists ? { note: 'Left alone.' } : {}) });

  // config and manifest
  const cfgText = ser(nextConfig);
  const cfgOld = readTextOrNull(path.join(root, CONFIG_REL));
  files.push({ path: CONFIG_REL, where: 'root', state: cfgOld === null ? 'new' : 'current', action: cfgOld === null ? 'create' : cfgOld === cfgText ? 'none' : 'update', ...(cfgOld !== null && cfgOld !== cfgText ? { note: 'Your answers are saved; other keys are kept.' } : {}) });
  nextManifest.version = tpl.version;
  const manText = ser({ ...nextManifest, files: Object.fromEntries(Object.entries(nextManifest.files).sort(([x], [y]) => (x < y ? -1 : 1))) });
  const manOld = readTextOrNull(path.join(root, MANIFEST_REL));
  files.push({ path: MANIFEST_REL, where: 'root', state: manOld === null ? 'new' : 'current', action: manOld === null ? 'create' : manOld === manText ? 'none' : 'update' });

  return {
    ok: true,
    plan: {
      root, docs: d, files, writes, warnings, config: nextConfig, cfgText, cfgChanged: cfgOld !== cfgText, manText, manChanged: manOld !== manText,
      readme: readmeExists ? null : docsReadme(tpl), readmePath, setRoot: root !== rootOf(account, state, home) ? root : null,
      claude: { markers: c.entry.markers, appendable: Boolean(c.appendable), blocksText: c.copyText },
      templateVersion: tpl.version, installedVersion: manifest.version,
    },
  };
}

/** The plan as the preview API returns it (no file contents). */
export function describe(plan) {
  return {
    root: plan.root,
    docsDir: plan.docs.docsDir,
    docs: { exists: plan.docs.exists, needsCreate: plan.docs.needsCreate },
    files: plan.files,
    claude: plan.claude,
    warnings: plan.warnings,
    templateVersion: plan.templateVersion,
    installedVersion: plan.installedVersion,
  };
}

/** Preview: validate and plan, write nothing. */
export function previewSetup(input, ctx) {
  const p = planSetup(input, ctx);
  return p.ok ? { ok: true, ...describe(p.plan) } : p;
}

/**
 * Apply the plan. Validation happens first, so a refusal writes nothing. Order: docs folder, template files, CLAUDE.md,
 * docs README, config, manifest (last, so an interrupted run is simply repeated). Existing files are never overwritten
 * except an unedited outdated file and the marked blocks. Returns {ok, created, skipped, updated, flagged, ...}.
 */
export function applySetup(input, ctx = {}) {
  const p = planSetup(input, ctx);
  if (!p.ok) return p;
  const { plan } = p;
  if (plan.docs.needsCreate && !(isObj(input) && input.createDocsDir === true)) return err('The docs folder does not exist yet. Tick "Create it" to create it, or choose an existing folder.', 'docsDir');
  const created = [];
  const updated = [];
  const skipped = [];
  const flagged = [];
  const blocksRefreshed = [];
  try {
    if (plan.docs.needsCreate) { fs.mkdirSync(plan.docs.docsDir, { recursive: true }); created.push(plan.docs.docsDir); }
    for (const w of plan.writes) {
      const dst = path.join(plan.root, w.rel);
      const data = w.buf ?? w.text;
      if (w.kind === 'create') {
        if (createFileExclusive(dst, data, w.mode)) created.push(w.rel); else skipped.push(w.rel); // appeared since the plan: never overwrite
      } else if (w.kind === 'newfile') {
        const had = lstatOrNull(dst);
        if (had && had.isFile() && fs.readFileSync(dst, 'utf8') === data) continue; // same text already there: nothing to write
        if (had && !had.isFile()) { plan.warnings.push(`${w.rel} is not a plain file; the new playbook text was not saved.`); continue; }
        writeFileAtomic(dst, data, 0o644);
        (had ? updated : created).push(w.rel);
      } else if (w.kind === 'blocks') {
        writeFileAtomic(dst, data, (lstatOrNull(dst)?.mode & 0o777) || w.mode);
        blocksRefreshed.push(w.rel); // blocks only: the rest of the file was kept, so it is not an "update" of the file
      } else {
        // an update keeps the file's own mode unless the template carries an exec bit the file lacks
        const old = lstatOrNull(dst);
        writeFileAtomic(dst, data, old ? ((old.mode & 0o777) | (w.mode & 0o111)) : w.mode);
        updated.push(w.rel);
      }
    }
    if (plan.readme !== null) { if (createFileExclusive(plan.readmePath, plan.readme)) created.push(plan.readmePath); else skipped.push(plan.readmePath); }
    if (plan.cfgChanged) { writeFileAtomic(path.join(plan.root, CONFIG_REL), plan.cfgText); (plan.files.find((f) => f.path === CONFIG_REL).state === 'new' ? created : updated).push(CONFIG_REL); }
    if (plan.manChanged) { writeFileAtomic(path.join(plan.root, MANIFEST_REL), plan.manText); (plan.files.find((f) => f.path === MANIFEST_REL).state === 'new' ? created : updated).push(MANIFEST_REL); }
  } catch (e) {
    return { ok: false, status: 500, error: `Setup stopped part way: ${e.message}. Run it again; nothing that exists is overwritten.`, created, updated };
  }
  // The rendered deny rules (.claude/worker-settings.json, gitignored) are written by the root's own harness.mjs, the same
  // helper delegate.sh uses. List the file like any other write: created the first time, updated when its content changed.
  const rendered = renderWorkerSettings(plan.root);
  if (rendered.state === 'created') created.push(WORKER_SETTINGS_REL);
  else if (rendered.state === 'updated') updated.push(WORKER_SETTINGS_REL);
  else if (rendered.state === 'same') skipped.push(WORKER_SETTINGS_REL);
  else if (rendered.state === 'failed') plan.warnings.push(`Could not render ${WORKER_SETTINGS_REL}: ${rendered.error}`);
  for (const f of plan.files) {
    if (f.action === 'flag') flagged.push({ path: f.path, state: f.state, note: f.note });
    else if ((f.action === 'none' || f.action === 'adopt') && f.path !== WORKER_SETTINGS_REL) skipped.push(f.path); // worker-settings is listed above
  }
  const account = activeAccount(ctx.state ?? readState());
  const trust = trustTargets(plan.root, plan.docs.docsDir, account, ctx.home ?? os.homedir());
  const newPlaybook = plan.files.find((f) => f.path === CLAUDE)?.newPlaybook ?? null;
  return { ok: true, root: plan.root, docsDir: plan.docs.docsDir, created, updated, blocksRefreshed, skipped, flagged, newPlaybook, newPlaybookNote: newPlaybook ? NEW_PLAYBOOK_NOTE : null, warnings: plan.warnings, setRoot: plan.setRoot, trust };
}

/**
 * Render .claude/worker-settings.json with the root's own harness.mjs (node, execFile, no shell). Returns
 * {state:'created'|'updated'|'same'|'none'|'failed', error?}; 'none' = the root has no harness.mjs (an old or fixture template).
 */
export function renderWorkerSettings(root) {
  const helper = path.join(root, '.claude/scripts/harness.mjs');
  const hl = lstatOrNull(helper);
  if (!hl || !hl.isFile()) return { state: 'none' };
  const out = path.join(root, WORKER_SETTINGS_REL);
  const before = readTextOrNull(out);
  try { execFileSync(process.execPath, [helper, 'render', root], { cwd: root, timeout: 15000, stdio: 'pipe', maxBuffer: 256 * 1024 }); } catch (e) {
    return { state: 'failed', error: String(e.stderr || e.message).trim().split('\n').pop().slice(0, 200) };
  }
  const after = readTextOrNull(out);
  if (after === null) return { state: 'failed', error: 'the helper wrote nothing' };
  return { state: before === null ? 'created' : before === after ? 'same' : 'updated' };
}

// ---------------------------------------------------------------- folder trust

/** A path inside double quotes for a shell line: backslash, quote, dollar and backtick are escaped. */
export const dq = (p) => `"${String(p).replace(/[\\"$`]/g, '\\$&')}"`;
export const TRUST_REPO_MAX = 10;

/**
 * `claude --bg` refuses a folder the user has not trusted once, and the trust prompt only appears in an interactive
 * `claude`. This lists the folders to open once: the docs folder, then the git repos found in the working folder
 * (at most TRUST_REPO_MAX, `more` counts the rest). A non-default account needs its own config dir on the command.
 * The deck never reads or writes the trust state (it lives in the account's global config file).
 */
export function trustTargets(root, docsDir, account, home = os.homedir()) {
  const env = account?.configDir ? ` CLAUDE_CONFIG_DIR=${dq(configDirOf(account, home))}` : '';
  const cmd = (dir) => `cd ${dq(dir)} &&${env} claude`;
  const repos = listRepos(root).repos.filter((r) => r.git);
  const dirs = [{ kind: 'docs', name: docsDir, path: docsDir, command: cmd(docsDir) }];
  for (const r of repos.slice(0, TRUST_REPO_MAX)) { const p = path.join(root, r.name); dirs.push({ kind: 'project', name: r.name, path: p, command: cmd(p) }); }
  return { dirs, more: Math.max(0, repos.length - TRUST_REPO_MAX), accountLabel: account?.configDir ? account.label : null };
}

// ---------------------------------------------------------------- status, repos, account reuse

/** First existing folder of ROOT_CANDIDATES under home, or null. */
export function suggestRoot(home = os.homedir()) {
  for (const c of ROOT_CANDIDATES) {
    const p = path.join(home, c);
    try { if (fs.statSync(p).isDirectory()) return p; } catch { /* next */ }
  }
  return null;
}

/** Immediate subfolders of a folder (hidden ones skipped), marked with whether they are git repos. */
export function listRepos(root) {
  let list;
  try { list = fs.readdirSync(root, { withFileTypes: true }); } catch { return { repos: [], more: 0 }; }
  const dirs = list.filter((e) => !e.name.startsWith('.') && (e.isDirectory() || (e.isSymbolicLink() && (() => { try { return fs.statSync(path.join(root, e.name)).isDirectory(); } catch { return false; } })()))).sort((a, b) => (a.name < b.name ? -1 : 1));
  const repos = dirs.slice(0, REPO_LIST_MAX).map((e) => ({ name: e.name, git: fs.existsSync(path.join(root, e.name, '.git')) }));
  return { repos, more: Math.max(0, dirs.length - REPO_LIST_MAX) };
}

const pickAnswers = (c) => ({
  protectedBranches: Array.isArray(c.protectedBranches) ? c.protectedBranches : DEFAULT_BRANCHES,
  neverTouch: typeof c.neverTouch === 'string' ? c.neverTouch : null,
  secretsDir: typeof c.secretsDir === 'string' ? c.secretsDir : null,
  preferences: { ...DEFAULT_PREFS, ...(isObj(c.preferences) ? Object.fromEntries(Object.keys(DEFAULT_PREFS).filter((k) => c.preferences[k] !== undefined).map((k) => [k, c.preferences[k]])) : {}) },
});

/** Other accounts that already have a config: their preferences and guardrails only. NEVER their docs folder. */
export function reuseCandidates(state = readState(), home = os.homedir()) {
  const active = activeAccount(state).id;
  const out = [];
  for (const a of listAccounts(state)) {
    if (a.id === active) continue;
    const root = rootOf(a, state, home);
    if (!root) continue;
    const c = readConfig(root);
    if (c.state === 'ok') out.push({ id: a.id, label: a.label, ...pickAnswers(c.config) });
  }
  return out;
}

/** GET /api/setup: where the active account stands. `candidate` (a typed folder) adds its repos and checks. */
export function setupStatus({ state = readState(), home = os.homedir(), env = process.env, candidate = null, demo = false } = {}) {
  const account = activeAccount(state);
  const root = rootOf(account, state, home);
  const tpl = loadTemplate(templateDir(env));
  const out = {
    account: { id: account.id, label: account.label },
    multi: listAccounts(state).length > 1,
    root,
    rootReady: false,
    demo,
    canPick: process.platform === 'darwin',
    suggestedRoot: root ? null : suggestRoot(home),
    defaults: { protectedBranches: DEFAULT_BRANCHES, preferences: DEFAULT_PREFS },
    templateVersion: tpl.version,
    templateProblems: tpl.problems,
    installedVersion: null,
    config: null,
    configState: 'missing',
    files: [],
    reuse: reuseCandidates(state, home),
  };
  if (root) {
    const cfg = readConfig(root);
    out.configState = cfg.state;
    if (cfg.error) out.configError = cfg.error;
    if (cfg.config) out.config = { docsDir: cfg.config.docsDir ?? null, ...pickAnswers(cfg.config) };
    const manifest = readManifest(root);
    out.installedVersion = manifest.version;
    out.rootReady = ['CLAUDE.md', '.claude/scripts/delegate.sh'].every((f) => fs.existsSync(path.join(root, f)));
    // per-file state with the saved answers (or defaults); needs a docs folder, so only when the config has one
    if (cfg.state === 'ok' && out.config?.docsDir && tpl.problems.length === 0) {
      const p = planSetup({ root, docsDir: out.config.docsDir, createDocsDir: true, ...out.config }, { state, home, env });
      if (p.ok) out.files = p.plan.files.filter((f) => f.where === 'root');
      out.upgradeAvailable = out.files.some((f) => f.action === 'update') || (manifest.version !== null && tpl.version > manifest.version);
    }
  }
  if (candidate) {
    const c = validateWorkRoot(candidate, home);
    out.candidate = c.ok ? { ok: true, root: c.root, ...listRepos(c.root) } : { ok: false, error: c.error };
  }
  return out;
}

// ---------------------------------------------------------------- health check

/** `Bash(a * b)` style permission pattern -> RegExp (`*` matches anything). */
export function globToRegExp(pattern) {
  return new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

/** Branches whose `git push` the deny list does not stop (tests two push forms per branch). */
export function unprotectedBranches(denyList, branches) {
  const res = (Array.isArray(denyList) ? denyList : []).map((d) => /^Bash\((.*)\)$/s.exec(String(d))?.[1]).filter((x) => x !== undefined).map(globToRegExp);
  const denied = (cmd) => res.some((re) => re.test(cmd));
  return branches.filter((b) => !(denied(`git push origin ${b}`) && denied(`git push -u origin ${b}`)));
}

const execP = (exec, file, args, opts) => new Promise((resolve) => exec(file, args, opts, (e, stdout, stderr) => resolve({ e, stdout: String(stdout || ''), stderr: String(stderr || '') })));

function onPath(bin, pathEnv = process.env.PATH || '') {
  for (const d of pathEnv.split(path.delimiter).filter(Boolean)) {
    try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); if (fs.statSync(path.join(d, bin)).isFile()) return true; } catch { /* next */ }
  }
  return false;
}

/**
 * Health check of the active account's working folder. Items: {id, label, status:'ok'|'fail'|'info', detail, fix}.
 * `delegate.sh --check` is run with execFile (no shell). The workspace-trust state is not read.
 */
export async function runHealth({ state = readState(), home = os.homedir(), exec = execFile, pathEnv = process.env.PATH } = {}) {
  const account = activeAccount(state);
  const root = rootOf(account, state, home);
  const items = [];
  const add = (id, label, ok, detail, fix, status = ok ? 'ok' : 'fail') => items.push({ id, label, status, detail, ...(status === 'fail' && fix ? { fix } : {}) });
  if (!root || !fs.existsSync(root)) {
    add('root', 'Working folder', false, root ? `Missing: ${root}` : 'None chosen.', 'Choose a working folder in Set up.');
    return { ok: false, root, items };
  }
  const run = 'Run Set up and press Create.';
  add('playbook', 'Manager playbook', fs.existsSync(path.join(root, CLAUDE)), CLAUDE, run);
  const scriptsDir = path.join(root, '.claude/scripts');
  let scripts = [];
  try { scripts = fs.readdirSync(scriptsDir).filter((n) => n.endsWith('.sh')); } catch { /* none */ }
  const notExec = scripts.filter((n) => { try { fs.accessSync(path.join(scriptsDir, n), fs.constants.X_OK); return false; } catch { return true; } });
  add('scripts', 'Scripts are executable', scripts.includes('delegate.sh') && notExec.length === 0, scripts.length ? `${scripts.length} script${scripts.length === 1 ? '' : 's'}` : 'No scripts found.', notExec.length ? `Run: chmod +x ${notExec.map((n) => `.claude/scripts/${n}`).join(' ')}` : run);
  const cfg = readConfig(root);
  const c = cfg.config || {};
  const cfgProblem = cfg.state === 'missing' ? 'harness.json is missing.' : cfg.error || (!path.isAbsolute(c.docsDir || '') ? 'The docs folder is not set.' : !Array.isArray(c.protectedBranches) || !c.protectedBranches.length ? 'No protected branches are set.' : null);
  add('config', 'Setup file', !cfgProblem, cfgProblem || 'harness.json', run);
  let docsOk = false;
  let docsDetail = 'Not set.';
  if (path.isAbsolute(c.docsDir || '')) {
    docsDetail = c.docsDir;
    try { docsOk = fs.statSync(c.docsDir).isDirectory(); fs.accessSync(c.docsDir, fs.constants.W_OK); } catch { docsOk = false; docsDetail = `${c.docsDir} is missing or not writable.`; }
  }
  add('docs', 'Docs folder exists and is writable', docsOk, docsDetail, 'Set up again and create or choose the docs folder.');
  add('claude', '`claude` is on PATH', onPath('claude', pathEnv), 'The deck runs agents with it.', 'Install Claude Code and make sure `claude` runs in a terminal.');
  const delegate = path.join(scriptsDir, 'delegate.sh');
  if (fs.existsSync(delegate)) {
    const r = await execP(exec, delegate, ['--check'], { cwd: root, timeout: 20000, env: claudeEnv(account, { ...process.env, PATH: pathEnv }), maxBuffer: 256 * 1024 });
    const line = (r.stderr || r.stdout).split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
    add('delegate', 'delegate.sh --check passes', !r.e, !r.e ? (r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'Config and rendering are fine.') : line.slice(0, 200) || 'The check failed.', /usage|unknown|not supported/i.test(line) ? 'This copy of delegate.sh is older than the wizard. Set up again to update it.' : 'Fix what it reports, then check again.');
  } else add('delegate', 'delegate.sh --check passes', false, 'delegate.sh is missing.', run);
  let deny = null;
  try { deny = JSON.parse(fs.readFileSync(path.join(root, '.claude/worker-settings.json'), 'utf8')); } catch { /* none */ }
  if (!deny) add('deny', 'Deny rules block pushes to protected branches', false, 'The rendered rules (.claude/worker-settings.json) are missing.', 'Run delegate.sh --check, or Set up again.');
  else {
    const open = unprotectedBranches(deny?.permissions?.deny, Array.isArray(c.protectedBranches) ? c.protectedBranches : DEFAULT_BRANCHES);
    add('deny', 'Deny rules block pushes to protected branches', open.length === 0, open.length ? `Not blocked: ${open.join(', ')}` : (Array.isArray(c.protectedBranches) ? c.protectedBranches : DEFAULT_BRANCHES).join(', '), 'Run delegate.sh --check to render the rules again.');
  }
  const skill = fs.existsSync(path.join(configDirOf(account, home), 'skills', 'unslop', 'SKILL.md'));
  add('unslop', 'unslop skill (optional)', skill, skill ? 'Installed.' : 'Not installed. Optional: it cleans up wording in reports and docs.', null, skill ? 'ok' : 'info');
  add('trust', 'Folders trusted once (not checked)', true, 'The deck does not read Claude\'s trust state. Claude refuses to start a worker in a folder you have not trusted: run `claude` once in the docs folder and in each project folder, accept the trust prompt, then /exit.', null, 'info');
  return { ok: items.every((i) => i.status !== 'fail'), root, items };
}
