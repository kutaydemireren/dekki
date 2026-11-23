// Manager -> worker links, written by the manager's delegate.sh as append-only lines
// `<worker id>\t<manager id>\t<time>` in links.tsv next to state.json. No read-modify-write, so parallel
// workers cannot corrupt it. A missing link just means "not nested": never an error.
import fs from 'node:fs';
import path from 'node:path';
import { isAgentId } from './claude.js';
import { statePath } from './state.js';

export const linksPath = () => path.join(path.dirname(statePath()), 'links.tsv');

let cache = { file: null, mtime: 0, size: 0, map: new Map() };

/** @returns {Map<string, string>} worker id -> manager id (last line wins; junk lines ignored). */
export function readLinks() {
  const file = linksPath();
  let st;
  try { st = fs.statSync(file); } catch { return new Map(); }
  if (cache.file === file && cache.mtime === st.mtimeMs && cache.size === st.size) return cache.map;
  const map = new Map();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const [worker, manager] = line.split('\t');
      if (isAgentId(worker) && isAgentId(manager) && worker !== manager) map.set(worker, manager);
    }
  } catch { return new Map(); }
  cache = { file, mtime: st.mtimeMs, size: st.size, map };
  return map;
}
