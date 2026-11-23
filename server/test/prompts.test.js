import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promptsRoot, listPrompts, savePrompt, movePrompt, makeFolder, trashPrompt, revealPrompt, revealTrash, cleanRel, PromptError } from '../prompts.js';
import { stripFrontmatter, placeholdersOf, fieldsOf, fill, render, toTerminalInput } from '../../web/prompt-text.js';

function withRoot(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-prompts-'));
  const root = path.join(dir, 'Prompts');
  process.env.DEKKI_PROMPTS = root;
  try { return fn(root, dir); } finally {
    delete process.env.DEKKI_PROMPTS;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
async function withRootAsync(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-prompts-'));
  const root = path.join(dir, 'Prompts');
  process.env.DEKKI_PROMPTS = root;
  try { return await fn(root, dir); } finally {
    delete process.env.DEKKI_PROMPTS;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const throwsStatus = (fn, status) => assert.throws(fn, (e) => e instanceof PromptError && (status === undefined || e.status === status));

test('prompts: path validation refuses traversal, absolute, dot segments, backslashes', () => {
  for (const bad of ['', '  ', '../x.md', 'a/../x.md', '/etc/x.md', 'a//b.md', '.trash/x.md', 'a/.hidden/x.md', 'a\\b.md', null, 5]) {
    throwsStatus(() => cleanRel(bad), 400);
  }
  assert.equal(cleanRel(' Acme / 1 PRD.md '), 'Acme/1 PRD.md');
});

test('prompts: default folder is ~/.dekki/prompts; a missing one lists as empty, no error, nothing created', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-prompts-home-'));
  const oldHome = process.env.HOME;
  const oldEnv = process.env.DEKKI_PROMPTS;
  delete process.env.DEKKI_PROMPTS;
  process.env.HOME = home;
  try {
    const want = path.join(home, '.dekki', 'prompts');
    assert.equal(promptsRoot(), want);
    assert.deepEqual(listPrompts(), { root: want, exists: false, trash: 0, folders: [], items: [] });
    assert.equal(fs.existsSync(path.join(home, '.dekki')), false); // listing creates nothing
    savePrompt('first.md', 'hi');
    assert.equal(fs.readFileSync(path.join(want, 'first.md'), 'utf8'), 'hi'); // created on first save
  } finally {
    process.env.HOME = oldHome;
    if (oldEnv !== undefined) process.env.DEKKI_PROMPTS = oldEnv;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('prompts: missing folder lists as empty and is created on first save', () => withRoot((root) => {
  assert.deepEqual(listPrompts(), { root, exists: false, trash: 0, folders: [], items: [] });
  savePrompt('1 PRD.md', 'hello');
  assert.equal(listPrompts().exists, true);
}));

test('prompts: save, list (natural order, folders, skips dot files and non-md), update', () => withRoot((root) => {
  savePrompt('10 Last.md', 'ten');
  savePrompt('2 Second.md', 'two');
  savePrompt('Acme/1 PRD.md', 'prd body');
  makeFolder('Empty');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
  fs.mkdirSync(path.join(root, '.obsidian'));
  fs.writeFileSync(path.join(root, '.obsidian', 'a.md'), 'x');
  const l = listPrompts();
  assert.deepEqual(l.items.map((i) => i.path), ['10 Last.md', '2 Second.md', 'Acme/1 PRD.md'].sort(new Intl.Collator('en', { numeric: true }).compare));
  assert.equal(l.items[0].path, '2 Second.md'); // 2 before 10
  assert.deepEqual(l.folders, ['Acme', 'Empty']);
  assert.equal(l.items.find((i) => i.name === '1 PRD').body, 'prd body');
  const { mtime } = savePrompt('2 Second.md', 'two v2', { baseMtime: listPrompts().items[0].mtime });
  assert.equal(typeof mtime, 'number');
  assert.equal(fs.readFileSync(path.join(root, '2 Second.md'), 'utf8'), 'two v2');
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.endsWith('.tmp')), []); // no tmp left behind
}));

test('prompts: create refuses an existing name; changed or deleted file is a 409 conflict', () => withRoot((root) => {
  savePrompt('a.md', '1');
  throwsStatus(() => savePrompt('a.md', '2', { create: true }), 409);
  const base = listPrompts().items[0].mtime;
  fs.writeFileSync(path.join(root, 'a.md'), 'edited in Obsidian');
  fs.utimesSync(path.join(root, 'a.md'), new Date(), new Date(Date.now() + 5000));
  throwsStatus(() => savePrompt('a.md', '3', { baseMtime: base }), 409);
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'edited in Obsidian');
  fs.rmSync(path.join(root, 'a.md'));
  throwsStatus(() => savePrompt('a.md', '4', { baseMtime: base }), 409);
  savePrompt('a.md', '5'); // no baseMtime = plain write (overwrite after the user chose it)
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), '5');
}));

test('prompts: only .md files, size cap, non-string body', () => withRoot(() => {
  throwsStatus(() => savePrompt('a.txt', 'x'), 400);
  throwsStatus(() => savePrompt('a.md', 5), 400);
  throwsStatus(() => savePrompt('a.md', 'x'.repeat(256 * 1024 + 1)), 400);
}));

test('prompts: move/rename never overwrites; folder cannot go into itself; case-only rename works', () => withRoot(() => {
  savePrompt('a.md', 'A');
  savePrompt('b.md', 'B');
  makeFolder('F');
  throwsStatus(() => movePrompt('a.md', 'b.md'), 409);
  movePrompt('a.md', 'F/a2.md');
  assert.deepEqual(listPrompts().items.map((i) => i.path), ['b.md', 'F/a2.md']);
  throwsStatus(() => movePrompt('F', 'F/G'), 400);
  throwsStatus(() => movePrompt('nope.md', 'x.md'), 404);
  throwsStatus(() => movePrompt('b.md', 'b.txt'), 400);
  movePrompt('F', 'Renamed');
  assert.deepEqual(listPrompts().folders, ['Renamed']);
  movePrompt('b.md', 'B.md');
  assert.ok(listPrompts().items.some((i) => i.path === 'B.md'));
}));

test('prompts: delete moves to .trash (file and folder), never unlinks, trash is not listed', () => withRoot((root) => {
  savePrompt('Acme/x.md', 'keep me');
  savePrompt('y.md', 'and me');
  const a = trashPrompt('y.md');
  const b = trashPrompt('Acme');
  assert.deepEqual(listPrompts().items, []);
  assert.deepEqual(listPrompts().folders, []);
  assert.equal(fs.readFileSync(path.join(root, a.trashed), 'utf8'), 'and me');
  assert.equal(fs.readFileSync(path.join(root, b.trashed, 'x.md'), 'utf8'), 'keep me');
  savePrompt('y.md', 'again');
  trashPrompt('y.md'); // same name in the same second still gets its own trash entry
  assert.equal(fs.readdirSync(path.join(root, '.trash')).length, 3);
  throwsStatus(() => trashPrompt('.trash'), 400);
  throwsStatus(() => trashPrompt('missing.md'), 404);
}));

test('prompts: a symlink that leaves the folder is refused for every operation', () => withRoot((root, dir) => {
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.md'), 'secret');
  savePrompt('seed.md', 'x');
  fs.symlinkSync(outside, path.join(root, 'link'));
  throwsStatus(() => savePrompt('link/new.md', 'x'));
  throwsStatus(() => makeFolder('link/sub'));
  throwsStatus(() => movePrompt('seed.md', 'link/seed.md'));
  throwsStatus(() => trashPrompt('link/secret.md'));
  assert.deepEqual(listPrompts().items.map((i) => i.path), ['seed.md']); // symlinked folder is not followed
  assert.deepEqual(fs.readdirSync(outside), ['secret.md']);
}));

test('prompt-text: frontmatter, placeholders, fill, render', () => {
  assert.equal(stripFrontmatter('---\ntags: [a]\n---\nBody\nmore'), 'Body\nmore');
  assert.equal(stripFrontmatter('no front matter\n---\nstill body'), 'no front matter\n---\nstill body');
  assert.equal(stripFrontmatter('---\nonly front\n---'), '');
  assert.deepEqual(placeholdersOf('Ticket {{ ticket }} and {{figma}} and {{ticket}} {{ {{bad}} }}'), ['ticket', 'figma', 'bad']);
  assert.deepEqual(placeholdersOf('none here {single} {{}}'), []);
  assert.equal(fill('A {{x}} B {{ x }} C {{y}}', { x: '1' }), 'A 1 B 1 C {{y}}');
  assert.equal(fill('{{x}}', { x: '$& $1' }), '$& $1'); // replacement text is literal
  assert.equal(render('---\nt: 1\n---\nDo {{x}}\n\n', { x: 'it' }), 'Do it');
});

test('prompt-text: toTerminalInput types the text, newline = ESC+CR, never submits', () => {
  assert.deepEqual(toTerminalInput('one line'), ['one line']);
  assert.deepEqual(toTerminalInput('a\nb\r\nc'), ['a\x1b\r', 'b\x1b\r', 'c']);
  assert.deepEqual(toTerminalInput('a\n\nb'), ['a\x1b\r', '\x1b\r', 'b']); // blank line kept
  assert.deepEqual(toTerminalInput('\tx\x03y\x1b[A'), ['    xy[A']); // tab -> spaces, controls dropped
  const joined = toTerminalInput('ünï ✓ `x` {{y}}\n/z').join('');
  assert.ok(!joined.replace(/\x1b\r/g, '').includes('\r'), 'no bare CR (would submit)');
  assert.equal(joined.replace(/\x1b\r/g, '\n'), 'ünï ✓ `x` {{y}}\n/z');
});

test('prompt-text: {{name|default}}',() => {
  assert.deepEqual(fieldsOf('Ticket {{ticket}} for {{ env | staging }} then {{env}} {{who|}} {{who| me }}'), [
    { name: 'ticket', def: undefined },
    { name: 'env', def: 'staging' },
    { name: 'who', def: 'me' },
  ]);
  assert.deepEqual(placeholdersOf('{{a|1}} {{a|2}} {{b}}'), ['a', 'b']);
  assert.deepEqual(fieldsOf('{{a|1}} {{a|2}}'), [{ name: 'a', def: '1' }]); // first default wins
  assert.equal(fill('{{env|staging}} / {{env}}', {}), 'staging / staging'); // not asked: default
  assert.equal(fill('{{env|staging}}', { env: 'prod' }), 'prod');
  assert.equal(fill('{{env|staging}} {{x}}', { env: '', x: '' }), ' {{x}}'); // cleared default = empty; no default = as written
  assert.equal(fill('{{a|x|y}}', {}), 'x|y'); // only the first | splits
  assert.equal(render('Go {{env|staging}}\n', { env: 'dev' }), 'Go dev');
});

test('prompts: Show in Finder only opens things inside the folder (fake opener, never spawns `open`)', () => withRootAsync(async (root, dir) => {
  const calls = [];
  const open = async (args) => { calls.push(args); };
  await assert.rejects(() => revealPrompt('', open), (e) => e instanceof PromptError && e.status === 404); // folder not created yet
  savePrompt('Acme/1 PRD.md', 'x');
  await revealPrompt('', open);
  await revealPrompt(undefined, open);
  await revealPrompt('Acme', open);
  await revealPrompt('Acme/1 PRD.md', open);
  assert.deepEqual(calls, [['--', root], ['--', root], ['--', path.join(root, 'Acme')], ['-R', '--', path.join(root, 'Acme', '1 PRD.md')]]);
  for (const bad of ['../x', '/etc', '.trash', 'a/../../b', 'missing.md']) {
    await assert.rejects(() => revealPrompt(bad, open), PromptError, bad);
  }
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'link'));
  await assert.rejects(() => revealPrompt('link', open), PromptError);
  assert.equal(calls.length, 4); // nothing refused was opened
}));

test('prompts: the list counts trash entries and the trash can be revealed', () => withRootAsync(async (root) => {
  const calls = [];
  const open = async (args) => { calls.push(args); };
  assert.equal(listPrompts().trash, 0);
  await assert.rejects(() => revealTrash(open), (e) => e instanceof PromptError && e.status === 404);
  savePrompt('a.md', 'x');
  savePrompt('F/b.md', 'y');
  trashPrompt('a.md');
  trashPrompt('F');
  assert.equal(listPrompts().trash, 2);
  assert.deepEqual(listPrompts().items, []); // trash entries are not prompts
  await revealTrash(open);
  assert.deepEqual(calls, [['--', path.join(root, '.trash')]]);
}));
