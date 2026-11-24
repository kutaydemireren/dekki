// REST routes. Called only after the shared Host/Origin check. Reads are GET; mutations POST/DELETE only.
import { listAgents } from './agents.js';
import { isAgentId } from './claude.js';
import { readState, setMember, setName, setArchived, setPinned } from './state.js';
import { publicAccounts, setActiveAccount, activeRoot } from './accounts.js';
import { rootConfig, setRoot, pickFolder, setupActiveRoot } from './root.js';
import { setupStatus, previewSetup, applySetup, runHealth } from './setup.js';
import { demoEnabled } from './demo.js';
import { closeAttachSessions } from './pty.js';
import { notifyEnabled, setNotifyPref } from './notify.js';
import { viewing } from './viewing.js';
import { loadHistory } from './history.js';
import { listChanges, fileDiff, agentDir, listGroupChanges } from './changes.js';
import { findTranscript, sessionStats, liveStats, skillAggregate } from './transcript.js';
import { startAgent } from './projects.js';
import { listTree, openPath } from './tree.js';
import { getIcon } from './icons.js';
import { saveUpload } from './uploads.js';
import { removeCheck, removeAgent, stopAgent, discardDraft } from './remove.js';
import { listPrompts, savePrompt, movePrompt, makeFolder, trashPrompt, revealPrompt, revealTrash, startImprover, PromptError, MAX_BYTES } from './prompts.js';

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v && typeof v === 'object' && !Array.isArray(v)) resolve(v); else reject(new Error('Expected a JSON object'));
      } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const prefsOf =(s) => ({ pinned: s.pinned, archived: s.archived });

