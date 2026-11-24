import { groupAgents, nest } from './groups.js';

// Mission-control numbers, from the same grouping rules the list uses (groupAgents over the top-level agents;
// workers of a manager are nested under it and not counted separately, as in the list).
export function homeSummary(agents, prefs = {}, now = new Date()) {
  const { top } = nest(agents, prefs.archived || []);
  const g = groupAgents(top, { ...prefs, pinned: [] }, now); // a pin only moves a row in the list, not the counts
  return { needs: g['Needs input'], working: g.Running, done: g['Done today'] };
}

export function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
