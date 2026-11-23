// Folder tree under the configured root, and "open" with the macOS default app (same as Finder).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { activeRoot } from './accounts.js';

const SKIP = new Set(['.DS_Store']); // hidden files are shown (like Finder with hidden files on), minus this noise
// Directories macOS treats as a single document (double-click opens them in their app, e.g. Xcode).
const PACKAGE_EXT = new Set(['.xcodeproj', '.xcworkspace', '.app', '.playground', '.xcassets', '.framework', '.bundle', '.pkg', '.rtfd', '.numbers', '.pages', '.key']);
const MAX_ENTRIES = 3000;

/** Validate a root-relative path (no '.'/'..' segments). Returns {root, parts, full} or null. */
function resolveRel(rel) {
  const root = activeRoot();
  if (!root) return null;
  const parts = String(rel ?? '').split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.' || p.includes('\0'))) return null;
  return { root, parts, full: path.join(root, ...parts) };
}

/** Entries of <root>/<rel>: [{name, kind: 'dir' | 'file' | 'package'}], folders first. null if the path is invalid. */
export function listTree(rel) {
  const r = resolveRel(rel);
  if (!r) return null;
  const entries = [];
  try {
    for (const name of fs.readdirSync(r.full)) {
      if (SKIP.has(name)) continue;
      let st;
      try { st = fs.statSync(path.join(r.full, name)); } catch { continue; } // follows symlinks, skips broken ones
      const kind = st.isDirectory() ? (PACKAGE_EXT.has(path.extname(name).toLowerCase()) ? 'package' : 'dir') : 'file';
      // icon = key for /api/icon: 'folder' or the file extension ('unknown' when there is none)
      const ext = path.extname(name).slice(1).toLowerCase();
      entries.push({ name, kind, icon: kind === 'dir' ? 'folder' : /^[a-z0-9_-]{1,24}$/.test(ext) ? ext : 'unknown' });
      if (entries.length >= MAX_ENTRIES) break;
    }
  } catch {
    // unreadable or missing: empty
  }
  entries.sort((a, b) => (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
  return { root: r.root, path: r.parts.join('/'), entries };
}

/** `open -- <path>`: folders open in Finder, files and packages in their default app. */
export function openPath(rel) {
  const r = resolveRel(rel);
  if (!r || !r.parts.length || !fs.existsSync(r.full)) return Promise.resolve({ ok: false, error: 'Not found.' });
  return new Promise((resolve) => {
    execFile('open', ['--', r.full], { timeout: 15000 }, (err, _out, stderr) => {
      resolve(err ? { ok: false, error: String(stderr || err.message).trim() } : { ok: true });
    });
  });
}
