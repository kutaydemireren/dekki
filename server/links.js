// Manager -> worker links, written by the manager's delegate.sh as append-only lines
// `<worker id>\t<manager id>\t<time>` in links.tsv next to state.json. No read-modify-write, so parallel
// workers cannot corrupt it. A missing link just means "not nested": never an error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAgentId } from './claude.js';
import { statePath } from './state.js';

export const linksPath = () => path.join(path.dirname(statePath()), 'links.tsv');

// Manager roots set up before the rename from Agent Deck keep an old delegate.sh copy that still appends to
// ~/.agent-deck/links.tsv. Read it as a fallback so those workers nest. Only with the default state location,
// so a custom DEKKI_STATE (tests, demo) stays isolated.
const legacyLinksPath = () =>
  process.env.DEKKI_STATE ? null : path.join(os.homedir(), '.agent-deck', 'links.tsv');

let cache = { sig: '', map: new Map() };

function stat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

/** @returns {Map<string, string>} worker id -> manager id (last line wins; legacy file first, current file overrides; junk lines ignored). */
export function readLinks() {
  const files = [legacyLinksPath(), linksPath()].filter(Boolean)
    .map((file) => ({ file, st: stat(file) })).filter((f) => f.st);
  const sig = files.map((f) => `${f.file}|${f.st.mtimeMs}|${f.st.size}`).join('\n');
  if (cache.sig === sig) return cache.map;
  const map = new Map();
  for (const { file } of files) {
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const [worker, manager] = line.split('\t');
        if (isAgentId(worker) && isAgentId(manager) && worker !== manager) map.set(worker, manager);
      }
    } catch { /* unreadable file: skip it */ }
  }
  cache = { sig, map };
  return map;
}
