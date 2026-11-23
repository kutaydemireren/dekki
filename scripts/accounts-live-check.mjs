// Live check against a THROWAWAY deck (own PORT, temp DEKKI_STATE with a second account):
//   PORT=4391 node scripts/accounts-live-check.mjs
// Starts an idle agent named dekki-throwaway-acct under the default account, attaches a Session terminal over
// /ws/attach, switches to the other account and expects: the terminal socket is closed, the agent list is empty,
// the old agent id is not listed. Then switches back, shows the agent again and removes it with `claude rm`.
import WebSocket from 'ws';
import { execFileSync } from 'node:child_process';

const port = process.env.PORT || '4391';
const base = `http://127.0.0.1:${port}`;
const H = { Origin: base, 'Content-Type': 'application/json' };
const api = async (p, opt = {}) => (await fetch(base + p, { headers: H, ...opt })).json();
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };

const acct = await api('/api/accounts');
const other = acct.accounts.find((a) => a.id !== 'default');
if (acct.accounts.length < 2 || acct.active !== 'default') throw new Error('need default active + one more account');

const started = await api('/api/agents', { method: 'POST', body: JSON.stringify({ name: 'dekki-throwaway-acct' }) });
ok(started.ok && started.id, `throwaway agent started ${started.id}`);
const id = started.id;
try {
  ok((await api('/api/agents')).agents.some((a) => a.id === id), 'agent listed under default');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/attach?id=${id}&cols=80&rows=24`, { headers: { Origin: base } });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const closed = new Promise((r) => ws.on('close', () => r(true)));
  await new Promise((r) => setTimeout(r, 1500));
  const sw = await api('/api/accounts/active', { method: 'POST', body: JSON.stringify({ id: other.id }) });
  ok(sw.ok && sw.active === other.id, `switched to ${other.id}`);
  ok(await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 4000))]), 'Session terminal socket closed on switch');
  const after = await api('/api/agents');
  ok(after.account === other.id && !after.agents.some((a) => a.id === id), 'old agent not listed under the other account');
  ok((await api(`/api/agents/${id}/history`)).status !== 'ok', 'old agent history not served under the other account');
  await api('/api/accounts/active', { method: 'POST', body: JSON.stringify({ id: 'default' }) });
  ok((await api('/api/agents')).agents.some((a) => a.id === id), 'agent listed again after switching back');
} finally {
  try { execFileSync('claude', ['rm', id], { timeout: 60000, stdio: 'pipe' }); console.log(`removed throwaway ${id}`); } catch (e) { console.log(`REMOVE FAILED ${id}: ${e.message}`); }
}
