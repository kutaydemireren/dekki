// Working folder ("root") of the active account: where New agent starts the manager. Choose it, check it, and scaffold
// the manager setup (templates/manager-root) into it. Never overwrites a file, never runs git. The default account keeps
// state.root; another account keeps accounts[].root (see rootOf in accounts.js). No fallback between accounts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { readState, writeState } from './state.js';
import { activeAccount, rootOf, expandHome, cleanAccounts, DEFAULT_ID } from './accounts.js';

export const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'manager-root');
// A root counts as set up when it has the playbook and the delegate script.
export const REQUIRED = ['CLAUDE.md', '.claude/scripts/delegate.sh'];

/** {ready, missing:[relative paths]} for a root (null root: not ready, everything missing). */
export function rootStatus(root) {
  const missing = REQUIRED.filter((f) => !root || !fs.existsSync(path.join(root, f)));
  return { ready: Boolean(root) && missing.length === 0, missing };
}

/** Config the UI needs for the active account. */
export function rootConfig(state = readState()) {
  const account = activeAccount(state);
  const root = rootOf(account, state);
  const st = rootStatus(root);
  return { root, rootReady: st.ready, rootMissing: st.missing, rootAccount: account.label };
}

/** Validate a typed path. Returns {ok:true, root: realpath} or {ok:false, status, error}. */
export function checkRootPath(input, home = os.homedir()) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) return { ok: false, status: 400, error: 'Give a folder path.' };
  const p = expandHome(input.trim(), home);
  if (!path.isAbsolute(p)) return { ok: false, status: 400, error: 'The path must be absolute (or start with ~/).' };
  let real;
  try {
    if (!fs.statSync(p).isDirectory()) return { ok: false, status: 400, error: `Not a folder: ${p}` };
    real = fs.realpathSync(p);
  } catch {
    return { ok: false, status: 400, error: `Folder does not exist: ${p}. Create it first (the Choose folder button can make one).` };
  }
  return { ok: true, root: real };
}

/** Set the ACTIVE account's working folder. Returns {ok, root} or {ok:false,status,error}. */
export function setRoot(input, { home = os.homedir() } = {}) {
  const c = checkRootPath(input, home);
  if (!c.ok) return c;
  const state = readState();
  const account = activeAccount(state);
  if (account.id === DEFAULT_ID) {
    writeState({ ...state, root: c.root });
  } else {
    // keep the raw entries (other fields round-trip); only this account's root changes
    const accounts = cleanAccounts(state.accounts).map((a) => (a.id === account.id ? { ...a, root: c.root } : a));
    writeState({ ...state, accounts });
  }
  return { ok: true, root: c.root };
}

/** macOS folder chooser. Resolves {ok:true, path} | {ok:true, cancelled:true} | {ok:false, error}. execFile, no shell. */
export function pickFolder({ platform = process.platform, exec = execFile, prompt = 'Choose the working folder for Dekki' } = {}) {
  if (platform !== 'darwin') return Promise.resolve({ ok: false, error: 'The folder chooser only works on macOS. Type the path instead.' });
  return new Promise((resolve) => {
    // the prompt is a constant of ours (working folder or docs folder), never user input
    exec('osascript', ['-e', `POSIX path of (choose folder with prompt "${String(prompt).replace(/["\\]/g, '')}")`], { timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) {
        if (/-128|User canceled/i.test(`${stderr}${err.message}`)) return resolve({ ok: true, cancelled: true });
        return resolve({ ok: false, error: 'Could not open the folder chooser. Type the path instead.' });
      }
      const out = String(stdout).trim().replace(/(.)\/+$/, '$1');
      resolve(out ? { ok: true, path: out } : { ok: false, error: 'No folder returned. Type the path instead.' });
    });
  });
}

function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else if (e.isFile() && e.name !== '.DS_Store') out.push(r);
  }
  return out.sort();
}

/** Copy the template into `root`. Existing files are skipped, never overwritten. Exec bit kept. Returns {created, skipped}. */
export function scaffold(root, templateDir = TEMPLATE_DIR) {
  const created = [];
  const skipped = [];
  for (const rel of walk(templateDir)) {
    const src = path.join(templateDir, rel);
    const dst = path.join(root, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      // 'wx' fails when anything (file or symlink) is already there: no overwrite, no race.
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    } catch (e) {
      if (e.code === 'EEXIST') { skipped.push(rel); continue; }
      throw e;
    }
    fs.chmodSync(dst, fs.statSync(src).mode & 0o777);
    created.push(rel);
  }
  return { created, skipped };
}

/** Scaffold into the ACTIVE account's root. */
export function setupActiveRoot(state = readState()) {
  const root = rootOf(activeAccount(state), state);
  if (!root) return { ok: false, status: 400, error: 'Choose a working folder first.' };
  try { if (!fs.statSync(root).isDirectory()) throw new Error(); } catch { return { ok: false, status: 400, error: `Working folder does not exist: ${root}` }; }
  try {
    return { ok: true, ...scaffold(root) };
  } catch (e) {
    return { ok: false, status: 500, error: `Setup failed: ${e.message}` };
  }
}
