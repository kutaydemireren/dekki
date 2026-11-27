// The optional quality check-in script (templates/manager-root/.claude/scripts/quality-baseline.py): the setup installs it
// and records it in the manifest, it carries no private wording, its markers match what the template's scripts emit,
// and it runs read-only on a tiny made-up transcript folder. All data here is fabricated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { firstBanned } from './banlist.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = path.join(REPO, 'templates', 'manager-root', '.claude', 'scripts');
const REL = '.claude/scripts/quality-baseline.py';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dekki-quality-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const S = await import('../setup.js');

test('setup installs the script, executable, and records its hash in the manifest', () => {
  const root = path.join(tmp, 'work'); const docs = path.join(tmp, 'docs'); const home = path.join(tmp, 'home');
  for (const d of [root, docs, home]) fs.mkdirSync(d);
  const ctx = { state: { root, accounts: [], activeAccount: 'default' }, home, env: process.env };
  const r = S.applySetup({ docsDir: docs }, ctx);
  assert.equal(r.ok, true, r.error);
  assert.ok(r.created.includes(REL));
  assert.ok(fs.statSync(path.join(root, REL)).mode & 0o100, 'executable');
  const man = JSON.parse(fs.readFileSync(path.join(root, S.MANIFEST_REL), 'utf8'));
  assert.equal(man.files[REL], S.sha256(fs.readFileSync(path.join(SCRIPTS, 'quality-baseline.py'))));
  // never overwrites: an edited copy is kept
  fs.writeFileSync(path.join(root, REL), '# mine\n');
  const r2 = S.applySetup({ docsDir: docs }, ctx);
  assert.equal(r2.ok, true, r2.error);
  assert.equal(fs.readFileSync(path.join(root, REL), 'utf8'), '# mine\n');
});

test('script text: no private wording, markers match delegate.sh and check-report.sh', () => {
  const text = fs.readFileSync(path.join(SCRIPTS, 'quality-baseline.py'), 'utf8');
  assert.equal(firstBanned(text, { template: true }), null);
  const marks = [...text.matchAll(/^(WORKER_MARK|HOOK_MARK) = "(.*)"$/gm)];
  assert.equal(marks.length, 2);
  for (const [, name, mark] of marks) {
    const file = name === 'WORKER_MARK' ? 'delegate.sh' : 'check-report.sh';
    assert.ok(fs.readFileSync(path.join(SCRIPTS, file), 'utf8').includes(mark), `${mark} is not in ${file}`);
  }
});

const line = (o) => JSON.stringify(o) + '\n';
function transcript(cwd, day, first, final, extra = []) {
  return [
    line({ type: 'user', cwd, timestamp: `${day}T10:00:00Z`, message: { role: 'user', content: first } }),
    line({ type: 'assistant', cwd, timestamp: `${day}T10:01:00Z`, message: { id: 'm1', role: 'assistant', usage: { input_tokens: 10, output_tokens: 20 }, content: [{ type: 'text', text: final }] } }),
    ...extra,
  ].join('');
}

test('script runs read-only on a made-up transcript folder', () => {
  const root = path.join(tmp, 'mgr'); fs.mkdirSync(path.join(root, '.claude', 'scripts'), { recursive: true });
  const projects = path.join(tmp, 'projects'); fs.mkdirSync(path.join(projects, 'p1'), { recursive: true });
  const w = (n, body) => fs.writeFileSync(path.join(projects, 'p1', n), body);
  w('a.jsonl', transcript('/x/repo', '2026-01-05', 'Report contract: you are a worker. Do a thing.', 'result: done\nskills used: none\n---\nmore'));
  w('b.jsonl', transcript('/x/repo', '2026-01-06', 'Report contract: you are a worker. Do it.', 'result: done', [
    line({ type: 'user', timestamp: '2026-01-06T10:02:00Z', message: { role: 'user', content: 'no, that is wrong' } }),
  ]));
  w('c.jsonl', transcript(root, '2026-01-06', 'plan the work', 'ok', [
    line({ type: 'user', timestamp: '2026-01-06T10:03:00Z', message: { role: 'user', content: 'thanks' } }),
  ]));
  w('d.jsonl', 'not json\n{"type":"user","message":5}\n[1,2]\n'); // malformed: ignored
  w('old.jsonl', transcript('/x/repo', '2025-12-01', 'Report contract: you are a worker. Old.', 'failed: x'));
  const before = fs.readdirSync(path.join(projects, 'p1')).sort();
  const run = (...a) => spawnSync('python3', ['-I', path.join(SCRIPTS, 'quality-baseline.py'), '--root', root, '--projects', projects, ...a], { encoding: 'utf8' });
  const r = run('--since', '2026-01-01');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /worker sessions: 2/);
  assert.match(r.stdout, /result 2 \(100%\)/);
  assert.match(r.stdout, /with a correction-style phrase in follow-ups: 50%/);
  assert.match(r.stdout, /manager sessions: 1/);
  assert.match(r.stdout, /user messages \(first of each session excluded\): 1,/);
  assert.ok(r.stdout.split('\n').length < 20, 'short output');
  assert.notEqual(run('--since', 'nope').status, 0);
  assert.deepEqual(fs.readdirSync(path.join(projects, 'p1')).sort(), before, 'writes nothing');
});
