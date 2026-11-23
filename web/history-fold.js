// Pure helpers for the History tab (also imported by the server tests): fold consecutive tool calls into one
// summary line, and count +/- lines of an edit card.

const READ = new Set(['Read', 'NotebookRead']);
const SEARCH = new Set(['Grep', 'Glob', 'LS', 'ToolSearch']);
const RUN = new Set(['Bash', 'BashOutput', 'KillShell']);

/** Tool entries that become a file card instead of a folded line: an edit/write with a parsed diff. */
export const isDiffTool = (e) => e.k === 'tool' && Boolean(e.diff);

/** Fold the entry list into render items: {type:'entry', e} or {type:'tools', id, tools:[tool entries]}.
 *  Consecutive tool entries without a diff form one group; a diff card or any other entry ends it. */
export function foldEntries(entries) {
  const out = [];
  let cur = null;
  for (const e of entries) {
    if (e.k === 'tool' && !isDiffTool(e)) {
      if (!cur) { cur = { type: 'tools', id: `g-${e.id}`, tools: [] }; out.push(cur); }
      cur.tools.push(e);
    } else {
      cur = null;
      out.push({ type: 'entry', e });
    }
  }
  return out;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** One line for a group: "Explored 6 files, 2 searches", "Ran 2 commands", unknown tools "N tool calls". */
export function summarizeTools(tools) {
  let files = 0, searches = 0, runs = 0, other = 0;
  for (const t of tools) {
    if (READ.has(t.name)) files++;
    else if (SEARCH.has(t.name)) searches++;
    else if (RUN.has(t.name)) runs++;
    else other++;
  }
  const parts = [];
  if (files || searches) {
    const bits = [];
    if (files) bits.push(plural(files, 'file', 'files'));
    if (searches) bits.push(plural(searches, 'search', 'searches'));
    parts.push(`Explored ${bits.join(', ')}`);
  }
  if (runs) parts.push(`Ran ${plural(runs, 'command', 'commands')}`);
  if (other) parts.push(plural(other, 'tool call', 'tool calls'));
  return parts.join(', ');
}

/** True when any tool in the group returned an error. */
export const groupHasError = (tools) => tools.some((t) => t.result?.isError);

/** True while some tool has not got its result yet. */
export const groupPending = (tools) => tools.some((t) => !t.result);

/** {add, del} line counts of a parsed diff ({hunks: [{lines: ['+x', '-y', ' z']}]}). */
export function diffCounts(diff) {
  let add = 0, del = 0;
  for (const h of diff?.hunks || []) {
    for (const l of h.lines || []) {
      if (l[0] === '+') add++;
      else if (l[0] === '-') del++;
    }
  }
  return { add, del };
}

export const MODES = ['summary', 'normal', 'verbose'];
