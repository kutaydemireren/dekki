import React, { useEffect, useRef, useState } from 'react';
import { projectLabel } from './skills-sort.js';
import { GROUPS, groupAgents, nest, age } from './groups.js';
import { searchVisible } from './search.js';
import { groupByProject, parseMode } from './project-groups.js';
import { MOD } from './shortcuts.js';
import StatusGlyph from './StatusGlyph.jsx';
import { PlusIcon } from './icons.jsx';
import { useListMotion, Tick } from './motion.jsx';

// Group names stay as groups.js has them; these are the labels shown.
const GROUP_LABEL = { 'Needs input': 'Needs you', Running: 'Working' };

export function glyphState(a) {
  if (a.stalled) return 'stalled';
  if (a.state === 'working') return 'working';
  if (a.needsInput) return 'needs';
  if (a.state === 'failed') return 'failed';
  if (a.state === 'stopped') return 'stopped';
  return 'done';
}

// Every badge the row could have, in priority order: needs-input > stalled > failed > no report > quiet > draft.
// The row shows only the first one; all of them are listed in the tooltip. A needs-input row shows none: its glyph
// and its question line already say it, but it still wins the priority (the others go to the tooltip).
function badgesOf(a, draft) {
  const out = [];
  if (a.needsInput && !a.stalled) out.push({ text: 'needs input', cls: 'amber', tip: 'Waiting for your answer.', hidden: true });
  if (a.stalled) out.push({ text: 'stalled', cls: 'amber', tip: 'Its turn ended and every linked worker has finished. Nothing will wake it. Send it a message.' });
  if (a.state === 'failed' && !a.stalled) out.push({ text: 'failed', cls: 'red', tip: 'The agent failed.' });
  if (a.noReport) out.push({ text: 'no report', cls: 'red', tip: 'It ended (done or stopped) without a result: / needs input: / failed: line in its last message. It may have died silently.' });
  if (a.quiet) out.push({ text: 'quiet', cls: 'amber', tip: `Working, but no transcript activity for over ${a.quietMinutes} minutes (last ${age(a.lastActivityAt)} ago). It may be stuck.` });
  if (draft) out.push({ text: 'draft', cls: 'dim', tip: 'Empty: it disappears if you leave it without sending a prompt.' });
  return out;
}

// The third line, only for a row that needs you or is stalled: the question / the reason.
function askText(a) {
  if (!(a.needsInput || a.stalled)) return null;
  if (a.workerResultAt && (a.stalled || a.detailStale)) return `worker ${a.workerResult} finished ${age(a.workerResultAt)} ago${a.stalled ? ': waiting on it, nothing will wake this agent' : ''}`;
  if (a.detail) return a.detailStale ? `(older) ${a.detail}` : a.detail;
  return a.stalled ? 'Nothing will wake it. Send it a message.' : null;
}

const Chevron = ({ open }) => (
  <svg className={`chev${open ? ' open' : ''}`} viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 6.5 5 3 8.5" /></svg>
);
const PinIcon = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.8 2.2l4 4-1.7.8-2.3 2.3.4 2.4-1 1-2.9-2.9L3 13.3l-.3-.3 3.5-3.5-2.9-2.9 1-1 2.4.4 2.3-2.3z" />
  </svg>
);

const segClass = (w) => (w.state === 'working' ? 'working' : w.needsInput ? 'blocked' : w.state === 'failed' ? 'failed' : w.state === 'stopped' ? 'stopped' : 'done');

// Manager line: one bar segment per worker (colour = state), the manager's one-line status text, a chevron that opens the workers.
function ManagerLine({ status, workers, open, onToggle }) {
  const text = status?.text || status?.tally || `${workers.length} worker${workers.length === 1 ? '' : 's'}`;
  const tip = [status?.tally, ...(status?.names || workers.map((w) => w.name))].filter(Boolean).join('\n');
  return (
    <div className={`mgr${onToggle ? ' toggle' : ''}`} title={`${onToggle ? (open ? 'Hide workers' : 'Show workers') : 'Matching workers'}\n${tip}`} onClick={onToggle ? (e) => { e.stopPropagation(); onToggle(); } : undefined}>
      {workers.length > 0 && <span className="wbar">{workers.map((w) => <i key={w.id} className={segClass(w)} title={`${w.name}: ${segClass(w)}`} />)}</span>}
      <span className={`mgr-text${status?.kind ? ` ${status.kind}` : ''}`}>{text}</span>
      {onToggle && <Chevron open={open} />}
    </div>
  );
}

