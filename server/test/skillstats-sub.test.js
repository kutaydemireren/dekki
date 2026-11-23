import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionStats, liveStats } from '../transcript.js';

// Sub-agent transcripts live in <session>/subagents/agent-*.jsonl next to <session>.jsonl (FINDINGS §2).
const j = (o) => JSON.stringify(o);
const asst = (ts, content, extra = {}) => j({ type: 'assistant', uuid: `a${ts}`, timestamp: ts, cwd: '/p/proj', message: { role: 'assistant', content }, ...extra });
const sideAsst = (ts, content) => asst(ts, content, { isSidechain: true, agentId: 'abc' });
const use = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });

function withSubs(mainLines, subs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstats-sub-'));
  const f = path.join(dir, 's2.jsonl');
  fs.writeFileSync(f, mainLines.join('\n') + '\n');
  fs.mkdirSync(path.join(dir, 's2', 'subagents'), { recursive: true });
  for (const [name, lines] of Object.entries(subs)) {
    fs.writeFileSync(path.join(dir, 's2', 'subagents', name), Array.isArray(lines) ? lines.join('\n') + '\n' : lines);
  }
  return f;
}

test('sub-agent files count in the totals; fromSubagents says how much; available stays main-only', () => {
  const f = withSubs(
    [
      j({ type: 'attachment', attachment: { type: 'skill_listing', names: ['a', 'b'] } }),
      asst('2026-01-01T00:00:00Z', [use('m1', 'Skill', { skill: 'a' }), use('m2', 'Agent')]),
    ],
    {
      'agent-x1.jsonl': [
        j({ type: 'attachment', attachment: { type: 'skill_listing', names: ['only-in-sub'] } }), // not the session's list
        sideAsst('2026-01-01T00:05:00Z', [use('s1', 'Skill', { skill: 'a' }), use('s2', 'Bash'), use('s3', 'mcp__srv__do_it')]),
        sideAsst('2026-01-01T00:09:00Z', [use('s1', 'Skill', { skill: 'a' }), use('s4', 'Bash')]), // s1 again: not counted twice
        j({ type: 'user', isSidechain: true, timestamp: '2026-01-01T00:09:30Z', message: { role: 'user', content: '<command-name>/b</command-name>' } }), // not a typed slash command
      ],
      'agent-x2.jsonl': [sideAsst('2026-01-01T00:07:00Z', [use('s5', 'Skill', { skill: 'b' })])],
      'agent-x1.meta.json': '{"agentType":"general-purpose"}', // sidecar: ignored
      'agent-x1.forked-skill.json': '{}',
    },
  );
  const s = sessionStats(f);
  assert.equal(s.toolCalls, 2 + 4 + 1); // main 2; x1: Skill, Bash, mcp, Bash; x2: Skill
  assert.equal(s.subagents, 1);
  assert.equal(s.skills.a.count, 2);
  assert.equal(s.skills.a.sub, 1);
  assert.equal(s.skills.a.last, '2026-01-01T00:05:00Z');
  assert.deepEqual(s.skills.b, { count: 1, slash: 0, sub: 1, first: '2026-01-01T00:07:00Z', last: '2026-01-01T00:07:00Z' });
  assert.deepEqual(s.mcp, { srv: { calls: 1, tools: { do_it: 1 } } });
  assert.deepEqual(s.fromSubagents, { files: 2, toolCalls: 5, skillCalls: 2, mcpCalls: 1 });
  assert.deepEqual(s.available, ['a', 'b']);
  assert.equal(s.lastTs, '2026-01-01T00:09:30Z'); // sub-agent activity extends the span
  assert.equal(s.durationMs, 9.5 * 60000);
});

test('no subagents/ folder: zero fromSubagents; broken sub-agent files are tolerated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstats-plain-'));
  const plain = path.join(dir, 'p.jsonl');
  fs.writeFileSync(plain, asst('2026-01-01T00:00:00Z', [use('t1', 'Read')]) + '\n');
  assert.deepEqual(sessionStats(plain).fromSubagents, { files: 0, toolCalls: 0, skillCalls: 0, mcpCalls: 0 });

  const f = withSubs([asst('2026-01-01T00:00:00Z', [use('t1', 'Read')])], {
    'agent-bad.jsonl': 'garbage\n{"type":"assistant"\n[1,2]\n',
    'agent-empty.jsonl': '',
    'agent-ok.jsonl': [sideAsst('2026-01-01T00:01:00Z', [use('s1', 'Grep')])],
  });
  const s = sessionStats(f);
  assert.equal(s.toolCalls, 2);
  assert.equal(s.fromSubagents.toolCalls, 1);
});

test('cache: a changed or new sub-agent file invalidates the session stats', () => {
  const f = withSubs([asst('2026-01-01T00:00:00Z', [use('t1', 'Read')])], { 'agent-a.jsonl': [sideAsst('2026-01-01T00:01:00Z', [use('s1', 'Grep')])] });
  assert.equal(sessionStats(f).toolCalls, 2);
  assert.equal(sessionStats(f), sessionStats(f)); // unchanged: same cached object
  const dir = path.join(path.dirname(f), 's2', 'subagents');
  fs.appendFileSync(path.join(dir, 'agent-a.jsonl'), sideAsst('2026-01-01T00:02:00Z', [use('s2', 'Grep')]) + '\n');
  assert.equal(sessionStats(f).toolCalls, 3); // sub file grew, main file untouched
  fs.writeFileSync(path.join(dir, 'agent-b.jsonl'), sideAsst('2026-01-01T00:03:00Z', [use('s3', 'Bash')]) + '\n');
  assert.equal(sessionStats(f).toolCalls, 4); // new sub file
});

test('liveStats: running agent duration runs to now; idle/stalled/finished keep the cached span', () => {
  const stats = { firstTs: '2026-01-01T00:00:00Z', lastTs: '2026-01-01T00:26:00Z', durationMs: 26 * 60000 };
  const now = Date.parse('2026-01-01T00:30:00Z');
  const run = liveStats(stats, { state: 'working', status: 'busy' }, now);
  assert.equal(run.live, true);
  assert.equal(run.durationMs, 30 * 60000);
  assert.equal(stats.durationMs, 26 * 60000); // cached object untouched
  for (const agent of [{ state: 'working', status: 'idle' }, { state: 'done', status: null }, undefined]) {
    const r = liveStats(stats, agent, now);
    assert.equal(r.live, false);
    assert.equal(r.durationMs, 26 * 60000);
  }
});
