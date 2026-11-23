import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionStats } from '../transcript.js';

const j = (o) => JSON.stringify(o);
const asst = (ts, content, extra = {}) => j({ type: 'assistant', uuid: `a${ts}`, timestamp: ts, cwd: '/p/proj', message: { role: 'assistant', content }, ...extra });
const use = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });

function tmp(lines) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skillstats-')), 's1.jsonl');
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
}

test('skills, tools, MCP, sub-agents, duration, available list; tolerates junk', () => {
  const f = tmp([
    j({ type: 'attachment', attachment: { type: 'skill_listing', names: ['a', 'b', 'c'], content: '- a: x\n- b: y\n- c: z' } }),
    j({ type: 'attachment', attachment: { type: 'skill_listing', content: '- d: late addition' } }), // no names: parse content
    'not json at all',
    j({ type: 'something-new', x: 1 }),
    j({ type: 'user', timestamp: '2026-01-01T00:00:00Z', cwd: '/p/proj', message: { role: 'user', content: '<command-name>/b</command-name><command-args>x</command-args>' } }),
    j({ type: 'user', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: '<command-name>/model</command-name>' } }), // not a skill
    asst('2026-01-01T00:01:00Z', [use('t1', 'Skill', { skill: 'a' }), use('t2', 'Bash'), use('t3', 'mcp__srv__do_it'), use('t4', 'Agent')]),
    asst('2026-01-01T00:01:00Z', [use('t1', 'Skill', { skill: 'a' })]), // same tool_use id written twice
    asst('2026-01-01T00:02:00Z', [use('t5', 'Skill', { skill: 'a' }), use('t6', 'mcp__srv__do_it'), use('t7', 'Mystery')]),
    asst('2026-01-01T00:03:00Z', [use('s1', 'Skill', { skill: 'zzz' })], { isSidechain: true }), // sub-agent record: ignored
  ]);
  const s = sessionStats(f);
  assert.equal(s.toolCalls, 7);
  assert.equal(s.subagents, 1);
  assert.deepEqual(s.skills.a, { count: 2, slash: 0, sub: 0, first: '2026-01-01T00:01:00Z', last: '2026-01-01T00:02:00Z' });
  assert.equal(s.skills.b.count, 1);
  assert.equal(s.skills.b.slash, 1);
  assert.equal(s.skills.model, undefined);
  assert.equal(s.skills.zzz, undefined);
  assert.deepEqual(s.mcp, { srv: { calls: 2, tools: { do_it: 2 } } });
  assert.deepEqual(s.available, ['a', 'b', 'c', 'd']);
  assert.equal(s.cwd, '/p/proj');
  assert.equal(s.durationMs, Date.parse('2026-01-01T00:02:00Z') - Date.parse('2026-01-01T00:00:00Z'));
});

test('no skill listing -> available is null; missing file -> null', () => {
  const f = tmp([asst('2026-01-01T00:00:00Z', [use('t1', 'Read')])]);
  assert.equal(sessionStats(f).available, null);
  assert.equal(sessionStats('/nonexistent/x.jsonl'), null);
});
