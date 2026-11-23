// Auto-unarchive: a new message to an archived agent shows up as its state going non-working -> working.
// Messages are typed into an xterm, so the server never sees them; the agent state is the reliable signal.
import { listAgents } from './agents.js';
import { readState, setMember } from './state.js';
import { accountEpoch } from './accounts.js';

const POLL_MS = 3000;

/** Pure. prev: Map id -> state from the last poll, or null on the very first poll (baseline only).
 *  Returns { ids: archived ids that went from a known non-working state to working, next }.
 *  Already working when seen (or when archived) never counts; neither does finishing (working -> done). */
export function toUnarchive(prev, agents, archived) {
  const next = new Map();
  const ids = [];
  const arch = new Set(archived);
  for (const a of agents) {
    next.set(a.id, a.state);
    const was = prev?.get(a.id);
    if (was === undefined) continue; // first sight: seed only
    if (arch.has(a.id) && a.state === 'working' && was !== 'working') ids.push(a.id);
  }
  return { ids, next };
}

/** One poll step. `tracker` = { prev }. Always updates the baseline. Returns the ids it unarchived. */
export function step(tracker, agents, { archived = readState().archived, unarchive = (id) => setMember('archived', id, false) } = {}) {
  const { ids, next } = toUnarchive(tracker.prev, agents, archived);
  tracker.prev = next;
  for (const id of ids) unarchive(id);
  return ids;
}

export function startUnarchivePoller({ list = listAgents, intervalMs = POLL_MS, env = process.env } = {}) {
  if (env.NODE_TEST_CONTEXT) return null;
  const tracker = { prev: null };
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const e0 = accountEpoch();
      const agents = await list();
      if (e0 !== accountEpoch()) { tracker.prev = null; return; } // account switched mid-poll: re-baseline
      if (tracker.epoch !== e0) { tracker.prev = null; tracker.epoch = e0; }
      step(tracker, agents);
    } catch { /* claude hiccup: try next tick */ } finally { busy = false; }
  };
  tick();
  const t = setInterval(tick, intervalMs);
  t.unref();
  return t;
}
