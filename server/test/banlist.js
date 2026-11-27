// Ban list for the "no private wording in shipped files" tests.
// Built-in part: generic patterns that are safe to publish. Private part: a local file, one regex or word per line
// (blank lines and lines starting with # are ignored, matching is case-insensitive). The file is never committed.
// Location: $DEKKI_TEST_BANLIST, else ~/.dekki/test-banlist.txt. See CONTRIBUTING.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BUILTIN = /\/Users\/|\/home\/[a-z_][a-z0-9_-]*\//;
export const BUILTIN_TEMPLATE_EXTRA = /\biOS\b|\bAndroid\b|\bXcode|Swift|Kotlin|\bBLE\b|Bluetooth|firmware|[Ss]imulator|SIMULATOR/;

export function banlistPath() {
  return process.env.DEKKI_TEST_BANLIST || path.join(os.homedir(), '.dekki', 'test-banlist.txt');
}

let cached;
export function privateBanlist() {
  if (cached !== undefined) return cached;
  const file = banlistPath();
  let lines = null;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')); } catch {}
  if (!lines || !lines.length) {
    console.log('# note: private ban list not found or empty (set DEKKI_TEST_BANLIST or create ~/.dekki/test-banlist.txt); only the built-in checks ran');
    return (cached = null);
  }
  const parts = lines.map((l) => { try { new RegExp(l); return l; } catch { return l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); } });
  return (cached = new RegExp(parts.join('|'), 'i'));
}

// Patterns to test text against. template: also apply the generic template-only terms.
export function bannedPatterns({ template = false } = {}) {
  const out = [BUILTIN];
  if (template) out.push(BUILTIN_TEMPLATE_EXTRA);
  const p = privateBanlist();
  if (p) out.push(p);
  return out;
}

// First banned match in text, or null.
export function firstBanned(text, opts) {
  for (const re of bannedPatterns(opts)) { const m = re.exec(text); if (m) return m[0]; }
  return null;
}
