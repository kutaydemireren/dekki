import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createParser, lastRealActivity } from '../transcript.js';

const j = (o) => JSON.stringify(o);
const user = (uuid, text) => j({ type: 'user', uuid, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text } });
const asst = (uuid, text) => j({ type: 'assistant', uuid, timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const queued = (uuid, prompt, kind = 'human') => j({
  type: 'attachment', uuid, timestamp: '2026-01-01T00:00:09Z',
  attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind }, source_uuid: `src-${uuid}`, delivery_id: `del-${uuid}`, timestamp: '2026-01-01T00:00:05Z' },
});

test('queued human message shows as a user entry in order; automated origins and junk are ignored', () => {
  const p = createParser();
  p.feed([
    user('u1', 'first request'),
    asst('a1', 'working'),
    queued('q1', 'queued while busy'),
    queued('q2', 'a task finished', 'task-notification'),
    queued('q3', 'idle notice', 'peer'),
    j({ type: 'attachment', uuid: 'x', attachment: { type: 'skill_listing' } }),
    j({ type: 'queue-operation', operation: 'enqueue', content: 'queued while busy' }),
    queued('q4', '   '),
    asst('a2', 'reply to queued'),
  ].join('\n') + '\n');
  assert.deepEqual(p.all().map((e) => [e.k, e.text]), [
    ['user', 'first request'], ['text', 'working'], ['user', 'queued while busy'], ['text', 'reply to queued'],
  ]);
  assert.equal(p.all()[2].ts, '2026-01-01T00:00:05Z'); // the attachment timestamp, not the row's
});

test('queued message later recorded as a normal user row with the same uuid shows once', () => {
  const p = createParser();
  p.feed(queued('q1', 'same message') + '\n');
  p.feed(user('src-q1', 'same message') + '\n');
  assert.equal(p.all().filter((e) => e.k === 'user').length, 1);
});

test('lastRealActivity counts a human queued message', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dekki-q-')), 's.jsonl');
  fs.writeFileSync(f, [asst('a1', 'x'), queued('q1', 'later')].join('\n') + '\n');
  assert.equal(lastRealActivity(f), Date.parse('2026-01-01T00:00:05Z'));
});
