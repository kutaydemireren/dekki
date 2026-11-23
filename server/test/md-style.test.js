import test from 'node:test';
import assert from 'node:assert/strict';
import { isPathLike, statusOf } from '../../web/md-style.js';

test('isPathLike: paths, folders, line suffixes', () => {
  for (const s of [
    'WidgetListViewModel.swift',
    'App/…/Widgets/List/WidgetListViewModel.swift',
    'server/routes.js:84',
    'server/routes.js:84-87',
    'web/App.jsx#L12',
    'web/App.jsx#L12-L20',
    'web-app/',
    './scripts/run.sh',
    '~/Documents/Projects',
    '.claude/scripts/delegate.sh',
    'package.json',
    'Foo.xcodeproj',
  ]) assert.equal(isPathLike(s), true, s);
});

test('isPathLike: code, urls, sentences and junk are not paths', () => {
  for (const s of [
    'startOver()', 'Foo.bar', 'a.b', 'widget_list_reset_filters', '.buttonTapped(id: "x")', 'a / b',
    'https://example.com/a/b.html', 'the file is server/routes.js', '', '   ', '/', '//', '..', '123', '84-87', 'x'.repeat(300) + '.swift', null, undefined, 5,
  ]) assert.equal(isPathLike(s), false, String(s));
});

test('statusOf: the four markers at the start, any case, with the rest kept', () => {
  assert.deepEqual(statusOf('result: all green'), { kind: 'ok', word: 'result:', rest: ' all green' });
  assert.deepEqual(statusOf('  Needs input: which branch?'), { kind: 'ask', word: 'Needs input:', rest: ' which branch?' });
  assert.equal(statusOf('FAILED: boom').kind, 'fail');
  assert.equal(statusOf('warning : careful').kind, 'warn');
  assert.equal(statusOf('Result:').rest, '');
});

test('statusOf: only at the very start', () => {
  for (const s of ['the result: fine', 'results: many', 'needs input here', 'resultant: x', '', null, undefined, 3]) assert.equal(statusOf(s), null, String(s));
});
