// Saved prompts: markdown files in one folder (default: ~/.dekki/prompts), subfolders allowed.
// This is the ONLY module that touches that folder. Every path from the browser goes through cleanRel()
// and inside(), so nothing outside the folder can be read, written or moved. Delete = move to .trash.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { run as runClaude } from './claude.js';
import { setMember } from './state.js';
import { failure } from './projects.js';

export const promptsRoot = () => process.env.DEKKI_PROMPTS || path.join(os.homedir(), '.dekki', 'prompts');

export const MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 8;
const MAX_ITEMS = 1000;
const TRASH = '.trash';
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export class PromptError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Relative "A/B/name.md" style path from the browser -> normalised string, or throw. Dot segments are refused (hides .trash, .obsidian). */
export function cleanRel(rel) {
  if (typeof rel !== 'string' || !rel.trim()) throw new PromptError('Missing path.');
  const parts = rel.split('/').map((s) => s.trim());
  for (const s of parts) {
    if (!s || s.startsWith('.') || s.includes('\\') || s.includes('\0') || s.length > 120) throw new PromptError(`Bad path: “${rel}”.`);
  }
  if (parts.length > MAX_DEPTH) throw new PromptError('Folders are nested too deeply.');
  return parts.join('/');
}

const needMd = (rel) => { if (!rel.endsWith('.md') || rel.endsWith('/.md')) throw new PromptError('A prompt file name must end with .md.'); };

/** Absolute path for a clean relative path, refusing anything that resolves (through symlinks) outside the root. */
function inside(rel) {
  const root = promptsRoot();
  const abs = path.join(root, rel);
  let probe = abs;
  while (!fs.existsSync(probe)) probe = path.dirname(probe); // deepest existing ancestor
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : null;
  const real = fs.realpathSync(probe);
  const ok = realRoot ? real === realRoot || real.startsWith(realRoot + path.sep) : false;
  if (!ok) throw new PromptError('That path is outside the prompts folder.');
  return abs;
}

const ensureRoot = () => fs.mkdirSync(promptsRoot(), { recursive: true });

function walk(dir, rel, depth, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.folders.push(r);
      if (depth < MAX_DEPTH) walk(path.join(dir, e.name), r, depth + 1, out);
    } else if (e.isFile() && e.name.endsWith('.md') && out.items.length < MAX_ITEMS) {
      const abs = path.join(dir, e.name);
      try {
        const st = fs.statSync(abs);
        if (st.size > MAX_BYTES) continue;
        out.items.push({ path: r, name: e.name.slice(0, -3), body: fs.readFileSync(abs, 'utf8'), mtime: st.mtimeMs });
      } catch { /* vanished while listing */ }
    }
  }
}

/** { root, exists, trash (entries in .trash), folders: [rel], items: [{path, name, body, mtime}] }, natural sort ("2 x" before "10 x"). */
export function listPrompts() {
  const root = promptsRoot();
  const out = { root, exists: fs.existsSync(root), trash: 0, folders: [], items: [] };
  if (out.exists) walk(root, '', 1, out);
  try { out.trash = fs.readdirSync(path.join(root, TRASH)).filter((n) => !n.startsWith('.')).length; } catch { /* no trash yet */ }
  out.folders.sort(collator.compare);
  out.items.sort((a, b) => collator.compare(a.path.slice(0, -3), b.path.slice(0, -3))); // without ".md", so "1 PRD" precedes "1 PRD copy"
  return out;
}

/** Create or update a prompt. baseMtime = the mtime the editor loaded; if the file changed since, 409. create = fail if it exists. */
export function savePrompt(relIn, body, { baseMtime, create } = {}) {
  const rel = cleanRel(relIn);
  needMd(rel);
  if (typeof body !== 'string') throw new PromptError('Missing text.');
  if (Buffer.byteLength(body) > MAX_BYTES) throw new PromptError('That prompt is too large (256 KB max).');
  ensureRoot();
  const abs = inside(rel);
  const exists = fs.existsSync(abs);
  if (exists && fs.statSync(abs).isDirectory()) throw new PromptError('A folder with that name exists.');
  if (create && exists) throw new PromptError('A prompt with that name already exists.', 409);
  if (!create && baseMtime != null) {
    if (!exists) throw new PromptError('This prompt was deleted or moved outside the deck.', 409);
    if (fs.statSync(abs).mtimeMs !== baseMtime) throw new PromptError('This prompt changed on disk since you opened it.', 409);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  inside(rel); // re-check after the parent folders exist
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, abs);
  return { mtime: fs.statSync(abs).mtimeMs };
}

const sameFile = (a, b) => { try { const x = fs.statSync(a); const y = fs.statSync(b); return x.ino === y.ino && x.dev === y.dev; } catch { return false; } };

/** Rename or move a file or folder inside the root. Never overwrites. */
export function movePrompt(fromIn, toIn) {
  const from = cleanRel(fromIn);
  const to = cleanRel(toIn);
  const src = inside(from);
  if (!fs.existsSync(src)) throw new PromptError('Nothing to move there.', 404);
  const isDir = fs.statSync(src).isDirectory();
  if (!isDir) { needMd(from); needMd(to); }
  if (isDir && (to === from || to.startsWith(`${from}/`))) throw new PromptError('A folder cannot be moved into itself.');
  const dst = inside(to);
  if (fs.existsSync(dst) && !sameFile(src, dst)) throw new PromptError('Something with that name already exists.', 409);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  inside(to);
  fs.renameSync(src, dst);
  return { ok: true };
}

