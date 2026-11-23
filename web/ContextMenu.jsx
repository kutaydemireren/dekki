import React, { useEffect } from 'react';
import useEscape from './useEscape.js';

// items: [{label, onClick, danger?, disabled?}]. Closes on any click, Esc (overlay stack), scroll or resize.
export default function ContextMenu({ x, y, items, onClose }) {
  useEscape(onClose);
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('resize', close);
    };
  }, [onClose]);

  // keep the menu on screen
  const left = Math.min(x, window.innerWidth - 190);
  const top = Math.min(y, window.innerHeight - items.length * 30 - 16);
  return (
    <div className="ctx-menu" style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it) => (
        <div
          key={it.label}
          className={`ctx-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}`}
          onClick={() => it.onClick()}
        >
          {it.label}
        </div>
      ))}
    </div>
  );
}
