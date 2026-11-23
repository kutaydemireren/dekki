import test from 'node:test';
import assert from 'node:assert/strict';
import { draftBlocker } from '../remove.js';
import { normalise, IDLE_DETAIL } from '../agents.js';

const draft = (over = {}) => ({ state: 'blocked', worktreePath: null, idle: true, ...over });

test('draftBlocker: a chat is only an empty draft with two independent signs; any doubt keeps it', () => {
  // the real draft: no transcript yet (or only metadata) and Claude's idle placeholder
  assert.equal(draftBlocker(draft(), 'missing'), null);
  assert.equal(draftBlocker(draft(), 'empty'), null);
  // kept: messages, anything unreadable/unrecognised, running, worktree
  assert.equal(draftBlocker(draft(), 'messages'), 'has messages');
  assert.equal(draftBlocker(draft(), 'unknown'), 'unreadable transcript');
  assert.equal(draftBlocker(draft({ state: 'working' }), 'missing'), 'running');
  assert.equal(draftBlocker(draft({ worktreePath: '/p/x/.claude/worktrees/w' }), 'empty'), 'has a worktree');
  // transcript can't be found (moved, format change) but the agent has clearly done something: kept
  assert.equal(draftBlocker(draft({ idle: false }), 'missing'), 'the agent has done something');
  assert.equal(draftBlocker(draft({ idle: false }), 'empty'), 'the agent has done something');
});

test('normalise: idle is the raw placeholder, even while the displayed description is the `needs` text', () => {
  const row = { id: 'aaaaaaaa', kind: 'background', cwd: '/p', state: 'blocked' };
  const fresh = normalise(row, { detail: IDLE_DETAIL, needs: 'send a prompt' }, null);
  assert.equal(fresh.idle, true);
  assert.equal(fresh.detail, 'send a prompt'); // what the list shows
  assert.equal(normalise(row, { detail: 'ran the build' }, null).idle, false);
  assert.equal(normalise(row, null, null).idle, false);
});
