import React, { useState } from 'react';
import Dialog from './Dialog.jsx';

// The deck's own yes/no popup (used instead of the browser's native confirm). onConfirm may be async; an error it
// throws is shown in the dialog. Esc and Cancel close it.
export default function ConfirmDialog({ title, text, confirmLabel, onConfirm, onClose }) {
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try { await onConfirm(); } catch (x) { setErr(x.message); setBusy(false); }
  }
  return (
    <Dialog
      title={title}
      onClose={onClose}
      actions={(
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary danger" disabled={busy} onClick={go}>{confirmLabel}</button>
        </>
      )}
    >
      <div>{text}</div>
      {err && <div className="err">{err}</div>}
    </Dialog>
  );
}
