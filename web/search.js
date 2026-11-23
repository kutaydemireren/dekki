// Pure search logic for the agent list. Plain substring matching, no scoring.

const norm = (s) => String(s ?? '').toLowerCase().replace(/[-_]+/g, ' ');

/** Parse a query into name words and an optional id fragment. */
export function parseQuery(query) {
  const q = String(query ?? '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  const words = norm(q).split(/\s+/).filter(Boolean);
  // hex with optional dashes and at least 4 chars: also an id fragment (short job id, session UUID or part of one)
  const idFrag = /^[0-9a-f-]+$/i.test(q) && q.replace(/-/g, '').length >= 4 ? q.toLowerCase() : null;
  return { words, idFrag };
}

/** Does the agent match? Empty query matches everything. Every word must appear in name or label
 *  (case-insensitive, '-' and '_' count as spaces); or the id fragment is a substring of id / sessionId. */
export function matchAgent(agent, query) {
  const { words, idFrag } = typeof query === 'string' ? parseQuery(query) : query;
  if (!words.length) return true;
  if (idFrag && (String(agent.id ?? '').toLowerCase().includes(idFrag) || String(agent.sessionId ?? '').toLowerCase().includes(idFrag))) return true;
  const hay = `${norm(agent.name)} ${norm(agent.label)}`; // not detail: the summary line pulled in unrelated rows
  return words.every((w) => hay.includes(w));
}

/** Search result: only hit sessions. A top-level agent is listed when it matches itself or any of its workers does;
 *  under it only the workers that match themselves (none for a manager-only hit).
 *  `visible` = ids of listed agents and workers, `workers` = Map manager id -> its matching workers.
 *  @param children Map manager id -> workers (from nest()). */
export function searchVisible(top, children, query) {
  const q = parseQuery(query);
  const visible = new Set();
  const workers = new Map();
  for (const a of top) {
    const kids = (children.get(a.id) || []).filter((w) => matchAgent(w, q));
    if (matchAgent(a, q) || kids.length) visible.add(a.id);
    if (kids.length) workers.set(a.id, kids);
    for (const w of kids) visible.add(w.id);
  }
  return { visible, workers };
}
