// Robustness sweep: parse every transcript under ~/.claude/projects (read-only) and report counts/timing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTranscript } from '../server/transcript.js';

const root = path.join(os.homedir(), '.claude', 'projects');
let files = 0, entries = 0, bytes = 0, slow = 0, failed = 0;
const t0 = Date.now();
for (const d of fs.readdirSync(root)) {
  const dir = path.join(root, d);
  let names;
  try { names = fs.readdirSync(dir); } catch { continue; }
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const f = path.join(dir, n);
    const t = Date.now();
    try {
      const r = readTranscript(f);
      entries += r.entries.length;
      bytes += r.size;
      files++;
    } catch (e) {
      failed++;
      console.log('FAILED', n, e.message);
    }
    if (Date.now() - t > 1000) { slow++; console.log('slow', n, Date.now() - t, 'ms'); }
  }
}
console.log({ files, entries, MB: Math.round(bytes / 1e6), failed, slow, totalMs: Date.now() - t0 });
