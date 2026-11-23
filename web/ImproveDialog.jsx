import React, { useState } from 'react';
import Dialog from './Dialog.jsx';

// "Improve with Claude": starts a normal agent in the prompts folder that helps you rework one prompt. It asks you
// (with Claude's ask prompt) when unsure and shows the new version before saving. Optional note = what you want.
export default function ImproveDialog({ path, dirty, onSave, onClose, onStarted }) {
  const [focus, setFocus] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (dirty && !(await onSave())) throw new Error('Could not save your edits first.');
      const res = await fetch('/api/prompts/improve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, focus: focus.trim() || undefined }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) setErr(body);
      else onStarted(body.id);
    } catch (e2) {
      setErr({ error: e2.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Improve with Claude" onClose={onClose} onSubmit={submit} actions={(
      <>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="primary" disabled={busy}>{busy ? 'Starting…' : 'Start'}</button>
      </>
    )}>
        <div className="hint">
          Starts a new agent on <code>{path}</code>. It asks you when it is unsure, shows the improved version in the chat, and saves it only after you say yes.
          A copy of the current version goes to <code>.trash</code> first.{dirty && <> Your unsaved edits are saved first.</>}
        </div>
        <label>
          What should it focus on? (optional)
          <textarea
            autoFocus
            rows={3}
            value={focus}
            placeholder="e.g. make it shorter, add acceptance criteria, keep the tone"
            onChange={(e) => setFocus(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(e); }}
          />
        </label>
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
