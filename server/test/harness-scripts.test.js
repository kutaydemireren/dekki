// The manager-folder template (templates/manager-root): wording hygiene, the marked blocks, and the scripts
// (delegate.sh, project-setup.sh, classify-change.sh, wait-worker.sh) run for real in a temp HOME against a stub `claude`.
// Never touches the user's own folders, agents or config.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = path.join(REPO, 'templates', 'manager-root');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dekki-harness-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { denied, pushProbe, renderSettings, validate } = await import(pathToFileURL(path.join(TEMPLATE, '.claude', 'scripts', 'harness.mjs')).href);

function listFiles(dir) {
  const out = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk : (p) => out.push(p))(path.join(d, e.name)); })(dir);
  return out;
}

// ---- hygiene -------------------------------------------------------------------------------------------------

test('template: no private or project-specific wording in any shipped file', () => {
  const words = /Canyon|Strava|ECLIPS|Jira|Lokalise|Apidog|Contentful|\biOS\b|\bAndroid\b|\bXcode|Swift|Kotlin|\bBLE\b|Bluetooth|firmware|SIMULATOR|Simulator|simulator|kdemireren|Kutay|\/Users\/|Obsidian|vault|caveman|voice-check|device-hygiene|WDD-/;
  const files = listFiles(TEMPLATE);
  assert.ok(files.length >= 19, `expected the full template, found ${files.length} files`);
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const m = words.exec(text);
    assert.equal(m, null, `${path.relative(TEMPLATE, f)} mentions "${m && m[0]}"`);
  }
});

test('template: shell scripts parse, are executable; python helper parses; JSON files parse', () => {
  const scripts = path.join(TEMPLATE, '.claude', 'scripts');
  for (const f of fs.readdirSync(scripts)) {
    const p = path.join(scripts, f);
    if (f.endsWith('.sh')) {
      assert.equal(spawnSync('bash', ['-n', p]).status, 0, `${f} does not parse`);
      assert.ok(fs.statSync(p).mode & 0o100, `${f} is not executable`);
    }
    if (f.endsWith('.mjs')) assert.equal(spawnSync('node', ['--check', p]).status, 0, `${f} does not parse`);
    if (f.endsWith('.json')) JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  JSON.parse(fs.readFileSync(path.join(TEMPLATE, '.claude', 'settings.local.json'), 'utf8'));
  JSON.parse(fs.readFileSync(path.join(TEMPLATE, '.claude', 'setup', 'blocks.json'), 'utf8'));
  assert.equal(spawnSync('python3', ['-I', '-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', path.join(scripts, 'voice-metrics.py')]).status, 0);
});

test('playbook: three marked blocks, project setup and tier sections, no stale references', () => {
  const md = fs.readFileSync(path.join(TEMPLATE, 'CLAUDE.md'), 'utf8');
  for (const b of ['preferences', 'guardrails', 'docs']) {
    const start = `<!-- setup:${b}:start -->`; const end = `<!-- setup:${b}:end -->`;
    assert.equal(md.split(start).length, 2, `${b} start marker appears once`);
    assert.equal(md.split(end).length, 2, `${b} end marker appears once`);
    const body = md.slice(md.indexOf(start) + start.length, md.indexOf(end)).trim();
    assert.ok(body.length > 20, `${b} block has empty-state text`);
  }
  for (const h of ['## Project setup', '## Verification tiers', '## Guardrails', '## Delegating', '## Work across projects', '## Asking the user', '## How requests arrive', '## Project map', '## Writing voice']) assert.ok(md.includes(h), h);
  assert.ok(md.includes('first-time setup for <project>'));
  assert.ok(md.includes('project-setup.sh'));
  assert.ok(md.includes('VISUAL=required'));
  assert.ok(md.length > 14000, 'playbook stays full size');
  // every script the playbook names exists in the template
  for (const s of new Set(md.match(/\.claude\/scripts\/[a-z-]+\.(sh|py|mjs)/g))) assert.ok(fs.existsSync(path.join(TEMPLATE, s)), `${s} is named in the playbook but missing`);
});

test('blocks.json: the keys the wizard needs, only the agreed placeholders', () => {
  const b = JSON.parse(fs.readFileSync(path.join(TEMPLATE, '.claude', 'setup', 'blocks.json'), 'utf8'));
  const keys = { 'preferences.replyStyle': ['short', 'detailed'], 'preferences.autonomy': ['outward', 'ask-all', 'rare'], 'preferences.prs': ['me', 'workers-draft'], 'preferences.language': ['same', 'custom'], guardrails: ['neverTouch', 'secretsDir'] };
  for (const [k, subs] of Object.entries(keys)) {
    const node = k.split('.').reduce((o, p) => o[p], b);
    for (const s of subs) assert.equal(typeof node[s], 'string', `${k}.${s}`);
  }
  assert.equal(typeof b.docs, 'string');
  const allowed = new Set(['{{language}}', '{{text}}', '{{path}}', '{{docsDir}}']);
  const found = JSON.stringify(b).match(/\{\{[^}]*\}\}/g) || [];
  for (const p of found) assert.ok(allowed.has(p), `unexpected placeholder ${p}`);
  assert.ok(b.preferences.language.custom.includes('{{language}}'));
  assert.ok(b.guardrails.neverTouch.includes('{{text}}'));
  assert.ok(b.guardrails.secretsDir.includes('{{path}}'));
  assert.ok(b.docs.includes('{{docsDir}}'));
});

test('docs templates: the five docs plus the index, placeholders only {{project}} and {{date}}, sizes', () => {
  const dir = path.join(TEMPLATE, '.claude', 'docs-templates');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['DECISIONS.md', 'INBOX.md', 'LOG.md', 'README.md', 'SPEC.md', 'START-HERE.md']);
  for (const f of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const p of text.match(/\{\{[^}]*\}\}/g) || []) assert.ok(['{{project}}', '{{date}}'].includes(p), `${f}: ${p}`);
    assert.ok(text.length < 4000 || f === 'README.md', `${f} stays a short starter`);
  }
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  for (const needle of ['20 KB', '25 KB', 'newest 5 entries', 'archive/DECISIONS-archive.md', 'Status', 'same session', 'A fact lives in one place']) assert.ok(readme.includes(needle), needle);
});

// ---- scripts in a temp root ----------------------------------------------------------------------------------

const stubBin = path.join(tmp, 'bin');
fs.mkdirSync(stubBin);
fs.writeFileSync(path.join(stubBin, 'claude'), `#!/bin/bash
if [ "$1" = agents ]; then echo "\${STUB_AGENTS:-[]}"; exit 0; fi
if [ -n "$STUB_FAIL" ]; then echo "$STUB_FAIL"; exit 1; fi
printf '%s\\0' "$@" > "$STUB_ARGS"
echo "PWD=$PWD" > "$STUB_ARGS.pwd"
echo "claude attach \${STUB_NEW_ID:-0123abcd}"
`, { mode: 0o755 });

