import React, { useEffect, useRef } from 'react';
import useEscape from './useEscape.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// The one dialog shell: blurred backdrop, pop-in, title, content, actions row. Esc (top-most only) and a click on the backdrop
// close it. Focus: an `autoFocus` field inside keeps it, else the first control; Tab stays inside; on close focus returns to
// where it was. `onSubmit` makes the shell a <form> (Enter submits). `top` = anchored near the top (dialogs whose height changes).
export default function Dialog({ title, onClose, onSubmit, top = false, className = '', actions, children }) {
  useEscape(onClose);
  const ref = useRef(null);
  useEffect(() => {
    const before = document.activeElement;
    const root = ref.current;
    if (root && !root.contains(document.activeElement)) (root.querySelector(FOCUSABLE) || root).focus();
    return () => { if (before && before.isConnected && typeof before.focus === 'function') before.focus(); };
  }, []);
  const trap = (e) => {
    if (e.key !== 'Tab') return;
    const items = [...ref.current.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const Tag = onSubmit ? 'form' : 'div';
  return (
    <div className="dialog-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <Tag ref={ref} className={`dialog${top ? ' top' : ''}${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} tabIndex={-1} onKeyDown={trap} onSubmit={onSubmit}>
        <h3>{title}</h3>
        {children}
        {actions && <div className="actions">{actions}</div>}
      </Tag>
    </div>
  );
}
