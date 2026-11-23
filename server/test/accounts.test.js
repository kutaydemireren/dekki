import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome, cleanAccounts, validateAccount, listAccounts, activeAccount, claudeEnv, configDirOf, setActiveAccount, accountEpoch, publicAccounts, addAccount } from '../accounts.js';
import { readState, writeState, setMember } from '../state.js';

const HOME = '/home/u';

test('expandHome: only ~ and ~/x', () => {
  assert.equal(expandHome('~', HOME), HOME);
  assert.equal(expandHome('~/.claude-second', HOME), '/home/u/.claude-second');
  assert.equal(expandHome('~other/x', HOME), '~other/x');
  assert.equal(expandHome('/abs', HOME), '/abs');
});

test('cleanAccounts: drops junk, bad ids, duplicates; trims label', () => {
  const out = cleanAccounts([
    { id: 'personal', label: ' Personal ', configDir: '~/.claude-second' },
    { id: 'personal', label: 'dup', configDir: '/x' },
    { id: 'Bad Id', label: 'x' },
    { id: 'nolabel' },
    null,
    'str',
    { id: 'work', label: 'Work' },
  ]);
  assert.deepEqual(out, [{ id: 'personal', label: 'Personal', configDir: '~/.claude-second' }, { id: 'work', label: 'Work' }]);
  assert.deepEqual(cleanAccounts('nope'), []);
});

test('validateAccount: default ok; relative and missing dirs rejected', () => {
  assert.equal(validateAccount({ id: 'default', label: 'x' }), null);
  assert.match(validateAccount({ configDir: 'rel/dir' }, { home: HOME }), /absolute/);
  assert.match(validateAccount({ configDir: '~/.nope' }, { home: HOME, isDir: () => false }), /does not exist/);
  assert.equal(validateAccount({ configDir: '~/.ok' }, { home: HOME, isDir: (p) => p === '/home/u/.ok' }), null);
});

test('listAccounts/activeAccount: default first; state entry id default only renames; no-dir entries ignored; unknown active falls back', () => {
  assert.deepEqual(listAccounts({ accounts: [] }), [{ id: 'default', label: 'Default' }]);
  const st = { accounts: [{ id: 'default', label: 'Work' }, { id: 'personal', label: 'Personal', configDir: '~/.claude-second' }, { id: 'nodir', label: 'No dir' }], activeAccount: 'personal' };
  assert.deepEqual(listAccounts(st).map((a) => a.id), ['default', 'personal']);
  assert.equal(listAccounts(st)[0].label, 'Work');
  assert.equal(activeAccount(st).id, 'personal');
  assert.equal(activeAccount({ ...st, activeAccount: 'gone' }).id, 'default');
});

test('claudeEnv: custom dir sets CLAUDE_CONFIG_DIR (~ expanded); default unsets it; base untouched', () => {
  const base = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/leak' };
  assert.equal(claudeEnv({ id: 'default' }, base).CLAUDE_CONFIG_DIR, undefined);
  assert.equal(claudeEnv({ id: 'p', configDir: '/abs/p' }, base).CLAUDE_CONFIG_DIR, '/abs/p');
  assert.equal(claudeEnv({ id: 'p', configDir: '~/p' }, base).CLAUDE_CONFIG_DIR, path.join(os.homedir(), 'p'));
  assert.equal(claudeEnv({ id: 'p', configDir: '/abs/p' }, base).PATH, '/bin');
  assert.equal(base.CLAUDE_CONFIG_DIR, '/leak');
  assert.equal(configDirOf({ id: 'default' }, HOME), '/home/u/.claude');
});

function withState(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-acct-'));
  process.env.DEKKI_STATE = path.join(dir, 'state.json');
  try { fn(dir); } finally { delete process.env.DEKKI_STATE; fs.rmSync(dir, { recursive: true, force: true }); }
}

test('setActiveAccount: switches, bumps epoch, persists, survives other state writes; rejects unknown and missing dir', () => {
  withState((dir) => {
    const pdir = path.join(dir, 'personal');
    fs.mkdirSync(pdir);
    writeState({ ...readState(), accounts: [{ id: 'personal', label: 'Personal', configDir: pdir }, { id: 'ghost', label: 'Ghost', configDir: path.join(dir, 'ghost') }] });
    assert.equal(publicAccounts().active, 'default');
    assert.deepEqual(publicAccounts().accounts.map((a) => [a.id, a.missing]), [['default', false], ['personal', false], ['ghost', true]]);
    assert.ok(!JSON.stringify(publicAccounts()).includes(pdir)); // no paths in the API shape
    const e0 = accountEpoch();
    assert.equal(setActiveAccount('personal').ok, true);
    assert.equal(accountEpoch(), e0 + 1);
    assert.equal(setActiveAccount('personal').ok, true); // no change: no bump
    assert.equal(accountEpoch(), e0 + 1);
    setMember('pinned', 'aaaaaaaa', true); // other writes keep accounts + active
    assert.equal(readState().activeAccount, 'personal');
    assert.equal(readState().accounts.length, 2);
    assert.equal(setActiveAccount('nope').ok, false);
    assert.equal(setActiveAccount('ghost').ok, false);
    assert.equal(setActiveAccount(5).ok, false);
    assert.equal(publicAccounts().active, 'personal');
    assert.equal(setActiveAccount('default').ok, true);
  });
});

test('addAccount: slug id, creates dir, replaces same id, refuses default and relative dirs', () => {
  withState((dir) => {
    const d = path.join(dir, 'sub', '.claude-second');
    const a = addAccount('My Personal!', d);
    assert.equal(a.id, 'my-personal');
    assert.ok(fs.statSync(d).isDirectory());
    addAccount('My Personal!', d);
    assert.equal(readState().accounts.length, 1);
    assert.throws(() => addAccount('Default', d), /built-in/);
    assert.throws(() => addAccount('X', 'relative/dir'), /absolute/);
    assert.throws(() => addAccount('  ', d), /Label/);
  });
});
