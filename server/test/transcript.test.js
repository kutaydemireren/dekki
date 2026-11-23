import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createParser, readTranscript, findTranscript, userText, projectsTouched, conversationState, lastRealActivity } from '../transcript.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const j = (o) => JSON.stringify(o);
const user = (uuid, content, extra = {}) => j({ type: 'user', uuid, timestamp: '2026-01-01T00:00:00Z', cwd: '/p', gitBranch: 'main', message: { role: 'user', content }, ...extra });
const asst = (uuid, content, extra = {}) => j({ type: 'assistant', uuid, timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content }, ...extra });

test('real excerpt: prompts, replies, title', () => {
  const { entries, meta } = readTranscript(path.join(FIX, 'real-throwaway.jsonl'));
  assert.deepEqual(entries.map((e) => [e.k, e.text]), [
    ['user', 'Reply with the single word ready, then wait for further instructions. Do not use any tools.'],
    ['text', 'ready'],
    ['user', 'Reply with the single word pong'],
    ['text', 'pong'],
  ]);
  assert.equal(meta.title, 'dekki-throwaway-1');
  assert.equal(meta.gitBranch, 'main');
});

test('tool_use paired with tool_result; Edit diff from structuredPatch; sub-agent id', () => {
  const p = createParser();
  const changed = p.feed([
    user('u1', 'fix it'),
    asst('a1', [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: 'on it' }, { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: '/p/a.js', old_string: 'x', new_string: 'y' } }]),
    asst('a2', [{ type: 'tool_use', id: 'tu2', name: 'Agent', input: { description: 'explore', prompt: 'p' } }]),
  ].join('\n') + '\n');
  assert.deepEqual(changed.map((e) => e.id), ['u:u1', 'a:a1:1', 't:tu1', 't:tu2']); // empty thinking dropped
  assert.equal(p.all().find((e) => e.id === 't:tu1').diff.hunks[0].lines.join('|'), '-x|+y'); // fallback from input

  const upd = p.feed([
    user('u2', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'updated' }], {
      toolUseResult: { filePath: '/p/a.js', structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: [' c', '-x', '+y'] }], originalFile: 'HUGE' },
    }),
    user('u3', [{ type: 'tool_result', tool_use_id: 'tu2', content: [{ type: 'text', text: 'launched' }] }], { toolUseResult: { agentId: 'af9a', status: 'async_launched' } }),
  ].join('\n') + '\n');
  assert.deepEqual(upd.map((e) => e.id), ['t:tu1', 't:tu2']); // results update tools, no new user entries
  const t1 = upd[0];
  assert.equal(t1.result.text, 'updated');
  assert.equal(t1.diff.hunks[0].header, '@@ -3,1 +3,1 @@');
  assert.ok(!JSON.stringify(t1).includes('HUGE'));
  assert.equal(upd[1].agentId, 'af9a');
  assert.equal(upd[1].result.text, 'launched');
});

test('Write create result becomes an all-added diff; error flag kept', () => {
  const p = createParser();
  p.feed(asst('a1', [{ type: 'tool_use', id: 'w', name: 'Write', input: { file_path: '/p/n.txt', content: 'l1\nl2' } }, { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'false' } }]) + '\n');
  const [w, b] = p.feed([
    user('r1', [{ type: 'tool_result', tool_use_id: 'w', content: 'created' }], { toolUseResult: { type: 'create', filePath: '/p/n.txt', content: 'l1\nl2', structuredPatch: [] } }),
    user('r2', [{ type: 'tool_result', tool_use_id: 'b', content: 'Exit code 1', is_error: true }], { toolUseResult: 'Exit code 1' }),
  ].join('\n') + '\n');
  assert.deepEqual(w.diff.hunks[0].lines, ['+l1', '+l2']);
  assert.equal(b.result.isError, true);
});

test('tolerates garbage: malformed lines, unknown types, meta/sidechain records, unknown tools, big metadata', () => {
  const p = createParser();
  const out = p.feed([
    '{not json',
    '',
    j({ type: 'brand-new-record', x: 1 }),
    '{"type":"api-request-blob","blob":"' + 'z'.repeat(100000) + '"}',
    user('m', 'hidden', { isMeta: true }),
    user('s', 'side', { isSidechain: true }),
    user('n', null),
    asst('weird', 'not-an-array'),
    asst('a', [{ type: 'tool_use', id: 'q', name: 'SomeFutureTool', input: { thing: 'v' } }, { type: 'mystery' }, null, 5]),
    user('ok', 'visible'),
  ].join('\n') + '\n');
  assert.deepEqual(out.map((e) => e.id), ['t:q', 'u:ok']);
  assert.equal(out[0].summary, 'v');
});

