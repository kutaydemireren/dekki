// "Group by project" for the agent list (the Status | Project toggle). Pure; groups.js stays as it is.
import { projectLabel } from './skills-sort.js';
import { groupOf } from './groups.js';

export const NO_PROJECT = 'No project';
export const parseMode = (v) => (v === 'project' ? 'project' : 'status');

/** Top-level agents grouped by the project label the rows show ('Manager sessions' for the projects root).
 *  Archived agents and "Other agents" are not projects: they are returned apart (`rest`) so the list keeps its own groups for them.
 *  Groups: most recent activity first; inside a group pinned first, then newest. Needs-you agents stay in their project's group
 *  (the attention strip above the list still counts and jumps to them).
 *  @returns {{projects: Array<{label: string, items: Array}>, rest: {'Other agents': Array, Archived: Array}}} */
export function groupByProject(top, prefs = {}, rootProject = '', now = new Date()) {
  const pinned = prefs.pinned || [];
  const rest = { 'Other agents': [], Archived: [] };
  const byLabel = new Map();
  for (const a of top) {
    const g = groupOf(a, prefs, now);
    if (g === 'Archived' || g === 'Other agents') { rest[g].push(a); continue; }
    const label = projectLabel(String(a.label ?? '').split(' / ')[0].trim(), rootProject) || NO_PROJECT; // 'project / branch' groups by project
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(a);
  }
  const latest = (items) => Math.max(...items.map((a) => a.lastActivityAt ?? 0));
  const sortItems = (items) => items.sort((x, y) => (pinned.includes(y.id) ? 1 : 0) - (pinned.includes(x.id) ? 1 : 0) || (y.lastActivityAt ?? 0) - (x.lastActivityAt ?? 0));
  for (const items of Object.values(rest)) sortItems(items);
  const projects = [...byLabel].map(([label, items]) => ({ label, items: sortItems(items) }));
  projects.sort((a, b) => latest(b.items) - latest(a.items) || a.label.localeCompare(b.label));
  return { projects, rest };
}
