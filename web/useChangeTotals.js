import { useEffect, useState } from 'react';
import { POLL_MS } from './changes-logic.js';

/** { files, add, del } of the selected agent's changes vs base (null: unknown, none, or no git). Feeds the count in the header. */
export function useChangeTotals(agentId, running, lastActivityAt) {
  const [totals, setTotals] = useState(null);
  useEffect(() => { setTotals(null); }, [agentId]);
  useEffect(() => {
    if (!agentId) return undefined;
    let stop = false;
    const load = () => fetch(`/api/agents/${agentId}/changes?scope=all`)
      .then((r) => r.json())
      .then((d) => { if (!stop) setTotals(d.status === 'ok' ? d.totals : null); })
      .catch(() => { /* keep the last count */ });
    load();
    const t = running ? setInterval(() => { if (!document.hidden) load(); }, POLL_MS) : null;
    return () => { stop = true; if (t) clearInterval(t); };
  }, [agentId, running, lastActivityAt]);
  return totals;
}
