import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lastAssistantText, hasWorkerReport } from '../transcript.js';
import { healthFlags, QUIET_MINUTES } from '../agents.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'));
const asst = (content, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content }, ...extra });
const text = (t) => ({ type: 'text', text: t });
const write = (name, lines) => { const f = path.join(dir, name); fs.writeFileSync(f, lines.join('\n') + '\n'); return f; };

test('lastAssistantText: last assistant text wins, tool-only and sidechain records skipped', () => {
  const f = write('a.jsonl', [
    asst([text('early')]),
    asst([text('result: done X\nbranch b')]),
    asst([{ type: 'tool_use', id: 't', name: 'Bash', input: {} }]),
    asst([text('sub text')], { isSidechain: true }),
    JSON.stringify({ type: 'cost-state' }),
  ]);
  assert.equal(lastAssistantText(f), 'result: done X\nbranch b');
});

test('lastAssistantText: malformed and half-written lines tolerated', () => {
  const f = write('b.jsonl', [asst([text('hello')]), '{"type":"assistant","message":{"con', 'not json']);
  assert.equal(lastAssistantText(f), 'hello');
});

test('lastAssistantText: no assistant text -> "", missing file -> null; cache follows file change', () => {
  assert.equal(lastAssistantText(write('c.jsonl', [JSON.stringify({ type: 'user', message: { content: 'hi' } }), 'garbage'])), '');
  assert.equal(lastAssistantText(path.join(dir, 'nope.jsonl')), null);
  const f = write('d.jsonl', [asst([text('one')])]);
  assert.equal(lastAssistantText(f), 'one');
  fs.appendFileSync(f, asst([text('two, longer')]) + '\n');
  assert.equal(lastAssistantText(f), 'two, longer');
});

test('lastAssistantText: finds text beyond the first 128 KB window', () => {
  const big = 'x'.repeat(200 * 1024);
  const f = write('e.jsonl', [asst([text('failed: old')]), asst([{ type: 'tool_use', id: 't', name: 'Bash', input: { c: big } }])]);
  assert.equal(lastAssistantText(f), 'failed: old');
});

test('hasWorkerReport: line-start result:/needs input:/failed:, not mid-line', () => {
  for (const t of ['result: ok', 'x\nneeds input: which?', '  failed: boom', 'a\n\nRESULT: ok']) assert.equal(hasWorkerReport(t), true, t);
  for (const t of ['all done, result: ok', 'resulted: no', '', null, undefined, 42]) assert.equal(hasWorkerReport(t), false, String(t));
});

const now = Date.parse('2026-01-01T12:00:00Z');
const min = (n) => now - n * 60000;
const w = (o) => ({ state: 'done', parent: 'abcd1234', ...o });

test('healthFlags noReport: only linked workers that are done/stopped without a report line', () => {
  assert.equal(healthFlags(w({}), null, 'finished, bye', now).noReport, true);
  assert.equal(healthFlags(w({ state: 'stopped' }), null, '', now).noReport, true);
  assert.equal(healthFlags(w({}), null, 'result: ok', now).noReport, false);
  assert.equal(healthFlags(w({}), null, 'failed: x', now).noReport, false);
  assert.equal(healthFlags(w({ parent: null }), null, 'no report', now).noReport, false, 'manager / other agent');
  assert.equal(healthFlags(w({ state: 'working' }), null, 'no report', now).noReport, false);
  assert.equal(healthFlags(w({ state: 'failed' }), null, 'no report', now).noReport, false);
  assert.equal(healthFlags(w({}), null, null, now).noReport, false, 'unreadable transcript: no verdict');
});

test('healthFlags quiet: working and last real record older than the threshold', () => {
  const a = { state: 'working', parent: null };
  assert.equal(healthFlags(a, min(QUIET_MINUTES + 1), 'x', now).quiet, true);
  assert.equal(healthFlags(a, min(QUIET_MINUTES - 1), 'x', now).quiet, false);
  assert.equal(healthFlags(a, null, 'x', now).quiet, false, 'unknown activity');
  assert.equal(healthFlags(a, 'junk', 'x', now).quiet, false);
  assert.equal(healthFlags({ state: 'blocked' }, min(999), 'x', now).quiet, false);
  assert.equal(healthFlags({ state: 'done' }, min(999), 'x', now).quiet, false);
  assert.equal(healthFlags(a, min(99), 'x', now).quietMinutes, QUIET_MINUTES);
});
