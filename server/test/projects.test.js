import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, failure } from '../projects.js';
import { trustHelp } from '../accounts.js';

const HOME = '/Users/fake';
const personal = { id: 'personal', label: 'Personal', configDir: '~/.claude-second' };

test('trustHelp: default account keeps the plain message, no command', () => {
  const h = trustHelp('/Users/fake/Projects', { id: 'default', label: 'Default' }, HOME);
  assert.equal(h.message, 'Workspace not trusted. Run `claude` in /Users/fake/Projects once and accept the trust prompt, then try again.');
  assert.equal(h.command, null);
});

test('trustHelp: non-default account gets the exact CLAUDE_CONFIG_DIR command, ~ form when plain', () => {
  const h = trustHelp('/Users/fake/Projects', personal, HOME);
  assert.equal(h.command, 'cd ~/Projects && CLAUDE_CONFIG_DIR=~/.claude-second claude');
  assert.match(h.message, /Personal/);
});

test('trustHelp: quotes paths with spaces and paths outside home', () => {
  const h = trustHelp('/Users/fake/My Projects', { ...personal, configDir: '/opt/cfg dir' }, HOME);
  assert.equal(h.command, "cd '/Users/fake/My Projects' && CLAUDE_CONFIG_DIR='/opt/cfg dir' claude");
});

test('failure: only a trust failure carries trust text', () => {
  const t = failure({ code: 1 }, 'Workspace not trusted. Run claude', '/x');
  assert.equal(t.trust, true);
  assert.ok(t.trustMessage);
  const o = failure({ code: 1 }, 'boom', '/x');
  assert.equal(o.trust, false);
  assert.equal(o.trustMessage, undefined);
});

test('buildArgs: no prompt makes an idle agent; prompt goes after --', () => {
  assert.deepEqual(buildArgs({}), ['--bg']);
  assert.deepEqual(buildArgs({ name: 'n' }), ['--bg', '-n', 'n']);
  assert.deepEqual(buildArgs({ prompt: '--help me' }), ['--bg', '--', '--help me']);
});