function Row({ agent, selected, onSelect, pinned, unread, draft, onContext, child, mgr, rootProject }) {
  const badges = badgesOf(agent, draft);
  const shown = badges[0] && !badges[0].hidden ? badges[0] : null;
  const ask = askText(agent);
  const label = projectLabel(agent.label, rootProject);
  const tip = [
    `${agent.name}${label ? ` · ${label}` : ''}`,
    `State: ${agent.stalled ? 'stalled' : agent.state}${agent.needsInput ? ' (needs input)' : ''}`,
    ...badges.map((b) => `${b.text}: ${b.tip}`),
    agent.detail && !ask ? agent.detail : null,
  ].filter(Boolean).join('\n');
  return (
    <div
      data-id={agent.id}
      className={`row${selected ? ' selected' : ''}${unread ? ' unread' : ''}${child ? ' child' : ''}`}
      title={tip}
      data-flip-id={agent.id}
      data-gs={glyphState(agent)}
      onClick={() => onSelect(agent.id)}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContext(e, agent); }}
    >
      <StatusGlyph state={glyphState(agent)} />
      <div className="nm">
        {pinned && <span className="pin" title="Pinned"><PinIcon /></span>}
        <b className="row-name">{agent.name}</b>
        {shown && <span className={`tag ${shown.cls}`}>{shown.text}</span>}
      </div>
      <div className="age">{unread && <span className="udot" title="New activity since you last looked" />}{age(agent.lastActivityAt)}</div>
      {!child && <div className="meta row-label">{label}</div>}
      {ask && <div className="q">{ask}</div>}
      {mgr}
    </div>
  );
}

