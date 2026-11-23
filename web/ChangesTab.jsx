import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_MS, STATUS_LETTER, STATUS_WORD, splitPath, fileSig, isLarge, isOpen, truncMessage, emptyState } from './changes-logic.js';

const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function Counts({ add, del }) {
  return (
    <span className="ch-n">
      {add > 0 && <span className="p">+{add}</span>}
      {del > 0 && <span className="m">-{del}</span>}
    </span>
  );
}

function Lines({ d }) {
  if (d.binary) return <div className="ch-note">binary file</div>;
  if (!d.hunks.length) return <div className="ch-note">{d.fileStatus === 'renamed' ? 'Renamed, no content changes' : 'No content changes'}</div>;
  const msg = truncMessage(d.truncated);
  return (
    <>
      <div className="ch-code">
        {d.hunks.map((h, i) => (
          <div key={i} className="ch-hunkblock">
            <div className="ch-hunk">{h.header}</div>
            {h.lines.map((l, j) => (
              <div key={j} className={`ch-l ${l.t}`}>
                <span className="ln" data-n={l.o ?? ''} />
                <span className="ln" data-n={l.n ?? ''} />
                <span className="tx">{l.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      {msg && <div className="ch-trunc">{msg}</div>}
    </>
  );
}

function FileCard({ file, open, onToggle, diff, onNeed, root, cardRef }) {
  const sig = fileSig(file);
  const [near, setNear] = useState(false);
  const el = useRef(null);
  useEffect(() => {
    const node = el.current;
    if (!node || typeof IntersectionObserver === 'undefined') { setNear(true); return undefined; }
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: root.current, rootMargin: '600px 0px' });
    io.observe(node);
    return () => io.disconnect();
  }, [root]);
  useEffect(() => { if (open && near && !file.binary && diff?.sig !== sig) onNeed(file, sig); }, [open, near, sig, diff?.sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const { dir, name } = splitPath(file.path);
  return (
    <section className="ch-card" ref={(n) => { el.current = n; cardRef(file.path, n); }} data-path={file.path}>
      <button className="ch-head" aria-expanded={open} onClick={onToggle}>
        <i className={`ch-chev${open ? ' open' : ''}`} aria-hidden="true" />
        <span className={`ch-st st-${STATUS_LETTER[file.status]}`} title={STATUS_WORD[file.status]}>{STATUS_LETTER[file.status]}</span>
        <span className="ch-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {dir && <span className="ch-dir">{dir}</span>}<b>{name}</b>
          {file.oldPath && <span className="ch-from"> ← {file.oldPath}</span>}
        </span>
        {file.binary && <span className="ch-tag">binary</span>}
        {!open && isLarge(file) && <span className="ch-tag">large</span>}
        <Counts add={file.add} del={file.del} />
      </button>
      {open && (
        <div className="ch-body">
          {file.binary ? <div className="ch-note">binary file</div>
            : !diff?.d ? <div className="ch-note dim">{diff?.error ? 'Could not load this diff' : 'Loading…'}</div>
              : <Lines d={diff.d} />}
        </div>
      )}
    </section>
  );
}

/**
 * Read-only code-review view of what an agent changed in its git worktree (server/changes.js).
 * Fetches the file list when opened and whenever the agent's last activity changes; while the agent runs it also
 * refetches every POLL_MS (visible browser tab only). The component stays mounted while hidden (see App.jsx), and a
 * refresh updates data in place, so scroll position and collapsed cards are kept.
 */
export default function ChangesTab({ agentId, active, running = false, lastActivityAt = null }) {
  const [scope, setScope] = useState('all');
  const [data, setData] = useState(null); // last good answer for `scope` ({status:'ok'|'none', ...}) or null
  const [failed, setFailed] = useState(false);
  const [explicit, setExplicit] = useState({}); // path -> open (user's choice)
  const [diffs, setDiffs] = useState({}); // `${scope}|${path}` -> { sig, d } | { sig, error }
  const [current, setCurrent] = useState(null);
  const scroller = useRef(null);
  const cards = useRef(new Map());
  const inflight = useRef(new Set());

  useEffect(() => {
    if (!active) return undefined;
    let stop = false;
    const load = () => fetch(`/api/agents/${agentId}/changes?scope=${scope}`)
      .then((r) => r.json())
      .then((d) => { if (stop) return; if (d.status === 'ok' || d.status === 'none') { setData(d); setFailed(false); } else setFailed(true); })
      .catch(() => { if (!stop) setFailed(true); });
    load();
    const t = running ? setInterval(() => { if (!document.hidden) load(); }, POLL_MS) : null;
    return () => { stop = true; if (t) clearInterval(t); };
  }, [agentId, active, scope, running, lastActivityAt]);

  const need = useCallback((file, sig) => {
    const key = `${scope}|${file.path}`;
    const flight = `${key}|${sig}`;
    if (inflight.current.has(flight)) return;
    inflight.current.add(flight);
    fetch(`/api/agents/${agentId}/changes/file?scope=${scope}&path=${encodeURIComponent(file.path)}`)
      .then((r) => r.json())
      .then((d) => setDiffs((m) => ({ ...m, [key]: d.status === 'ok' ? { sig, d } : { sig, error: true } })))
      .catch(() => setDiffs((m) => ({ ...m, [key]: { sig, error: true } })))
      .finally(() => inflight.current.delete(flight));
  }, [agentId, scope]);

  const files = data?.status === 'ok' && data.scope === scope ? data.files : [];
  const stale = data && data.status === 'ok' && data.scope !== scope;
  const setAll = (open) => setExplicit(Object.fromEntries(files.map((f) => [f.path, open])));
  const allOpen = files.length > 0 && files.every((f) => isOpen(f, explicit));
  const toggle = (f) => setExplicit((m) => ({ ...m, [f.path]: !isOpen(f, m) }));
  const cardRef = useCallback((p, n) => { if (n) cards.current.set(p, n); else cards.current.delete(p); }, []);
  const goto = (f) => {
    setCurrent(f.path);
    setExplicit((m) => ({ ...m, [f.path]: true }));
    requestAnimationFrame(() => cards.current.get(f.path)?.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' }));
  };
  const totals = useMemo(() => (data?.status === 'ok' ? data.totals : { files: 0, add: 0, del: 0 }), [data]);

  if (!data) return <div className="placeholder">{failed ? 'Could not load changes' : 'Loading…'}</div>;
  if (data.status === 'none') {
    const e = emptyState(data, scope);
    return <div className="ch-empty"><div className="ch-empty-t">{e.title}</div><div className="ch-empty-s">{e.sub}</div></div>;
  }

  const empty = !files.length && !stale;
  const e = empty ? emptyState(data, scope) : null;
  return (
    <div className="changes">
      <div className="ch-sum">
        {data.branch && <span className="chip mono ch-branch" title="Branch">{data.branch}</span>}
        {data.base && <span className="ch-vs">vs <b>{data.base.name}</b></span>}
        <span className="ch-count"><b>{totals.files}</b> {totals.files === 1 ? 'file' : 'files'}</span>
        <Counts add={totals.add} del={totals.del} />
        {failed && <span className="ch-warn" title="The last refresh failed; showing the previous result">stale</span>}
        <span className="spacer" />
        <div className="seg" role="tablist" aria-label="Scope">
          <button role="tab" aria-selected={scope === 'all'} className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All changes vs base</button>
          <button role="tab" aria-selected={scope === 'uncommitted'} className={scope === 'uncommitted' ? 'on' : ''} onClick={() => setScope('uncommitted')}>Uncommitted only</button>
        </div>
        {files.length > 0 && <button className="ghost ch-fold" onClick={() => setAll(!allOpen)}>{allOpen ? 'Collapse all' : 'Expand all'}</button>}
      </div>
      {data.note && scope === 'all' && <div className="ch-banner">{data.note}</div>}
      {data.truncatedFiles && <div className="ch-banner">More than 500 files changed: only the first 500 are listed.</div>}
      {empty ? (
        <div className="ch-empty"><div className="ch-empty-t">{e.title}</div><div className="ch-empty-s">{e.sub}</div></div>
      ) : (
        <div className={`ch-main${stale ? ' stale' : ''}`}>
          <nav className="ch-files" aria-label="Changed files">
            {files.map((f) => {
              const { dir, name } = splitPath(f.path);
              return (
                <button key={f.path} className={`ch-fi${current === f.path ? ' on' : ''}`} onClick={() => goto(f)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                  <span className={`ch-st st-${STATUS_LETTER[f.status]}`}>{STATUS_LETTER[f.status]}</span>
                  <span className="ch-path">{dir && <span className="ch-dir">{dir}</span>}<b>{name}</b></span>
                  <Counts add={f.add} del={f.del} />
                </button>
              );
            })}
          </nav>
          <div className="ch-diffs" ref={scroller}>
            {files.map((f) => (
              <FileCard key={f.path} file={f} open={isOpen(f, explicit)} onToggle={() => toggle(f)} diff={diffs[`${scope}|${f.path}`]} onNeed={need} root={scroller} cardRef={cardRef} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
