// Deck state: one small JSON file outside the repo. Atomic writes (tmp + rename). No DB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULTS = () => ({ root: '', pinned: [], archived: [], owned: [], others: [], names: {}, prefs: {}, accounts: [], activeAccount: 'default' });

export const statePath = () => process.env.DEKKI_STATE || path.join(os.homedir(), '.dekki', 'state.json');

export const NAME_MAX = 80;

// names: deck-only display names, { <agent id>: "text" }.
function cleanNames(v) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [id, n] of Object.entries(v)) {
      if (/^[0-9a-f]{8}$/.test(id) && typeof n === 'string' && n.trim()) out[id] = n.trim().slice(0, NAME_MAX);
    }
  }
  return out;
}

export function readState() {
  const d = DEFAULTS();
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    const archived = Array.isArray(s.archived) ? s.archived.filter((x) => typeof x === 'string') : [];
    return {
      root: typeof s.root === 'string' && s.root ? s.root : d.root,
      // archived means never pinned: older state files may hold both, so drop the pin (idempotent)
      pinned: Array.isArray(s.pinned) ? s.pinned.filter((x) => typeof x === 'string' && !archived.includes(x)) : [],
      archived,
      owned: Array.isArray(s.owned) ? s.owned.filter((x) => typeof x === 'string') : [],
      others: Array.isArray(s.others) ? s.others.filter((x) => typeof x === 'string') : [],
      names: cleanNames(s.names),
      prefs: s.prefs && typeof s.prefs === 'object' ? s.prefs : {},
      // Accounts (server/accounts.js cleans them): kept verbatim so every write round-trips them.
      accounts: Array.isArray(s.accounts) ? s.accounts : [],
      activeAccount: typeof s.activeAccount === 'string' ? s.activeAccount : 'default',
    };
  } catch {
    return d; // missing or corrupt: start fresh (corrupt file is overwritten on next write)
  }
}

export function writeState(state) {
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

/** Add/remove an id in state[key] ('pinned' | 'archived'). Returns the new state. */
export function setMember(key, id, on) {
  const s = readState();
  const set = new Set(s[key]);
  if (on) set.add(id); else set.delete(id);
  s[key] = [...set];
  writeState(s);
  return s;
}

/** Archive or un-archive an agent in one write. Archiving drops its pin; un-archiving does not bring it back. Returns the new state. */
export function setArchived(id, on) {
  const s = readState();
  const arch = new Set(s.archived);
  if (on) { arch.add(id); s.pinned = s.pinned.filter((x) => x !== id); } else arch.delete(id);
  s.archived = [...arch];
  writeState(s);
  return s;
}

/** Pin or unpin an agent in one write. Pinning an archived agent un-archives it. Returns the new state. */
export function setPinned(id, on) {
  const s = readState();
  const pin = new Set(s.pinned);
  if (on) { pin.add(id); s.archived = s.archived.filter((x) => x !== id); } else pin.delete(id);
  s.pinned = [...pin];
  writeState(s);
  return s;
}

/** Set (or, when empty, clear) the deck-only display name of an agent. Returns the new state. */
export function setName(id, name) {
  const s = readState();
  const n = typeof name === 'string' ? name.trim().slice(0, NAME_MAX) : '';
  if (n) s.names[id] = n; else delete s.names[id];
  writeState(s);
  return s;
}
