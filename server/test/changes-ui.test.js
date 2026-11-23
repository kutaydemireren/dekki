import test from 'node:test';
import assert from 'node:assert/strict';
import { splitPath, fileSig, isOpen, isLarge, truncMessage, emptyState, LARGE_LINES } from '../../web/changes-logic.js';
import { demoChanges, demoChangeFile } from '../demo-changes.js';
import { MAX_DIFF_LINES, listGroupChanges } from '../changes.js';
import { hasChangesTab, visibleGroups, groupTotals, workerIdsParam, managerEmptyState } from '../../web/changes-logic.js';
import { demoGroupChanges } from '../demo-changes.js';

// ---------- manager view ----------
test('Changes tab visibility: worktree or manager with workers, never by current changes', () => {
  assert.equal(hasChangesTab({ worktreePath: '/x/wt' }, 0), true);
  assert.equal(hasChangesTab({ worktreePath: null }, 2), true);
  assert.equal(hasChangesTab({ worktreePath: '/x/wt' }, 3), true);
  assert.equal(hasChangesTab({ worktreePath: null }, 0), false);
  assert.equal(hasChangesTab({}, 0), false);
  assert.equal(hasChangesTab(null, 0), false);
});

test('manager empty state says workers, other empty states are unchanged', () => {
  assert.equal(managerEmptyState('all').title, "Workers haven't changed anything yet");
  assert.equal(managerEmptyState('uncommitted').title, "Workers haven't changed anything yet");
  assert.equal(emptyState({ status: 'none' }, 'all').title, 'No git changes for this agent');
  assert.equal(emptyState({ status: 'ok', files: [], base: { name: 'develop' } }, 'all').title, 'Nothing changed yet');
});

test('visibleGroups drops groups without files; groupTotals sums the rest; workerIdsParam keeps order', () => {
  const g = (id, files, add, del) => ({ id, files: Array.from({ length: files }, (_, i) => ({ path: `f${i}` })), totals: { add, del } });
  const data = { status: 'ok', groups: [g('m', 1, 2, 0), g('w1', 0, 0, 0), g('w2', 2, 5, 3)] };
  const shown = visibleGroups(data);
  assert.deepEqual(shown.map((x) => x.id), ['m', 'w2']);
  assert.deepEqual(groupTotals(shown), { files: 3, add: 7, del: 3 });
  assert.deepEqual(visibleGroups({ status: 'none' }), []);
  assert.deepEqual(visibleGroups(null), []);
  assert.equal(workerIdsParam([{ id: 'a' }, { id: 'b' }]), 'a,b');
});

test('listGroupChanges: one pass per entry, non-git skipped, manager group first, capped', async () => {
  const calls = [];
  const ok = (n) => ({ status: 'ok', branch: `b${n}`, base: null, files: [{ path: 'x' }], totals: { files: 1, add: n, del: 0 }, truncatedFiles: false });
  const list = async (dir, scope) => { calls.push([dir, scope]); return dir === '/none' ? { status: 'none', reason: 'not-git' } : ok(dir.length); };
  const r = await listGroupChanges([
    { id: 'w1', name: 'one', role: 'worker', dir: '/a' },
    { id: 'w2', name: 'two', role: 'worker', dir: '/none' },
    { id: 'm', name: 'mgr', role: 'manager', dir: '/mm' },
    { id: 'w3', name: 'three', role: 'worker', dir: '/ccc' },
  ], 'uncommitted', list);
  assert.equal(r.scope, 'uncommitted');
  assert.deepEqual(r.groups.map((g) => g.id), ['m', 'w1', 'w3']);
  assert.equal(r.groups[1].branch, 'b2');
  assert.equal(calls.length, 4);
  assert.ok(calls.every(([, s]) => s === 'uncommitted'));
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `w${i}`, name: 'n', role: 'worker', dir: '/a' }));
  assert.equal((await listGroupChanges(many, 'all', list)).groups.length, 30);
});

test('demo manager: two workers with changes, the rest skipped', () => {
  const specs = ['b1000001', 'b1000002', 'b1000003', 'b1000004'].map((id) => ({ id, name: id, branch: id }));
  const r = demoGroupChanges(specs, 'all');
  assert.deepEqual(r.groups.map((g) => g.id), ['b1000001', 'b1000003']);
  assert.ok(r.groups.every((g) => g.files.length > 0 && g.totals.add > 0));
  assert.ok(demoGroupChanges(specs, 'uncommitted').groups.length >= 1);
});

test('splitPath keeps the directory dimmed apart from the file name', () => {
  assert.deepEqual(splitPath('src/auth/session.ts'), { dir: 'src/auth/', name: 'session.ts' });
  assert.deepEqual(splitPath('README.md'), { dir: '', name: 'README.md' });
});

test('fileSig changes with the content stamp, status and counts', () => {
  const f = { status: 'modified', add: 1, del: 2, mtime: 5 };
  assert.equal(fileSig(f), fileSig({ ...f }));
  assert.notEqual(fileSig(f), fileSig({ ...f, mtime: 6 }));
  assert.notEqual(fileSig(f), fileSig({ ...f, add: 2 }));
});

test('cards: open by default, large ones start collapsed, an explicit choice wins', () => {
  const small = { path: 'a', add: 3, del: 1 };
  const big = { path: 'b', add: LARGE_LINES + 1, del: 0 };
  assert.equal(isOpen(small, {}), true);
  assert.equal(isLarge(big), true);
  assert.equal(isOpen(big, {}), false);
  assert.equal(isOpen(big, { b: true }), true);
  assert.equal(isOpen(small, { a: false }), false);
});

test('truncation marker and empty states use plain words', () => {
  assert.equal(truncMessage(null), null);
  assert.equal(truncMessage({ moreLines: 1234, atLeast: false }), 'diff truncated, 1,234 more lines');
  assert.equal(truncMessage({ moreLines: 10, atLeast: true }), 'diff truncated, at least 10 more lines');
  assert.equal(emptyState({ status: 'none' }, 'all').title, 'No git changes for this agent');
  assert.equal(emptyState({ status: 'ok', files: [], base: { name: 'develop' } }, 'all').title, 'Nothing changed yet');
  assert.equal(emptyState({ status: 'ok', files: [], base: { name: 'develop' } }, 'uncommitted').title, 'No uncommitted changes');
  assert.match(emptyState({ status: 'ok', files: [], base: null, note: 'No base branch found' }, 'all').sub, /No base branch/);
});

test('demo fixtures: added, deleted, renamed, binary, a truncated diff, a clean agent, no worktree', () => {
  const a = demoChanges({ id: 'c2d3e4f5', branch: 'x' });
  assert.equal(a.files.length, 6);
  for (const s of ['added', 'deleted', 'renamed']) assert.ok(a.files.some((f) => f.status === s), s);
  assert.ok(a.files.some((f) => f.binary));
  assert.equal(a.totals.add, a.files.reduce((n, f) => n + f.add, 0));
  assert.equal(demoChanges({ id: 'c2d3e4f5', branch: 'x' }, 'uncommitted').files.length, 3);
  const big = demoChangeFile({ id: 'd3e4f5a6' }, 'internal/search/testdata/corpus.golden.json');
  assert.equal(big.hunks[0].lines.length, MAX_DIFF_LINES);
  assert.equal(big.truncated.moreLines, 400);
  assert.equal(demoChanges({ id: 'e4f5a6b7' }).files.length, 0);
  assert.equal(demoChanges(null).status, 'none');
  assert.equal(demoChangeFile({ id: 'c2d3e4f5' }, 'public/img/login-hero.png').binary, true);
});