let counter = 0;
/** A fresh copy of the template as a manager folder with one project; optional harness.json. */
function makeRoot(config) {
  const base = path.join(tmp, `case${++counter}`);
  const root = path.join(base, 'work dir');
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(TEMPLATE, root, { recursive: true });
  fs.mkdirSync(path.join(root, 'proj'));
  spawnSync('git', ['init', '-q', path.join(root, 'proj')]);
  fs.mkdirSync(path.join(root, 'scratch'));
  const docs = path.join(base, 'docs');
  fs.mkdirSync(docs);
  const secrets = path.join(base, 'secrets');
  fs.mkdirSync(secrets);
  const cfg = typeof config === 'function' ? config({ root, docs, secrets }) : config;
  if (cfg) fs.writeFileSync(path.join(root, '.claude', 'harness.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg, null, 2));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const args = path.join(base, 'args');
  const env = { PATH: `${stubBin}:${process.env.PATH}`, HOME: home, CLAUDE_CONFIG_DIR: path.join(base, 'cfg'), CLAUDE_JOB_DIR: '', STUB_ARGS: args, LANG: 'C' };
  return { base, root, docs, secrets, env, args };
}
const run = (c, script, args = [], opts = {}) => spawnSync(path.join(c.root, '.claude', 'scripts', script), args, { cwd: c.root, env: { ...c.env, ...(opts.env || {}) }, encoding: 'utf8', input: opts.input });
const claudeArgs = (c) => fs.readFileSync(c.args, 'utf8').split('\0').slice(0, -1);
const claudeCalled = (c) => fs.existsSync(c.args);
const fullConfig = ({ docs, secrets }) => ({
  version: 1, docsDir: docs, protectedBranches: ['main', 'master', 'develop'], neverTouch: 'the billing service and live accounts', secretsDir: secrets,
  preferences: { replyStyle: 'short', autonomy: 'outward', prs: 'me', language: 'same' },
  projects: { proj: { setupAt: '2026-01-01', checks: { build: 'npm run build', lint: 'npm run lint', testScoped: 'npm test -- {files}', testFull: 'npm test' }, sensitivePaths: ['^db/'], uiPaths: ['\\.html$'], visualProof: 'a browser screenshot' } },
});
const settingsOf = (c) => JSON.parse(fs.readFileSync(path.join(c.root, '.claude', 'worker-settings.json'), 'utf8'));

test('delegate.sh with a config: the brief gets guardrails, docs path and checks; docs folder is added; deny rules follow the branches', () => {
  const c = makeRoot((p) => ({ ...fullConfig(p), protectedBranches: ['main', 'release/1.0'] }));
  const r = run(c, 'delegate.sh', ['proj', 'do the thing', '--name', 'x']);
  assert.equal(r.status, 0, r.stderr);
  const args = claudeArgs(c);
  const brief = args[args.length - 1];
  assert.ok(brief.startsWith('do the thing'));
  assert.match(brief, /Never touch: the billing service and live accounts/);
  assert.match(brief, /files under .*secrets are there for you to USE, never to read/);
  assert.match(brief, /Never push to main, release\/1\.0; never force-push; never merge/);
  assert.ok(brief.includes(`${c.docs}/proj/`), 'docs path for the project');
  assert.ok(brief.includes(`${c.docs}/README.md`));
  assert.match(brief, /read START-HERE\.md and the newest LOG\.md entry/);
  assert.match(brief, /- Build: npm run build/);
  assert.match(brief, /- Lint: npm run lint/);
  assert.match(brief, /- Scoped tests: npm test -- \{files\}/);
  assert.match(brief, /- Full tests: npm test\n/);
  assert.match(brief, /Visual proof for changes people can see: a browser screenshot/);
  assert.match(brief, /Report contract/);
  assert.match(brief, /\n---\n<details:/);
  assert.ok(brief.indexOf('Harness rules') < brief.indexOf('Report contract'));
  // the docs folder is passed before the next flag (the option takes a list)
  const i = args.indexOf('--add-dir');
  assert.ok(i >= 0 && args[i + 1] === c.docs && args[i + 2].startsWith('--'), args.join(' | '));
  assert.equal(args[args.indexOf('--settings') + 1], path.join(c.root, '.claude', 'worker-settings.json'));
  assert.equal(fs.readFileSync(`${c.args}.pwd`, 'utf8').trim(), `PWD=${path.join(c.root, 'proj')}`);
  // deny rules: every protected branch, nothing for a branch that is not protected, a named feature branch stays allowed
  const rules = settingsOf(c).permissions.deny;
  assert.ok(rules.includes('Bash(git push)') && rules.includes('Bash(git push -f*)') && rules.includes('Bash(git push * HEAD)'));
  for (const b of ['main', 'release/1.0']) for (const form of [`Bash(git push * ${b})`, `Bash(git push * ${b} *)`, `Bash(git push * *:${b})`, `Bash(git push * *refs/heads/${b}*)`]) assert.ok(rules.includes(form), form);
  assert.ok(!rules.some((x) => x.includes('develop')), 'develop is not protected in this config');
  assert.ok(!rules.some((x) => x.includes('__BRANCH__')));
  assert.deepEqual(pushProbe(rules, ['main', 'release/1.0']), []);
  for (const cmd of ['git push origin main', 'git push -u origin main', 'git push origin HEAD:main', 'git push origin HEAD:refs/heads/release/1.0', 'git push origin +main', 'git push --force origin feature/x', 'git push']) assert.ok(denied(rules, cmd), `should deny: ${cmd}`);
  for (const cmd of ['git push -u origin feature/login', 'git push -u origin worktree-docs-fix', 'git push -u origin feature/main-menu', 'git push -u origin develop']) assert.ok(!denied(rules, cmd), `should allow: ${cmd}`);
  // secrets folder: reading is denied, using is not blocked by a rule on the folder name alone
  assert.ok(rules.some((x) => x.startsWith('Read(/') && x.includes(c.secrets)));
  assert.ok(rules.includes(`Bash(cat *${c.secrets}/*)`));
  // the Stop hook points at this root (path with a space)
  assert.ok(settingsOf(c).hooks.Stop[0].hooks[0].command.includes(`'${c.root}/.claude/scripts/check-report.sh'`));
  assert.ok(!r.stderr.includes('no settings'), 'a configured project does not warn');
  // the delegation is logged
  assert.match(fs.readFileSync(path.join(c.root, '.claude', 'delegations.log'), 'utf8'), /proj-x\tproj\tdo the thing/);
});

test('delegate.sh: a project without settings warns on stderr, still starts, and gets guardrails and docs but no checks', () => {
  const c = makeRoot((p) => ({ ...fullConfig(p), projects: {} }));
  const r = run(c, 'delegate.sh', ['proj', 'brief']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /warning: proj has no settings in \.claude\/harness\.json yet\. Run the first-time project setup/);
  const brief = claudeArgs(c).pop();
  assert.match(brief, /Never touch: /);
  assert.ok(brief.includes(`${c.docs}/proj/`));
  assert.doesNotMatch(brief, /Checks for this project/);
});

test('delegate.sh: an old root without harness.json behaves as before (defaults, no extra text, no --add-dir, no warning)', () => {
  const c = makeRoot(null);
  const r = run(c, 'delegate.sh', ['proj', 'old style brief', '--name', 'y', '--effort', 'high']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /warning/);
  const args = claudeArgs(c);
  const brief = args.pop();
  assert.ok(brief.startsWith('old style brief\n\n---\nReport contract'));
  assert.doesNotMatch(brief, /Harness rules/);
  assert.ok(!args.includes('--add-dir'));
  assert.deepEqual(args.slice(0, 7), ['--bg', '--name', 'proj-y', '--effort', 'high', '--settings', path.join(c.root, '.claude', 'worker-settings.json')]);
  assert.ok(args.includes('--permission-mode') && args.includes('auto'));
  const rules = settingsOf(c).permissions.deny;
  for (const b of ['main', 'master', 'develop']) assert.ok(denied(rules, `git push -u origin ${b}`) && denied(rules, `git push origin HEAD:${b}`), b);
  assert.ok(!denied(rules, 'git push -u origin feature/x'));
  assert.ok(!rules.some((x) => x.startsWith('Read(')), 'no secrets folder, no read rules');
  // --check works on an old root too: a note, no problem
  const k = run(c, 'delegate.sh', ['--check']);
  assert.equal(k.status, 0, k.stdout);
  assert.match(k.stdout, /warn: no \.claude\/harness\.json: running with defaults/);
  assert.match(k.stdout, /check passed/);
});

function resumeRoot() {
  const c = makeRoot(fullConfig);
  fs.mkdirSync(path.join(c.env.CLAUDE_CONFIG_DIR, 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(c.env.CLAUDE_CONFIG_DIR, 'projects', 'p', '0123abcd-full-session.jsonl'), '');
  c.env.CLAUDE_JOB_DIR = path.join(c.base, 'jobs', 'deadbeef');
  return c;
}
const linksOf = (c) => { try { return fs.readFileSync(path.join(c.env.HOME, '.dekki', 'links.tsv'), 'utf8'); } catch { return ''; } };

test('delegate.sh --resume without flags continues the same session: no --effort, --settings or --permission-mode, no copy note, no link', () => {
  const c = resumeRoot();
  const r = run(c, 'delegate.sh', ['--resume', '0123abcd', 'proj', 'follow up']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(claudeArgs(c), ['--bg', '--resume', '0123abcd-full-session', 'follow up']);
  assert.doesNotMatch(r.stderr, /COPY/);
  assert.equal(linksOf(c), '', 'the same id is already linked');
  assert.match(fs.readFileSync(path.join(c.root, '.claude', 'delegations.log'), 'utf8'), /\tresume\t0123abcd\tfollow up/);
});

test('delegate.sh --resume --effort starts a copy: auto mode, deny rules and effort passed, a note, and the new id linked', () => {
  const c = resumeRoot();
  const r = run(c, 'delegate.sh', ['--resume', '0123abcd', 'proj', 'follow up', '--effort', 'high'], { env: { STUB_NEW_ID: 'feedbeef' } });
  assert.equal(r.status, 0, r.stderr);
  const args = claudeArgs(c);
  assert.ok(args.includes('--resume') && args[args.indexOf('--resume') + 1] === '0123abcd-full-session');
  assert.equal(args[args.length - 1], 'follow up');
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'auto');
  assert.equal(args[args.indexOf('--settings') + 1], path.join(c.root, '.claude', 'worker-settings.json'));
  assert.match(r.stderr, /note: --effort starts a COPY of 0123abcd/);
  assert.match(linksOf(c), /^feedbeef\tdeadbeef\t/);
  assert.doesNotMatch(linksOf(c), /0123abcd/);
});

test('delegate.sh --resume rejects an unknown effort level only when --effort is given', () => {
  const c = resumeRoot();
  const r = run(c, 'delegate.sh', ['--resume', '0123abcd', 'proj', 'x', '--effort', 'ultra']);
  assert.equal(r.status, 2);
  assert.equal(claudeCalled(c), false);
});

test('delegate.sh refuses a broken config and unsafe project names, and does not start claude', () => {
  const bad = makeRoot('{ not json');
  let r = run(bad, 'delegate.sh', ['proj', 'x']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not valid JSON/);
  assert.equal(claudeCalled(bad), false);
  const wrong = makeRoot((p) => ({ ...fullConfig(p), version: 2 }));
  r = run(wrong, 'delegate.sh', ['proj', 'x']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /version must be 1/);
  assert.equal(claudeCalled(wrong), false);
  const c = makeRoot(fullConfig);
  for (const name of ['../proj', '.hidden', '-x', 'a/b', 'a..b', 'p;rm']) {
    r = run(c, 'delegate.sh', [name, 'x']);
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, /Not a usable project folder name/);
  }
  r = run(c, 'delegate.sh', ['nonexistent', 'x']);
  assert.match(r.stderr, /No such project folder/);
  r = run(c, 'delegate.sh', ['scratch', 'x']);
  assert.match(r.stderr, /not a repo or Claude project/);
  assert.equal(claudeCalled(c), false);
});

test('delegate.sh --check: passes on a good config, prints the appended text, never calls claude', () => {
  const c = makeRoot(fullConfig);
  const r = run(c, 'delegate.sh', ['--check', 'proj']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ok: \.claude\/harness\.json is valid/);
  assert.match(r.stdout, /ok: docs folder .* exists and is writable/);
  assert.match(r.stdout, /ok: rendered \.claude\/worker-settings\.json/);
  assert.match(r.stdout, /ok: deny rules refuse git push to main, master, develop and allow a named feature branch/);
  assert.match(r.stdout, /--- text appended to a brief for proj ---/);
  assert.match(r.stdout, /- Build: npm run build/);
  assert.match(r.stdout, /check passed/);
  assert.equal(claudeCalled(c), false);
  assert.ok(fs.existsSync(path.join(c.root, '.claude', 'worker-settings.json')));
  assert.equal(run(c, 'delegate.sh', ['--check']).status, 0);
  // an unknown project is a problem
  const u = run(c, 'delegate.sh', ['--check', 'nope']);
  assert.notEqual(u.status, 0);
  assert.match(u.stdout, /problem: no project folder named nope/);
});

test('delegate.sh --check fails correctly: bad version, docs inside the working folder, missing docs folder, bad branch, bad regex, broken deny template', () => {
  const cases = [
    ['version', (p) => ({ ...fullConfig(p), version: 3 }), /problem: version must be 1/],
    ['docs inside root', (p) => ({ ...fullConfig(p), docsDir: path.join(p.root, 'notes') }), /problem: docsDir must be outside the working folder/],
    ['docs equal root', (p) => ({ ...fullConfig(p), docsDir: p.root }), /problem: docsDir must be outside the working folder/],
    ['docs missing', (p) => ({ ...fullConfig(p), docsDir: path.join(p.docs, 'nope') }), /problem: docs folder .* does not exist or is not writable/],
    ['docs relative', (p) => ({ ...fullConfig(p), docsDir: 'relative/dir' }), /problem: docsDir must be an absolute path/],
    ['docs not set', (p) => { const c = fullConfig(p); delete c.docsDir; return c; }, /problem: docsDir is not set/],
    ['branch with glob', (p) => ({ ...fullConfig(p), protectedBranches: ['main', 'a*b'] }), /problem: protectedBranches: not a usable branch name: "a\*b"/],
    ['branch not a list', (p) => ({ ...fullConfig(p), protectedBranches: 'main' }), /problem: protectedBranches must be a list/],
    ['secrets with parens', (p) => ({ ...fullConfig(p), secretsDir: '/tmp/a (b)' }), /problem: secretsDir must not contain/],
    ['bad regex', (p) => { const c = fullConfig(p); c.projects.proj.sensitivePaths = ['(unclosed']; return c; }, /problem: projects\.proj\.sensitivePaths: not a valid extended regex/],
    ['unsafe project key', (p) => { const c = fullConfig(p); c.projects['../x'] = {}; return c; }, /problem: projects: unsafe folder name "\.\.\/x"/],
    ['bad preference', (p) => ({ ...fullConfig(p), preferences: { autonomy: 'always' } }), /problem: preferences\.autonomy must be one of/],
    ['broken json', () => '{"version": 1,', /problem: \.claude\/harness\.json is not valid JSON/],
  ];
  for (const [name, cfg, re] of cases) {
    const c = makeRoot(cfg);
    const r = run(c, 'delegate.sh', ['--check']);
    assert.notEqual(r.status, 0, name);
    assert.match(r.stdout, re, name);
    assert.match(r.stdout, /check failed: \d+ problems?/, name);
    assert.equal(claudeCalled(c), false, name);
  }
  // deny template that lost its branch rules: the probe catches it
  const c = makeRoot(fullConfig);
  const tplPath = path.join(c.root, '.claude', 'scripts', 'worker-deny.json');
  const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
  tpl.permissions.deny = tpl.permissions.deny.filter((x) => !x.includes('__BRANCH__'));
  fs.writeFileSync(tplPath, JSON.stringify(tpl));
  const r = run(c, 'delegate.sh', ['--check']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /problem: deny rules do not refuse: git push origin main/);
  // a template without the files at all
  fs.rmSync(tplPath);
  assert.notEqual(run(c, 'delegate.sh', ['--check']).status, 0);
});

test('validate()/pushProbe() unit checks', () => {
  const root = path.join(tmp, 'unit-root');
  fs.mkdirSync(root, { recursive: true });
  assert.deepEqual(validate({ version: 1 }, root), []);
  assert.ok(validate({ version: 1, projects: { 'a b': { checks: { build: 'x', oops: 'y' } } } }, root).some((p) => p.includes('unknown check')));
  assert.ok(validate({ version: 1, projects: { x: { checks: { build: 'a\nb' } } } }, root).some((p) => p.includes('one-line')));
  const rules = ['Bash(git push)'];
  assert.ok(pushProbe(rules, ['main']).length > 0);
  assert.ok(denied(['Bash(git push * main)'], 'git push origin main'));
  assert.ok(!denied(['Bash(git push * main)'], 'git push origin feature/main-menu'));
  const s = renderSettings(path.join(TEMPLATE), { protectedBranches: ['trunk'] });
  assert.ok(s.permissions.deny.includes('Bash(git push * trunk)'));
  assert.ok(!s.permissions.deny.includes('Bash(git push * main)'));
});

// ---- project-setup.sh ----------------------------------------------------------------------------------------

test('project-setup.sh: saves the settings, creates the docs from the templates, never overwrites, merges a re-run', () => {
  const c = makeRoot((p) => ({ ...fullConfig(p), projects: { other: { setupAt: '2025-12-01', checks: { build: 'make' } } }, extraKey: { keep: true } }));
  const r = run(c, 'project-setup.sh', ['proj', '--build', 'npm run build', '--lint', 'npm run lint', '--test-scoped', 'npm test -- {files}', '--test-full', 'npm test', '--sensitive', '^db/', '--sensitive', 'secrets', '--ui', '\\.html$', '--visual', 'a browser screenshot']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /project settings saved for proj/);
  assert.match(r.stdout, /build: npm run build/);
  assert.match(r.stdout, /sensitive paths: \^db\/ {2}\| {2}secrets/);
  assert.ok(r.stdout.includes(`created ${c.docs}/proj/START-HERE.md`));
  assert.ok(r.stdout.includes(`created ${c.docs}/README.md`));
  const cfg = JSON.parse(fs.readFileSync(path.join(c.root, '.claude', 'harness.json'), 'utf8'));
  assert.deepEqual(cfg.projects.proj.checks, { build: 'npm run build', lint: 'npm run lint', testScoped: 'npm test -- {files}', testFull: 'npm test' });
  assert.deepEqual(cfg.projects.proj.sensitivePaths, ['^db/', 'secrets']);
  assert.deepEqual(cfg.projects.proj.uiPaths, ['\\.html$']);
  assert.equal(cfg.projects.proj.visualProof, 'a browser screenshot');
  assert.match(cfg.projects.proj.setupAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(cfg.projects.other, { setupAt: '2025-12-01', checks: { build: 'make' } }, 'other projects untouched');
  assert.deepEqual(cfg.extraKey, { keep: true }, 'unknown keys survive');
  assert.deepEqual(fs.readdirSync(path.dirname(path.join(c.root, '.claude', 'harness.json'))).filter((f) => f.endsWith('.tmp')), [], 'no temp file left');
  for (const f of ['START-HERE.md', 'SPEC.md', 'DECISIONS.md', 'LOG.md', 'INBOX.md']) {
    const text = fs.readFileSync(path.join(c.docs, 'proj', f), 'utf8');
    assert.ok(text.includes('proj'), f);
    assert.doesNotMatch(text, /\{\{/, `${f} has no placeholder left`);
  }
  assert.ok(fs.statSync(path.join(c.docs, 'proj', 'archive')).isDirectory());
  assert.ok(fs.readFileSync(path.join(c.docs, 'README.md'), 'utf8').startsWith('# Project docs'));
  assert.ok(fs.statSync(path.join(c.docs, 'proj', 'START-HERE.md')).size < 4096);
  // the saved settings are valid for the other scripts
  assert.equal(run(c, 'delegate.sh', ['--check', 'proj']).status, 0);

  // re-run: edited docs stay, only the given fields change, others keep their value, "" clears
  fs.writeFileSync(path.join(c.docs, 'proj', 'LOG.md'), 'my own log\n');
  const again = run(c, 'project-setup.sh', ['proj', '--lint', 'eslint .', '--visual', '']);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(again.stdout.includes(`left alone ${c.docs}/proj/LOG.md`));
  assert.equal(fs.readFileSync(path.join(c.docs, 'proj', 'LOG.md'), 'utf8'), 'my own log\n');
  const cfg2 = JSON.parse(fs.readFileSync(path.join(c.root, '.claude', 'harness.json'), 'utf8'));
  assert.equal(cfg2.projects.proj.checks.lint, 'eslint .');
  assert.equal(cfg2.projects.proj.checks.build, 'npm run build');
  assert.equal(cfg2.projects.proj.visualProof, undefined);
  assert.deepEqual(cfg2.projects.proj.sensitivePaths, ['^db/', 'secrets']);
  assert.equal(cfg2.projects.proj.setupAt, cfg.projects.proj.setupAt);
});

test('project-setup.sh refuses unknown folders, unsafe names, bad input and a missing config or docs folder', () => {
  const c = makeRoot((p) => ({ ...fullConfig(p), projects: {} }));
  const before = fs.readFileSync(path.join(c.root, '.claude', 'harness.json'), 'utf8');
  const fails = (args, re) => { const r = run(c, 'project-setup.sh', args); assert.notEqual(r.status, 0, args.join(' ')); assert.match(r.stderr, re, args.join(' ')); };
  fails(['nope', '--build', 'x'], /no project folder named nope/);
  for (const n of ['../proj', '.git', '-rf', 'a/b', 'a..b', '$(id)', 'a;b', 'proj\nx']) fails([n, '--build', 'x'], /Not a usable project folder name|unsafe project name/);
  fails(['proj', '--bogus', 'x'], /unknown option --bogus/);
  fails(['proj', '--build'], /--build needs a value/);
  fails(['proj', '--sensitive', '(unclosed'], /not a valid extended regex/);
  fails(['proj', '--build', 'a\nb'], /must be one line/);
  assert.equal(fs.readFileSync(path.join(c.root, '.claude', 'harness.json'), 'utf8'), before, 'a refused run changes nothing');
  assert.deepEqual(fs.readdirSync(c.docs), [], 'a refused run creates no docs');
  assert.notEqual(run(c, 'project-setup.sh', []).status, 0);
  // not a git repo is fine for setup (the folder just has to exist)
  assert.equal(run(c, 'project-setup.sh', ['scratch', '--build', 'make']).status, 0);
  // no config
  const old = makeRoot(null);
  let r = run(old, 'project-setup.sh', ['proj', '--build', 'x']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no \.claude\/harness\.json: run the setup wizard/);
  // docs folder gone
  const gone = makeRoot(fullConfig);
  fs.rmSync(gone.docs, { recursive: true });
  r = run(gone, 'project-setup.sh', ['proj', '--build', 'x']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /docs folder does not exist/);
  // a root path with a space and a project name with a space both work
  const sp = makeRoot(fullConfig);
  fs.mkdirSync(path.join(sp.root, 'my app'));
  r = run(sp, 'project-setup.sh', ['my app', '--build', 'make']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(sp.docs, 'my app', 'START-HERE.md')));
});

// ---- classify-change.sh --------------------------------------------------------------------------------------

const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (dir, ...a) => { const r = spawnSync('git', ['-C', dir, ...a], { env: { ...process.env, ...gitEnv }, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
const lines = (n, f = (i) => `const value${i} = compute(${i});`) => Array.from({ length: n }, (_, i) => f(i)).join('\n') + '\n';

/** A synthetic project repo inside a manager folder with settings; `files` is the committed baseline. */
function makeRepo(files, config = fullConfig) {
  const c = makeRoot(config);
  const dir = path.join(c.root, 'proj');
  fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  spawnSync('git', ['init', '-q', '-b', 'main', dir]);
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  git(dir, 'add', '-A'); git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base');
  return { c, dir };
}
const write = (dir, f, text) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };
const classify = (c, dir, args = []) => run(c, 'classify-change.sh', [dir, ...args], { env: gitEnv });

test('classify-change: docs only -> tier 0, no visual', () => {
  const { c, dir } = makeRepo({ 'README.md': '# a\n', 'src/app.js': lines(30) });
  write(dir, 'README.md', '# a\nmore words\n');
  write(dir, 'notes.txt', 'new note\n');
  const r = classify(c, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^TIER=0 UI=no VISUAL=no\n/);
  assert.match(r.stdout, /only docs\/assets changed/);
  assert.match(r.stdout, /verify: nothing to run/);
});

test('classify-change: empty diff -> tier 0', () => {
  const { c, dir } = makeRepo({ 'src/app.js': lines(5) });
  assert.match(classify(c, dir).stdout, /^TIER=0 UI=no VISUAL=no\n- empty diff/);
});

test('classify-change: mostly removal -> tier 1, with the project\'s commands', () => {
  const { c, dir } = makeRepo({ 'src/app.js': lines(40) });
  write(dir, 'src/app.js', lines(40).split('\n').slice(0, 25).join('\n') + '\n');
  const r = classify(c, dir);
  assert.match(r.stdout, /^TIER=1 UI=no VISUAL=no\n/);
  assert.match(r.stdout, /mostly removal: \+0\/-15/);
  assert.match(r.stdout, /verify: the floor/);
  assert.match(r.stdout, /  build: npm run build\n  lint: npm run lint/);
  assert.doesNotMatch(r.stdout, /scoped tests|full tests/);
});

test('classify-change: real logic -> tier 2 with scoped tests; new code file counts', () => {
  const { c, dir } = makeRepo({ 'src/app.js': lines(10) });
  write(dir, 'src/app.js', lines(10) + 'function added(x) {\n  if (x) return 1;\n  return 2;\n}\n');
  let r = classify(c, dir);
  assert.match(r.stdout, /^TIER=2 UI=no VISUAL=no\n/);
  assert.match(r.stdout, /added declarations\/control flow in: src\/app\.js/);
  assert.match(r.stdout, /  scoped tests: npm test -- \{files\}/);
  assert.doesNotMatch(r.stdout, /full tests/);
  git(dir, 'checkout', '-q', '--', '.');
  write(dir, 'src/new.js', 'export const a = 1;\n');
  r = classify(c, dir);
  assert.match(r.stdout, /^TIER=2 /);
  assert.match(r.stdout, /1 new code file/);
});

test('classify-change: test files only -> tier 2', () => {
  const { c, dir } = makeRepo({ 'src/app.js': lines(5), 'test/app.test.js': 'x\n' });
  write(dir, 'test/app.test.js', 'x\n' + lines(6));
  assert.match(classify(c, dir).stdout, /^TIER=2 UI=no VISUAL=no\n- test files only/);
});

test('classify-change: sensitive paths -> tier 3 (built-in manifests, CI, auth-like names, and the project\'s own regex)', () => {
  const base = { 'src/app.js': lines(5), 'package.json': '{"name":"a"}\n', 'db/schema.sql': 'x\n', 'src/auth/session.js': 'x\n', '.github/workflows/ci.yml': 'a: 1\n', 'src/auth.test.js': 'x\n', 'lib/Authors.js': 'x\n' };
  const cases = [['package.json', '{"name":"b"}\n', 'package.json'], ['.github/workflows/ci.yml', 'a: 2\n', 'ci.yml'], ['src/auth/session.js', 'x\ny\n', 'src/auth/session.js'], ['db/schema.sql', 'x\ny\n', 'db/schema.sql']];
  for (const [f, text, hit] of cases) {
    const { c, dir } = makeRepo(base);
    write(dir, f, text);
    const r = classify(c, dir);
    assert.match(r.stdout, /^TIER=3 /, f);
    assert.ok(r.stdout.includes(`sensitive path: ${f}`) || r.stdout.includes(hit), f);
    assert.match(r.stdout, /  full tests: npm test/, f);
  }
  // a name that merely starts with a risky word is not sensitive; a sensitive-looking TEST file is not either
  const { c, dir } = makeRepo(base);
  write(dir, 'lib/Authors.js', 'x\nfunction a() {}\n');
  assert.match(classify(c, dir).stdout, /^TIER=2 /);
  write(dir, 'src/auth.test.js', 'x\ny\n');
  assert.match(classify(c, dir).stdout, /^TIER=2 /);
});

test('classify-change: large change -> tier 3 (many lines, many files)', () => {
  const { c, dir } = makeRepo({ 'src/app.js': lines(5) });
  write(dir, 'src/big.js', lines(200));
  let r = classify(c, dir);
  assert.match(r.stdout, /^TIER=3 /);
  assert.match(r.stdout, /large change: 200 added code lines in 1 code files/);
  git(dir, 'clean', '-fdq');
  for (let i = 0; i < 13; i++) write(dir, `src/f${i}.js`, 'a = 1\n');
  r = classify(c, dir);
  assert.match(r.stdout, /^TIER=3 /);
  assert.match(r.stdout, /large change: 13 added code lines in 13 code files/);
});

test('classify-change: UI paths from the config -> UI=yes, VISUAL=required from tier 2', () => {
  const { c, dir } = makeRepo({ 'web/page.html': '<p>a</p>\n', 'src/app.js': lines(5) });
  write(dir, 'web/page.html', '<p>a</p>\n<h1>Title</h1>\n');
  let r = classify(c, dir);
  assert.match(r.stdout, /^TIER=2 UI=yes VISUAL=required\n/);
  assert.match(r.stdout, /added markup, style or text in UI files: web\/page\.html/);
  assert.match(r.stdout, /UI-visible files: web\/page\.html/);
  assert.match(r.stdout, /verify: also produce the visual proof of the changed screen: a browser screenshot\./);
  // removal in a UI file stays tier 1, no visual proof needed
  write(dir, 'web/page.html', '');
  git(dir, 'checkout', '-q', '--', '.');
  const big = lines(30, (i) => `<li>${i}</li>`);
  write(dir, 'web/page.html', big);
  git(dir, '-c', 'commit.gpgsign=false', 'commit', '-qam', 'more');
  write(dir, 'web/page.html', big.split('\n').slice(0, 10).join('\n') + '\n');
  r = classify(c, dir);
  assert.match(r.stdout, /^TIER=1 UI=yes VISUAL=no\n/);
  // without the project's UI paths nothing is UI-visible
  const noUi = makeRepo({ 'web/page.html': '<p>a</p>\n' }, (p) => { const f = fullConfig(p); f.projects.proj.uiPaths = []; return f; });
  write(noUi.dir, 'web/page.html', '<p>a</p>\n<h1>Title</h1>\n');
  assert.match(classify(noUi.c, noUi.dir).stdout, /^TIER=2 UI=no VISUAL=no\n/);
});

test('classify-change: a commit, a range, and a worktree elsewhere with --project', () => {
  const { c, dir } = makeRepo({ 'src/app.js': lines(5) });
  write(dir, 'package.json', '{}\n');
  git(dir, 'add', '-A'); git(dir, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'deps');
  assert.match(classify(c, dir, ['HEAD']).stdout, /^TIER=3 /);
  assert.match(classify(c, dir, ['HEAD~1..HEAD']).stdout, /^TIER=3 /);
  // a copy outside the manager folder: the project comes from --project, not from the path
  const outside = path.join(c.base, 'elsewhere');
  fs.cpSync(dir, outside, { recursive: true });
  write(outside, 'src/app.js', lines(5) + 'function x() { return 1; }\n');
  const without = classify(c, outside);
  assert.match(without.stdout, /^TIER=2 UI=no/);
  assert.match(without.stderr, /no settings for project|^$/);
  const withProject = classify(c, outside, ['--project', 'proj']);
  assert.match(withProject.stdout, /  scoped tests: npm test -- \{files\}/);
});

test('classify-change: no settings for the project -> built-in rules only, a note on stderr; no Swift/Kotlin/BLE patterns left', () => {
  const { c, dir } = makeRepo({ 'src/Bluetooth.swift': lines(5), 'Package.swift': 'x\n' }, (p) => ({ ...fullConfig(p), projects: {} }));
  write(dir, 'src/Bluetooth.swift', lines(5) + 'x\n');
  write(dir, 'Package.swift', 'y\n');
  const r = classify(c, dir);
  assert.match(r.stdout, /^TIER=2 UI=no VISUAL=no\n/, 'language-specific names are not sensitive by default');
  assert.match(r.stderr, /no settings for project 'proj'/);
  const src = fs.readFileSync(path.join(TEMPLATE, '.claude', 'scripts', 'classify-change.sh'), 'utf8');
  assert.doesNotMatch(src, /SIMULATOR|swift|kt\b|Peripheral|Firmware|Keychain|CoreData|ViewModel/);
  assert.ok(src.includes('VISUAL='));
});

// ---- wait-worker.sh ------------------------------------------------------------------------------------------

test('wait-worker.sh: returns a finished worker\'s state and last message', () => {
  const c = makeRoot(null);
  const sess = path.join(c.env.CLAUDE_CONFIG_DIR, 'projects', 'p');
  fs.mkdirSync(sess, { recursive: true });
  fs.writeFileSync(path.join(sess, 'abcd1234-x.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'result: all done' }] } }) + '\n');
  const r = run(c, 'wait-worker.sh', ['abcd1234'], { env: { STUB_AGENTS: '[{"id":"abcd1234","state":"done","status":"idle"}]', WAIT_POLL_SECS: '1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /worker abcd1234: state=done status=idle \| last: result: all done/);
  assert.notEqual(run(c, 'wait-worker.sh', []).status, 0);
});

test('approach page: linked from the README, no private wording, covers the agreed topics', () => {
  const page = fs.readFileSync(path.join(REPO, 'docs', 'APPROACH.md'), 'utf8');
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  assert.ok(readme.includes('](docs/APPROACH.md)'), 'README links the page');
  assert.doesNotMatch(page, /Canyon|Strava|ECLIPS|Jira|Lokalise|Apidog|Contentful|kdemireren|Kutay|\/Users\/|Obsidian/);
  for (const needle of ['FINDINGS.md', 'per Claude account', 'tier', 'protected branches']) assert.ok(page.toLowerCase().includes(needle.toLowerCase()), needle);
});

test('approach page: a CLAUDE.md above a project folder loads for every worker, and says what delegate.sh adds', () => {
  const page = fs.readFileSync(path.join(REPO, 'docs', 'APPROACH.md'), 'utf8');
  assert.match(page, /every folder above the one it starts in/);
  assert.match(page, /whether the manager started it or you started it yourself, also reads the manager playbook/);
  assert.doesNotMatch(page, /nothing from the manager folder/i, 'the old, wrong claim is gone');
  assert.doesNotMatch(page, /does not know about the docs rules/);
  for (const added of ['guardrails', 'docs', 'check commands', 'report contract', 'deny rules']) assert.ok(page.includes(added), `names what delegate.sh adds: ${added}`);
});

// ---- fixes from the end-to-end run ---------------------------------------------------------------------------------

const PLAYBOOK = fs.readFileSync(path.join(TEMPLATE, 'CLAUDE.md'), 'utf8');
const SKILL = fs.readFileSync(path.join(TEMPLATE, '.claude', 'skills', 'delegate', 'SKILL.md'), 'utf8');

test('playbook: a three-line note at the very top says a delegate.sh worker is not the manager', () => {
  const lines = PLAYBOOK.split('\n');
  assert.ok(lines.slice(0, 3).every((l) => l.startsWith('> ')), 'lines 1-3 are the note');
  assert.equal(lines[3], '');
  assert.equal(lines[4], '# Manager playbook');
  const note = lines.slice(0, 3).join(' ');
  assert.match(note, /started by `delegate\.sh`/);
  assert.match(note, /report contract/);
  assert.match(note, /you are a worker/);
  assert.match(note, /follow your brief and your project's own rules/i);
  assert.match(note, /manager sections .* do not apply to you/);
});

test('playbook: "Trust first" names the working folder, the docs folder and every project folder, and the ask-once flow', () => {
  const sec = PLAYBOOK.slice(PLAYBOOK.indexOf('**Trust first.**'), PLAYBOOK.indexOf('**Read the project'));
  assert.ok(sec.length > 300);
  for (const needle of ['working folder', 'docs folder', 'every project folder', 'Workspace not trusted', 'Added folder not trusted', '`AskUserQuestion`', 'exact command', 'once', 'run the same `delegate.sh` call again', 'accepting the trust prompt']) assert.ok(sec.includes(needle), needle);
  assert.doesNotMatch(PLAYBOOK, /hasTrustDialogAccepted/, 'the playbook no longer tells the manager to edit the global config');
  assert.match(sec, /never read or edit Claude's global config/);
  assert.ok(SKILL.includes('Trust first'), 'the skill points at it');
});

test('playbook: reading START-HERE and the newest LOG before briefing is a hard inline rule, and "docs read: yes" goes in the first-time setup and every brief', () => {
  const rule = PLAYBOOK.slice(PLAYBOOK.indexOf('**Read the project'), PLAYBOOK.indexOf('**Brief**'));
  assert.match(rule, /hard rule/);
  assert.match(rule, /START-HERE\.md/);
  assert.match(rule, /newest entry of `LOG\.md`/);
  assert.match(rule, /`docs read: yes`/);
  const setup = PLAYBOOK.slice(PLAYBOOK.indexOf('## Project setup'), PLAYBOOK.indexOf('## Work across projects'));
  assert.match(setup, /START-HERE\.md/);
  assert.match(setup, /newest `LOG\.md` entry/);
  assert.match(setup, /`docs read: yes`/);
  const brief = PLAYBOOK.slice(PLAYBOOK.indexOf('**Brief**'), PLAYBOOK.indexOf('**Monitor**'));
  assert.match(brief, /`docs read: yes`/);
  assert.match(SKILL, /`docs read: yes`/);
  assert.match(SKILL, /START-HERE\.md/);
});

test('delegate.sh warns when the brief has no "docs read: yes" line, and stays quiet with it', () => {
  const c = makeRoot(fullConfig);
  const bare = run(c, 'delegate.sh', ['proj', 'fix the thing']);
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stderr, /warning: the brief does not say "docs read: yes"\. Read .*\/proj\/START-HERE\.md and the newest LOG\.md entry first/);
  const said = run(c, 'delegate.sh', ['proj', 'fix the thing\n\ndocs read: yes']);
  assert.equal(said.status, 0, said.stderr);
  assert.doesNotMatch(said.stderr, /docs read/);
  const old = makeRoot(null);
  assert.doesNotMatch(run(old, 'delegate.sh', ['proj', 'x']).stderr, /docs read/, 'no docs folder, nothing to read');
});

test('playbook and skill: the brief guidance states no expected tier and never asks for the full suite', () => {
  const brief = PLAYBOOK.slice(PLAYBOOK.indexOf('**Brief**'), PLAYBOOK.indexOf('**Monitor**'));
  assert.doesNotMatch(brief, /Verification tier: 3/);
  assert.doesNotMatch(brief, /new feature|new screen/i, 'no kind of work is tied to a tier');
  assert.match(brief, /do not write an expected tier/);
  assert.match(brief, /do not ask for the full test suite/);
  assert.match(brief, /only when you decide to preset a tier/);
  assert.match(brief, /classify its diff at review/);
  const step = SKILL.split('\n').find((l) => l.startsWith('3. '));
  assert.doesNotMatch(step, /Verification tier: 3/);
  assert.doesNotMatch(step, /new features/i);
  assert.match(step, /don't write an expected tier/);
  assert.match(step, /Write `Verification tier: N` only when you deliberately preset a tier/);
  // nothing else in the manager text tells a worker to run everything
  for (const text of [PLAYBOOK, SKILL]) assert.doesNotMatch(text, /(run|runs|running) (the )?(full|entire|whole) (test )?suite (first|always|on every)/i);
});

test('delegate.sh: a trust error for the project folder prints one line with the exact command and exits non-zero', () => {
  const c = makeRoot(fullConfig);
  const r = run(c, 'delegate.sh', ['proj', 'x\ndocs read: yes'], { env: { STUB_FAIL: `Workspace not trusted. Run claude in ${path.join('x', 'proj')} once.` } });
  assert.notEqual(r.status, 0);
  const line = r.stderr.split('\n').filter((l) => /not trusted yet/.test(l));
  assert.equal(line.length, 1, r.stderr);
  assert.equal(line[0], `The project folder is not trusted yet. Run this once in a terminal, accept the trust prompt, type /exit, then run delegate.sh again: cd "${path.join(c.root, 'proj')}" && CLAUDE_CONFIG_DIR="${c.env.CLAUDE_CONFIG_DIR}" claude`);
  assert.equal(r.stdout, '', 'no silent fallback: nothing was started or logged as started');
  assert.equal(fs.existsSync(path.join(c.root, '.claude', 'delegations.log')), false);
});

test('delegate.sh: a trust error for the docs folder names the docs folder, with a path that needs escaping', () => {
  const c = makeRoot((p) => fullConfig(p));
  const odd = path.join(c.base, 'docs "odd" $x');
  fs.mkdirSync(odd);
  const cfg = JSON.parse(fs.readFileSync(path.join(c.root, '.claude', 'harness.json'), 'utf8'));
  cfg.docsDir = odd;
  fs.writeFileSync(path.join(c.root, '.claude', 'harness.json'), JSON.stringify(cfg));
  const env = { STUB_FAIL: `Error: Added folder not trusted: ${odd}` };
  const r = run(c, 'delegate.sh', ['proj', 'x\ndocs read: yes'], { env });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /^(.*\n)?The docs folder is not trusted yet\. Run this once in a terminal/);
  assert.ok(r.stderr.includes(`cd "${path.join(c.base, 'docs \\"odd\\" \\$x')}" && CLAUDE_CONFIG_DIR=`), r.stderr);
  // without CLAUDE_CONFIG_DIR (the default account) the command is the plain one
  const plain = run(c, 'delegate.sh', ['proj', 'x\ndocs read: yes'], { env: { ...env, CLAUDE_CONFIG_DIR: '' } });
  assert.ok(plain.stderr.trimEnd().endsWith('&& claude'), plain.stderr);
  assert.doesNotMatch(plain.stderr, /CLAUDE_CONFIG_DIR/);
});

test('delegate.sh: any other claude failure is printed as it was and exits 1; --resume reports a trust error too', () => {
  const c = makeRoot(fullConfig);
  const r = run(c, 'delegate.sh', ['proj', 'x\ndocs read: yes'], { env: { STUB_FAIL: 'Error: something else broke' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Error: something else broke/);
  assert.doesNotMatch(r.stderr, /not trusted/);
  const sess = path.join(c.env.CLAUDE_CONFIG_DIR, 'projects', 'p');
  fs.mkdirSync(sess, { recursive: true });
  fs.writeFileSync(path.join(sess, '0123abcd-full.jsonl'), '');
  const res = run(c, 'delegate.sh', ['--resume', '0123abcd', 'proj', 'again'], { env: { STUB_FAIL: 'Workspace not trusted. Run claude in somewhere once.' } });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /The project folder is not trusted yet\. Run this once in a terminal.*cd ".*\/proj" && /);
});

test('project-setup.sh prints one hint when the project does not ignore .claude/, and never edits the project', () => {
  const c = makeRoot((p) => ({ ...fullConfig(p), projects: {} }));
  const proj = path.join(c.root, 'proj');
  const before = spawnSync('git', ['-C', proj, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;
  const r = run(c, 'project-setup.sh', ['proj', '--build', 'make']);
  assert.equal(r.status, 0, r.stderr);
  const hints = r.stdout.split('\n').filter((l) => l.startsWith('hint:'));
  assert.equal(hints.length, 1, r.stdout);
  assert.match(hints[0], /^hint: proj does not ignore \.claude\/ .*Consider adding `\.claude\/` to its \.gitignore; this script never edits the project\.$/);
  assert.equal(fs.existsSync(path.join(proj, '.gitignore')), false, 'the project is not edited');
  assert.equal(spawnSync('git', ['-C', proj, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, before);

  // ignored by the project: no hint
  fs.writeFileSync(path.join(proj, '.gitignore'), '.claude/\n');
  assert.doesNotMatch(run(c, 'project-setup.sh', ['proj', '--lint', 'make lint']).stdout, /^hint:/m);
  // only .claude/worktrees/ ignored: .claude/ is not, so the hint comes back
  fs.writeFileSync(path.join(proj, '.gitignore'), '.claude/worktrees/\n');
  assert.match(run(c, 'project-setup.sh', ['proj', '--lint', 'make lint']).stdout, /^hint: proj does not ignore/m);
  // not a git repo (a loose folder with a CLAUDE.md): no hint, no error
  const loose = path.join(c.root, 'loose');
  fs.mkdirSync(loose);
  fs.writeFileSync(path.join(loose, 'CLAUDE.md'), '# loose\n');
  const lr = run(c, 'project-setup.sh', ['loose', '--build', 'make']);
  assert.equal(lr.status, 0, lr.stderr);
  assert.doesNotMatch(lr.stdout, /^hint:/m);
  // a failed setup prints no hint
  const bad = run(c, 'project-setup.sh', ['no-such-folder', '--build', 'x']);
  assert.notEqual(bad.status, 0);
  assert.doesNotMatch(bad.stdout, /^hint:/m);
});

test('delegate.sh: a trust failure prints only the trust line, even when the brief lacks "docs read: yes"; other failures still print the warning', () => {
  const c = makeRoot(fullConfig);
  const r = run(c, 'delegate.sh', ['proj', 'no docs line'], { env: { STUB_FAIL: `Workspace not trusted. Run claude in ${path.join('x', 'proj')} once.` } });
  assert.notEqual(r.status, 0);
  assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr);
  assert.match(r.stderr, /^The project folder is not trusted yet\./);
  assert.doesNotMatch(r.stderr, /docs read/);
  const other = run(c, 'delegate.sh', ['proj', 'no docs line'], { env: { STUB_FAIL: 'Error: something else broke' } });
  assert.equal(other.status, 1);
  assert.match(other.stderr, /does not say "docs read: yes"/);
  assert.match(other.stderr, /something else broke/);
  // a successful launch still warns, as before
  assert.match(run(c, 'delegate.sh', ['proj', 'no docs line']).stderr, /does not say "docs read: yes"/);
});

test('playbook and SKILL.md: after the extra tier checks pass, the LOG entry is amended with the checks that ran', () => {
  for (const [name, text] of [['CLAUDE.md', PLAYBOOK], ['SKILL.md', SKILL]]) {
    assert.match(text, /amend[^.]*dated `LOG\.md` entry[^.]*checks that actually ran/, name);
    assert.match(text, /if (the worker|it) has exited/, name);
  }
});
