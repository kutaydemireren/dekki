import { useEffect, useState } from 'react';

// "Unread" = an agent has new activity (it finished, failed or needs input) since you last had it open.
// Last-seen timestamps live in this browser's localStorage. First run marks everything as seen.
const KEY = 'dekki.seen';

const load = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
const save = (o) => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* private mode etc. */ } };

export default function useUnread(agents, selectedId) {
  const [seen, setSeen] = useState(load); // null until first run
  const [visible, setVisible] = useState(document.visibilityState === 'visible');

  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  useEffect(() => {
    if (!agents.length) return;
    setSeen((prev) => {
      const next = prev ? { ...prev } : Object.fromEntries(agents.map((a) => [a.id, a.lastActivityAt ?? 0]));
      const open = agents.find((a) => a.id === selectedId);
      if (open && visible) next[open.id] = open.lastActivityAt ?? 0; // looking at it: it is read
      if (prev && JSON.stringify(prev) === JSON.stringify(next)) return prev;
      save(next);
      return next;
    });
  }, [agents, selectedId, visible]);

  const unread = new Set();
  if (seen) {
    for (const a of agents) {
      if (a.state === 'working') continue; // nothing to read yet
      if (!(a.id in seen) || (a.lastActivityAt ?? 0) > seen[a.id]) unread.add(a.id);
    }
  }
  return unread;
}
