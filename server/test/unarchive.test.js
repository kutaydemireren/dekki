import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toUnarchive, step, startUnarchivePoller } from '../unarchive.js';
import { readState, setMember } from '../state.js';

const a = (id, state) => ({ id, state });

test('first poll only seeds: archived agent already working is not unarchived', () => {
  const r = toUnarchive(null, [a('x', 'working')], ['x']);
  assert.deepEqual(r.ids, []);
  assert.equal(r.next.get('x'), 'working');
});

test('archived agent going idle/done/blocked -> working is unarchived', () => {
  for (const was of ['done', 'idle', 'blocked']) {
    assert.deepEqual(toUnarchive(new Map([['x', was]]), [a('x', 'working')], ['x']).ids, ['x']);
  }
});

test('archived while working and still working: no unarchive', () => {
  assert.deepEqual(toUnarchive(new Map([['x', 'working']]), [a('x', 'working')], ['x']).ids, []);
});

test('worker finishing while archived (working -> done) stays archived', () => {
  assert.deepEqual(toUnarchive(new Map([['x', 'working']]), [a('x', 'done')], ['x']).ids, []);
});

test('non-archived agents and agents first seen later are ignored', () => {
  const prev = new Map([['y', 'done']]);
  assert.deepEqual(toUnarchive(prev, [a('y', 'working'), a('x', 'working')], ['x']).ids, []);
});

test('step writes state, then a later poll does not repeat', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unarch-'));
  process.env.DEKKI_STATE = path.join(dir, 'state.json');
  try {
    setMember('archived', 'aaaaaaaa', true);
    const t = { prev: null };
    assert.deepEqual(step(t, [a('aaaaaaaa', 'done')]), []);
    assert.deepEqual(step(t, [a('aaaaaaaa', 'working')]), ['aaaaaaaa']);
    assert.deepEqual(readState().archived, []);
    assert.deepEqual(step(t, [a('aaaaaaaa', 'working')]), []);
  } finally {
    delete process.env.DEKKI_STATE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('poller is off under node --test', () => {
  assert.equal(startUnarchivePoller(), null);
});
