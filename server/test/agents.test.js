import test from 'node:test';
import assert from 'node:assert/strict';
import { normalise, isMine, linkedParent } from '../agents.js';

test('normalise: blocked agent, job detail, worktree label', () => {
  const a = normalise(
    { id: 'f8578bc7', kind: 'background', state: 'blocked', cwd: '/p/x/.claude/worktrees/w', startedAt: 1000, sessionId: 's' },
    { detail: 'waiting on you', worktreeBranch: 'feat/a', originCwd: '/p/x', lastTerminalAt: '2026-10-21T12:00:00.000Z' },
    null,
  );
  assert.equal(a.needsInput, true);
  assert.equal(a.label, 'x / feat/a');
  assert.equal(a.detail, 'waiting on you');
  assert.equal(a.lastActivityAt, Date.parse('2026-10-21T12:00:00.000Z'));
});

test('normalise: description is `needs` while the agent needs input, `detail` otherwise', () => {
  const job = { detail: '(idle — send a prompt to start)', needs: 'answer: Which project should I review?' };
  const blocked = normalise({ id: 'aaaaaaaa', kind: 'background', cwd: '/p', state: 'blocked', status: 'waiting' }, job, null);
  assert.equal(blocked.detail, 'answer: Which project should I review?');
  const waitingOnly = normalise({ id: 'aaaaaaaa', kind: 'background', cwd: '/p', state: 'working', status: 'waiting' }, job, null);
  assert.equal(waitingOnly.detail, 'answer: Which project should I review?');
  const done = normalise({ id: 'bbbbbbbb', kind: 'background', cwd: '/p', state: 'done', status: 'idle' }, job, null); // stale `needs` is ignored
  assert.equal(done.detail, '(idle — send a prompt to start)');
  const noNeeds = normalise({ id: 'cccccccc', kind: 'background', cwd: '/p', state: 'blocked' }, { detail: 'last line' }, null);
  assert.equal(noNeeds.detail, 'last line');
});

test('normalise: project is the repo of the worktree, not the folder the agent started in', () => {
  const job = { originCwd: '/p', worktreePath: '/p/dekki/.claude/worktrees/v1', worktreeBranch: 'worktree-v1' };
  assert.equal(normalise({ id: 'aaaaaaaa', kind: 'background', cwd: '/p', state: 'working' }, job, null).label, 'dekki / worktree-v1');
  // cwd already inside a worktree, no job state
  assert.equal(normalise({ id: 'bbbbbbbb', kind: 'background', cwd: '/p/ios/.claude/worktrees/w', state: 'done' }, null, null).label, 'ios');
  // no worktree at all: where it started
  assert.equal(normalise({ id: 'cccccccc', kind: 'background', cwd: '/p/web-app', state: 'done' }, { originCwd: '/p/web-app' }, null).label, 'web-app');
});

test('normalise: agent started in the root is labelled with the projects it worked on', () => {
  const row = { id: 'aaaaaaaa', kind: 'background', cwd: '/p', state: 'working' };
  const at = { root: '/p' };
  assert.equal(normalise(row, { originCwd: '/p' }, null, { ...at, touched: ['web-app', 'mobile-app'] }).label, 'web-app, mobile-app');
  assert.equal(normalise(row, { originCwd: '/p' }, null, { ...at, touched: [] }).label, 'p'); // nothing known: the root folder name
  // a worktree wins, and an agent started in a project is not relabelled
  assert.equal(normalise(row, { originCwd: '/p', worktreePath: '/p/x/.claude/worktrees/w', worktreeBranch: 'b' }, null, { ...at, touched: ['y'] }).label, 'x / b');
  assert.equal(normalise({ ...row, cwd: '/p/ios' }, { originCwd: '/p/ios' }, null, { ...at, touched: ['y'] }).label, 'ios');
});

