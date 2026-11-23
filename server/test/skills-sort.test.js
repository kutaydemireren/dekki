import test from 'node:test';
import assert from 'node:assert/strict';
import { sortSkills, nextSort, projectLabel } from '../../web/skills-sort.js';

const rows = [
  { name: 'beta', uses: 2, sessions: 1, availableIn: 5, lastUsed: '2026-01-02T00:00:00Z' },
  { name: 'Alpha', uses: 2, sessions: 2, availableIn: 9, lastUsed: null },
  { name: 'gamma', uses: 0, sessions: 0, availableIn: 3, lastUsed: '2026-03-01T00:00:00Z' },
  { name: 'delta', uses: 0, sessions: 0, availableIn: 1, lastUsed: null },
];
const names = (s) => sortSkills(rows, s).map((r) => r.name).join(',');

test('no sort keeps API order', () => assert.equal(names(null), 'beta,Alpha,gamma,delta'));
test('name is case-insensitive', () => {
  assert.equal(names({ key: 'name', dir: 'asc' }), 'Alpha,beta,delta,gamma');
  assert.equal(names({ key: 'name', dir: 'desc' }), 'gamma,delta,beta,Alpha');
});
test('numbers, ties keep API order', () => {
  assert.equal(names({ key: 'uses', dir: 'desc' }), 'beta,Alpha,gamma,delta');
  assert.equal(names({ key: 'uses', dir: 'asc' }), 'gamma,delta,beta,Alpha');
  assert.equal(names({ key: 'availableIn', dir: 'desc' }), 'Alpha,beta,gamma,delta');
});
test('lastUsed: never-used always last', () => {
  assert.equal(names({ key: 'lastUsed', dir: 'desc' }), 'gamma,beta,Alpha,delta');
  assert.equal(names({ key: 'lastUsed', dir: 'asc' }), 'beta,gamma,Alpha,delta');
});
test('nextSort', () => {
  assert.deepEqual(nextSort(null, 'name'), { key: 'name', dir: 'asc' });
  assert.deepEqual(nextSort(null, 'uses'), { key: 'uses', dir: 'desc' });
  assert.deepEqual(nextSort({ key: 'uses', dir: 'desc' }, 'uses'), { key: 'uses', dir: 'asc' });
});

test('projectLabel: only the root entry is relabelled, value untouched', () => {
  assert.equal(projectLabel('Projects', 'Projects'), 'Manager sessions');
  assert.equal(projectLabel('web-app', 'Projects'), 'web-app');
  assert.equal(projectLabel('Projects', ''), 'Projects');
});
