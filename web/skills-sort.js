// Client-side sort for the all-time skills table. Rows arrive from the API in the default
// order (uses desc + tie-breakers); a stable sort keeps that order for ties.
export const COLUMNS = [
  { key: 'name', label: 'Skill' },
  { key: 'uses', label: 'Uses' },
  { key: 'sessions', label: 'Sessions used in' },
  { key: 'availableIn', label: 'Available in' },
  { key: 'lastUsed', label: 'Last used' },
];

/** sort = null (API order) or { key, dir: 'asc' | 'desc' }. Never-used lastUsed rows always last. */
export function sortSkills(rows, sort) {
  if (!sort) return rows;
  const sign = sort.dir === 'asc' ? 1 : -1;
  const val = (r) => (sort.key === 'name' ? String(r.name).toLowerCase()
    : sort.key === 'lastUsed' ? (r.lastUsed ? Date.parse(r.lastUsed) : null) : r[sort.key]);
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1; // empty last, any direction
    return x < y ? -sign : x > y ? sign : 0;
  });
}

/** Click on a header: a new column starts asc for Skill, desc for numbers/dates; same column flips. */
export function nextSort(sort, key) {
  if (sort?.key === key) return { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'name' ? 'asc' : 'desc' };
}

/** Picker label only: the projects root itself is not a project, it holds the manager sessions. The option value stays the raw name. */
export const MANAGER_LABEL = 'Manager sessions';
export const projectLabel = (name, rootProject) => (rootProject && name === rootProject ? MANAGER_LABEL : name);
