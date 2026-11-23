// Drag-and-drop into the Session tab: the browser can't expose a dropped file's path, so the file is
// uploaded here and its saved path is typed into the terminal. Files older than a week are pruned.
import fs from 'node:fs';
import path from 'node:path';
import { statePath } from './state.js';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const uploadsDir = () => path.join(path.dirname(statePath()), 'uploads');

function prune(dir) {
  try {
    for (const n of fs.readdirSync(dir)) {
      const f = path.join(dir, n);
      if (Date.now() - fs.statSync(f).mtimeMs > MAX_AGE_MS) fs.rmSync(f, { force: true });
    }
  } catch {
    // best effort
  }
}

/** Reads the raw request body to a file; returns its absolute path (no spaces: safe to type into a prompt). */
export function saveUpload(req, rawName) {
  const base = path.basename(String(rawName || 'file')).replace(/[^\w.-]+/g, '_').slice(-80) || 'file';
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });
  prune(dir);
  const file = path.join(dir, `${Date.now()}-${base}`);
  return new Promise((resolve, reject) => {
    let size = 0;
    const out = fs.createWriteStream(file, { mode: 0o600 });
    const fail = (e) => { out.destroy(); fs.rmSync(file, { force: true }); reject(e); };
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) { fail(new Error('File too large (25 MB max)')); req.destroy(); } else out.write(c);
    });
    req.on('end', () => out.end(() => resolve(file)));
    req.on('error', fail);
  });
}
