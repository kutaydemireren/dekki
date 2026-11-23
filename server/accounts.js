// Multi-account: an account is { id, label, configDir? }. Claude Code keeps its login, sessions (projects/), jobs/ and
// daemon state in a config dir chosen by CLAUDE_CONFIG_DIR (default ~/.claude). The built-in `default` account has no
// configDir and means ~/.claude. Extra accounts live ONLY in the local state file (never in the repo). The server has
// one active account; every `claude` call, the Session pty, jobs/ and the transcript glob follow it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readState, writeState } from './state.js';

export const DEFAULT_ID = 'default';
export const DEFAULT_LABEL = 'Default';
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const LABEL_MAX = 40;

/** `~` and `~/x` -> absolute under home; anything else unchanged. */
export function expandHome(p, home = os.homedir()) {
  if (typeof p !== 'string') return p;
  if (p === '~') return home;
  return p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

/** Shape-only clean of the `accounts` array from the state file (no disk access). Drops junk and duplicates. */
export function cleanAccounts(v) {
  const out = [];
  if (!Array.isArray(v)) return out;
  const seen = new Set();
  for (const a of v) {
    if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !ID_RE.test(a.id) || seen.has(a.id)) continue;
    const label = typeof a.label === 'string' ? a.label.trim().slice(0, LABEL_MAX) : '';
    if (!label) continue;
    const entry = { id: a.id, label };
    if (typeof a.configDir === 'string' && a.configDir.trim()) entry.configDir = a.configDir.trim();
    if (typeof a.root === 'string' && a.root.trim()) entry.root = a.root.trim(); // working folder of a non-default account
    seen.add(a.id);
    out.push(entry);
  }
  return out;
}

const isDirSync = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** Full check of one account against the disk. Returns an error string, or null when usable. */
export function validateAccount(a, { home = os.homedir(), isDir = isDirSync } = {}) {
  if (!a.configDir) return null; // default dir: nothing to check
  const dir = expandHome(a.configDir, home);
  if (!path.isAbsolute(dir)) return 'configDir must be an absolute path (or start with ~/).';
  if (!isDir(dir)) return `configDir does not exist: ${dir}`;
  return null;
}

/** All accounts: the built-in default first (a state entry with id `default` only renames it), then the others. */
export function listAccounts(state = readState()) {
  const extra = cleanAccounts(state.accounts);
  const renamed = extra.find((a) => a.id === DEFAULT_ID);
  const def = { id: DEFAULT_ID, label: renamed?.label || 'Default' }; // its root is state.root, not an accounts[] entry
  return [def, ...extra.filter((a) => a.id !== DEFAULT_ID && a.configDir)];
}

export function activeAccount(state = readState()) {
  const all = listAccounts(state);
  return all.find((a) => a.id === state.activeAccount) || all[0];
}

/**
 * Working folder (where New agent starts the manager) of an account. The default account uses state.root (no migration);
 * a fresh default account has no root until the user picks one; another account uses its own accounts[].root and has NONE until the user picks one (null: never fall back to the default's).
 */
export function rootOf(account = activeAccount(), state = readState(), home = os.homedir()) {
  if (account.id === DEFAULT_ID) return state.root ? expandHome(state.root, home) : null;
  const r = cleanAccounts(state.accounts).find((a) => a.id === account.id)?.root;
  return r ? expandHome(r, home) : null;
}
export const activeRoot = (state = readState()) => rootOf(activeAccount(state), state);

/** Absolute config dir of an account (default = ~/.claude). */
export const configDirOf = (a, home = os.homedir()) => (a.configDir ? expandHome(a.configDir, home) : path.join(home, '.claude'));
export const activeConfigDir = (state = readState()) => configDirOf(activeAccount(state));

/** Environment for a `claude` child process: CLAUDE_CONFIG_DIR set for a custom account, unset for the default. */
export function claudeEnv(account = activeAccount(), base = process.env) {
  const env = { ...base };
  if (account.configDir) env.CLAUDE_CONFIG_DIR = configDirOf(account);
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

// Bumped on every switch. Pollers compare it so a list fetched for the old account is never used as a baseline.
let epoch = 0;
export const accountEpoch = () => epoch;

/** Switch the active account. Returns {ok:true, account} or {ok:false, status, error}. */
export function setActiveAccount(id) {
  const state = readState();
  const account = typeof id === 'string' ? listAccounts(state).find((a) => a.id === id) : null;
  if (!account) return { ok: false, status: 400, error: 'Unknown account.' };
  const bad = validateAccount(account);
  if (bad) return { ok: false, status: 400, error: bad };
  if (activeAccount(state).id !== account.id) {
    writeState({ ...state, activeAccount: account.id });
    epoch++;
  }
  return { ok: true, account };
}

/** Add (or replace, same id) an account in the state file. Used by scripts/add-account.mjs. Creates the dir if missing. */
export function addAccount(label, configDir, { home = os.homedir() } = {}) {
  const clean = typeof label === 'string' ? label.trim().slice(0, LABEL_MAX) : '';
  const id = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!clean || !ID_RE.test(id)) throw new Error('Label needs letters or digits.');
  if (id === DEFAULT_ID) throw new Error('"default" is the built-in account (~/.claude); pick another label.');
  const dir = expandHome(configDir, home);
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('configDir must be an absolute path (or start with ~/).');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const state = readState();
  const accounts = cleanAccounts(state.accounts).filter((a) => a.id !== id);
  accounts.push({ id, label: clean, configDir: dir });
  writeState({ ...state, accounts });
  return { id, label: clean, configDir: dir };
}

/** What the API and the UI see: no paths. `missing` = configDir does not exist (cannot switch to it). */
export function publicAccounts(state = readState()) {
  return {
    active: activeAccount(state).id,
    accounts: listAccounts(state).map((a) => ({ id: a.id, label: a.label, missing: Boolean(validateAccount(a)) })),
  };
}

const SAFE_SHELL = /^[\w@%+=:,./~-]+$/;
const shq = (s) => (SAFE_SHELL.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** Shell word for an absolute path: `~/x` form when under home and plain, else single-quoted. */
function shPath(p, home) {
  if (p === home) return '~';
  if (home && p.startsWith(home + path.sep)) {
    const rel = p.slice(home.length + 1);
    if (SAFE_SHELL.test(rel)) return `~/${rel}`;
  }
  return shq(p);
}

/**
 * Text for a "Workspace not trusted" failure. Trust is stored per Claude config dir, so a non-default account needs
 * its own config dir on the command. Returns {message, command}; command is null for the default account.
 * The deck never accepts trust itself.
 */
export function trustHelp(dir, account = activeAccount(), home = os.homedir()) {
  if (!account?.configDir) {
    return { message: `Workspace not trusted. Run \`claude\` in ${dir} once and accept the trust prompt, then try again.`, command: null };
  }
  const command = `cd ${shPath(dir, home)} && CLAUDE_CONFIG_DIR=${shPath(configDirOf(account, home), home)} claude`;
  return { message: `Workspace not trusted for the "${account.label}" account. Run this in a terminal once, accept the trust prompt, then try again:`, command };
}
