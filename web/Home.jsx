import React, { useEffect, useMemo, useState } from 'react';
import AccountsPopover from './AccountsPopover.jsx';
import { accountsButtonLabel } from './accounts-ui.js';
import StatusGlyph from './StatusGlyph.jsx';
import { homeSummary, greeting } from './home.js';
import { age } from './groups.js';

// Mission control: shown when no agent is selected. Counts use the list's own grouping rules (home.js).
export default function Home({ setup, onSetup, agents, prefs, onSelect, accounts = [], activeAccount, accountColors = ['var(--acct-1)'], onSwitchAccount, autoOpenAccounts, onAccountsOpened }) {
  const [acctOpen, setAcctOpen] = useState(false);
  useEffect(() => { if (autoOpenAccounts) { setAcctOpen(true); onAccountsOpened?.(); } }, [autoOpenAccounts]); // eslint-disable-line react-hooks/exhaustive-deps
  const multi = accounts.length > 1;
  const actIdx = Math.max(0, accounts.findIndex((a) => a.id === activeAccount));
  const { needs, working, done } = useMemo(() => homeSummary(agents, prefs), [agents, prefs]);
  const tiles = [
    { key: 'need', label: 'Needs you', glyph: 'needs', list: needs },
    { key: 'work', label: 'Working', glyph: 'working', list: working },
    { key: 'done', label: 'Done today', glyph: 'done', list: done },
  ];
  const sub = !agents.length ? 'No agents yet. Use New to start one.'
    : needs.length ? `${needs.length} agent${needs.length === 1 ? '' : 's'} waiting on you.`
    : working.length ? `${working.length} working, nothing needs you.`
    : 'Nothing needs you right now.';
  return (
    <div className="home">
      <h2>{greeting()}</h2>
      <div className="hs">{sub}</div>
      {setup && !setup.rootReady && !setup.demo && onSetup && (
        <div className="setup-callout">
          <span>{setup.root ? 'Your manager folder is not set up yet.' : 'Set up your manager folder to start agents.'}</span>
          <button type="button" className="primary" onClick={onSetup}>Set up</button>
        </div>
      )}
      <div className="tiles">
        {tiles.map((t) => (
          <button key={t.key} className={`tile ${t.key}`} disabled={!t.list.length} onClick={() => t.list[0] && onSelect(t.list[0].id)} title={t.list.length ? `Open ${t.list[0].name}` : undefined}>
            <div className="n">{t.list.length}</div>
            <div className="l"><StatusGlyph state={t.glyph} active={t.list.length > 0} />{t.label}</div>
          </button>
        ))}
      </div>
      {needs.length > 0 && (
        <>
          <div className="sec">Waiting on you</div>
          {needs.map((a) => (
            <div key={a.id} className="ask">
              <StatusGlyph state={a.stalled ? 'stalled' : 'needs'} />
              <div className="tx">
                <b>{a.name}</b>
                <div>{a.stalled ? 'Stalled: its turn ended and nothing will wake it. Send it a message.' : a.detail || 'Needs your input'}</div>
              </div>
              {a.lastActivityAt && <span className="ask-age">{age(a.lastActivityAt)}</span>}
              <button className="btn" onClick={() => onSelect(a.id)}>Open</button>
            </div>
          ))}
        </>
      )}
      <div className="hint">
        <span><kbd>/</kbd> search agents</span>
        <span><kbd>Esc</kbd> clear the search</span>
        {onSetup && <button type="button" className="acct-quiet" title="Set up or check the manager folder" onClick={onSetup}>Setup</button>}
        <span className="acct-wrap">
          <button type="button" className="acct-quiet" aria-haspopup="true" aria-expanded={acctOpen} title="Claude accounts" onClick={() => setAcctOpen((v) => !v)}>
            {multi && <span className="account-dot" style={{ '--account': accountColors[actIdx % accountColors.length] }} />}
            {accountsButtonLabel(accounts, activeAccount)}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
          {acctOpen && <AccountsPopover accounts={accounts} active={activeAccount} colors={accountColors} onSwitch={onSwitchAccount} onClose={() => setAcctOpen(false)} />}
        </span>
      </div>
    </div>
  );
}
