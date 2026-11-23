import React, { useEffect, useState } from 'react';
import { POLL_MS, STATUS_LETTER, STATUS_WORD, splitPath, visibleGroups, groupTotals, workerIdsParam, managerEmptyState } from './changes-logic.js';

function Counts({ add, del }) {
  return (
    <span className="ch-n">
      {add > 0 && <span className="p">+{add}</span>}
      {del > 0 && <span className="m">-{del}</span>}
    </span>
  );
}

/**
 * Manager's Changes tab: the combined changes of its workers (server/changes.js listGroupChanges), grouped by worker.
 * The manager's own worktree changes, if any, come first as "Manager". A worker or a file opens that worker's own
 * Changes tab (`onOpen(workerId)`) for the full diff. Fetches only while the tab is open; polls while something runs.
 */
export default function ManagerChanges({ agentId, workers, active, running = false, lastActivityAt = null, onOpen }) {
  const [scope, setScope] = useState('all');
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const ids = workerIdsParam(workers);

  useEffect(() => {
    if (!active) return undefined;
    let stop = false;
    const load = () => fetch(`/api/agents/${agentId}/changes/workers?scope=${scope}&ids=${encodeURIComponent(ids)}`)
      .then((r) => r.json())
      .then((d) => { if (stop) return; if (d.status === 'ok') { setData(d); setFailed(false); } else setFailed(true); })
      .catch(() => { if (!stop) setFailed(true); });
    load();
    const t = running ? setInterval(() => { if (!document.hidden) load(); }, POLL_MS) : null;
    return () => { stop = true; if (t) clearInterval(t); };
  }, [agentId, active, scope, ids, running, lastActivityAt]);

  if (!data) return <div className="placeholder">{failed ? 'Could not load changes' : 'Loading…'}</div>;
  const groups = data.scope === scope ? visibleGroups(data) : [];
  const t = groupTotals(groups);
  const e = managerEmptyState(scope);
  return (
    <div className="changes">
      <div className="ch-sum">
        <span className="ch-count"><b>{groups.length}</b> {groups.length === 1 ? 'worker' : 'workers'}</span>
        <span className="ch-count"><b>{t.files}</b> {t.files === 1 ? 'file' : 'files'}</span>
        <Counts add={t.add} del={t.del} />
        {failed && <span className="ch-warn" title="The last refresh failed; showing the previous result">stale</span>}
        <span className="spacer" />
        <div className="seg" role="tablist" aria-label="Scope">
          <button role="tab" aria-selected={scope === 'all'} className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All changes vs base</button>
          <button role="tab" aria-selected={scope === 'uncommitted'} className={scope === 'uncommitted' ? 'on' : ''} onClick={() => setScope('uncommitted')}>Uncommitted only</button>
        </div>
      </div>
      {!groups.length ? (
        <div className="ch-empty"><div className="ch-empty-t">{e.title}</div><div className="ch-empty-s">{e.sub}</div></div>
      ) : (
        <div className="ch-groups">
          {groups.map((g) => (
            <section key={g.id} className="ch-group">
              <button className="ch-ghead" onClick={() => onOpen(g.id)} title="Open this agent's Changes tab for the full diff">
                <b className="ch-gname">{g.role === 'manager' ? 'Manager' : g.name}</b>
                {g.branch && <span className="chip mono ch-branch" title="Branch">{g.branch}</span>}
                <span className="spacer" />
                <Counts add={g.totals.add} del={g.totals.del} />
                <span className="ch-count"><b>{g.files.length}</b> {g.files.length === 1 ? 'file' : 'files'}</span>
              </button>
              <div className="ch-glist">
                {g.files.map((f) => {
                  const { dir, name } = splitPath(f.path);
                  return (
                    <button key={f.path} className="ch-fi" onClick={() => onOpen(g.id)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                      <span className={`ch-st st-${STATUS_LETTER[f.status]}`} title={STATUS_WORD[f.status]}>{STATUS_LETTER[f.status]}</span>
                      <span className="ch-path">{dir && <span className="ch-dir">{dir}</span>}<b>{name}</b></span>
                      <Counts add={f.add} del={f.del} />
                    </button>
                  );
                })}
                {g.truncatedFiles && <div className="ch-note dim">More than 500 files changed: only the first 500 are listed.</div>}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
