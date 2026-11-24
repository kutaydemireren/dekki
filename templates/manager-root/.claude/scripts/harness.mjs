#!/usr/bin/env node
// Helper for the manager scripts (delegate.sh, project-setup.sh, classify-change.sh). Reads and writes
// <root>/.claude/harness.json with node only (no jq, no python). Not meant to be called by hand.
//
//   harness.mjs render   <root>                     render .claude/worker-settings.json from worker-deny.json + the config
//   harness.mjs brief    <root> <project>           print the text delegate.sh appends to a brief (warnings on stderr)
//   harness.mjs docs-dir <root>                     print docsDir when the config sets one and it exists
//   harness.mjs check    <root> [<project>]         validate the config and the rendered rules; exit 1 on a problem
//   harness.mjs get      <root> <project> <field>   exists | all (7 lines: sensitive regex, ui regex, visual, build, lint, scoped, full) | sensitive | ui | visual | check:<name>
//   harness.mjs setup    <root> <project> [--build C] [--lint C] [--test-scoped C] [--test-full C]
//                                         [--sensitive RE]... [--ui RE]... [--visual TEXT]
//
// Config (version 1) is described in the Dekki docs; unknown keys are kept when the file is rewritten.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BRANCHES = ['main', 'master', 'develop'];
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;
const PROJECT_RE = /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,99}$/;
const PROJECT_FILES = ['START-HERE.md', 'SPEC.md', 'DECISIONS.md', 'LOG.md', 'INBOX.md'];
const CHECK_KEYS = { build: 'build', lint: 'lint', testScoped: 'test-scoped', testFull: 'test-full' };
const ENUMS = {
  replyStyle: ['short', 'detailed'],
  autonomy: ['outward', 'ask-all', 'rare'],
  prs: ['me', 'workers-draft'],
};

export const safeProject = (name) => typeof name === 'string' && PROJECT_RE.test(name) && !name.includes('..') && !/\s$/.test(name);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const configPath = (root) => path.join(root, '.claude', 'harness.json');

/** {config:null|object, error:null|string}. A missing file is not an error (old roots). */
export function loadConfig(root) {
  let text;
  try { text = fs.readFileSync(configPath(root), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { config: null, error: null };
    return { config: null, error: `cannot read .claude/harness.json: ${e.message}` };
  }
  try {
    const c = JSON.parse(text);
    if (!isObj(c)) return { config: null, error: '.claude/harness.json must hold a JSON object' };
    return { config: c, error: null };
  } catch (e) {
    return { config: null, error: `.claude/harness.json is not valid JSON: ${e.message}` };
  }
}

/** True when `p` is a regex grep -E accepts (the same engine classify-change.sh uses). */
function ereOk(p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.includes('\n')) return false;
  const r = spawnSync('grep', ['-E', '-e', p, '/dev/null'], { stdio: 'ignore' });
  return r.status === 0 || r.status === 1;
}

const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