test('isMine: started at the root is mine (even if it moved into a worktree); started in a project is Other; your marks override', () => {
  const at = { root: '/p' };
  const rootAgent = normalise({ id: 'aaaaaaaa', kind: 'background', cwd: '/p', state: 'done' }, { originCwd: '/p' }, null, at);
  const worker = normalise({ id: 'bbbbbbbb', kind: 'background', cwd: '/p/web-app', state: 'done' }, { originCwd: '/p/web-app' }, null, at);
  const wtFromRoot = normalise({ id: 'cccccccc', kind: 'background', cwd: '/p', state: 'done' }, { originCwd: '/p', worktreePath: '/p/x/.claude/worktrees/w', worktreeBranch: 'b' }, null, at);
  const wtWorker = normalise({ id: 'dddddddd', kind: 'background', cwd: '/p/x', state: 'done' }, { originCwd: '/p/x', worktreePath: '/p/x/.claude/worktrees/w', worktreeBranch: 'b' }, null, at);
  assert.equal(rootAgent.startedAtRoot, true);
  assert.equal(isMine(rootAgent), true);
  assert.equal(isMine(worker), false);
  assert.equal(isMine(wtFromRoot), true); // started at the root, moved into a worktree later: still yours
  assert.equal(isMine(wtWorker), false); // a worker started inside a project
  assert.equal(wtFromRoot.label, 'x / b'); // the label rule is unchanged
  assert.equal(isMine(worker, { owned: ['bbbbbbbb'] }), true); // marked Mine / started by the deck
  assert.equal(isMine(rootAgent, { others: ['aaaaaaaa'] }), false); // marked Other beats the root rule
  assert.equal(isMine(rootAgent, { owned: ['aaaaaaaa'], others: ['aaaaaaaa'] }), false);
});

test('isMine: a worker linked to a manager is not mine (even if it started at the root); your marks still override', () => {
  const resumed = { id: 'aaaaaaaa', startedAtRoot: true, parent: 'bbbbbbbb' };
  assert.equal(isMine(resumed), false);
  assert.equal(isMine({ ...resumed, parent: null }), true);
  assert.equal(isMine(resumed, { owned: ['aaaaaaaa'] }), true);
  assert.equal(isMine({ id: 'cccccccc', startedAtRoot: false, parent: 'bbbbbbbb' }, { owned: ['cccccccc'], others: ['cccccccc'] }), false);
});

test('linkedParent: needs a listed manager; self, missing manager and loops give no parent', () => {
  const ids = new Set(['aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
  const links = new Map([['aaaaaaaa', 'bbbbbbbb'], ['cccccccc', 'cccccccc'], ['dddddddd', 'eeeeeeee']]);
  assert.equal(linkedParent('aaaaaaaa', links, ids), 'bbbbbbbb');
  assert.equal(linkedParent('cccccccc', links, ids), null); // self
  assert.equal(linkedParent('dddddddd', links, new Set([...ids, 'dddddddd'])), null); // manager not listed (deleted)
  assert.equal(linkedParent('bbbbbbbb', links, ids), null); // no link
  const loop = new Map([['aaaaaaaa', 'bbbbbbbb'], ['bbbbbbbb', 'aaaaaaaa']]);
  assert.equal(linkedParent('aaaaaaaa', loop, ids), null);
  assert.equal(linkedParent('bbbbbbbb', loop, ids), null);
  const chain = new Map([['aaaaaaaa', 'bbbbbbbb'], ['bbbbbbbb', 'cccccccc']]); // a worker's worker keeps its direct manager
  assert.equal(linkedParent('aaaaaaaa', chain, ids), 'bbbbbbbb');
});

test('normalise: last activity is the last real conversation record; terminal/mtime signals are only fallbacks', () => {
  const row = { id: 'aaaaaaaa', kind: 'background', cwd: '/p', state: 'blocked', startedAt: 5 };
  const job = { lastTerminalAt: '2026-10-22T11:50:00.000Z' }; // moved by a process restart, not by talking
  assert.equal(normalise(row, job, 99, { lastReal: 1000 }).lastActivityAt, 1000);
  assert.equal(normalise(row, job, 99, {}).lastActivityAt, Date.parse('2026-10-22T11:50:00.000Z'));
  assert.equal(normalise(row, {}, 99, { lastReal: null }).lastActivityAt, 99);
});

test('normalise: no job state falls back to transcript mtime, then startedAt', () => {
  const row = { id: 'aaaaaaaa', kind: 'background', state: 'done', cwd: '/p/proj', startedAt: 5 };
  assert.equal(normalise(row, null, 99).lastActivityAt, 99);
  assert.equal(normalise(row, null, null).lastActivityAt, 5);
  assert.equal(normalise(row, null, null).label, 'proj');
  assert.equal(normalise({ ...row, state: undefined, status: 'waiting' }, null, null).needsInput, true);
});

test('normalise: a deck name overrides Claude\'s name and claudeName keeps the original', () => {
  const row = { id: 'aaaaaaaa', kind: 'background', cwd: '/p', state: 'done', name: 'from claude' };
  const a = normalise(row, null, null, { names: { aaaaaaaa: 'mine' } });
  assert.equal(a.name, 'mine');
  assert.equal(a.claudeName, 'from claude');
  assert.equal(normalise(row, null, null, {}).name, 'from claude');
});