test('long tool output is capped; partial last line is left to the caller (readTranscript drops it)', () => {
  const p = createParser();
  p.feed(asst('a', [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'cat big' } }]) + '\n');
  const [t] = p.feed(user('r', [{ type: 'tool_result', tool_use_id: 'x', content: 'y'.repeat(50000) }]) + '\n');
  assert.equal(t.result.text.length, 20000);
  assert.equal(t.result.truncated, true);

  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'tr-'));
  const f = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f, user('one', 'complete') + '\n' + '{"type":"user","uuid":"two","mess');
  const r = readTranscript(f);
  assert.equal(r.entries.length, 1);
  assert.equal(r.size, Buffer.byteLength(user('one', 'complete') + '\n'));
  fs.rmSync(dir, { recursive: true });
});

test('tag-wrapped user text is shown as a normal chat: slash commands, shell commands, outputs, notifications', () => {
  const cases = [
    ['<command-message>pr-review</command-message>\n<command-name>/pr-review</command-name>', { k: 'user', text: '/pr-review' }],
    ['<command-name>/model</command-name>\n  <command-message>model</command-message>\n  <command-args>opus</command-args>', { k: 'user', text: '/model opus' }],
    ['<command-name>/exit</command-name>\n <command-message>exit</command-message>\n <command-args></command-args>', { k: 'user', text: '/exit' }],
    ['<bash-input>ls -la &amp;&amp; echo hi</bash-input>', { k: 'user', text: '! ls -la && echo hi' }],
    ['<bash-stdout>a -&gt; b</bash-stdout><bash-stderr></bash-stderr>', { k: 'note', text: 'a -> b' }],
    ['<local-command-stdout>Set model to opus</local-command-stdout>', { k: 'note', text: 'Set model to opus' }],
    ['<local-command-stdout>(no content)</local-command-stdout>', null],
    ['<local-command-caveat>The command below was run directly</local-command-caveat>', null],
    ['<system-reminder>x</system-reminder>', null],
    ['<task-notification>\n<task-id>a</task-id>\n<summary>Background command "x" completed (exit code 0)</summary>\n</task-notification>', { k: 'note', text: 'Background task: Background command "x" completed (exit code 0)' }],
    ['just a normal prompt with <b>html</b>', { k: 'user', text: 'just a normal prompt with <b>html</b>' }],
  ];
  for (const [input, expected] of cases) assert.deepEqual(userText(input), expected, input);

  const p = createParser();
  const out = p.feed(user('c1', '<command-message>pr-review</command-message>\n<command-name>/pr-review</command-name>') + '\n');
  assert.deepEqual(out.map((e) => [e.k, e.text]), [['user', '/pr-review']]);
});

test('pasted_content wrapper tags are dropped from text; segments say what was pasted (backslash variants, nesting, mismatched ids)', () => {
  const body = 'Read only. Figma file: https://figma.com/x\nsecond line <b>kept</b>';
  const P = (text) => ({ text, pasted: true });
  const U = (text) => ({ text, pasted: false });
  const cases = [
    [`<pasted_content id="b790">\n${body}\n</pasted_content id="b790">`, body, [P(body)]],
    [`<\\pasted_content id="7f5f">\n<\\pasted_content id="b790">\n${body}\n<\\/pasted_content id="b790">\n<\\/pasted_content id="7f5f">`, body, [P(body)]],
    [`<pasted_content id="a">\n<pasted_content id="b">\n${body}\n</pasted_content id="c">\n</pasted_content>`, body, [P(body)]],
    ['Please check:\n<pasted_content id="a">\nline 1\nline 2\n</pasted_content id="a">\nthanks', 'Please check:\nline 1\nline 2\nthanks', [U('Please check:\n'), P('line 1\nline 2\n'), U('thanks')]],
    ['look <pasted_content id="a">\nline 1\n</pasted_content id="a"> done', 'look\nline 1\ndone', [U('look'), P('\nline 1\n'), U('done')]],
    ['intro\n<pasted_content id="a">one</pasted_content id="a">\n<pasted_content id="b">two</pasted_content id="b">', 'intro\none\ntwo', [U('intro\n'), P('one'), U('\n'), P('two')]],
    ['<pasted_content id="a">\nnever closed\nstill pasted', 'never closed\nstill pasted', [P('never closed\nstill pasted')]],
  ];
  for (const [input, text, segments] of cases) assert.deepEqual(userText(input), { k: 'user', text, segments }, input);

  // nothing pasted (a stray closing tag, a mention mid-sentence) or nothing left after stripping: plain text, no segments
  const plain = [
    ['stray close\n</pasted_content id="a">\nafter', 'stray close\nafter'],
    ['see <pasted_content> tags in the docs', 'see <pasted_content> tags in the docs'],
    ['<pasted_content id="a"></pasted_content id="a">', '<pasted_content id="a"></pasted_content id="a">'],
  ];
  for (const [input, text] of plain) assert.deepEqual(userText(input), { k: 'user', text }, input);
});

