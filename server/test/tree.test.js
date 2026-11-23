import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listTree, openPath } from '../tree.js';
import { getIcon } from '../icons.js';

test('listTree: folders first, packages, hidden shown, icon keys, traversal rejected', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-tree-')));
  const root = path.join(dir, 'root');
  fs.mkdirSync(path.join(root, 'zeta', 'inner'), { recursive: true });
  fs.mkdirSync(path.join(root, 'App.xcodeproj'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'a.TXT'), 'x');
  fs.writeFileSync(path.join(root, '.hidden'), 'x');
  fs.writeFileSync(path.join(root, '.DS_Store'), 'x');
  fs.writeFileSync(path.join(root, 'Makefile'), 'x');
  fs.symlinkSync(path.join(root, 'zeta'), path.join(root, 'link-to-zeta'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ root }));
  process.env.DEKKI_STATE = path.join(dir, 'state.json');
  try {
    const t = listTree('');
    assert.deepEqual(t.entries.map((e) => `${e.kind}:${e.name}:${e.icon}`), [
      'dir:.git:folder',
      'dir:link-to-zeta:folder',
      'dir:zeta:folder',
      'file:.hidden:unknown',
      'file:a.TXT:txt',
      'file:Makefile:unknown',
      'package:App.xcodeproj:xcodeproj',
    ].sort((a, b) => (a.startsWith('dir') ? 0 : 1) - (b.startsWith('dir') ? 0 : 1) || a.split(':')[1].localeCompare(b.split(':')[1])));
    assert.deepEqual(listTree('zeta').entries.map((e) => e.name), ['inner']);
    assert.equal(listTree('../x'), null);
    assert.equal(listTree('zeta/../..'), null);
    assert.equal((await openPath('../etc')).ok, false); // rejected before anything is launched
    assert.equal((await openPath('')).ok, false);
    assert.equal((await openPath('missing')).ok, false);
    assert.equal(await getIcon('../../etc/passwd'), null); // invalid icon type
    assert.equal(await getIcon('a b'), null);
  } finally {
    delete process.env.DEKKI_STATE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
