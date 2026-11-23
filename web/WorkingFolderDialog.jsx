import React, { useEffect, useState } from 'react';
import Dialog from './Dialog.jsx';

// Change the working folder of the active account (where New agent starts the manager). Pick or type a folder and save it.
// A folder without the manager setup offers the setup wizard (onSetup). Each account has its own folder.
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }));

export default function WorkingFolderDialog({ onClose, onChanged, onSetup }) {
  const [cfg, setCfg] = useState(null);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = () => fetch('/api/config').then((r) => r.json()).then((b) => { setCfg(b); return b; }).catch(() => null);
  useEffect(() => { load(); }, []);

  async function choose() {
    setErr(null);
    const r = await post('/api/root/pick');
    if (!r.ok) setErr(r.body.error || 'Could not open the folder chooser.');
    else if (r.body.path) setPath(r.body.path);
  }
  async function save(e) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const r = await post('/api/root', { path });
    setBusy(false);
    if (!r.ok) return setErr(r.body.error || 'Could not save.');
    setCfg(r.body); setPath('');
    onChanged && onChanged();
  }
  return (
    <Dialog title={`Working folder${cfg?.rootAccount ? ` (${cfg.rootAccount})` : ''}`} top onClose={onClose} onSubmit={save} actions={<button type="button" onClick={onClose}>Close</button>}>
        <div className="hint">
          New agents start the manager here. It should be the folder that holds your projects. Each account has its own working folder.
        </div>
        <div>Current: {cfg?.root ? <code style={{ wordBreak: 'break-all' }}>{cfg.root}</code> : <i>none yet</i>}</div>
        <label>
          Folder path
          <input type="text" autoFocus value={path} placeholder="/path/to/folder or ~/folder" onChange={(e) => setPath(e.target.value)} />
        </label>
        <div className="actions" style={{ justifyContent: 'flex-start' }}>
          <button type="button" onClick={choose}>Choose folder…</button>
          <button type="submit" className="primary" disabled={busy || !path.trim()}>Save</button>
        </div>
        {cfg?.root && !cfg.rootReady && onSetup && (
          <div className="hint">
            This folder has no manager setup yet (missing: {cfg.rootMissing.map((m) => <code key={m}>{m}</code>).reduce((a, b) => [a, ', ', b])}).
            The setup wizard adds a manager playbook and the delegate scripts. Files that already exist are never overwritten.
            <div style={{ marginTop: 6 }}><button type="button" disabled={busy} onClick={onSetup}>Set up with the wizard…</button></div>
          </div>
        )}
        {err && <div className="err">{err}</div>}
    </Dialog>
  );
}
