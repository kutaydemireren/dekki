import React, { useEffect, useRef, useState } from 'react';
import useEscape from './useEscape.js';
import { addAccountExample, accountRows } from './accounts-ui.js';

function CopyBox({ text, label }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked: the text is selectable */ }
  };
  return (
    <div className="acct-code">
      <code>{text}</code>
      <button type="button" className="btn" aria-label={`Copy: ${label}`} onClick={copy}>{done ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

// Small popover anchored to the quiet Accounts button on the home screen. Closes on Esc (overlay stack) and outside click.
// 2+ accounts: pick one (same switch flow as the sidebar menu), plus a collapsed "Add another account" row. One account: how to add another, open.
export default function AccountsPopover({ accounts, active, colors, onSwitch, onClose }) {
  useEscape(onClose);
  const ref = useRef(null);
  const multi = accounts.length > 1;
  const [addOpen, setAddOpen] = useState(!multi);
  const ex = addAccountExample(accounts.length);
  const addBody = (
    <>
      <p>{multi ? 'To add another Claude account, run this in a terminal in the Dekki folder (the name and folder are only an example):' : 'Only one Claude account is connected. To add another, run this in a terminal in the Dekki folder:'}</p>
      <CopyBox text={ex.addCmd} label="add account command" />
      <p>The new account needs its own Claude login:</p>
      <CopyBox text={ex.loginCmd} label="login command" />
      <p className="small">{multi ? 'Then reload this page. The new account appears in this list.' : 'Then reload this page. The account switcher appears.'}</p>
    </>
  );
  useEffect(() => {
    const down = (e) => { if (ref.current && !ref.current.contains(e.target) && !e.target.closest?.('.acct-quiet')) onClose(); };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [onClose]);
  useEffect(() => { ref.current?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true }); }, []);
  const onKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...ref.current.querySelectorAll('[role="menuitemradio"]:not(:disabled)')];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  };
  return (
    <div className="acct-pop" ref={ref} role={multi ? 'menu' : 'dialog'} aria-label="Claude accounts" onKeyDown={onKeyDown}>
      {multi ? (
        <>
          {accountRows(accounts, active).map((r, i) => (
            <button key={r.id} type="button" role="menuitemradio" aria-checked={r.current} className={`acct-row${r.current ? ' cur' : ''}`} disabled={r.disabled}
              onClick={() => (r.current ? onClose() : onSwitch(r.id))}>
              <span className="account-dot" style={{ '--account': colors[i % colors.length] }} />
              <span className="nm">{r.label}</span>
              {r.note && <span className="note">{r.note}</span>}
              {r.current && <span className="tick" aria-hidden="true">✓</span>}
            </button>
          ))}
          <div className="acct-add">
            <button type="button" className="acct-add-toggle" aria-expanded={addOpen} aria-controls="acct-add-body" onClick={() => setAddOpen((v) => !v)}>
              <span className="chev" aria-hidden="true">›</span>Add another account
            </button>
            {addOpen && <div className="acct-help" id="acct-add-body">{addBody}</div>}
          </div>
        </>
      ) : (
        <div className="acct-help" id="acct-add-body">{addBody}</div>
      )}
    </div>
  );
}
