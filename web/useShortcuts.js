import { useEffect, useRef } from 'react';
import { keyMode, stepId, panelFor, IS_MAC } from './shortcuts.js';
import { overlayCount } from './overlay-stack.js';

// The one keyboard layer. Whether a key may act is decided by the pure keyMode() (shortcuts.js): letters never act while an
// input / textarea / select / contenteditable / the terminal has focus, nor with Cmd/Ctrl/Alt; Cmd+K, Cmd+1..9, Cmd+B and Cmd+Shift+S / P (toggle the folder tree, skill usage, saved prompts) work anywhere.
// Esc is not here: every popup registers in overlay-stack.js through useEscape, and its one capture handler closes the top-most one.
// handlers: { onPalette(), onNext(), onNew(), onHelp(), onNumber(n), onPanel('tree'|'skills'|'prompts'), onSelect(id), selectedId }.
export default function useShortcuts(handlers) {
  const h = useRef(handlers);
  h.current = handlers;
  useEffect(() => {
    const move = (dir) => {
      const ids = [...document.querySelectorAll('.list .row[data-id]')].filter((el) => el.offsetParent !== null).map((el) => el.dataset.id);
      const id = stepId(ids, h.current.selectedId, dir);
      if (id == null) return;
      h.current.onSelect(id);
      requestAnimationFrame(() => document.querySelector('.list .row.selected')?.scrollIntoView({ block: 'nearest' }));
    };
    const onKey = (e) => {
      const mode = keyMode(e, { isMac: IS_MAC });
      if (!mode) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (mode === 'mod') {
        if (k === 'k') { e.preventDefault(); h.current.onPalette(true); }
        else if (/^[1-9]$/.test(k) && !e.shiftKey && !overlayCount()) { e.preventDefault(); h.current.onNumber(Number(k)); }
        else {
          const panel = panelFor(k, e.shiftKey); // the skills and prompts panels are overlays themselves, so onPanel decides whether another overlay blocks it
          if (panel) { e.preventDefault(); h.current.onPanel(panel); }
        }
        return;
      }
      if (overlayCount()) return; // a dialog or the palette is open: its own keys only
      if (k === '/') { e.preventDefault(); h.current.onPalette(false); }
      else if (k === 'j') { e.preventDefault(); move(1); }
      else if (k === 'k') { e.preventDefault(); move(-1); }
      else if (k === 'n') { e.preventDefault(); h.current.onNext(); }
      else if (k === 'c') { e.preventDefault(); h.current.onNew(); }
      else if (k === '?') { e.preventDefault(); h.current.onHelp(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
