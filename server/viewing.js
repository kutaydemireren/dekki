// Which agent the user is looking at in a deck page. In memory only (never state.json): a page reports its view,
// a report older than STALE_MS is gone, so a closed or crashed tab stops suppressing notifications within ~30 s.
export const STALE_MS = 30_000;

const validId = (id) => typeof id === 'string' && /^[0-9a-f]{8}$/.test(id);
const validAccount = (a) => typeof a === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(a); // same shape as accounts.js ID_RE
const validPage = (p) => typeof p === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(p);
const MAX_PAGES = 50; // a hostile local page cannot grow the map without bound

export function createViewing({ now = Date.now, staleMs = STALE_MS } = {}) {
  const pages = new Map(); // page id -> { id: agentId|null, active: bool, at: ms }
  const prune = () => { for (const [k, v] of pages) if (now() - v.at > staleMs) pages.delete(k); };
  return {
    /** Returns true when the report was valid and stored. */
    report(page, id, active, account = null) {
      if (!validPage(page) || typeof active !== 'boolean' || !(id === null || validId(id)) || !(account === null || validAccount(account))) return false;
      prune();
      if (!pages.has(page) && pages.size >= MAX_PAGES) return false;
      pages.set(page, { id, account, active, at: now() });
      return true;
    },
    /** True when any fresh, active page has this agent selected. With `account`, that page must be on that account
     *  too (a page that reported no account, e.g. an old cached one, matches any). */
    isViewing(id, account = null) {
      prune();
      for (const v of pages.values()) if (v.active && v.id === id && (account === null || v.account === null || v.account === account)) return true;
      return false;
    },
  };
}

export const viewing = createViewing();