export default function AgentList({ agents, selectedId, onSelect, onNew, onNext, onPalette, prefs = {}, unread = new Set(), drafts = new Set(), onContext, rootKey = 0 }) {
  const [, tick] = useState(0);
  const [rootProject, setRootProject] = useState(''); // projects-root folder name: its sessions are labelled 'Manager sessions'
  useEffect(() => { fetch('/api/config').then((r) => r.json()).then((b) => setRootProject(String(b.root || '').split('/').filter(Boolean).pop() || '')).catch(() => {}); }, [rootKey]);
  const [open, setOpen] = useState({ Older: false, 'Other agents': false, Archived: false });
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000); // refresh ages and the midnight boundary
    return () => clearInterval(t);
  }, []);

  const [query, setQuery] = useState('');
  const searching = query.trim() !== '';
  const searchRef = useRef(null);
  const listRef = useRef(null);
  useListMotion(listRef);
  const { top, children } = nest(agents, prefs.archived);
  const needs = groupAgents(top, prefs)['Needs input'];
  // The in-list filter stays reachable: the palette action "Filter the agent list" (and Tab) focus the field.
  useEffect(() => {
    const focus = () => searchRef.current?.focus();
    window.addEventListener('dekki:focus-search', focus);
    return () => window.removeEventListener('dekki:focus-search', focus);
  }, []);
  const [mode, setModeRaw] = useState(() => { try { return parseMode(localStorage.getItem('dekki.groupMode')); } catch { return 'status'; } });
  const setMode = (m) => { setModeRaw(m); try { localStorage.setItem('dekki.groupMode', m); } catch { /* ignore */ } };

  const found = searching ? searchVisible(top, children, query) : null;
  const shown = found ? top.filter((a) => found.visible.has(a.id)) : top;
  const groups = groupAgents(shown, prefs);
  const byProject = mode === 'project' ? groupByProject(shown, prefs, rootProject) : null;
  // Sections: the status groups, or (Project mode) one per project, then Other agents and Archived as before.
  const sections = byProject
    ? [...byProject.projects.map((p) => ({ key: `p:${p.label}`, label: p.label, items: p.items })), ...['Other agents', 'Archived'].map((g) => ({ key: g, g, items: byProject.rest[g] }))]
    : GROUPS.map((g) => ({ key: g, g, items: groups[g] }));
  const noMatches = searching && sections.every((x) => !x.items.length);
  const [expanded, setExpanded] = useState(() => new Set());
  const toggleWorkers = (id) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // Selecting a worker (e.g. from a link) opens its manager's strip so the selection is visible.
  useEffect(() => {
    for (const [manager, list] of children) {
      if (list.some((w) => w.id === selectedId)) setExpanded((s) => (s.has(manager) ? s : new Set(s).add(manager)));
    }
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="list-wrap">
      <div className="sb-bar">
        <div className="search-bar">
          <svg className="search-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4-4" /></svg>
          <input
            ref={searchRef}
            type="text"
            className="search-input"
            placeholder="Search or jump to…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onMouseDown={(e) => { if (!query) { e.preventDefault(); onPalette(false); } }}
            onKeyDown={(e) => { if (e.key === 'Escape' && query && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); setQuery(''); } }}
            spellCheck={false}
            aria-label="Search agents"
            title={`Search and jump (${MOD}K or /). With a filter typed, click here to edit it; the palette action "Filter the agent list" focuses this field.`}
          />
          {!query && <kbd className="search-kbd">{MOD}K</kbd>}
          {query && <button className="search-clear" title="Clear search (Esc)" aria-label="Clear search" onClick={() => { setQuery(''); searchRef.current?.focus(); }}>×</button>}
        </div>
        <button className="new-btn" title="New agent (C)" aria-label="New agent" onClick={onNew}><PlusIcon size={14} strokeWidth={2.2} /><span>New</span></button>
      </div>
      {needs.length > 0 && (
        <button className="attn" title="Select the next agent that needs you (N)" onClick={onNext}>
          <StatusGlyph state="needs" /><Tick value={needs.length} /> need{needs.length === 1 ? 's' : ''} you<span className="nx">Next <kbd>N</kbd></span>
        </button>
      )}
      <div className="list-mode" role="group" aria-label="Group the list by">
        <div className="seg">
          <button className={mode === 'status' ? 'on' : ''} aria-pressed={mode === 'status'} onClick={() => setMode('status')}>Status</button>
          <button className={mode === 'project' ? 'on' : ''} aria-pressed={mode === 'project'} onClick={() => setMode('project')}>Project</button>
        </div>
      </div>
      <div className={`list${byProject ? ' by-project' : ''}`} ref={listRef}>
        {noMatches && <div className="search-empty">No matches</div>}
        {sections.map(({ key, g, label, items }) => {
          if ((g === 'Archived' || g === 'Other agents' || searching) && !items.length) return null;
          const collapsible = g === 'Older' || g === 'Other agents' || g === 'Archived';
          // A collapsed Other agents group must not hide a worker's question or news.
          const alerts = g === 'Other agents' ? items.filter((a) => a.needsInput).length : 0;
          const news = g === 'Other agents' && items.some((a) => unread.has(a.id));
          const isOpen = collapsible ? (searching || open[g]) : true; // a search expands every group; the stored open state returns when cleared
          if (!items.length && !collapsible) return null;
          const head = (
            <>
              {collapsible && <Chevron open={isOpen} />}{label || GROUP_LABEL[g] || g} <Tick className="ct" value={items.length} />
              {alerts > 0 && !isOpen && <span className="tag amber" title="Agents here are waiting for you">{alerts} need input</span>}
              {news && !isOpen && !alerts && <span className="udot" title="New activity" />}
            </>
          );
          return (
            <section key={key}>
              {collapsible
                ? <button className="gh group-head clickable" data-flip-id={`g:${key}`} aria-expanded={isOpen} onClick={searching ? undefined : () => setOpen({ ...open, [g]: !open[g] })}>{head}</button>
                : <div className={`gh group-head${g === 'Needs input' ? ' need' : ''}`} data-flip-id={`g:${key}`}>{head}</div>}
              {isOpen && items.map((a) => {
                // while searching: only the workers that match themselves, strip always open, chevron not clickable; else the user's expanded state
                const workers = found ? found.workers.get(a.id) || [] : children.get(a.id) || [];
                const stripOpen = searching || expanded.has(a.id);
                const rowProps = (x) => ({
                  agent: x,
                  rootProject,
                  selected: x.id === selectedId,
                  onSelect,
                  pinned: (prefs.pinned || []).includes(x.id),
                  unread: unread.has(x.id),
                  draft: drafts.has(x.id) && x.empty === true,
                  onContext,
                });
                return (
                  <React.Fragment key={a.id}>
                    <Row
                      {...rowProps(a)}
                      mgr={workers.length || a.managerStatus ? <ManagerLine status={a.managerStatus} workers={workers} open={stripOpen} onToggle={searching || !workers.length ? null : () => toggleWorkers(a.id)} /> : null}
                    />
                    {stripOpen && workers.map((w) => <Row key={w.id} {...rowProps(w)} child />)}
                  </React.Fragment>
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}