test('entries carry segments only for prompts with pasted text; text stays the plain whole, also when blocks are merged', () => {
  const p = createParser();
  const out = p.feed([
    user('p1', [{ type: 'text', text: 'Fix this:\n<pasted_content id="a">\nboom\n</pasted_content id="a">' }, { type: 'text', text: 'and thanks' }]),
    user('p2', 'no paste here'),
  ].join('\n') + '\n');
  assert.deepEqual(out.map((e) => [e.id, e.text, e.segments]), [
    ['u:p1', 'Fix this:\nboom\nand thanks', [{ text: 'Fix this:\n', pasted: false }, { text: 'boom', pasted: true }, { text: '\n', pasted: false }, { text: 'and thanks', pasted: false }]],
    ['u:p2', 'no paste here', undefined],
  ]);
  assert.ok(!('segments' in out[1]));
});

test('a prompt recorded twice as sibling records (same parent, same text) is shown once; later turns are not collapsed', () => {
  const p = createParser();
  const out = p.feed([
    user('u1', 'looking good', { parentUuid: 'P', timestamp: '2026-01-01T00:00:00Z' }),
    user('u2', 'looking good', { parentUuid: 'P', timestamp: '2026-01-01T00:00:10Z' }),
    asst('a1', [{ type: 'text', text: 'thanks' }], { parentUuid: 'u2' }),
    user('u3', 'looking good', { parentUuid: 'a1' }), // user legitimately repeats it after a reply: kept
  ].join('\n') + '\n');
  assert.deepEqual(p.all().map((e) => [e.id, e.k]), [['u:u1', 'user'], ['a:a1:0', 'text'], ['u:u3', 'user']]);
  assert.equal(p.all()[0].ts, '2026-01-01T00:00:10Z'); // later timestamp
  assert.ok(out.some((e) => e.id === 'u:u1')); // the update is delivered to live clients as an upsert
});

