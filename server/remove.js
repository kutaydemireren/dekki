// Delete an agent = `claude rm <id>`. Claude itself keeps a worktree that is dirty, locked or has unpushed
// commits and says so. The deck never removes worktrees itself. The only destructive path is
// `discard: true` (explicit confirmation in the UI): it throws away uncommitted changes in the agent's own
// worktree with git, then lets `claude rm` remove the (now clean) worktree, passing claude's own
// --discard-unpushed token if it reports unpushed commits. This mirrors ctrl+x twice in claude's agent view.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { listAgents } from './agents.js';
import { run, isAgentId } from './claude.js';
import { setMember } from './state.js';
import { findTranscript, conversationState } from './transcript.js';

const find = async (id) => (await listAgents()).find((a) => a.id === id);

const git = (cwd, args) => new Promise((resolve) => {
  execFile('git', ['-C', cwd, ...args], { timeout: 30000 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }));
});

async function dirtyFiles(worktreePath) {
  const r = await git(worktreePath, ['status', '--porcelain']);
  return r.ok ? r.stdout.split('\n').filter(Boolean) : [];
}

/** True only for a git worktree root that claude created (default location .claude/worktrees/<name>). */
async function isAgentWorktree(wt) {
  if (!wt || !wt.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`) || !fs.existsSync(wt)) return false;
  const top = await git(wt, ['rev-parse', '--show-toplevel']);
  return top.ok && fs.realpathSync(top.stdout.trim()) === fs.realpathSync(wt);
}

/** `claude stop <id>`: ends the agent's process, the conversation is kept (attach/resume brings it back). */
export async function stopAgent(id) {
  const a = isAgentId(id) && (await find(id));
  if (!a) return { ok: false, status: 404, error: 'Agent not found.' };
  const r = await run(['stop', id], { timeout: 30000 });
  const output = `${r.stdout}${r.stderr}`.trim();
  return r.ok ? { ok: true, status: 200, output } : { ok: false, status: 500, error: output || `claude stop failed (${r.code})` };
}

/**
 * Why a chat must NOT be discarded as an empty draft, or null if it really is one. Fail-safe: it needs two
 * independent signs of emptiness, the transcript (none, or only metadata) AND Claude's idle placeholder in the
 * job state, and any doubt (unreadable or unrecognised transcript, the agent has said something) keeps the chat.
 */
export function draftBlocker(a, convo) {
  if (a.state === 'working') return 'running';
  if (a.worktreePath) return 'has a worktree';
  if (convo === 'messages') return 'has messages';
  if (convo !== 'missing' && convo !== 'empty') return 'unreadable transcript';
  if (!a.idle) return 'the agent has done something';
  return null;
}

/**
 * Discard an empty draft chat (an idle agent nobody has sent a prompt to): `claude rm`, but only after
 * re-checking on the server that it really is empty (see draftBlocker). Anything else is left alone.
 */
export async function discardDraft(id) {
  const a = isAgentId(id) && (await find(id));
  if (!a) return { ok: true, removed: false, reason: 'gone' };
  const blocker = draftBlocker(a, conversationState(a.sessionId ? findTranscript(a.sessionId) : null));
  if (blocker) return { ok: true, removed: false, reason: blocker };
  const r = await run(['rm', id], { timeout: 60000 });
  const output = `${r.stdout}${r.stderr}`.trim();
  if (!r.ok || /^kept\b/m.test(output)) return { ok: true, removed: false, reason: output || 'claude kept it' };
  setMember('pinned', id, false);
  setMember('archived', id, false);
  return { ok: true, removed: true };
}

/** What the confirm dialog needs: name, whether it is running, uncommitted files in its worktree. */
export async function removeCheck(id) {
  const a = isAgentId(id) && (await find(id));
  if (!a) return null;
  return {
    id,
    name: a.name,
    running: a.state === 'working',
    worktreePath: a.worktreePath,
    dirty: a.worktreePath ? await dirtyFiles(a.worktreePath) : [],
  };
}

export async function removeAgent(id, { discard = false } = {}) {
  const a = isAgentId(id) && (await find(id));
  if (!a) return { ok: false, status: 404, error: 'Agent not found.' };
  if (a.state === 'working') return { ok: false, status: 409, error: 'Agent is running. Stop it first (in its Session tab or `claude stop`).' };

  const log = [];
  if (discard && a.worktreePath) {
    if (!(await isAgentWorktree(a.worktreePath))) {
      return { ok: false, status: 409, error: `Not discarding: ${a.worktreePath} is not a worktree Claude created under .claude/worktrees/.` };
    }
    const reset = await git(a.worktreePath, ['reset', '--hard']);
    const clean = await git(a.worktreePath, ['clean', '-fd']);
    if (!reset.ok || !clean.ok) return { ok: false, status: 500, error: `Could not discard changes: ${(reset.stderr || clean.stderr).trim()}` };
    log.push('Discarded uncommitted changes.');
  }

  let r = await run(['rm', id], { timeout: 60000 });
  let output = `${r.stdout}${r.stderr}`.trim();
  if (discard) {
    const m = /--discard-unpushed\s+(\S+)/.exec(output);
    if (m && /^kept\b/m.test(output)) {
      log.push('Discarded unpushed commits.');
      r = await run(['rm', id, '--discard-unpushed', m[1]], { timeout: 60000 });
      output = `${r.stdout}${r.stderr}`.trim();
    }
  }
  const kept = /^kept\b/m.test(output); // claude kept the worktree (and the session row) and says why: not an error
  if (!r.ok && !kept) return { ok: false, status: 500, error: output || `claude rm failed (${r.code})` };
  if (!kept) {
    setMember('pinned', id, false);
    setMember('archived', id, false);
  }
  return { ok: true, status: 200, kept, output: [...log, output].filter(Boolean).join('\n') };
}
