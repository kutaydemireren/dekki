import React, { useEffect, useState } from 'react';
import useEscape from './useEscape.js';
import { COLUMNS, sortSkills, nextSort, projectLabel } from './skills-sort.js';

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');

/** All-time skill table over every session transcript. Covers the main pane, like the Prompts panel. */
export default function SkillsPanel({ onClose }) {
  useEscape(onClose);
  const [project, setProject] = useState('');
  const [neverUsed, setNeverUsed] = useState(true);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [sort, setSort] = useState(null); // null = API order; resets when the panel is reopened

  useEffect(() => {
    let stop = false;
    setErr(null);
    fetch(`/api/skills${project ? `?project=${encodeURIComponent(project)}` : ''}`)
      .then((r) => r.json())
      .then((d) => { if (!stop) (d.skills ? setData(d) : setErr(d.error || 'failed')); })
      .catch((e) => { if (!stop) setErr(e.message); });
    return () => { stop = true; };
  }, [project]);

  const rows = data ? sortSkills(data.skills.filter((s) => neverUsed || s.uses > 0), sort) : [];
  const unusedCount = data ? data.skills.filter((s) => s.uses === 0).length : 0;

  return (
    <div className="prompts skills-panel">
      <div className="skills-main">
        <div className="skills-head">
          <b>Skills, all time</b>
          <select value={project} onChange={(e) => setProject(e.target.value)} title="Only sessions started in this project">
            <option value="">All projects</option>
            {data?.projects.map((p) => <option key={p} value={p}>{projectLabel(p, data.rootProject)}</option>)}
          </select>
          <label><input type="checkbox" checked={neverUsed} onChange={(e) => setNeverUsed(e.target.checked)} /> show never used ({unusedCount})</label>
          <span className="spacer" />
          {data && <span className="stat-dim">{data.sessions} sessions, {data.sessionsWithListing} with a skill list</span>}
          <button onClick={onClose} title="Close (Esc)">✕</button>
        </div>
        {err && <div className="error">{err}</div>}
        {!data && !err && <div className="placeholder">Reading transcripts…</div>}
        {data && (
          <div className="skills-scroll">
            <table className="skills-table">
              <thead><tr>
                {COLUMNS.map((c) => (
                  <th key={c.key} aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button className="sort-btn" onClick={() => setSort(nextSort(sort, c.key))} title={`Sort by ${c.label}`}>
                      {c.label}<span className="sort-arrow">{sort?.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                    </button>
                  </th>
                ))}
              </tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.name} className={s.uses ? '' : 'never'}>
                    <td>{s.name}</td>
                    <td>{s.uses}</td>
                    <td>{s.sessions}</td>
                    <td>{s.availableIn}</td>
                    <td>{fmtDate(s.lastUsed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && <div className="prompts-empty">No skills found in the transcripts.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
