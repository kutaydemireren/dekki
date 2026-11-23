import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTheme, nextTheme, resolveTheme, THEMES } from '../../web/theme.js';
import { flipPlan, flashKind } from '../../web/motion-logic.js';
import { termThemeFor, TERM_THEME, TERM_THEME_LIGHT } from '../../web/term-theme.js';

test('theme: unknown values fall back to system, cycle is system -> dark -> light -> system', () => {
  assert.equal(normalizeTheme(null), 'system');
  assert.equal(normalizeTheme('blue'), 'system');
  assert.equal(normalizeTheme('dark'), 'dark');
  assert.deepEqual(THEMES, ['system', 'dark', 'light']);
  assert.equal(nextTheme('system'), 'dark');
  assert.equal(nextTheme('dark'), 'light');
  assert.equal(nextTheme('light'), 'system');
  assert.equal(nextTheme('junk'), 'dark');
});

test('theme: system follows the OS, dark and light are fixed', () => {
  assert.equal(resolveTheme('system', true), 'light');
  assert.equal(resolveTheme('system', false), 'dark');
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('light', false), 'light');
});

test('terminal theme follows the resolved theme', () => {
  assert.equal(termThemeFor('light'), TERM_THEME_LIGHT);
  assert.equal(termThemeFor('dark'), TERM_THEME);
  assert.equal(termThemeFor(undefined), TERM_THEME);
  assert.deepEqual(Object.keys(TERM_THEME_LIGHT).sort(), Object.keys(TERM_THEME).sort());
});

test('flipPlan: moved rows get their starting offset, new rows are reported, tiny moves and scroll-free layouts are ignored', () => {
  const prev = new Map([['a', 0], ['b', 50], ['c', 100]]);
  const next = new Map([['b', 0], ['a', 50], ['c', 101], ['d', 150]]);
  const { moved, entered } = flipPlan(prev, next);
  assert.deepEqual(moved, [{ id: 'b', dy: 50 }, { id: 'a', dy: -50 }]);
  assert.deepEqual(entered, ['d']);
});

test('flipPlan: a huge reshuffle does not glide', () => {
  const prev = new Map();
  const next = new Map();
  for (let i = 0; i < 60; i++) { prev.set(`r${i}`, i * 10); next.set(`r${i}`, i * 10 + 30); }
  assert.deepEqual(flipPlan(prev, next), { moved: [], entered: [] });
});

test('flashKind: only a finish (working -> done) or a new need flashes', () => {
  assert.equal(flashKind('working', 'done'), 'done');
  assert.equal(flashKind('working', 'needs'), 'needs');
  assert.equal(flashKind('done', 'needs'), 'needs');
  assert.equal(flashKind(undefined, 'needs'), null);
  assert.equal(flashKind('needs', 'needs'), null);
  assert.equal(flashKind('working', 'failed'), null);
  assert.equal(flashKind('stopped', 'done'), null);
});
