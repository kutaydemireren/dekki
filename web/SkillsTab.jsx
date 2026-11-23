import React, { useEffect, useState } from 'react';

export const fmtDuration = (ms) => {
  if (!ms || ms < 1000) return '0s';
  const m = Math.floor(ms / 60000);
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
};

export const POLL_MS = 12000;

/** True while this tab should keep refetching: the agent is running (state working, not the idle/stalled status). */
export const shouldPoll = (agent) => agent?.state === 'working' && agent.status !== 'idle';

/**
 * Compact skill / tool usage of one session (from its transcript). Fetches when opened and whenever the agent's last
 * activity changes (the agent list refreshes every 3 s); while the agent runs it also refetches every POLL_MS
 * (the duration keeps counting; sub-agents write to files of their own). Idle/finished agents: no polling.
 * Unmounting (tab closed / another agent selected) clears the timer.
 */
export default function SkillsTab({ agentId, active, running = false, lastActivityAt = null }) {
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    setState({ status: 'loading' });
  }, [agentId]);

  useEffect(() => {
    if (!active) return undefined;
    let stop = false;
    const load = () => fetch(`/api/agents/${agentId}/stats`)
      .then((r) => r.json())
      .then((d) => { if (!stop) setState(d.status === 'ok' ? { status: 'ok', stats: d.stats } : { status: d.status || 'error' }); })
      .catch(() => { if (!stop) setState((s) => (s.status === 'ok' ? s : { status: 'error' })); });
    load();
    const t = running ? setInterval(() => { if (!document.hidden) load(); }, POLL_MS) : null;
    return () => { stop = true; if (t) clearInterval(t); };
  }, [agentId, active, running, lastActivityAt]);

  if (state.status === 'loading') return <div className="placeholder">Loading…</div>;
  if (state.status === 'expired') return <div className="placeholder">History expired</div>;
  if (state.status !== 'ok') return <div className="placeholder">Could not load stats</div>;

  const s = state.stats;
  const used = Object.entries(s.skills).sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  const unused = s.available ? s.available.filter((n) => !s.skills[n]) : null;
  const sub = s.fromSubagents || { toolCalls: 0 };
  const mcp = Object.entries(s.mcp).sort((a, b) => b[1].calls - a[1].calls);

  return (
    <div className="skills-tab">
      <div className="stat-row">
        <span>
          <b>{s.toolCalls}</b> tool calls
          {sub.toolCalls > 0 && <span className="stat-dim" title="Included in all counts on this tab: calls made inside sub-agents"> ({sub.toolCalls} from sub-agents)</span>}
        </span>
        <span><b>{s.subagents}</b> sub-agents</span>
        <span><b>{fmtDuration(s.durationMs)}</b> duration{s.live ? ' …' : ''}</span>
      </div>

      <h4>Skills used</h4>
      {used.length ? (
        <div className="chips">
          {used.map(([n, u]) => (
            <span key={n} className="chip-skill" title={`first ${u.first || '?'}\nlast ${u.last || '?'}${u.slash ? `\n${u.slash} via /${n}` : ''}`}>
              {n} <b>×{u.count}</b>{u.sub > 0 && <span className="stat-dim"> ({u.sub} sub)</span>}
            </span>
          ))}
        </div>
      ) : (
        <div className="stat-dim">None. {s.available ? 'No skill was used in this session.' : ''}</div>
      )}

      <h4>Available, never used</h4>
      {unused === null ? (
        <div className="stat-dim">Skill list not recorded for this session.</div>
      ) : unused.length ? (
        <details>
          <summary>{unused.length} of {s.available.length} skills</summary>
          <div className="chips dim">{unused.map((n) => <span key={n} className="chip-skill">{n}</span>)}</div>
        </details>
      ) : (
        <div className="stat-dim">All available skills were used.</div>
      )}

      <h4>MCP servers</h4>
      {mcp.length ? (
        <div className="chips">
          {mcp.map(([server, m]) => (
            <span key={server} className="chip-skill" title={Object.entries(m.tools).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ×${n}`).join('\n')}>
              {server} <b>×{m.calls}</b>
            </span>
          ))}
        </div>
      ) : (
        <div className="stat-dim">No MCP tool calls.</div>
      )}

      <h4>Top tools</h4>
      <div className="chips">
        {s.topTools.map(([n, c]) => <span key={n} className="chip-skill">{n} <b>×{c}</b></span>)}
      </div>
    </div>
  );
}
