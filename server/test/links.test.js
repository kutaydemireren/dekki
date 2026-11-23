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
