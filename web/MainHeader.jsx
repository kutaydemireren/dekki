import React, { useState } from 'react';
import StatusGlyph from './StatusGlyph.jsx';

// Glyph state of one agent, same precedence as the list rows (AgentList.jsx dotClass).
export function glyphState(a) {
  if (a.stalled) return 'stalled';
  if (a.state === 'working') return 'working';
  if (a.needsInput) return 'needs';
  if (a.state === 'failed') return 'failed';
  if (a.state === 'stopped') return 'stopped';
  return 'done';
}

// project / branch for the chips, taken from fields the agent already has (`label` = "project / branch").
export function projectAndBranch(a) {
  const branch = a.worktreeBranch || null;
  const label = a.label || '';
  const tail = ` / ${branch}`;
  const project = branch && label.endsWith(tail) ? label.slice(0, -tail.length) : label;
  return { project: project || null, branch };
}

const TABS = [['session', 'Session'], ['history', 'History'], ['changes', 'Changes'], ['skills', 'Skills']];

// One row replacing the old tab strip: glyph, name (double-click renames), project + branch chips,
// Session | History | Changes | Skills, ghost Stop, copy-id chip.
export default function MainHeader({ agent, tab, onTab, canStop, onStop, onRename, changes = null, showChanges = true }) {
  const [copied, setCopied] = useState(false);
  const { project, branch } = projectAndBranch(agent);
  const copy = async () => {
    try { await navigator.clipboard.writeText(agent.id); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* clipboard blocked */ }
  };
  return (
    <header className="main-head">
      <h1 className="mh-name" title="Double-click to rename" onDoubleClick={() => onRename(agent)}>
        <StatusGlyph state={glyphState(agent)} />
        <span className="mh-title">{agent.name}</span>
      </h1>
      {project && <span className="chip mh-chip" title="Project">{project}</span>}
      {branch && <span className="chip mh-chip mono" title="Branch">{branch}</span>}
      <span className="spacer" />
      <div className="seg" role="tablist" aria-label="View">
        {TABS.filter(([k]) => k !== 'changes' || showChanges).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => onTab(k)}>
            {l}
            {k === 'changes' && changes && (changes.add > 0 || changes.del > 0) && (
              <span className="seg-n" title={`${changes.files} changed ${changes.files === 1 ? 'file' : 'files'} vs the base branch`}>
                <span className="p">+{changes.add}</span> <span className="m">-{changes.del}</span>
              </span>
            )}
          </button>
        ))}
      </div>
      {canStop && <button className="ghost mh-stop" title="Stop this agent (the conversation is kept)" onClick={onStop}><i />Stop</button>}
      <button className="chip mh-id mono" title="Copy the agent id" onClick={copy}>{copied ? 'Copied' : agent.id}</button>
    </header>
  );
}
