import React, { useEffect, useState } from 'react';
import Dialog from './Dialog.jsx';
import { planWorkers, workerOutcome } from './cascade.js';

// Confirm + `claude rm <id>`. The plain Delete never loses work: if claude keeps the worktree (uncommitted
// changes, unpushed commits) its message is shown. "Discard changes and delete" is a separate, explicitly
// confirmed step that throws that work away, like ctrl+x twice in claude's agent view.
// A manager can take its workers along ("Also delete its workers", on by default): only finished, clean
// workers are ticked (see cascade.js), they get the plain delete (never discard), and the manager goes last,
// and only if no worker call failed, so the remaining workers stay nested under it.
export default function DeleteDialog({ agent, workers = [], onClose, onDeleted }) {
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // {ok, kept, output} | {error}
  const [understood, setUnderstood] = useState(false);
  const [plan, setPlan] = useState(null); // per worker, once its remove-check is in
  const [picked, setPicked] = useState(() => new Set());
  const [alsoWorkers, setAlsoWorkers] = useState(true);
  const [workerResults, setWorkerResults] = useState([]); // [{id, name, status: deleted|kept|error, text}]
  const hasWorkers = workers.length > 0;

  useEffect(() => {
    fetch(`/api/agents/${agent.id}/remove-check`)
      .then((r) => r.json())
      .then(setCheck)
      .catch((e) => setResult({ error: e.message }));
  }, [agent.id]);

  useEffect(() => {
    if (!hasWorkers) return;
    Promise.all(workers.map((w) => fetch(`/api/agents/${w.id}/remove-check`).then((r) => (r.ok ? r.json() : undefined)).catch(() => undefined)))
      .then((list) => {
        const p = planWorkers(workers, Object.fromEntries(workers.map((w, i) => [w.id, list[i]])));
        setPlan(p);
        setPicked(new Set(p.filter((x) => x.defaultOn).map((x) => x.id)));
      });
  }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePick = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function deleteOne(id, discard) {
    const res = await fetch(`/api/agents/${id}${discard ? '?discard=1' : ''}`, { method: 'DELETE' });
    return res.json();
  }

  async function remove(discard) {
    setBusy(true);
    try {
      const out = [];
      let failed = false;
      if (hasWorkers && alsoWorkers && plan) {
        for (const p of plan.filter((x) => picked.has(x.id) && !x.disabled)) {
          try {
            const body = await deleteOne(p.id, false); // workers never get the discard step
            const outcome = workerOutcome(body);
            if (outcome === 'deleted' || outcome === 'gone') { out.push({ id: p.id, name: p.name, status: 'deleted', text: outcome === 'gone' ? 'already gone' : '' }); onDeleted(p.id); }
            else if (outcome === 'kept') out.push({ id: p.id, name: p.name, status: 'kept', text: body.output });
            else { out.push({ id: p.id, name: p.name, status: 'error', text: body.error }); failed = true; }
          } catch (e) {
            out.push({ id: p.id, name: p.name, status: 'error', text: e.message });
            failed = true;
          }
        }
      }
      setWorkerResults(out);
      if (failed) {
        setResult({ error: `A worker could not be deleted, so “${agent.name}” was not deleted either (its remaining workers stay under it).` });
        return;
      }
      const body = await deleteOne(agent.id, discard);
      setResult(body);
      if (body.ok && !body.kept) onDeleted(agent.id);
    } catch (e) {
      setResult({ error: e.message });
    } finally {
      setBusy(false);
    }
  }

  const deleted = result?.ok && !result.kept;
  const hasWorktree = !!check?.worktreePath;
  // the discard step is offered when there is work at risk (uncommitted files now, or claude kept the worktree)
  const showDiscard = !deleted && hasWorktree && !check?.running && (check?.dirty?.length > 0 || result?.kept);
  const selectedCount = plan ? plan.filter((p) => picked.has(p.id) && !p.disabled).length : 0;

  return (
    <Dialog title={`Delete “${agent.name}”?`} onClose={onClose} actions={(
      <>
        <button onClick={onClose}>{deleted ? 'Close' : result ? 'Close' : 'Cancel'}</button>
        {!deleted && !result?.kept && (
          <button className="primary danger" onClick={() => remove(false)} disabled={busy || !check || check.running || (hasWorkers && !plan)}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        )}
      </>
    )}>
        {!result && (
          <>
            <div>Runs <code>claude rm {agent.id}</code>: the session is removed from the agent list. Its transcript stays on disk until Claude Code expires it.</div>
            {check?.running && <div className="err">This agent is running. Stop it first.</div>}
            {check?.dirty?.length > 0 && (
              <div className="err">
                <b>Its worktree has uncommitted changes ({check.dirty.length}):</b>
                {check.dirty.slice(0, 8).join('\n')}
                {check.dirty.length > 8 ? '\n…' : ''}
                {'\n'}Plain Delete keeps the worktree and these changes.
              </div>
            )}
            {hasWorktree && !check.dirty.length && <div>Worktree: {check.worktreePath} (removed only if clean and saved; otherwise Claude keeps it and says why).</div>}
            {hasWorkers && (
              <div className="workers-box">
                <label className="inline">
                  <input type="checkbox" checked={alsoWorkers} onChange={(e) => setAlsoWorkers(e.target.checked)} />
                  <b>Also delete its workers</b>{plan ? ` (${selectedCount} of ${plan.length} selected)` : ' (checking…)'}
                </label>
                {alsoWorkers && plan && plan.map((p) => (
                  <label key={p.id} className={`inline worker-row${p.disabled ? ' disabled' : ''}`}>
                    <input type="checkbox" disabled={p.disabled} checked={picked.has(p.id) && !p.disabled} onChange={() => togglePick(p.id)} />
                    <span className="worker-name">{p.name}</span>
                    <span className="worker-state">{p.state}</span>
                    {p.reason && <span className="worker-reason">{p.reason}</span>}
                  </label>
                ))}
                {alsoWorkers && plan && <div className="worker-note">Workers that are running, waiting for you, or have uncommitted changes are not ticked. Their work is never discarded from here; if Claude finds unpushed commits it keeps that worker and says so.</div>}
                {!alsoWorkers && <div className="worker-note">The workers stay in the list, no longer under a manager.</div>}
              </div>
            )}
          </>
        )}
        {workerResults.length > 0 && (
          <div className="worker-results">
            {workerResults.map((r) => (
              <div key={r.id} className={r.status === 'deleted' ? 'ok' : 'err'}>
                {r.name}: {r.status === 'deleted' ? `deleted${r.text ? ` (${r.text})` : ''}` : r.status === 'kept' ? `kept by Claude. ${r.text || ''}` : `error: ${r.text}`}
              </div>
            ))}
          </div>
        )}
        {result && (
          <div className={deleted ? 'ok' : 'err'}>
            {result.error || result.output}
            {result.kept && '\n\nNothing was deleted. The worktree and its work are untouched.'}
          </div>
        )}

        {showDiscard && (
          <div className="err" style={{ border: '1px solid var(--rd)' }}>
            <b>Discard changes and delete</b>
            Permanently throws away the uncommitted changes (and any unpushed commits and branch) in this agent’s worktree, then deletes the session. This cannot be undone.{hasWorkers && alsoWorkers ? ' Applies to this agent only; its workers get the plain delete.' : ''}
            <label className="inline" style={{ marginTop: 8, color: 'inherit' }}>
              <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
              I understand this work will be lost
            </label>
            <div style={{ marginTop: 8 }}>
              <button className="primary danger" disabled={!understood || busy} onClick={() => remove(true)}>
                {busy ? 'Deleting…' : 'Discard changes and delete'}
              </button>
            </div>
          </div>
        )}
    </Dialog>
  );
}
