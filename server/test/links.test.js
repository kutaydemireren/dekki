import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLinks, linksPath } from '../links.js';

test('links: parse links.tsv next to state.json; last line wins; junk, bad ids and self-links ignored; missing file is empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-links-'));
  process.env.DEKKI_STATE = path.join(dir, 'state.json');
  try {
    assert.equal(linksPath(), path.join(dir, 'links.tsv'));
    assert.equal(readLinks().size, 0); // no file
    fs.writeFileSync(linksPath(), [
      'aaaaaaaa\tbbbbbbbb\t2026-10-22T09:00:00Z',
      'cccccccc\tbbbbbbbb\t2026-10-22T09:01:00Z',
      'aaaaaaaa\tdddddddd\t2026-10-22T09:02:00Z', // re-recorded: last wins
      'not-an-id\tbbbbbbbb\tx',
      'eeeeeeee\tnot-an-id\tx',
      'ffffffff\tffffffff\tx', // self link
      'garbage',
      '',
    ].join('\n') + '\n');
    assert.deepEqual([...readLinks()], [['aaaaaaaa', 'dddddddd'], ['cccccccc', 'bbbbbbbb']]);
    fs.appendFileSync(linksPath(), '11111111\tbbbbbbbb\t2026-10-22T09:03:00Z\n'); // picked up after the file changes
    assert.equal(readLinks().get('11111111'), 'bbbbbbbb');
  } finally {
    delete process.env.DEKKI_STATE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('links: legacy ~/.agent-deck/links.tsv is a fallback when DEKKI_STATE is unset; current file wins; ignored with DEKKI_STATE', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-links-home-'));
  const oldHome = process.env.HOME;
  const oldState = process.env.DEKKI_STATE;
  delete process.env.DEKKI_STATE;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(home, '.agent-deck'));
    fs.mkdirSync(path.join(home, '.dekki'));
    const legacy = path.join(home, '.agent-deck', 'links.tsv');
    assert.equal(readLinks().size, 0); // neither file exists
    fs.writeFileSync(legacy, 'aaaaaaaa\tbbbbbbbb\tx\ncccccccc\tbbbbbbbb\tx\n');
    assert.deepEqual([...readLinks()], [['aaaaaaaa', 'bbbbbbbb'], ['cccccccc', 'bbbbbbbb']]);
    fs.writeFileSync(path.join(home, '.dekki', 'links.tsv'), 'aaaaaaaa\tdddddddd\tx\n'); // current wins
    assert.equal(readLinks().get('aaaaaaaa'), 'dddddddd');
    assert.equal(readLinks().get('cccccccc'), 'bbbbbbbb');
    process.env.DEKKI_STATE = path.join(home, 'custom', 'state.json'); // legacy ignored
    assert.equal(readLinks().size, 0);
  } finally {
    process.env.HOME = oldHome;
    if (oldState === undefined) delete process.env.DEKKI_STATE; else process.env.DEKKI_STATE = oldState;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
