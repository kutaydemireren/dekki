// Setup wizard API (GET /api/setup, POST /api/setup/preview|apply|health, POST /api/docs/pick) on a throwaway server.
// Temp HOME, temp state file, fixture template, stub `claude` on PATH. The real Finder chooser is never opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dekki-setupapi-test-')));
const homeDir = path.join(tmp, 'home');
fs.mkdirSync(path.join(homeDir, 'Projects'), { recursive: true });
process.env.HOME = homeDir;
process.env.DEKKI_STATE = path.join(tmp, '.dekki', 'state.json'); // the health check looks for this dir name in delegate.sh
process.env.DEKKI_TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'setup-template');
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const { readState, writeState } = await import('../state.js');
const { createServer, listen } = await import('../index.js');
const { apiRoutes } = await import('../routes.js');
const { demoRoutes } = await import('../demo.js');
const { pickFolder } = await import('../root.js');

const P = 4397;
const mk = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); return d; };
function call(method, p, body, { port = P, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const r = http.request({ agent: false, host: '127.0.0.1', port, method, path: p, headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => { let b = null; try { b = s ? JSON.parse(s) : null; } catch { b = s; } resolve({ status: res.statusCode, body: b }); });
    });
    r.on('error', (e) => resolve({ status: e.code, body: null })); // a request the server cuts off (too large) ends in a reset
    r.end(data);
  });
}

test('API: status, preview, apply (saves a new working folder), health, idempotent re-run, refusals', async () => {
  const server = createServer({ port: P, routes: [apiRoutes()] });
  await listen(server, P);
  try {
    writeState({ ...readState(), root: '', accounts: [], activeAccount: 'default' });
    // fresh deck: no working folder, ~/Projects is suggested, a typed candidate lists its repos
    fs.mkdirSync(path.join(homeDir, 'Projects/app/.git'), { recursive: true });
    fs.mkdirSync(path.join(homeDir, 'Projects/notes'));
    let s = await call('GET', '/api/setup');
    assert.equal(s.status, 200);
    assert.equal(s.body.root, null);
    assert.equal(s.body.suggestedRoot, path.join(homeDir, 'Projects'));
    assert.equal(s.body.demo, false);
    assert.equal(s.body.rootReady, false);
    assert.deepEqual(s.body.defaults.protectedBranches, ['main', 'master', 'develop']);
    s = await call('GET', `/api/setup?root=${encodeURIComponent(path.join(homeDir, 'Projects'))}`);
    assert.deepEqual(s.body.candidate.repos, [{ name: 'app', git: true }, { name: 'notes', git: false }]);
    assert.equal((await call('GET', `/api/setup?root=${encodeURIComponent(path.join(tmp, 'nope'))}`)).body.candidate.ok, false);

    const root = path.join(homeDir, 'Projects');
    const docs = mk('docs');
    // validation errors carry a field and a status
    let r = await call('POST', '/api/setup/preview', { root });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, 'docsDir');
    r = await call('POST', '/api/setup/preview', { root, docsDir: path.join(root, 'docs') });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /inside the working folder/);
    r = await call('POST', '/api/setup/preview', { docsDir: docs });
    assert.equal(r.body.field, 'root', 'no working folder saved and none given');
    assert.equal((await call('POST', '/api/setup/preview', { root: path.join(tmp, 'bad&name'), docsDir: docs })).status, 400);

    // preview writes nothing
    r = await call('POST', '/api/setup/preview', { root, docsDir: docs, neverTouch: 'prod' });
    assert.equal(r.status, 200);
    assert.ok(r.body.files.every((f) => f.state === 'new'));
    assert.deepEqual(fs.readdirSync(root).sort(), ['app', 'notes']);
    assert.equal(readState().root, '', 'preview does not save the working folder');

    // a refused apply saves nothing, either
    r = await call('POST', '/api/setup/apply', { root, docsDir: 'relative' });
    assert.equal(r.status, 400);
    assert.equal(readState().root, '');

    // apply: writes, saves the folder, returns the health result
    r = await call('POST', '/api/setup/apply', { root, docsDir: docs, neverTouch: 'prod', preferences: { replyStyle: 'detailed' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.ok(r.body.created.includes('CLAUDE.md'));
    assert.equal(r.body.root, fs.realpathSync(root));
    assert.equal(r.body.rootReady, true);
    assert.equal(readState().root, fs.realpathSync(root));
    assert.equal(r.body.health.ok, true, JSON.stringify(r.body.health.items.filter((i) => i.status === 'fail')));
    assert.match(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), /Reply in detail/);
    // the apply answer carries the folders to trust once: the docs folder, then the git repos of the working folder
    assert.deepEqual(r.body.trust.dirs.map((d) => [d.kind, d.name]), [['docs', docs], ['project', 'app']]);
    assert.equal(r.body.trust.dirs[1].command, `cd "${path.join(fs.realpathSync(root), 'app')}" && claude`);
    assert.equal(r.body.health.items.find((i) => i.id === 'trust').status, 'info');

    // GET shows what was saved, with the per-file state
    s = await call('GET', '/api/setup');
    assert.equal(s.body.rootReady, true);
    assert.equal(s.body.config.docsDir, docs);
    assert.equal(s.body.config.neverTouch, 'prod');
    assert.equal(s.body.installedVersion, 1);
    assert.ok(s.body.files.length > 0 && s.body.files.every((f) => f.action === 'none' && f.state === 'current'));

    // re-run: nothing created or updated
    r = await call('POST', '/api/setup/apply', { docsDir: docs, neverTouch: 'prod', preferences: { replyStyle: 'detailed' } });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.created, r.body.updated, r.body.flagged], [[], [], []]);

    // health on its own
    r = await call('POST', '/api/setup/health', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    fs.rmSync(path.join(root, 'CLAUDE.md'));
    r = await call('POST', '/api/setup/health', {});
    assert.equal(r.body.items.find((i) => i.id === 'playbook').status, 'fail');
  } finally { server.close(); }
});

