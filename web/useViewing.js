import { useEffect } from 'react';

// Tell the server which agent this page is looking at, so it skips macOS notifications for it.
// Viewing = the agent is selected on Session or History, the page is visible and has focus.
const PAGE = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
const HEARTBEAT_MS = 10_000;

const send = (id, active, account) => {
  fetch('/api/viewing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: PAGE, id, active, account }), keepalive: true }).catch(() => {});
};

// account = the account the agent belongs to (the page's own), so another account's agent with the same id is not suppressed.
export function useViewing(selectedId, tab, account = null) {
  useEffect(() => {
    const id = selectedId && (tab === 'session' || tab === 'history') ? selectedId : null;
    const active = () => Boolean(id) && document.visibilityState === 'visible' && document.hasFocus();
    const report = () => send(id, active(), account);
    report();
    const t = setInterval(() => { if (active()) report(); }, HEARTBEAT_MS);
    document.addEventListener('visibilitychange', report);
    window.addEventListener('focus', report);
    window.addEventListener('blur', report);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', report);
      window.removeEventListener('focus', report);
      window.removeEventListener('blur', report);
    };
  }, [selectedId, tab, account]);
}
