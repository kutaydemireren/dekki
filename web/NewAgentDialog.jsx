import React, { useEffect, useRef, useState } from 'react';
import Dialog from './Dialog.jsx';
import WorkingFolderDialog from './WorkingFolderDialog.jsx';
import SetupWizard from './SetupWizard.jsx';
import { stripFrontmatter, fieldsOf, render } from './prompt-text.js';

// New agent = always the manager, started in the projects root. You describe what you want in the terminal
// that opens next (slash commands, @files and autocomplete work exactly as in `claude`); the manager works
// out which projects are involved (one, several or all) and runs a worker in each. Only a name is asked here.
export default function NewAgentDialog({ onClose, onCreated, onRootChanged }) {
  const [root, setRoot] = useState(null); // null = still loading, '' = this account has no working folder yet
  const [folderOpen, setFolderOpen] = useState(false);
  const [wizard, setWizard] = useState(false); // the setup wizard (first setup, or "Set up" from the folder dialog)
  const [ready, setReady] = useState(true); // the working folder has the playbook and scripts
  const [demo, setDemo] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const rootRef = useRef('');

  const [items, setItems] = useState([]); // saved prompts, for the optional "start from" picker
  const [pick, setPick] = useState('');
  const [values, setValues] = useState({});

  const loadRoot = () => fetch('/api/config').then((r) => r.json()).then((b) => { setRoot(b.root || ''); setReady(b.rootReady !== false); setDemo(b.demo === true); }).catch(() => {});
  useEffect(() => { if (root === '') setWizard(true); }, [root]); // once opened for a missing folder it stays until closed: the health result is its last screen
  useEffect(() => {
    loadRoot();
    fetch('/api/prompts').then((r) => r.json()).then((b) => setItems(b.items || [])).catch(() => {});
  }, []);

  const chosen = items.find((i) => i.path === pick) || null;
  const fields = chosen ? fieldsOf(stripFrontmatter(chosen.body)) : [];
  function choose(path) {
    setPick(path);
    const it = items.find((i) => i.path === path);
    setValues(it ? Object.fromEntries(fieldsOf(stripFrontmatter(it.body)).map((f) => [f.name, f.def ?? ''])) : {});
  }
  // Picker rows grouped by folder (top-level prompts first).
  const groups = [];
  for (const it of items) {
    const dir = it.path.includes('/') ? it.path.slice(0, it.path.lastIndexOf('/')) : '';
    let g = groups.find((x) => x.dir === dir);
    if (!g) groups.push((g = { dir, items: [] }));
    g.items.push(it);
  }
  groups.sort((a, b) => (a.dir === '' ? -1 : b.dir === '' ? 1 : 0));

  async function submit(e) {
    e.preventDefault();
    const prompt = chosen ? render(chosen.body, values) : undefined;
    if (prompt && prompt.length > 20000) { setErr({ error: 'That prompt is too long to start an agent with (20,000 characters max).' }); return; }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() || undefined, prompt }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) setErr(body);
      else onCreated(body.id, !!prompt);
    } catch (e2) {
      setErr({ error: e2.message });
    } finally {
      setBusy(false);
    }
  }

  // No working folder for this account yet: the setup wizard replaces the start form (never falls back to another account's folder).
  if (wizard || root === '') {
    return <SetupWizard onClose={() => { setWizard(false); if (!rootRef.current && !root) onClose(); }} onChanged={(r) => { rootRef.current = r.root || rootRef.current; setRoot(r.root || ''); loadRoot(); onRootChanged && onRootChanged(); }} />;
  }
  if (folderOpen) {
    return <WorkingFolderDialog onClose={() => setFolderOpen(false)} onSetup={() => { setFolderOpen(false); setWizard(true); }} onChanged={() => { loadRoot(); onRootChanged && onRootChanged(); }} />;
  }

  return (
    <Dialog title="New manager agent" top onClose={onClose} onSubmit={submit} actions={(
      <>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="primary" disabled={busy}>{busy ? 'Starting…' : 'Start'}</button>
      </>
    )}>
        <div className="hint">
          Starts the manager{root && <> in <code>{root}</code></>}{root && <> (<a href="#" onClick={(e) => { e.preventDefault(); setFolderOpen(true); }}>Change</a>)</>}. Describe what you want in the terminal that opens next: the manager works out which
          projects are involved (one, several or all) and runs a worker in each. Slash commands, @files and autocomplete work as in <code>claude</code>.
        </div>
        {!ready && !demo && (
          <div className="hint">This folder is not set up yet, so the manager has no playbook. <a href="#" onClick={(e) => { e.preventDefault(); setWizard(true); }}>Set it up</a></div>
        )}
        <label>
          Name (optional)
          <input type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {items.length > 0 && (
          <label>
            Start from a saved prompt (optional)
            <select value={pick} onChange={(e) => choose(e.target.value)}>
              <option value="">None: I'll type it in the terminal</option>
              {groups.map((g) => {
                const opts = g.items.map((it) => <option key={it.path} value={it.path}>{it.name}</option>);
                return g.dir ? <optgroup key={g.dir} label={g.dir}>{opts}</optgroup> : opts;
              })}
            </select>
          </label>
        )}
        {chosen && (
          <div className="hint">It is sent to the manager as the first message, right after the agent starts.</div>
        )}
        {fields.map((f) => (
          <label key={f.name}>
            {f.name}
            <input type="text" value={values[f.name] ?? ''} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
          </label>
        ))}
        {err && (
          <div className="err">
            {err.trust && (
              <>
                <b>{err.trustMessage}</b>
                {err.trustCommand && <code className="trust-cmd">{err.trustCommand}</code>}
              </>
            )}
            {err.error}
          </div>
        )}
    </Dialog>
  );
}
