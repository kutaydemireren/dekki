// Dev aid: print record type + keys (+ short samples) of a transcript: node scripts/peek.mjs <file> [type...]
import fs from 'node:fs';

const [file, ...types] = process.argv.slice(2);
const seen = new Map();
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let r;
  try { r = JSON.parse(line); } catch { console.log('BAD LINE', line.slice(0, 60)); continue; }
  const n = (seen.get(r.type) || 0) + 1;
  seen.set(r.type, n);
  if (types.length ? types.includes(r.type) && n <= 2 : n === 1) {
    console.log(`== ${r.type} #${n}`);
    console.log(JSON.stringify(r, (k, v) => (typeof v === 'string' && v.length > 160 ? v.slice(0, 160) + '…' : v)).slice(0, 1500));
  }
}
console.log([...seen].map(([k, v]) => `${k}:${v}`).join(' '));
