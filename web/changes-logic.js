// Pure helpers of the Changes tab (tested in server/test/changes-ui.test.js).
export const POLL_MS = 10000;
export const LARGE_LINES = 1500; // a file with more changed lines than this starts collapsed

export const STATUS_LETTER = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
export const STATUS_WORD = { added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed' };

/** "src/auth/session.ts" -> { dir: "src/auth/", name: "session.ts" } */
export function splitPath(p) {
  const i = String(p).lastIndexOf('/');
  return i < 0 ? { dir: '', name: String(p) } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

/** Changes while the file is unchanged on disk keep the same signature, so its cached diff is reused. */
export const fileSig = (f) => `${f.status}:${f.add}:${f.del}:${f.mtime ?? 0}:${f.oldPath || ''}`;

export const isLarge = (f) => f.add + f.del > LARGE_LINES;

/** Open state of a card: the user's explicit choice, else open unless the diff is large. */
export const isOpen = (f, explicit) => (f.path in explicit ? explicit[f.path] : !isLarge(f));

/** Text of the truncation marker, or null. */
export function truncMessage(t) {
  if (!t) return null;
  if (!t.moreLines) return 'diff truncated, more lines are not shown';
  return `diff truncated, ${t.atLeast ? 'at least ' : ''}${t.moreLines.toLocaleString('en-US')} more lines`;
}

/**
 * Is the Changes tab shown for this agent? Yes when it has a git worktree or is a manager with workers. Never depends on
 * whether anything changed right now. `agent.worktreePath` comes with the agent list (no extra fetch).
 */
export const hasChangesTab = (agent, workerCount = 0) => Boolean(agent && (agent.worktreePath || workerCount > 0));

/** Manager view: the groups worth showing (the manager's own first, then workers), without the ones with no files. */
export function visibleGroups(data) {
  if (data?.status !== 'ok') return [];
  return (data.groups || []).filter((g) => g.files?.length);
}

/** Sum over the shown groups (for the summary line of the manager view). */
export const groupTotals = (groups) => ({
  files: groups.reduce((s, g) => s + g.files.length, 0),
  add: groups.reduce((s, g) => s + g.totals.add, 0),
  del: groups.reduce((s, g) => s + g.totals.del, 0),
});

/** Comma separated worker ids for the manager request (stable order, so the effect does not refire for nothing). */
export const workerIdsParam = (workers) => workers.map((w) => w.id).join(',');

/** Empty state of a manager's tab: no worker (and not the manager itself) has changed anything. */
export function managerEmptyState(scope = 'all') {
  return scope === 'uncommitted'
    ? { title: "Workers haven't changed anything yet", sub: 'No uncommitted changes in any worker worktree.' }
    : { title: "Workers haven't changed anything yet", sub: 'Files the workers change in their worktrees show up here.' };
}

/** What the tab says when there is nothing to list. */
export function emptyState(data, scope) {
  if (data.status === 'none') return { title: 'No git changes for this agent', sub: 'It has no git worktree to compare.' };
  if (data.note && !data.files.length && !data.base) return { title: 'Nothing changed yet', sub: data.note };
  return scope === 'uncommitted'
    ? { title: 'No uncommitted changes', sub: 'Everything this agent changed is already committed.' }
    : { title: 'Nothing changed yet', sub: 'Files this agent changes in its worktree show up here.' };
}
