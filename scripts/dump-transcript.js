// Dump a transcript to the terminal: node scripts/dump-transcript.js <file | sessionId | agentId> [--json]
import fs from 'node:fs';
import { readTranscript, findTranscript } from '../server/transcript.js';
import { listAgents } from '../server/agents.js';
import { isAgentId } from '../server/claude.js';

const [arg, flag] = process.argv.slice(2);
if (!arg) {
  console.error('usage: dump-transcript.js <file | sessionId | agentId> [--json]');
  process.exit(2);
}

let file = fs.existsSync(arg) ? arg : findTranscript(arg);
if (!file && isAgentId(arg)) {
  const a = (await listAgents()).find((x) => x.id === arg);
  file = a?.sessionId ? findTranscript(a.sessionId) : null;
}
if (!file) {
  console.error('History expired (no transcript file found)');
  process.exit(1);
}

const { entries, meta } = readTranscript(file);
if (flag === '--json') {
  console.log(JSON.stringify({ meta, entries }, null, 2));
  process.exit(0);
}
console.log(`# ${meta.title ?? '(untitled)'}  cwd=${meta.cwd}  branch=${meta.gitBranch}  entries=${entries.length}`);
for (const e of entries) {
  const t = e.ts ? e.ts.slice(11, 19) : '--------';
  if (e.k === 'tool') {
    const status = e.result ? (e.result.isError ? 'ERR' : 'ok') : '...';
    console.log(`${t} [tool ${e.name}] ${e.summary}  -> ${status}${e.agentId ? ` agent=${e.agentId}` : ''}`);
    if (e.diff) for (const h of e.diff.hunks) console.log(`         ${e.diff.filePath} ${h.header} (${h.lines.length} lines)`);
  } else {
    console.log(`${t} [${e.k}] ${e.text.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
}