test('API: input limits and bad bodies', async () => {
  const server = createServer({ port: P, routes: [apiRoutes()] });
  await listen(server, P);
  try {
    assert.equal((await call('POST', '/api/setup/preview', 'not json')).status, 400);
    assert.equal((await call('POST', '/api/setup/apply', '[]')).status, 400);
    const big = await call('POST', '/api/setup/preview', { docsDir: '/x', neverTouch: 'a'.repeat(40 * 1024) });
    assert.ok(big.status === 400 || big.status === 'ECONNRESET', `too large is refused (got ${big.status})`);
    assert.deepEqual(fs.readdirSync(mk('untouched')), []);
    const long = await call('POST', '/api/setup/preview', { root: mk('w1'), docsDir: mk('d1'), neverTouch: 'a'.repeat(3000) });
    assert.equal(long.status, 400);
    assert.equal(long.body.field, 'neverTouch');
  } finally { server.close(); }
});

test('API: per account, the second account has its own working folder and config', async () => {
  const server = createServer({ port: P, routes: [apiRoutes()] });
  await listen(server, P);
  try {
    const rootA = mk('wa');
    const rootB = mk('wb');
    const cfgB = mk('cfgb');
    writeState({ ...readState(), root: rootA, accounts: [{ id: 'second', label: 'Second', configDir: cfgB }], activeAccount: 'default' });
    const dA = mk('da');
    const dB = mk('db');
    assert.equal((await call('POST', '/api/setup/apply', { docsDir: dA, neverTouch: 'prod A' })).status, 200);
    assert.equal((await call('POST', '/api/accounts/active', { id: 'second' })).status, 200);
    let s = await call('GET', '/api/setup');
    assert.equal(s.body.account.id, 'second');
    assert.equal(s.body.root, null, 'no fallback to the other account\'s folder');
    assert.equal(s.body.reuse[0].neverTouch, 'prod A');
    assert.ok(!JSON.stringify(s.body.reuse).includes(dA), 'the docs folder is never offered for reuse');
    const r = await call('POST', '/api/setup/apply', { root: rootB, docsDir: dB, ...s.body.reuse[0] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(readState().accounts[0].root, fs.realpathSync(rootB));
    assert.equal(readState().root, rootA, 'the default account keeps its folder');
    assert.equal(JSON.parse(fs.readFileSync(path.join(rootB, '.claude/harness.json'), 'utf8')).neverTouch, 'prod A');
    assert.equal(JSON.parse(fs.readFileSync(path.join(rootA, '.claude/harness.json'), 'utf8')).docsDir, dA);
    await call('POST', '/api/accounts/active', { id: 'default' });
  } finally { server.close(); }
});

test('API: the browser-origin rule covers every setup route', async () => {
  const server = createServer({ port: P, routes: [apiRoutes()] });
  await listen(server, P);
  try {
    for (const [method, p] of [['POST', '/api/setup/preview'], ['POST', '/api/setup/apply'], ['POST', '/api/setup/health'], ['POST', '/api/docs/pick'], ['GET', '/api/setup']]) {
      assert.equal((await call(method, p, method === 'POST' ? {} : undefined, { headers: { origin: 'http://evil.com' } })).status, 403, `${method} ${p} bad Origin`);
      assert.equal((await call(method, p, method === 'POST' ? {} : undefined, { headers: { host: 'evil.com' } })).status, 403, `${method} ${p} bad Host`);
    }
  } finally { server.close(); }
});

test('demo mode: apply, health and the folder chooser are refused with the demo message; read-only routes still answer', async () => {
  const DP = 4395;
  process.env.DEKKI_DEMO = '1';
  const root = mk('demo-root');
  const server = createServer({ port: DP, routes: [demoRoutes(root), apiRoutes()] });
  await listen(server, DP);
  try {
    for (const p of ['/api/setup/apply', '/api/setup/health', '/api/docs/pick']) {
      const r = await call('POST', p, { docsDir: mk('demo-docs'), root }, { port: DP });
      assert.equal(r.status, 400, p);
      assert.match(r.body.error, /^Demo mode: .* switched off\. Nothing was changed\.$/, p);
    }
    assert.deepEqual(fs.readdirSync(root), [], 'nothing was written');
    const s = await call('GET', '/api/setup', undefined, { port: DP });
    assert.equal(s.status, 200);
    assert.equal(s.body.demo, true);
    const pv = await call('POST', '/api/setup/preview', { root, docsDir: mk('demo-docs2') }, { port: DP });
    assert.equal(pv.status, 200, 'the wizard can be walked through in demo mode');
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { server.close(); delete process.env.DEKKI_DEMO; }
});

test('pickFolder: custom prompt goes to osascript as one argument (no shell), cancel and error handled, non-macOS typed-path fallback', async () => {
  const calls = [];
  const exec = (file, args, opts, cb) => { calls.push([file, args]); cb(null, '/Users/x/Docs/\n', ''); };
  const r = await pickFolder({ platform: 'darwin', exec, prompt: 'Choose the docs folder for Dekki' });
  assert.deepEqual(r, { ok: true, path: '/Users/x/Docs' });
  assert.equal(calls[0][0], 'osascript');
  assert.equal(calls[0][1].length, 2);
  assert.match(calls[0][1][1], /prompt "Choose the docs folder for Dekki"/);
  await pickFolder({ platform: 'darwin', exec, prompt: 'x" & (do shell script "id") & "' });
  assert.doesNotMatch(calls[1][1][1], /prompt "x" &/, 'quotes are stripped from the prompt');
  assert.deepEqual(await pickFolder({ platform: 'darwin', exec: (f, a, o, cb) => cb(Object.assign(new Error('x'), {}), '', 'execution error: User canceled. (-128)') }), { ok: true, cancelled: true });
  assert.equal((await pickFolder({ platform: 'darwin', exec: (f, a, o, cb) => cb(new Error('boom'), '', '') })).ok, false);
  assert.equal((await pickFolder({ platform: 'darwin', exec: (f, a, o, cb) => cb(null, '  \n', '') })).ok, false);
  const win = await pickFolder({ platform: 'linux', exec });
  assert.equal(win.ok, false);
  assert.match(win.error, /Type the path instead/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
