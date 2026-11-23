import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listPrompts, savePrompt, startImprover, PromptError } from '../prompts.js';

async function withRoot(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-improve-'));
  const root = path.join(dir, 'Prompts');
  process.env.DEKKI_PROMPTS = root;
  try { return await fn(root); } finally {
    delete process.env.DEKKI_PROMPTS;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('improve: copies the prompt into .trash, starts the agent in the prompts folder, owns it', () => withRoot(async (root) => {
  savePrompt('Acme/1 PRD (example).md', 'original text', { create: true });
  const calls = [];
  const owned = [];
  const run = async (args, opts) => { calls.push({ args, opts }); return { ok: true, code: 0, stdout: 'backgrounded · abcdef12 · improve-1 PRD example\n', stderr: '' }; };
  const r = await startImprover('Acme/1 PRD (example).md', '  make it shorter  ', { run, own: (id) => owned.push(id) });
  assert.equal(r.ok, true);
  assert.equal(r.id, 'abcdef12');
  assert.deepEqual(owned, ['abcdef12']);
  assert.equal(calls.length, 1);
  const { args, opts } = calls[0];
  assert.equal(opts.cwd, root);
  assert.deepEqual(args.slice(0, 6), ['--bg', '-n', 'improve-1 PRD example', '--permission-mode', 'acceptEdits', '--']);
  const brief = args[6];
  assert.match(brief, /Acme\/1 PRD \(example\)\.md/);
  assert.match(brief, /AskUserQuestion/);
  assert.match(brief, /What I want from you: make it shorter/);
  assert.match(brief, /Do not write to the file yet/);
  // the untouched original is in the trash, and the list still shows only the real prompt
  assert.match(r.snapshot, /^\.trash\/.+before-improve-1 PRD \(example\)\.md$/);
  assert.equal(fs.readFileSync(path.join(root, r.snapshot), 'utf8'), 'original text');
  assert.equal(listPrompts().items.length, 1);
}));

test('improve: refuses bad paths and long notes; a failed start leaves no copy behind and flags trust', () => withRoot(async (root) => {
  savePrompt('a.md', 'x', { create: true });
  const never = async () => { throw new Error('must not start'); };
  for (const bad of ['../a.md', '.trash/a.md', 'a.txt', 'missing.md', '']) {
    await assert.rejects(startImprover(bad, '', { run: never }), (e) => e instanceof PromptError);
  }
  fs.mkdirSync(path.join(root, 'dir.md'));
  await assert.rejects(startImprover('dir.md', '', { run: never }), (e) => e instanceof PromptError && e.status === 404);
  await assert.rejects(startImprover('a.md', 'x'.repeat(2001), { run: never }), (e) => e instanceof PromptError);
  assert.equal(fs.existsSync(path.join(root, '.trash')), false);

  const untrusted = async () => ({ ok: false, code: 1, stdout: '', stderr: 'Workspace not trusted. Run `claude` in /x once' });
  const r = await startImprover('a.md', '', { run: untrusted });
  assert.equal(r.ok, false);
  assert.equal(r.trust, true);
  assert.equal(r.dir, root);
  assert.deepEqual(fs.readdirSync(path.join(root, '.trash')), []);
}));
