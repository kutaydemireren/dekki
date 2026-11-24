// Pure logic of the keyboard layer (web/useShortcuts.js): may a key event act, and which agent a key moves to.
import { nest, groupAgents } from './groups.js';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
export const MOD = IS_MAC ? '⌘' : 'Ctrl+'; // label of the Cmd/Ctrl key in hints
export const SHIFT = IS_MAC ? '⇧' : 'Shift+';

const isEditable =(t) => {
  if (!t) return false;
  const tag = String(t.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return true;
  return !!(t.closest && t.closest('.xterm')); // the terminal's helper textarea is a TEXTAREA already; this covers its canvas too
};

/** Decide what a keydown may do. Returns 'plain' (a letter or ? shortcut), 'mod' (Cmd/Ctrl + key) or null (ignore).
 *  - plain: no Cmd/Ctrl/Alt (Shift allowed, for '?'), and the focus is not an input, textarea, select, contenteditable or the terminal.
 *  - mod: Cmd (Mac) or Ctrl (elsewhere), no Alt. Acts even while typing, except Ctrl in the terminal (shell keys like Ctrl+K). */
export function keyMode(e, { isMac = true } = {}) {
  if (!e || e.isComposing || e.defaultPrevented) return null;
  const t = e.target;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const other = isMac ? e.ctrlKey : e.metaKey;
  if (e.altKey) return null;
  if (mod) {
    if (other) return null;
    if (!isMac && t && t.closest && t.closest('.xterm')) return null;
    return 'mod';
  }
  if (other) return null;
  return isEditable(t) ? null : 'plain';
}

/** Which toolbar panel a Cmd/Ctrl+key toggles: B folder tree, Shift+S skill usage, Shift+P saved prompts; null for any other key. */
export function panelFor(key, shiftKey) {
  const k = String(key || '').toLowerCase();
  if (k === 'b' && !shiftKey) return 'tree';
  if (k === 's' && shiftKey) return 'skills';
  if (k === 'p' && shiftKey) return 'prompts';
  return null;
}

/** Id `dir` steps (+1 / -1) from `current` in `ids` (no wrap). Nothing selected: first (dir +1) or last (dir -1). */
export function stepId(ids, current, dir) {
  if (!ids.length) return null;
  const i = ids.indexOf(current);
  if (i < 0) return dir > 0 ? ids[0] : ids[ids.length - 1];
  return ids[Math.min(ids.length - 1, Math.max(0, i + dir))];
}

/** The id after `selectedId` among top-level agents that need you (wraps), or null when none. */
export function nextNeedingId(agents, prefs, selectedId) {
  const needs = groupAgents(nest(agents, prefs.archived).top, prefs)['Needs input'];
  if (!needs.length) return null;
  const i = needs.findIndex((a) => a.id === selectedId);
  return needs[(i + 1) % needs.length].id;
}

/** Agent ids for Cmd+1..9, in the order the list shows them: every top-level row in "Needs you" (pinned or not),
 *  then the rows of the Pinned section. At most 9. */
export function shortcutOrder(agents, prefs) {
  const groups = groupAgents(nest(agents, prefs.archived).top, prefs);
  return [...groups['Needs input'], ...groups.Pinned].map((a) => a.id).slice(0, 9);
}
