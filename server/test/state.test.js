import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readState, writeState, setMember, setName, setArchived, setPinned, statePath, NAME_MAX } from '../state.js';

test('state: defaults, pin/archive round trip, corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-state-'));
  process.env.DEKKI_STATE = path.join(dir, 'sub', 'state.json');
  try {
    assert.deepEqual(readState().pinned, []);
    setMember('pinned', 'aaaaaaaa', true);
    setMember('pinned', 'aaaaaaaa', true);
    setMember('archived', 'bbbbbbbb', true);
    assert.deepEqual(readState().pinned, ['aaaaaaaa']);
    assert.deepEqual(readState().archived, ['bbbbbbbb']);
    setMember('pinned', 'aaaaaaaa', false);
    assert.deepEqual(readState().pinned, []);
    assert.deepEqual(fs.readdirSync(path.dirname(statePath())), ['state.json']); // no tmp left behind
    fs.writeFileSync(statePath(), '{not json');
    assert.deepEqual(readState().archived, []);
  } finally {
    delete process.env.DEKKI_STATE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('state: archived means never pinned (load drops the pin, idempotent; archive drops it; pin un-archives; un-archive keeps it dropped)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-state-'));
  process.env.DEKKI_STATE = path.join(dir, 'state.json');
  try {
    fs.writeFileSync(statePath(), JSON.stringify({ pinned: ['aaaaaaaa', 'bbbbbbbb'], archived: ['bbbbbbbb', 'cccccccc'] }));
    assert.deepEqual(readState().pinned, ['aaaaaaaa']);
    assert.deepEqual(readState().pinned, ['aaaaaaaa']); // idempotent
    writeState(readState());
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath(), 'utf8')).pinned, ['aaaaaaaa']);
    setPinned('dddddddd', true);
    assert.deepEqual(setArchived('dddddddd', true).pinned, ['aaaaaaaa']);
    assert.ok(readState().archived.includes('dddddddd'));
    setArchived('dddddddd', false);
    assert.deepEqual(readState().pinned, ['aaaaaaaa']); // un-archiving does not restore the pin
    const s = setPinned('cccccccc', true); // pinning an archived agent un-archives it
    assert.ok(s.pinned.includes('cccccccc') && !s.archived.includes('cccccccc'));
    assert.deepEqual(setPinned('cccccccc', false).pinned, ['aaaaaaaa']);
  } finally {
    delete process.env.DEKKI_STATE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('state: owned/others lists default empty, round trip, junk is dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-state-'));
  process.env.DEKKI_STATE = path.join(dir, 'state.json');
  try {
    assert.deepEqual([readState().owned, readState().others], [[], []]);
    setMember('owned', 'aaaaaaaa', true);
    setMember('others', 'bbbbbbbb', true);
    assert.deepEqual([readState().owned, readState().others], [['aaaaaaaa'], ['bbbbbbbb']]);
    fs.writeFileSync(statePath(), JSON.stringify({ owned: ['aaaaaaaa', 5, null], others: 'x' }));
    assert.deepEqual([readState().owned, readState().others], [['aaaaaaaa'], []]);
  } finally {
    delete process.env.DEKKI_STATE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('state: deck names are trimmed, capped, cleared by empty, junk ids dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-state-'));
  process.env.DEKKI_STATE = path.join(dir, 'state.json');
  try {
    assert.deepEqual(readState().names, {});
    setName('aaaaaaaa', '  My chat  ');
    assert.equal(readState().names.aaaaaaaa, 'My chat');
    setName('bbbbbbbb', 'x'.repeat(NAME_MAX + 50));
    assert.equal(readState().names.bbbbbbbb.length, NAME_MAX);
    setName('aaaaaaaa', '   ');
    assert.equal(readState().names.aaaaaaaa, undefined);
    fs.writeFileSync(statePath(), JSON.stringify({ names: { 'not-an-id': 'x', cccccccc: 5, dddddddd: 'ok' } }));
    assert.deepEqual(readState().names, { dddddddd: 'ok' });
  } finally {
    delete process.env.DEKKI_STATE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('state: a fresh state has no working folder (the Working folder dialog asks for one)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-state-'));
  process.env.DEKKI_STATE = path.join(dir, 'state.json');
  try {
    assert.equal(readState().root, '');
    fs.writeFileSync(statePath(), JSON.stringify({ root: '/some/where' }));
    assert.equal(readState().root, '/some/where');
  } finally {
    delete process.env.DEKKI_STATE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