export function apiRoutes() {
  return async (req, res, url) => {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/agents') {
      try {
        const st = readState();
        json(res, 200, { agents: await listAgents(), ...prefsOf(st), account: publicAccounts(st).active });
      } catch (e) {
        json(res, 502, { error: e.message });
      }
      return true;
    }
    if (req.method === 'POST' && p === '/api/upload') {
      try {
        json(res, 200, { path: await saveUpload(req, url.searchParams.get('name')) });
      } catch (e) {
        json(res, 400, { error: e.message });
      }
      return true;
    }
    if (req.method === 'GET' && p === '/api/icon') {
      const png = await getIcon(url.searchParams.get('type'));
      if (!png) return json(res, 404, { error: 'no icon' }), true;
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400' });
      res.end(png);
      return true;
    }
    if (req.method === 'POST' && p === '/api/open') {
      let body;
      try { body = await readJson(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }), true; }
      const r = await openPath(body.path);
      json(res, r.ok ? 200 : 400, r);
      return true;
    }
    if (req.method === 'GET' && p === '/api/tree') {
      const t = listTree(url.searchParams.get('path') || '');
      json(res, t ? 200 : 400, t || { error: 'bad path' });
      return true;
    }
    // Accounts: GET {active, accounts:[{id,label,missing}]} (no paths); POST /active {id} switches the whole deck.
    if (req.method === 'GET' && p === '/api/accounts') {
      json(res, 200, publicAccounts());
      return true;
    }
    if (req.method === 'POST' && p === '/api/accounts/active') {
      let body;
      try { body = await readJson(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }), true; }
      const r = setActiveAccount(body.id);
      if (!r.ok) return json(res, r.status, { ok: false, error: r.error }), true;
      closeAttachSessions(); // open Session terminals belong to the old account
      json(res, 200, { ok: true, ...publicAccounts() });
      return true;
    }
    if (req.method === 'GET' && p === '/api/config') {
      const st = readState();
      json(res, 200, { ...rootConfig(st), notify: notifyEnabled(st), demo: demoEnabled() });
      return true;
    }
    // Working folder of the ACTIVE account: POST /root {path} sets it, /root/pick opens the macOS chooser,
    // /root/setup copies templates/manager-root into it (never overwrites).
    if (req.method === 'POST' && (p === '/api/root' || p === '/api/root/pick' || p === '/api/root/setup')) {
      let body = {};
      if (p === '/api/root') { try { body = await readJson(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }), true; } }
      if (p === '/api/root') {
        const r = setRoot(body.path);
        return json(res, r.ok ? 200 : r.status, r.ok ? { ok: true, ...rootConfig() } : r), true;
      }
      if (p === '/api/root/pick') {
        const r = await pickFolder();
        return json(res, r.ok ? 200 : 501, r), true;
      }
      const r = setupActiveRoot();
      return json(res, r.ok ? 200 : r.status, r.ok ? { ...r, ...rootConfig() } : r), true;
    }
    // Setup wizard (server/setup.js), all for the ACTIVE account. GET /api/setup[?root=<typed folder>] = where it stands;
    // POST /preview plans without writing; POST /apply writes (and saves a changed working folder), then runs the health
    // check; POST /health re-runs it; POST /api/docs/pick opens the Finder chooser for the docs folder.
    if (req.method === 'GET' && p === '/api/setup') {
      json(res, 200, setupStatus({ candidate: url.searchParams.get('root') || null, demo: demoEnabled() }));
      return true;
    }
    if (req.method === 'POST' && (p === '/api/setup/preview' || p === '/api/setup/apply')) {
      let body;
      try { body = await readJson(req, 32 * 1024); } catch (e) { return json(res, 400, { ok: false, error: e.message }), true; }
      if (p === '/api/setup/preview') {
        const r = previewSetup(body);
        return json(res, r.ok ? 200 : r.status, r), true;
      }
      const r = applySetup(body);
      if (!r.ok) return json(res, r.status, r), true;
      // a changed working folder is saved only now, after everything was written there
      if (r.setRoot) { const sr = setRoot(r.setRoot); if (!sr.ok) return json(res, sr.status, sr), true; }
      const health = await runHealth();
      return json(res, 200, { ...r, ...rootConfig(), health }), true;
    }
    if (req.method === 'POST' && p === '/api/setup/health') {
      json(res, 200, await runHealth());
      return true;
    }
    if (req.method === 'POST' && p === '/api/docs/pick') {
      const r = await pickFolder({ prompt: 'Choose the docs folder for Dekki' });
      return json(res, r.ok ? 200 : 501, r), true;
    }
    if (req.method === 'POST' && p === '/api/prefs/notify') {
      let body;
      try { body = await readJson(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }), true; }
      if (typeof body.enabled !== 'boolean') return json(res, 400, { ok: false, error: 'enabled must be true or false' }), true;
      json(res, 200, { ok: true, notify: notifyEnabled(setNotifyPref(body.enabled)) });
      return true;
    }
    if (req.method === 'POST' && p === '/api/viewing') {
      let body;
      try { body = await readJson(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }), true; }
      if (!viewing.report(body.page, body.id ?? null, body.active, body.account ?? null)) return json(res, 400, { ok: false, error: 'page, id (8 hex or null), active (boolean) and optional account (account id) required' }), true;
      json(res, 200, { ok: true });
      return true;
    }
    if (req.method === 'POST' && p === '/api/agents') {
      let body;
      try { body = await readJson(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }), true; }
      const r = await startAgent(body);
      json(res, r.ok ? 200 : r.trust ? 409 : 400, r);
      return true;
    }
    const h = /^\/api\/agents\/([^/]+)\/history$/.exec(p);
    if (h && req.method === 'GET') {
      if (!isAgentId(h[1])) return json(res, 400, { error: 'bad agent id' }), true;
      const found = await loadHistory(h[1]);
      json(res, found.status === 'unknown' ? 404 : 200, found.status === 'ok' ? { status: 'ok', meta: found.meta, entries: found.entries } : { status: found.status });
      return true;
    }
    // Skill / tool usage, derived from the transcripts (read-only): per session, and all-time per skill.
    const sx = /^\/api\/agents\/([^/]+)\/stats$/.exec(p);
    if (sx && req.method === 'GET') {
      if (!isAgentId(sx[1])) return json(res, 400, { error: 'bad agent id' }), true;
      const agent = (await listAgents()).find((a) => a.id === sx[1]);
      if (!agent) return json(res, 404, { error: 'agent not found' }), true;
      const file = agent.sessionId ? findTranscript(agent.sessionId) : null;
      const cached = file ? sessionStats(file) : null;
      // A running agent's duration is measured to now at request time (the cached value stops at its last record,
      // which lags while it works silently: long tool call, sub-agents writing to their own files).
      const stats = cached && liveStats(cached, agent);
      json(res, 200, stats ? { status: 'ok', stats } : { status: 'expired' });
      return true;
    }
    // Changes tab (server/changes.js): what the agent changed in its git worktree. Read-only git only.
    // GET /changes?scope=all|uncommitted, GET /changes/file?path=<relative>&scope=...
    const ch = /^\/api\/agents\/([^/]+)\/changes(\/file)?$/.exec(p);
    // GET /api/agents/:managerId/changes/workers?ids=<worker ids, comma separated>&scope=...: the manager's own worktree
    // (if it has one) plus each listed worker. Ids must be known agents; unknown ones are ignored.
    const cw = /^\/api\/agents\/([^/]+)\/changes\/workers$/.exec(p);
    if (cw && req.method === 'GET') {
      if (!isAgentId(cw[1])) return json(res, 400, { error: 'bad agent id' }), true;
      const scope = url.searchParams.get('scope') === 'uncommitted' ? 'uncommitted' : 'all';
      const all = await listAgents();
      const manager = all.find((a) => a.id === cw[1]);
      if (!manager) return json(res, 404, { error: 'agent not found' }), true;
      const want = new Set((url.searchParams.get('ids') || '').split(',').filter(isAgentId));
      const entries = [];
      if (manager.worktreePath) entries.push({ id: manager.id, name: manager.name, role: 'manager', dir: manager.worktreePath });
      for (const a of all) if (want.has(a.id) && a.id !== manager.id) entries.push({ id: a.id, name: a.name, role: 'worker', dir: agentDir(a) });
      json(res, 200, await listGroupChanges(entries, scope));
      return true;
    }
    if (ch && req.method === 'GET') {
      if (!isAgentId(ch[1])) return json(res, 400, { error: 'bad agent id' }), true;
      const scope = url.searchParams.get('scope') === 'uncommitted' ? 'uncommitted' : 'all';
      const agent = (await listAgents()).find((a) => a.id === ch[1]);
      if (!agent) return json(res, 404, { error: 'agent not found' }), true;
      if (ch[2]) {
        const r = await fileDiff(agentDir(agent), url.searchParams.get('path'), scope);
        return json(res, r.status === 'bad-path' ? 400 : r.status === 'error' ? 502 : 200, r), true;
      }
      json(res, 200, await listChanges(agentDir(agent), scope));
      return true;
    }
    if (req.method === 'GET' && p === '/api/skills') {
      json(res, 200, skillAggregate({ project: url.searchParams.get('project') || '', root: activeRoot() || '' }));
      return true;
    }
    const rc = /^\/api\/agents\/([^/]+)\/remove-check$/.exec(p);
    if (rc && req.method === 'GET') {
      const c = await removeCheck(rc[1]);
      json(res, c ? 200 : 404, c || { error: 'Agent not found.' });
      return true;
    }
    const st = /^\/api\/agents\/([^/]+)\/stop$/.exec(p);
    if (st && req.method === 'POST') {
      const r = await stopAgent(st[1]);
      json(res, r.status, r);
      return true;
    }
    const rm = /^\/api\/agents\/([^/]+)$/.exec(p);
    if (rm && req.method === 'DELETE' && url.searchParams.get('draft') === '1') {
      json(res, 200, await discardDraft(rm[1]));
      return true;
    }
    if (rm && req.method === 'DELETE') {
      const r = await removeAgent(rm[1], { discard: url.searchParams.get('discard') === '1' });
      json(res, r.status, r);
      return true;
    }
    // POST /api/agents/:id/name {name}: deck-only display name (empty clears it); never touches the agent.
    const nm = /^\/api\/agents\/([^/]+)\/name$/.exec(p);
    if (nm && req.method === 'POST') {
      if (!isAgentId(nm[1])) return json(res, 400, { error: 'bad agent id' }), true;
      try {
        const b = await readJson(req);
        json(res, 200, { ok: true, name: setName(nm[1], b.name).names[nm[1]] ?? null });
      } catch (e) {
        json(res, 400, { error: e.message });
      }
      return true;
    }
    // Saved prompts (server/prompts.js): GET list; POST save {path, body, baseMtime?, create?}; POST /move {from, to};
    // POST /folder {path}; POST /reveal {path?} or {trash:true} (Show in Finder); DELETE ?path= moves to the folder's .trash.
    // POST /improve {path, focus?}: save a copy into .trash, then start an agent in the prompts folder that helps improve that prompt.
    if (p === '/api/prompts' || p === '/api/prompts/move' || p === '/api/prompts/folder' || p === '/api/prompts/reveal' || p === '/api/prompts/improve') {
      const fail = (e) => json(res, e instanceof PromptError ? e.status : 400, { error: e.message });
      try {
        if (req.method === 'GET' && p === '/api/prompts') json(res, 200, listPrompts());
        else if (req.method === 'DELETE' && p === '/api/prompts') json(res, 200, trashPrompt(url.searchParams.get('path')));
        else if (req.method === 'POST') {
          const b = await readJson(req, MAX_BYTES + 4096);
          if (p === '/api/prompts') json(res, 200, { ok: true, ...savePrompt(b.path, b.body, { baseMtime: b.baseMtime, create: b.create === true }) });
          else if (p === '/api/prompts/move') json(res, 200, movePrompt(b.from, b.to));
          else if (p === '/api/prompts/reveal') json(res, 200, b.trash === true ? await revealTrash() : await revealPrompt(b.path));
          else if (p === '/api/prompts/improve') {
            const r = await startImprover(b.path, b.focus);
            json(res, r.ok ? 200 : r.trust ? 409 : 400, r);
          }
          else json(res, 200, makeFolder(b.path));
        } else return false;
      } catch (e) {
        fail(e);
      }
      return true;
    }
    // POST/DELETE /api/agents/:id/(pin|archive|mine): hide/pin/move in the deck only; never touches the agent.
    // mine: POST = show in my list, DELETE = move to Other agents.
    const m = /^\/api\/agents\/([^/]+)\/(pin|archive|mine)$/.exec(p);
    if (m && (req.method === 'POST' || req.method === 'DELETE')) {
      if (!isAgentId(m[1])) return json(res, 400, { error: 'bad agent id' }), true;
      const on = req.method === 'POST';
      if (m[2] === 'mine') {
        setMember('others', m[1], !on);
        json(res, 200, prefsOf(setMember('owned', m[1], on)));
        return true;
      }
      const s = m[2] === 'pin' ? setPinned(m[1], on) : setArchived(m[1], on); // archive drops the pin; pin un-archives
      json(res, 200, prefsOf(s));
      return true;
    }
    return false;
  };
}