export function makeFolder(relIn) {
  const rel = cleanRel(relIn);
  ensureRoot();
  const abs = inside(rel);
  if (fs.existsSync(abs)) throw new PromptError('That folder already exists.', 409);
  fs.mkdirSync(abs, { recursive: true });
  inside(rel);
  return { ok: true };
}

/** "Delete": move a prompt or a whole folder into <root>/.trash/<timestamp>-<name>. Nothing is ever unlinked. */
export function trashPrompt(relIn) {
  const rel = cleanRel(relIn);
  const src = inside(rel);
  if (!fs.existsSync(src)) throw new PromptError('Nothing to delete there.', 404);
  if (!fs.statSync(src).isDirectory()) needMd(rel);
  const dst = trashSlot(path.basename(rel));
  fs.renameSync(src, dst);
  return { ok: true, trashed: path.relative(promptsRoot(), dst) };
}

/** A free "<root>/.trash/<timestamp>-<name>" path (the trash folder is created if needed). */
function trashSlot(name) {
  const trash = path.join(promptsRoot(), TRASH);
  fs.mkdirSync(trash, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let dst = path.join(trash, `${stamp}-${name}`);
  for (let i = 2; fs.existsSync(dst); i++) dst = path.join(trash, `${stamp}-${i}-${name}`);
  return dst;
}

const MAX_FOCUS = 2000;

/** First message for the improver agent. `abs` = the prompt file, `snap` = where the untouched copy was saved. */
export function improveBrief(abs, snap, focus) {
  return [
    `Help me improve one saved prompt: \`${abs}\`. My prompts folder is your working directory.`,
    ...(focus ? [`What I want from you: ${focus}`] : []),
    '',
    'How to work with me:',
    '- Read the prompt first.',
    '- Whenever you are unsure about anything (the goal, who it is for, what to keep, what "better" means), ask me with the AskUserQuestion tool (the ask prompt with options), not as plain text. Ask rather than guess.',
    '- Show me the improved version in the chat, with a short note on what you changed and why. Do not write to the file yet.',
    '- Only after I say yes, save it: edit that one file in place. Do not touch any other file.',
    '- Keep `{{name}}` and `{{name|default}}` placeholders (parts I fill in each time) working, keep the front matter if the file has any, and keep my language and tone.',
    `- The untouched original is saved at \`${snap}\`, so nothing is lost.`,
  ].join('\n');
}

/**
 * "Improve with Claude": save an untouched copy of the prompt into .trash, then start a normal background agent in the
 * prompts folder (permission mode acceptEdits: it may edit files in that folder without asking, the brief says to
 * show you the new version first). Returns {ok:true,id,snapshot} or {ok:false,error,trust,dir}.
 * `run` and `own` are injectable so tests never start a real agent.
 */
export async function startImprover(relIn, focusIn, { run = runClaude, own = (id) => setMember('owned', id, true) } = {}) {
  const rel = cleanRel(relIn);
  needMd(rel);
  const abs = inside(rel);
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) throw new PromptError('Nothing to improve there.', 404);
  const focus = typeof focusIn === 'string' ? focusIn.trim() : '';
  if (focus.length > MAX_FOCUS) throw new PromptError(`The note is too long (${MAX_FOCUS} characters max).`);

  const snap = trashSlot(`before-improve-${path.basename(rel)}`);
  fs.copyFileSync(abs, snap, fs.constants.COPYFILE_EXCL);
  const label = path.basename(rel, '.md').replace(/[^\w .-]+/g, ' ').replace(/\s+/g, ' ').replace(/^[^\w]+/, '').trim().slice(0, 60) || 'prompt';
  const dir = promptsRoot();
  const r = await run(['--bg', '-n', `improve-${label}`, '--permission-mode', 'acceptEdits', '--', improveBrief(abs, snap, focus)], { cwd: dir, timeout: 60000 });
  const output = `${r.stdout}${r.stderr}`.trim();
  if (!r.ok) {
    fs.rmSync(snap, { force: true }); // our own copy, made a moment ago: it protects nothing now
    return failure(r, output, dir);
  }
  const m = /\b([0-9a-f]{8})\b/.exec(output);
  if (m) own(m[1]);
  return { ok: true, id: m ? m[1] : null, snapshot: path.relative(dir, snap) };
}

const openWithFinder = (args) => new Promise((resolve, reject) => {
  execFile('open', args, { timeout: 15000 }, (err, _out, stderr) => (err ? reject(new PromptError(String(stderr || err.message).trim())) : resolve()));
});

/** "Show in Finder": '' = the prompts folder itself, a folder opens, a prompt is revealed (selected) in its folder. Only paths inside the folder. */
export async function revealPrompt(relIn, open = openWithFinder) {
  const root = promptsRoot();
  if (relIn === undefined || relIn === null || relIn === '') {
    if (!fs.existsSync(root)) throw new PromptError('The prompts folder does not exist yet.', 404);
    await open(['--', root]);
    return { ok: true };
  }
  const rel = cleanRel(relIn);
  const abs = inside(rel);
  if (!fs.existsSync(abs)) throw new PromptError('Nothing there.', 404);
  await open(fs.statSync(abs).isDirectory() ? ['--', abs] : ['-R', '--', abs]);
  return { ok: true };
}

/** Open the .trash folder in Finder (the one dot folder the deck itself creates). */
export async function revealTrash(open = openWithFinder) {
  const dir = path.join(promptsRoot(), TRASH);
  if (!fs.existsSync(dir)) throw new PromptError('The trash is empty.', 404);
  await open(['--', dir]);
  return { ok: true };
}
