import test from 'node:test';
import assert from 'node:assert/strict';
import { foldEntries, summarizeTools, groupHasError, groupPending, diffCounts } from '../../web/history-fold.js';
import { calloutOf } from '../../web/md-style.js';
import { homeSummary } from '../../web/home.js';

const tool = (id, name, extra = {}) => ({ id, k: 'tool', name, result: { text: '' }, ...extra });

test('foldEntries: consecutive tools form one group; diff tools, text and notes end it', () => {
  const diff = { filePath: 'a.js', hunks: [{ lines: ['+x', '-y', ' z'] }] };
  const items = foldEntries([
    { id: 'u', k: 'user', text: 'go' },
    tool('1', 'Read'), tool('2', 'Grep'), tool('3', 'Bash'),
    tool('4', 'Edit', { diff }),
    tool('5', 'Read'),
    { id: 't', k: 'text', text: 'done' },
    tool('6', 'Bash'),
  ]);
  assert.deepEqual(items.map((i) => i.type), ['entry', 'tools', 'entry', 'tools', 'entry', 'tools']);
  assert.equal(items[1].tools.length, 3);
  assert.equal(items[2].e.id, '4');
  assert.equal(items[1].id, 'g-1');
});

test('summarizeTools: counts from tool names, unknown tools are tool calls', () => {
  assert.equal(summarizeTools([...Array(6)].map((_, i) => tool(i, i < 4 ? 'Read' : 'Grep'))), 'Explored 4 files, 2 searches');
  assert.equal(summarizeTools([tool(1, 'Bash'), tool(2, 'Bash')]), 'Ran 2 commands');
  assert.equal(summarizeTools([tool(1, 'Bash')]), 'Ran 1 command');
  assert.equal(summarizeTools([tool(1, 'Mystery'), tool(2, 'mcp__x__y'), tool(3, 'Agent')]), '3 tool calls');
  assert.equal(summarizeTools([tool(1, 'Read'), tool(2, 'Bash'), tool(3, 'Mystery')]), 'Explored 1 file, Ran 1 command, 1 tool call');
});

test('group flags: error and pending', () => {
  assert.equal(groupHasError([tool(1, 'Bash'), tool(2, 'Bash', { result: { isError: true } })]), true);
  assert.equal(groupHasError([tool(1, 'Bash')]), false);
  assert.equal(groupPending([tool(1, 'Bash', { result: null })]), true);
  assert.equal(groupPending([tool(1, 'Bash')]), false);
});

test('diffCounts: + and - lines over hunks', () => {
  assert.deepEqual(diffCounts({ hunks: [{ lines: ['+a', '+b', '-c', ' d'] }, { lines: ['-e'] }] }), { add: 2, del: 2 });
  assert.deepEqual(diffCounts(null), { add: 0, del: 0 });
});

test('calloutOf: result / needs input / failed lead a message; others do not', () => {
  assert.deepEqual(calloutOf('result: it works\nAct: none\n\nDetails here'), { kind: 'ok', label: 'Result', body: 'it works\nAct: none', rest: 'Details here' });
  assert.equal(calloutOf('**needs input:** which one?').kind, 'ask');
  assert.equal(calloutOf('**needs input:** which one?').body, 'which one?');
  assert.equal(calloutOf('Failed: boom').kind, 'fail');
  assert.equal(calloutOf('warning: careful'), null);
  assert.equal(calloutOf('The result: is fine'), null);
  assert.equal(calloutOf('Here is a plan.\n\nresult: later'), null);
  assert.equal(calloutOf(null), null);
});

test('homeSummary: same grouping as the list, workers nested under a manager are not counted', () => {
  const now = new Date();
  const t = now.getTime();
  const agents = [
    { id: 'a', state: 'blocked', needsInput: true, lastActivityAt: t },
    { id: 'b', state: 'working', lastActivityAt: t },
    { id: 'c', state: 'done', lastActivityAt: t },
    { id: 'd', state: 'done', lastActivityAt: t - 3 * 86400000 },
    { id: 'w', state: 'working', parent: 'b', mine: false, lastActivityAt: t },
  ];
  const s = homeSummary(agents, {}, now);
  assert.deepEqual([s.needs, s.working, s.done].map((l) => l.map((a) => a.id)), [['a'], ['b'], ['c']]);
});
