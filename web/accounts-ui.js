// Pure helpers for the quiet Accounts entry on the home screen (web/AccountsPopover.jsx).
export const ADD_ACCOUNT_CMD = 'node scripts/add-account.mjs Second ~/.claude-second';
export const LOGIN_CMD = 'CLAUDE_CONFIG_DIR=~/.claude-second claude auth login';

const ORDINALS = ['Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];

/** Example label, folder and the two commands for the NEXT account, derived from how many accounts exist (1 -> Second, 2 -> Third ...). Only an example: the user may change it. */
export function addAccountExample(count) {
  const n = Math.max(1, Number.isFinite(count) ? Math.floor(count) : 1);
  const label = ORDINALS[n - 1] || `Account ${n + 1}`;
  const slug = ORDINALS[n - 1] ? label.toLowerCase() : String(n + 1);
  const dir = `~/.claude-${slug}`;
  return { label, dir, addCmd: `node scripts/add-account.mjs ${label.replace(/ /g, '')} ${dir}`, loginCmd: `CLAUDE_CONFIG_DIR=${dir} claude auth login` };
}

/** Text of the quiet button: the active account's label, or "Accounts" while the list is not loaded. */
export function accountsButtonLabel(accounts, active) {
  const list = Array.isArray(accounts) ? accounts : [];
  const cur = list.find((a) => a.id === active) || list[0];
  return cur?.label || 'Accounts';
}

/** Rows of the switch list: the current one marked, a missing config dir disabled with a note. */
export function accountRows(accounts, active) {
  return (Array.isArray(accounts) ? accounts : []).map((a) => ({
    id: a.id,
    label: a.label,
    current: a.id === active,
    disabled: Boolean(a.missing) && a.id !== active,
    note: a.missing ? '(config dir missing)' : '',
  }));
}
