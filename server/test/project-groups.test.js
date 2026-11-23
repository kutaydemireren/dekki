import test from 'node:test';
import assert from 'node:assert/strict';
import { groupByProject, parseMode, NO_PROJECT } from '../../web/project-groups.js';

const a = (id, label, lastActivityAt, o = {}) => ({ id, name: id, label, lastActivityAt, state: 'idle', ...o });

test('parseMode only knows project, default status', () => {
  assert.equal(parseMode('project'), 'project');
  for (const v of ['status', '', null, undefined, 'x']) assert.equal(parseMode(v), 'status');
});
test('groups by the project part of the shown label, groups sorted by most recent activity, items newest first', () => {
  const { projects } = groupByProject([a('1', 'ios / b1', 10), a('2', 'web', 50), a('3', 'ios / b2', 70), a('4', 'web / b', 5)], {});
  assert.deepEqual(projects.map((p) => p.label), ['ios', 'web']);
  assert.deepEqual(projects[0].items.map((x) => x.id), ['3', '1']);
});
test('the projects root is "Manager sessions"; no label is "No project"', () => {
  const { projects } = groupByProject([a('1', 'Projects / wt', 1), a('2', '', 2), a('3', undefined, 3)], {}, 'Projects');
  assert.deepEqual(projects.map((p) => p.label).sort(), ['Manager sessions', NO_PROJECT].sort());
  assert.equal(projects.find((p) => p.label === NO_PROJECT).items.length, 2);
});
test('pinned first inside a group; archived and other agents are returned apart', () => {
  const top = [a('1', 'ios', 10), a('2', 'ios', 99), a('3', 'ios', 5), a('4', 'ios', 50, { mine: false }), a('5', 'ios', 60)];
  const { projects, rest } = groupByProject(top, { pinned: ['3'], archived: ['5'] });
  assert.deepEqual(projects[0].items.map((x) => x.id), ['3', '2', '1']);
  assert.deepEqual(rest['Other agents'].map((x) => x.id), ['4']);
  assert.deepEqual(rest.Archived.map((x) => x.id), ['5']);
});
test('needs-you agents stay in their project group', () => {
  const { projects } = groupByProject([a('1', 'ios', 10, { needsInput: true }), a('2', 'ios', 20)], {});
  assert.equal(projects.length, 1);
  assert.equal(projects[0].items.length, 2);
});
