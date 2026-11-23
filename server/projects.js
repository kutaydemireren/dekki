// New agent = always the manager: `claude --bg` started in the active account's working folder, where the manager playbook
// (CLAUDE.md) lives. The manager works out which projects a request touches and delegates to a worker in
// each. The deck deliberately cannot start project-scoped agents.
import { run } from './claude.js';
import { setMember } from './state.js';
import { trustHelp, activeAccount, activeRoot } from './accounts.js';

const NAME_RE = /^[\w][\w .-]{0,79}$/;
const MAX_PROMPT = 20000;

/** claude --bg arguments. No prompt = an idle agent you type into from the Session tab (full terminal UX). */
export function buildArgs({ name, prompt }) {
  const args = ['--bg'];
  if (name) args.push('-n', name);
  if (prompt) args.push('--', prompt);
  return args;
}

/** Failed start. A trust failure carries trustMessage (+ trustCommand for a non-default account); the UI only shows them. */
export function failure(r, output, dir) {
  const trust = /workspace not trusted/i.test(output);
  const out = { ok: false, error: output || `claude exited with code ${r.code}`, trust, dir };
  if (trust) { const h = trustHelp(dir); out.trustMessage = h.message; out.trustCommand = h.command; }
  return out;
}

/** Returns {ok:true,id,output} or {ok:false,error,trust,trustMessage,trustCommand,dir} (never throws on user input). */
export async function startAgent({ prompt, name } = {}) {
  if (prompt != null && prompt !== '' && (typeof prompt !== 'string' || prompt.length > MAX_PROMPT)) return { ok: false, error: 'Invalid or too long prompt.' };
  if (name != null && name !== '' && (typeof name !== 'string' || !NAME_RE.test(name))) return { ok: false, error: 'Invalid name (letters, digits, space, . _ -).' };

  const dir = activeRoot();
  // A non-default account has its own working folder and never falls back to another account's.
  if (!dir) return { ok: false, noRoot: true, error: `Choose a working folder for ${activeAccount().label} first.` };
  const r = await run(buildArgs({ name, prompt: typeof prompt === 'string' ? prompt.trim() : '' }), { cwd: dir, timeout: 60000 });
  const output = `${r.stdout}${r.stderr}`.trim();
  if (!r.ok) return failure(r, output, dir);
  const m = /\b([0-9a-f]{8})\b/.exec(output);
  if (m) setMember('owned', m[1], true); // started from the deck: always in the main list
  return { ok: true, id: m ? m[1] : null, output };
}
