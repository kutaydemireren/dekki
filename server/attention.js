// How many agents need the user's input right now, per account, as the notify poller last saw it.
// In memory only. The Mac app (Dock badge, menu-bar count) reads it over loopback: GET /api/attention.
export const MAX_NAME = 80;

export function createAttention() {
  const byAccount = new Map(); // account id -> [{id, name}]
  return {
    set(accountId, agents) {
      byAccount.set(accountId, agents.map((a) => ({ id: a.id, name: String(a.name ?? '').slice(0, MAX_NAME) })));
    },
    drop(accountId) { byAccount.delete(accountId); },
    /** { count, agents: [{id, name, accountId}] } across all accounts. */
    snapshot() {
      const agents = [];
      for (const [accountId, list] of byAccount) for (const a of list) agents.push({ ...a, accountId });
      return { count: agents.length, agents };
    },
  };
}

export const attention = createAttention();
