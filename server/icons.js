// Finder icons for the folder tree: the macOS icon for a file type (extension), rendered once through
// AppKit (icon.jxa.js) + sips and cached as a small PNG next to the deck state.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { statePath } from './state.js';

const JXA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'icon.jxa.js');
const TYPE_RE = /^[A-Za-z0-9_-]{1,24}$/;
const MAX_PARALLEL = 3;

const cacheDir = () => path.join(path.dirname(statePath()), 'icons');
const inflight = new Map();
let running = 0;
const waiting = [];

const sh = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 20000 }, (e) => (e ? reject(e) : resolve())));

function slot() {
  if (running < MAX_PARALLEL) { running++; return Promise.resolve(); }
  return new Promise((r) => waiting.push(r));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else running--;
}

async function render(type, png) {
  const tiff = `${png}.${process.pid}.tiff`;
  try {
    await sh('osascript', ['-l', 'JavaScript', JXA, type === 'folder' ? 'public.folder' : type, tiff]);
    await sh('sips', ['-s', 'format', 'png', '-Z', '64', tiff, '--out', `${png}.tmp`]);
    fs.renameSync(`${png}.tmp`, png);
  } finally {
    fs.rmSync(tiff, { force: true });
    fs.rmSync(`${png}.tmp`, { force: true });
  }
}

/** PNG bytes of the Finder icon for `type` ('folder' or a file extension), or null if invalid/unavailable. */
export async function getIcon(type) {
  if (typeof type !== 'string' || !TYPE_RE.test(type)) return null;
  const key = type.toLowerCase();
  const png = path.join(cacheDir(), `${key}.png`);
  if (!fs.existsSync(png)) {
    if (!inflight.has(key)) {
      fs.mkdirSync(cacheDir(), { recursive: true });
      const job = slot().then(() => render(key, png)).finally(() => { release(); inflight.delete(key); });
      inflight.set(key, job);
    }
    try { await inflight.get(key); } catch { return null; }
  }
  try { return fs.readFileSync(png); } catch { return null; }
}