/** Problems with a config object (strings). */
export function validate(config, root) {
  const bad = [];
  if (config.version !== 1) bad.push(`version must be 1 (found ${JSON.stringify(config.version)})`);
  if (config.docsDir !== undefined && config.docsDir !== null) {
    if (typeof config.docsDir !== 'string' || !path.isAbsolute(config.docsDir) || config.docsDir.includes('\0')) bad.push('docsDir must be an absolute path');
    else if (inside(realOr(config.docsDir), realOr(root))) bad.push('docsDir must be outside the working folder (its subfolders are listed as projects)');
  }
  if (config.protectedBranches !== undefined) {
    if (!Array.isArray(config.protectedBranches)) bad.push('protectedBranches must be a list of branch names');
    else for (const b of config.protectedBranches) {
      if (typeof b !== 'string' || !BRANCH_RE.test(b) || b.includes('..') || b.endsWith('/') || b.endsWith('.lock')) bad.push(`protectedBranches: not a usable branch name: ${JSON.stringify(b)}`);
    }
  }
  if (config.neverTouch != null && typeof config.neverTouch !== 'string') bad.push('neverTouch must be text or null');
  if (config.secretsDir != null) {
    if (typeof config.secretsDir !== 'string' || !path.isAbsolute(config.secretsDir)) bad.push('secretsDir must be an absolute path or null');
    else if (/[*?\[\]{}()'"\\\n\0]/.test(config.secretsDir)) bad.push('secretsDir must not contain * ? [ ] { } ( ) quotes or backslashes');
  }
  if (config.preferences !== undefined) {
    if (!isObj(config.preferences)) bad.push('preferences must be an object');
    else {
      for (const [k, allowed] of Object.entries(ENUMS)) {
        const v = config.preferences[k];
        if (v !== undefined && !allowed.includes(v)) bad.push(`preferences.${k} must be one of ${allowed.join(', ')}`);
      }
      const l = config.preferences.language;
      if (l !== undefined && (typeof l !== 'string' || !l.trim())) bad.push('preferences.language must be "same" or a language name');
    }
  }
  if (config.projects !== undefined) {
    if (!isObj(config.projects)) bad.push('projects must be an object');
    else for (const [name, p] of Object.entries(config.projects)) {
      if (!safeProject(name)) { bad.push(`projects: unsafe folder name ${JSON.stringify(name)}`); continue; }
      if (!isObj(p)) { bad.push(`projects.${name} must be an object`); continue; }
      if (p.checks !== undefined) {
        if (!isObj(p.checks)) bad.push(`projects.${name}.checks must be an object`);
        else for (const [k, v] of Object.entries(p.checks)) {
          if (!(k in CHECK_KEYS)) bad.push(`projects.${name}.checks.${k}: unknown check (build, lint, testScoped, testFull)`);
          else if (typeof v !== 'string' || !v.trim() || v.includes('\n')) bad.push(`projects.${name}.checks.${k} must be a one-line command`);
        }
      }
      for (const k of ['sensitivePaths', 'uiPaths']) {
        if (p[k] === undefined) continue;
        if (!Array.isArray(p[k])) { bad.push(`projects.${name}.${k} must be a list of regexes`); continue; }
        for (const re of p[k]) if (!ereOk(re)) bad.push(`projects.${name}.${k}: not a valid extended regex: ${JSON.stringify(re)}`);
      }
      if (p.visualProof !== undefined && typeof p.visualProof !== 'string') bad.push(`projects.${name}.visualProof must be text`);
    }
  }
  return bad;
}

export const branchesOf = (config) => (config && Array.isArray(config.protectedBranches) ? config.protectedBranches : DEFAULT_BRANCHES);

/** Deny rules for files under the secrets folder (use is allowed, reading is not). */
function secretsRules(dir) {
  const d = dir.replace(/\/+$/, '');
  const rules = [`Read(/${d}/**)`];
  for (const c of ['cat', 'head', 'tail', 'less', 'more', 'strings', 'od', 'xxd']) rules.push(`Bash(${c} *${d}/*)`);
  for (const c of ['grep', 'sed', 'awk']) rules.push(`Bash(${c} * *${d}/*)`);
  return rules;
}

/** The worker settings object: the template with __MANAGER_ROOT__ filled in, __BRANCH__ rules expanded per protected branch. */
export function renderSettings(root, config) {
  const tpl = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'scripts', 'worker-deny.json'), 'utf8'));
  const fill = (v) => {
    if (typeof v === 'string') return v.split('__MANAGER_ROOT__').join(root);
    if (Array.isArray(v)) return v.map(fill);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  const out = fill(tpl);
  const deny = [];
  for (const rule of (out.permissions && out.permissions.deny) || []) {
    if (rule.includes('__BRANCH__')) for (const b of branchesOf(config)) deny.push(rule.split('__BRANCH__').join(b));
    else deny.push(rule);
  }
  if (config && typeof config.secretsDir === 'string' && config.secretsDir) deny.push(...secretsRules(config.secretsDir));
  out.permissions = { ...(out.permissions || {}), deny: [...new Set(deny)] };
  return out;
}

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const globRe = (g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
/** True when some Bash(...) deny rule matches the command (glob: * matches anything). */
export function denied(rules, cmd) {
  return rules.some((r) => { const m = /^Bash\((.*)\)$/.exec(r); return m && globRe(m[1]).test(cmd); });
}

/** Every form of a push to branch `b` the rendered rules must refuse, and a feature branch they must allow. */
export function pushProbe(rules, branches) {
  const problems = [];
  for (const b of branches) {
    const forms = [`git push origin ${b}`, `git push -u origin ${b}`, `git push origin ${b} --tags`, `git push origin HEAD:${b}`, `git push origin work:${b}`, `git push origin HEAD:refs/heads/${b}`, `git push origin +${b}`];
    for (const f of forms) if (!denied(rules, f)) problems.push(`deny rules do not refuse: ${f}`);
  }
  for (const f of ['git push', 'git push origin HEAD', 'git push --force origin feature/x', 'git push origin --delete feature/x']) {
    if (!denied(rules, f)) problems.push(`deny rules do not refuse: ${f}`);
  }
  for (const f of ['git push -u origin feature/login-form', 'git push -u origin worktree-docs-fix']) {
    if (denied(rules, f)) problems.push(`deny rules refuse a named feature branch: ${f}`);
  }
  return problems;
}

/** Text appended to a brief. '' when there is no config (old roots behave as before). */
export function briefText(config, project) {
  if (!config) return '';
  const branches = branchesOf(config);
  const lines = ['', '', '---', 'Harness rules from the manager folder (they apply on top of the project\'s own rules):', '', 'Guardrails'];
  if (config.neverTouch) lines.push(`- Never touch: ${config.neverTouch}. If the task needs it, stop and report needs input.`);
  if (config.secretsDir) lines.push(`- Secrets: files under ${config.secretsDir} are there for you to USE, never to read. Load one inside the command that needs it (set -a; . <file>; set +a; then the command) and make sure nothing prints the value. Do not open, cat, grep or copy it. If a secret value shows up anyway, say so at once in your report: which secret, where, and that it needs rotating.`);
  if (branches.length) lines.push(`- Never push to ${branches.join(', ')}; never force-push; never merge. Push only a named feature branch (git push -u origin <branch>).`);
  else lines.push('- Never force-push; never merge. Push only a named feature branch (git push -u origin <branch>).');
  if (config.docsDir) {
    const d = `${config.docsDir.replace(/\/+$/, '')}/${project}`;
    lines.push('', 'Docs',
      `- This project's docs live in ${d}/ (outside the repo). Before you change anything, read START-HERE.md and the newest LOG.md entry there, then only the SPEC and DECISIONS sections your change touches. Update the docs in the same session as the change (SPEC for what it does now, DECISIONS for a choice made or reversed, LOG entry at the end, INBOX for bugs and ideas you were told to note), following ${config.docsDir.replace(/\/+$/, '')}/README.md. In your report, name which docs you read (START-HERE and the date of the newest LOG entry) and which you touched. If you cannot read or write that folder, say so in your report; do not skip it silently.`);
  }
  const p = isObj(config.projects) && isObj(config.projects[project]) ? config.projects[project] : null;
  const c = p && isObj(p.checks) ? p.checks : {};
  const have = Object.keys(CHECK_KEYS).filter((k) => c[k]);
  if (have.length) {
    lines.push('', 'Checks for this project (set by the user; the floor is build + lint, the manager asks for more depending on the diff)');
    if (c.build) lines.push(`- Build: ${c.build}`);
    if (c.lint) lines.push(`- Lint: ${c.lint}`);
    if (c.testScoped) lines.push(`- Scoped tests: ${c.testScoped}   ({files} = the changed files or targets)`);
    if (c.testFull) lines.push(`- Full tests: ${c.testFull}`);
  }
  if (p && p.visualProof) lines.push('', `Visual proof for changes people can see: ${p.visualProof}`);
  return lines.join('\n');
}

const projectDirOk = (root, project) => safeProject(project) && fs.existsSync(path.join(root, project)) && fs.statSync(path.join(root, project)).isDirectory();

function cmdCheck(root, project) {
  const out = [];
  let problems = 0;
  const ok = (m) => out.push(`ok: ${m}`);
  const warn = (m) => out.push(`warn: ${m}`);
  const bad = (m) => { problems++; out.push(`problem: ${m}`); };
  const { config, error } = loadConfig(root);
  if (error) bad(error);
  else if (!config) warn('no .claude/harness.json: running with defaults (protected branches main, master, develop); briefs get no guardrails, docs or checks');
  else {
    const v = validate(config, root);
    if (v.length) v.forEach(bad); else ok('.claude/harness.json is valid (version 1)');
    if (!config.docsDir) bad('docsDir is not set');
    else {
      try {
        if (!fs.statSync(config.docsDir).isDirectory()) throw new Error('not a folder');
        fs.accessSync(config.docsDir, fs.constants.W_OK);
        ok(`docs folder ${config.docsDir} exists and is writable`);
      } catch { bad(`docs folder ${config.docsDir} does not exist or is not writable`); }
    }
  }
  if (!fs.existsSync(path.join(root, '.claude', 'scripts', 'worker-deny.json'))) bad('.claude/scripts/worker-deny.json is missing');
  else if (!error) {
    try {
      const settings = renderSettings(root, config);
      const rules = settings.permissions.deny;
      atomicWrite(path.join(root, '.claude', 'worker-settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
      ok(`rendered .claude/worker-settings.json (${rules.length} deny rules)`);
      const branches = branchesOf(config);
      const probe = pushProbe(rules, branches);
      if (probe.length) probe.forEach(bad); else ok(`deny rules refuse git push to ${branches.join(', ') || '(no protected branch)'} and allow a named feature branch`);
      if (!JSON.stringify(settings).includes('check-report.sh')) warn('worker settings do not wire the report check hook');
    } catch (e) { bad(`cannot render the worker settings: ${e.message}`); }
  }
  if (config && isObj(config.projects)) {
    const names = Object.keys(config.projects);
    ok(`projects with settings: ${names.length ? names.join(', ') : '(none yet)'}`);
    for (const n of names) if (!projectDirOk(root, n)) warn(`projects.${n} has no folder in the working folder`);
  }
  if (project) {
    if (!projectDirOk(root, project)) bad(`no project folder named ${project}`);
    else {
      out.push(`--- text appended to a brief for ${project} ---`);
      out.push(config && !error ? briefText(config, project).replace(/^\s*---\n/, '') : '(nothing: no config)');
      if (config && !(isObj(config.projects) && config.projects[project])) warn(`${project} has no settings yet: project-setup.sh ${project} ... should run first`);
    }
  }
  out.push(problems ? `check failed: ${problems} problem${problems === 1 ? '' : 's'}` : 'check passed');
  console.log(out.join('\n'));
  return problems ? 1 : 0;
}

function parseSetup(args) {
  const flags = { '--build': 'build', '--lint': 'lint', '--test-scoped': 'testScoped', '--test-full': 'testFull', '--visual': 'visual' };
  const lists = { '--sensitive': 'sensitive', '--ui': 'ui' };
  const o = { checks: {}, sensitive: null, ui: null, visual: undefined };
  for (let i = 0; i < args.length; i += 2) {
    const f = args[i];
    if (i + 1 >= args.length) throw new Error(`${f} needs a value (use "" to clear it)`);
    const v = args[i + 1];
    if (f in flags) {
      if (flags[f] === 'visual') o.visual = v; else o.checks[flags[f]] = v;
    } else if (f in lists) {
      (o[lists[f]] ||= []).push(v);
    } else throw new Error(`unknown option ${f}`);
  }
  return o;
}

function copyDoc(src, dst, vars) {
  if (fs.existsSync(dst)) return false;
  let text = fs.readFileSync(src, 'utf8');
  for (const [k, v] of Object.entries(vars)) text = text.split(`{{${k}}}`).join(v);
  fs.writeFileSync(dst, text, { flag: 'wx' });
  return true;
}

function cmdSetup(root, project, rest) {
  if (!safeProject(project)) throw new Error(`unsafe project name: ${JSON.stringify(project)}`);
  if (!projectDirOk(root, project)) throw new Error(`no project folder named ${project} in ${root}`);
  const { config, error } = loadConfig(root);
  if (error) throw new Error(error);
  if (!config) throw new Error('no .claude/harness.json: run the setup wizard in Dekki first (it chooses the docs folder)');
  const probs = validate(config, root);
  if (probs.length) throw new Error(`.claude/harness.json is invalid: ${probs.join('; ')}`);
  if (!config.docsDir) throw new Error('docsDir is not set in .claude/harness.json: run the setup wizard in Dekki first');
  try { if (!fs.statSync(config.docsDir).isDirectory()) throw new Error(); } catch { throw new Error(`docs folder does not exist: ${config.docsDir}`); }
  const o = parseSetup(rest);
  for (const [k, v] of Object.entries(o.checks)) if (v.includes('\n')) throw new Error(`--${k} must be one line`);
  for (const list of [o.sensitive, o.ui]) for (const re of list || []) if (re !== '' && !ereOk(re)) throw new Error(`not a valid extended regex: ${JSON.stringify(re)}`);

  const projects = isObj(config.projects) ? config.projects : {};
  const prev = isObj(projects[project]) ? projects[project] : {};
  const next = { ...prev, setupAt: prev.setupAt || new Date().toISOString().slice(0, 10) };
  const checks = { ...(isObj(prev.checks) ? prev.checks : {}) };
  for (const [k, v] of Object.entries(o.checks)) { if (v === '') delete checks[k]; else checks[k] = v; }
  next.checks = checks;
  if (o.sensitive) next.sensitivePaths = o.sensitive.filter((x) => x !== '');
  if (o.ui) next.uiPaths = o.ui.filter((x) => x !== '');
  if (!Array.isArray(next.sensitivePaths)) next.sensitivePaths = [];
  if (!Array.isArray(next.uiPaths)) next.uiPaths = [];
  if (o.visual !== undefined) { if (o.visual === '') delete next.visualProof; else next.visualProof = o.visual; }
  config.projects = { ...projects, [project]: next };
  atomicWrite(configPath(root), `${JSON.stringify(config, null, 2)}\n`);

  const tplDir = path.join(root, '.claude', 'docs-templates');
  const made = []; const kept = [];
  const docs = path.join(config.docsDir, project);
  fs.mkdirSync(path.join(docs, 'archive'), { recursive: true });
  const vars = { project, date: new Date().toISOString().slice(0, 10) };
  const readme = path.join(config.docsDir, 'README.md');
  if (fs.existsSync(path.join(tplDir, 'README.md'))) (copyDoc(path.join(tplDir, 'README.md'), readme, vars) ? made : kept).push(readme);
  for (const f of PROJECT_FILES) {
    const src = path.join(tplDir, f);
    if (!fs.existsSync(src)) { kept.push(`${path.join(docs, f)} (no template ${f})`); continue; }
    (copyDoc(src, path.join(docs, f), vars) ? made : kept).push(path.join(docs, f));
  }
  const show = (v, none = 'not set') => (v === undefined || v === '' || (Array.isArray(v) && !v.length) ? none : Array.isArray(v) ? v.join('  |  ') : v);
  console.log([
    `project settings saved for ${project} in .claude/harness.json`,
    `  build: ${show(checks.build)}`, `  lint: ${show(checks.lint)}`, `  scoped tests: ${show(checks.testScoped)}`, `  full tests: ${show(checks.testFull)}`,
    `  sensitive paths: ${show(next.sensitivePaths)}`, `  ui paths: ${show(next.uiPaths)}`, `  visual proof: ${show(next.visualProof)}`,
    `docs: ${docs}/`,
    ...made.map((f) => `  created ${f}`), ...kept.map((f) => `  left alone ${f}`),
  ].join('\n'));
}

function cmdGet(root, project, field) {
  const { config } = loadConfig(root);
  const p = config && isObj(config.projects) && isObj(config.projects[project]) ? config.projects[project] : null;
  if (!p) return;
  if (field === 'exists') console.log('yes');
  else if (field === 'all') {
    const join = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x).map((x) => `(${x})`).join('|') : '');
    const c = isObj(p.checks) ? p.checks : {};
    const one = (v) => (typeof v === 'string' ? v.replace(/\n/g, ' ') : '');
    console.log([join(p.sensitivePaths), join(p.uiPaths), one(p.visualProof), one(c.build), one(c.lint), one(c.testScoped), one(c.testFull)].join('\n'));
  }
  else if (field === 'sensitive') console.log((Array.isArray(p.sensitivePaths) ? p.sensitivePaths : []).join('\n'));
  else if (field === 'ui') console.log((Array.isArray(p.uiPaths) ? p.uiPaths : []).join('\n'));
  else if (field === 'visual') console.log(typeof p.visualProof === 'string' ? p.visualProof : '');
  else if (field.startsWith('check:')) console.log(isObj(p.checks) && typeof p.checks[field.slice(6)] === 'string' ? p.checks[field.slice(6)] : '');
  else throw new Error(`unknown field ${field}`);
}

function main(argv) {
  const [cmd, root, ...rest] = argv;
  if (!cmd || !root) { console.error('usage: harness.mjs <render|brief|docs-dir|check|get|setup> <root> ...'); return 2; }
  try {
    if (cmd === 'check') return cmdCheck(root, rest[0]);
    if (cmd === 'setup') { cmdSetup(root, rest[0], rest.slice(1)); return 0; }
    if (cmd === 'get') { cmdGet(root, rest[0], rest[1]); return 0; }
    const { config, error } = loadConfig(root);
    if (error) { console.error(`${error}. Fix it, or run delegate.sh --check.`); return 1; }
    if (config) {
      const v = validate(config, root);
      if (v.length) { console.error(`.claude/harness.json is invalid (${v.join('; ')}). Run delegate.sh --check.`); return 1; }
    }
    if (cmd === 'render') {
      const settings = renderSettings(root, config);
      atomicWrite(path.join(root, '.claude', 'worker-settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
      return 0;
    }
    if (cmd === 'brief') {
      const project = rest[0];
      if (config && !(isObj(config.projects) && isObj(config.projects[project]))) {
        console.error(`warning: ${project} has no settings in .claude/harness.json yet. Run the first-time project setup (.claude/scripts/project-setup.sh ${project} --build ... --lint ... --test-scoped ... --test-full ... --sensitive ... --ui ... --visual ...) so the tier checks know its commands and sensitive paths.`);
      }
      if (config && config.docsDir && !fs.existsSync(config.docsDir)) console.error(`warning: docs folder ${config.docsDir} does not exist; the worker cannot update the docs.`);
      process.stdout.write(briefText(config, project));
      return 0;
    }
    if (cmd === 'docs-dir') {
      if (config && config.docsDir && fs.existsSync(config.docsDir)) console.log(config.docsDir);
      return 0;
    }
    console.error(`unknown command ${cmd}`);
    return 2;
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
