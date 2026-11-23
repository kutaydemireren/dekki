// Pure logic of the command palette (web/Palette.jsx): which agents and actions match a query.
import { matchAgent } from './search.js';

const rank = (a) => (a.stalled || (a.needsInput && a.state !== 'working') ? 0 : a.state === 'working' ? 1 : 2);

/** Agents for the palette: every agent incl. workers, matched with the list search (name / project / id).
 *  No query: those that need you first, then working, then the rest, newest first inside each. */
export function paletteAgents(agents, query) {
  return agents
    .filter((a) => matchAgent(a, query))
    .sort((x, y) => rank(x) - rank(y) || (y.lastActivityAt ?? 0) - (x.lastActivityAt ?? 0));
}

/** Actions whose label (or hidden keywords) contain every word of the query. Disabled ones are dropped. */
export function paletteActions(actions, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return actions.filter((a) => !a.disabled && words.every((w) => `${a.label} ${a.keywords || ''}`.toLowerCase().includes(w)));
}

/** Items in display order (agents, then actions), each with a unique key. */
export function paletteItems(agents, actions, query) {
  const out = [];
  for (const a of paletteAgents(agents, query)) out.push({ kind: 'agent', agent: a, key: `a:${a.id}` });
  for (const x of paletteActions(actions, query)) out.push({ kind: 'action', action: x, key: `x:${x.id}` });
  return out;
}

/** Index after pressing arrow down (+1) / up (-1), wrapping. */
export const moveIndex = (i, n, dir) => (n ? (i + dir + n) % n : 0);