test('the same prompt sent again after the agent worked keeps both prompts and the work between them', () => {
  // resent after an interruption: different parent (the interrupt record), work in between
  const p = createParser();
  p.feed([
    user('u1', 'do the thing', { parentUuid: 'P' }),
    asst('a1', [{ type: 'text', text: 'working on it' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], { parentUuid: 'u1' }),
    user('i1', '[Request interrupted by user]', { parentUuid: 'a1' }),
    user('u2', 'do the thing', { parentUuid: 'i1' }),
  ].join('\n') + '\n');
  assert.deepEqual(p.all().map((e) => e.k), ['user', 'text', 'tool', 'user', 'user']);

  // even as true siblings (rewind and resend, same parent): work happened in between, so nothing is merged
  const q = createParser();
  q.feed([
    user('u1', 'do the thing', { parentUuid: 'P' }),
    asst('a1', [{ type: 'text', text: 'working on it' }], { parentUuid: 'u1' }),
    user('u2', 'do the thing', { parentUuid: 'P' }),
  ].join('\n') + '\n');
  assert.deepEqual(q.all().map((e) => [e.id, e.k]), [['u:u1', 'user'], ['a:a1:0', 'text'], ['u:u2', 'user']]);
});

test('projectsTouched: projects an agent referenced under the root, ranked, with boundaries', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'pt-'));
  const root = path.join(dir, 'Projects');
  const bash = (id, command) => asst(`a-${id}`, [{ type: 'tool_use', id, name: 'Bash', input: { command } }]);
  const f = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f, [
    bash('1', `.claude/scripts/delegate.sh web-app "brief" --name x`),
    bash('2', `cd ${root}/web-app && ls`),
    bash('3', `claude agents --json --cwd web-app`),
    bash('4', `cd ${root}/mobile-app && ls`),
    bash('5', `cd ${root}/mobile-app && ls`),
    bash('6', `ls ${root}/dekki-scratch`), // must not count for dekki
    bash('7', `cat ${root}/infra-tf/README.md`), // once: below the "twice" threshold
    asst('t', [{ type: 'text', text: `${root}/api-gateway mentioned in prose only` }]),
  ].join('\n') + '\n');
  try {
    const folders = ['dekki', 'dekki-scratch', 'mobile-app', 'web-app', 'infra-tf', 'api-gateway'];
    assert.deepEqual(projectsTouched(f, root, folders), ['web-app', 'mobile-app']);
    assert.deepEqual(projectsTouched(path.join(dir, 'missing.jsonl'), root, folders), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const tmpFile = (lines) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'cv-'));
  const f = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f, lines);
  return { f, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

test('conversationState: only known metadata is empty; any message, big file, junk or unknown record is not', () => {
  const meta = (type, extra = {}) => j({ type, sessionId: 's', ...extra });
  const cases = [
    [null, 'missing'],
    [meta('last-prompt') + '\n' + meta('cost-state') + '\n' + meta('agent-name') + '\n', 'empty'],
    ['', 'empty'],
    [meta('cost-state') + '\n' + user('u1', 'hi') + '\n', 'messages'],
    [asst('a1', [{ type: 'text', text: 'x' }]) + '\n', 'messages'],
    [user('m', 'hidden', { isMeta: true }) + '\n', 'messages'], // even a hidden user record: conservative
    [meta('cost-state') + '\n' + meta('brand-new-record-type') + '\n', 'unknown'], // can't tell: keep
    [meta('cost-state') + '\n{not json\n', 'unknown'],
    [meta('cost-state') + '\n{"type":"user","mess', 'unknown'], // a line still being written
    [meta('cost-state', { pad: 'z'.repeat(300000) }) + '\n', 'messages'], // big: never "empty"
  ];
  for (const [content, expected] of cases) {
    if (content === null) { assert.equal(conversationState(null), expected); assert.equal(conversationState('/nonexistent/x.jsonl'), 'missing'); continue; }
    const t = tmpFile(content);
    try { assert.equal(conversationState(t.f), expected, content.slice(0, 60)); } finally { t.done(); }
  }
});

test('lastRealActivity: last user/assistant timestamp; trailing metadata, meta and sidechain records are ignored; huge last record handled', () => {
  const stamp = (ts, o) => ({ ...o, timestamp: ts });
  const meta = (type) => j({ type, sessionId: 's' }); // no timestamp, like Claude's attach/stop metadata
  const lines = [
    j(stamp('2026-10-20T12:31:40.211Z', JSON.parse(asst('a1', [{ type: 'text', text: 'x' }])))),
    j(stamp('2026-10-20T12:40:15.301Z', JSON.parse(asst('a2', [{ type: 'text', text: 'done' }])))),
    j({ type: 'system', subtype: 'turn_duration', timestamp: '2026-10-20T12:40:15.355Z' }), // not conversation
    j(stamp('2026-10-21T08:00:00.000Z', JSON.parse(user('m', 'caveat', { isMeta: true })))), // hidden record
    j(stamp('2026-10-21T09:00:00.000Z', JSON.parse(user('s', 'side', { isSidechain: true })))),
    meta('cost-state'), meta('ai-title'), meta('agent-name'),
    '{"type":"user","timestamp":"2026-10-22T11:50:00.000Z","mess', // half-written line
  ].join('\n');
  const t = tmpFile(lines);
  try {
    assert.equal(lastRealActivity(t.f), Date.parse('2026-10-20T12:40:15.301Z'));
  } finally { t.done(); }

  // the last real record is bigger than the first tail window (128 KB): the window widens
  const big = j({ type: 'user', uuid: 'b', timestamp: '2026-10-19T10:00:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y'.repeat(400000) }] } });
  const t2 = tmpFile([big, meta('cost-state'), meta('ai-title')].join('\n') + '\n');
  try {
    assert.equal(lastRealActivity(t2.f), Date.parse('2026-10-19T10:00:00.000Z'));
    assert.equal(lastRealActivity(path.join(path.dirname(t2.f), 'missing.jsonl')), null);
  } finally { t2.done(); }

  // cache is keyed by mtime/size: appending a newer record is picked up
  const t3 = tmpFile(j({ type: 'user', uuid: 'a', timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: 'a' } }) + '\n');
  try {
    assert.equal(lastRealActivity(t3.f), Date.parse('2026-10-01T00:00:00.000Z'));
    fs.appendFileSync(t3.f, j({ type: 'assistant', uuid: 'b', timestamp: '2026-10-02T00:00:00.000Z', message: { role: 'assistant', content: [] } }) + '\n');
    assert.equal(lastRealActivity(t3.f), Date.parse('2026-10-02T00:00:00.000Z'));
  } finally { t3.done(); }
});

test('findTranscript: bad ids and missing sessions return null', () => {
  assert.equal(findTranscript('../../etc/passwd'), null);
  assert.equal(findTranscript('00000000-0000-0000-0000-000000000000'), null);
});
