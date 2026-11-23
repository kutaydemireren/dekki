import React, { useEffect, useMemo, useRef, useState } from 'react';
import useEscape from './useEscape.js';
import StatusGlyph from './StatusGlyph.jsx';
import { glyphState } from './AgentList.jsx';
import { projectLabel } from './skills-sort.js';
import { paletteItems, moveIndex } from './palette.js';

const ActionIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3 5 14h6l-1 7 8-11h-6z" /></svg>
);

// Command palette: jump to any agent (workers included) or run an action. Matching of agents is search.js (name, project, id).
// `actions`: [{id, label, keys?: 'C', keywords?, disabled?, run()}]. Enter runs the highlighted row and closes the palette.
export default function Palette({ agents, actions, onSelectAgent, onClose }) {
  useEscape(onClose);
  const [query, setQuery] = useState('');
  const [idx, setIdx] = useState(0);
  const [rootProject, setRootProject] = useState('');
  const activeRef = useRef(null);
  useEffect(() => { fetch('/api/config').then((r) => r.json()).then((b) => setRootProject(String(b.root || '').split('/').filter(Boolean).pop() || '')).catch(() => {}); }, []);

  const items = useMemo(() => paletteItems(agents, actions, query), [agents, actions, query]);
  const cur = Math.min(idx, Math.max(0, items.length - 1));
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest' }); }, [cur, items.length]);

  const run = (it) => {
    if (!it) return;
    onClose();
    if (it.kind === 'agent') onSelectAgent(it.agent.id);
    else it.action.run();
  };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(moveIndex(cur, items.length, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(moveIndex(cur, items.length, -1)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(items[cur]); }
  };

  let n = -1;
  const row = (it) => {
    const k = ++n;
    const on = k === cur;
    return (
      <button key={it.key} ref={on ? activeRef : null} className={`it${on ? ' hl' : ''}`} role="option" aria-selected={on} onMouseMove={() => k !== cur && setIdx(k)} onClick={() => run(it)}>
        {it.kind === 'agent' ? <StatusGlyph state={glyphState(it.agent)} /> : <ActionIcon />}
        <span className="nm">{it.kind === 'agent' ? it.agent.name : it.action.label}</span>
        <span className="m">
          {it.kind === 'agent' ? projectLabel(it.agent.label, rootProject) : it.action.keys && <kbd>{it.action.keys}</kbd>}
        </span>
      </button>
    );
  };
  const agentItems = items.filter((i) => i.kind === 'agent');
  const actionItems = items.filter((i) => i.kind === 'action');
  return (
    <div className="pal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pal" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          type="text"
          autoFocus
          value={query}
          placeholder="Jump to an agent or run an action…"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded="true"
          aria-controls="pal-res"
          onChange={(e) => { setQuery(e.target.value); setIdx(0); }}
          onKeyDown={onKeyDown}
        />
        <div className="res" id="pal-res" role="listbox">
          {agentItems.length > 0 && <div className="gl">Agents</div>}
          {agentItems.map(row)}
          {actionItems.length > 0 && <div className="gl">Actions</div>}
          {actionItems.map(row)}
          {!items.length && <div className="pal-empty">No matches</div>}
        </div>
        <div className="foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>
      </div>
    </div>
  );
}
