// Location hash deep link. Pure, shared by the page (load + hashchange) and the server (notification click link).
//   "#<agentId>[/history]"                 old form: the account the page is on
//   "#<accountId>:<agentId>[/history]"     names the account the agent belongs to
// agentId = 8 hex, accountId = accounts.js ID_RE (lowercase alphanumerics and '-', so never contains ':').
// Anything that does not validate parses to id null and account null: never an error, never a guess.
export const AGENT_ID_RE = /^[0-9a-f]{8}$/;
export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function parseHash(hash) {
  const h = String(hash || '').replace(/^#/, '');
  const tab = h.endsWith('/history') ? 'history' : 'session';
  const head = h.split('/')[0];
  const colon = head.indexOf(':');
  const accountPart = colon < 0 ? null : head.slice(0, colon);
  const idPart = colon < 0 ? head : head.slice(colon + 1);
  const id = AGENT_ID_RE.test(idPart) && (accountPart === null || ACCOUNT_ID_RE.test(accountPart)) ? idPart : null;
  return { account: id ? accountPart : null, id, tab };
}

/** The hash for an agent. account optional (omitted: old form). Returns null when something does not validate. */
export function buildHash(id, account = null, tab = 'session') {
  if (!AGENT_ID_RE.test(id) || !(account === null || ACCOUNT_ID_RE.test(account))) return null;
  return `#${account ? `${account}:` : ''}${id}${tab === 'history' ? '/history' : ''}`;
}
