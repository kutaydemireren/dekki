import test from 'node:test';
import assert from 'node:assert/strict';
import { demoAgents, demoHistory } from '../demo.js';
import { groupAgents, nest } from '../../web/groups.js';

const ROOT = '/tmp/demo-root';
const NOW = Date.now();

test('demo agents cover every state and nest workers under their manager', () => {
  const agents = demoAgents(ROOT, { names: {} }, NOW);
  const states = new Set(agents.map((a) => a.state));
  for (const s of ['working', 'blocked', 'done', 'failed']) assert.ok(states.has(s), `state ${s}`);
  assert.ok(agents.some((a) => a.stalled), 'a stalled manager');
  const { top, children } = nest(agents);
  assert.ok([...children.values()].some((w) => w.length >= 3), 'a manager with workers');
  assert.ok(top.every((a) => !a.parent));
  const groups = groupAgents(top, {}, new Date(NOW));
  assert.ok(groups.Running.length && groups['Needs input'].length && groups['Done today'].length && groups.Older.length);
  for (const a of agents) assert.match(a.id, /^[0-9a-f]{8}$/);
});

test('demo history has a prompt, tool calls, a diff and a closing report', () => {
  const h = demoHistory('b1000002', NOW);
  const kinds = new Set(h.entries.map((e) => e.k));
  for (const k of ['user', 'text', 'tool']) assert.ok(kinds.has(k), k);
  assert.ok(h.entries.some((e) => e.diff));
  assert.match(h.entries.at(-1).text, /^needs input:/);
  assert.equal(demoHistory('00000000'), null);
});
