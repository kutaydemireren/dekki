// Pure grouping logic for the agent list.
// Display order. Labels shown in the UI live in AgentList (Needs input = "Needs you", Running = "Working").
export const GROUPS = ['Needs input', 'Running', 'Done today', 'Older', 'Other agents', 'Archived'];

export function localMidnight(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function groupOf(agent, { pinned = [], archived = [] } = {}, now = new Date()) {
  if (archived.includes(agent.id)) return 'Archived';
  if (agent.mine === false) return 'Other agents'; // not created by you (e.g. a manager's workers): hidden by default
  if (agent.stalled) return 'Needs input'; // turn ended, workers all finished, nothing will wake it
  if (agent.state === 'working') return 'Running';
  if (agent.needsInput) return 'Needs input';
  return (agent.lastActivityAt ?? 0) >= localMidnight(now) ? 'Done today' : 'Older';
}

/** Workers linked to a manager nest under it (one level; a worker's own workers are flattened under the top
 *  manager; archived workers stay top-level). Marking a worker "Show in my list" (mine) keeps it top-level. Orphans (manager gone) stay top-level.
 *  @returns {{top: Array, children: Map<string, Array>}} children: top manager id -> workers, running first, then newest. */
export function nest(agents, archived = []) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  // an archived worker is not nested: it stays top-level (groupOf puts it in Archived), so the chip never counts it
  const isChild = (a) => a.parent && a.mine === false && byId.has(a.parent) && !archived.includes(a.id);
  const top = agents.filter((a) => !isChild(a));
  const children = new Map();
  for (const a of agents) {
    if (!isChild(a)) continue;
    let root = byId.get(a.parent);
    for (let depth = 0; isChild(root) && depth < 10; depth++) root = byId.get(root.parent);
    if (isChild(root)) continue; // a loop the server should have removed: leave it hidden rather than guess
    if (!children.has(root.id)) children.set(root.id, []);
    children.get(root.id).push(a);
  }
  for (const list of children.values()) {
    list.sort((x, y) => (y.state === 'working') - (x.state === 'working') || (y.lastActivityAt ?? 0) - (x.lastActivityAt ?? 0));
  }
  return { top, children };
}

/** @returns {Record<string, Array>} group name -> agents (pinned first, then newest first). */
export function groupAgents(agents, prefs = {}, now = new Date()) {
  const pinned = prefs.pinned || [];
  const out = Object.fromEntries(GROUPS.map((g) => [g, []]));
  for (const a of agents) out[groupOf(a, prefs, now)].push(a);
  for (const g of GROUPS) {
    out[g].sort((x, y) => {
      const px = pinned.includes(x.id) ? 1 : 0;
      const py = pinned.includes(y.id) ? 1 : 0;
      return py - px || (y.lastActivityAt ?? 0) - (x.lastActivityAt ?? 0);
    });
  }
  return out;
}

export function age(ts, now = Date.now()) {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Marker on the collapsed "N workers" chip: 'working' (the rows' green pulsing dot) when any worker is working,
// else 'unread' (blue dot) when any is unread, else null. Working wins: "still running" is the more useful signal.
export function workingCount(workers) {
  return workers.filter((w) => w.state === 'working').length;
}

export function chipMarker(workers, unread) {
  if (workingCount(workers)) return 'working';
  return workers.some((w) => unread.has(w.id)) ? 'unread' : null;
}
