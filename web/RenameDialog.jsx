import React, { useState } from 'react';
import Dialog from './Dialog.jsx';

// Deck-only name: saved in the deck's state, Claude's own name is untouched. Empty = back to Claude's name.
export default function RenameDialog({ agent, onClose, onSaved }) {
  const [name, setName] = useState(agent.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/agents/${agent.id}/name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onSaved();
    } catch (e2) {
      setErr(e2.message);
      setBusy(false);
    }
  }

  return (
    <Dialog title="Rename chat" onClose={onClose} onSubmit={submit} actions={(
      <>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="primary" disabled={busy}>Save</button>
      </>
    )}>
        <div className="hint">
          Only changes the name shown in Dekki. Claude keeps calling it <code>{agent.claudeName}</code>; leave this empty to use that name.
        </div>
        <label>
          Name
          <input type="text" autoFocus maxLength={80} value={name} onFocus={(e) => e.target.select()} onChange={(e) => setName(e.target.value)} />
        </label>
        {err && <div className="err">{err}</div>}
    </Dialog>
  );
}
