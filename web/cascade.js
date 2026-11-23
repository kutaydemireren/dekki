// Deleting a manager can take its workers along. Which ones are ticked by default is the safety rule:
// only finished workers with nothing to lose. Pure logic, no fetching.

/**
 * How one worker's `DELETE /api/agents/:id` went, for the cascade. 'gone' (404: someone already removed it) counts
 * as done; only a real failure ('error') stops the cascade before the manager is deleted.
 */
export function workerOutcome(body) {
  if (body?.ok && !body.kept) return 'deleted';
  if (body?.ok) return 'kept';
  if (body?.status === 404) return 'gone';
  return 'error';
}

/**
 * @param workers the manager's workers (agent rows from the list: id, name, state, needsInput)
 * @param checks  remove-check result per worker id ({running, dirty: [files]}), or missing if the check failed
 * @returns per worker {id, name, state, defaultOn, disabled, reason}
 *   defaultOn: finished and clean; unticked (but tickable) while waiting for input, with uncommitted changes, or
 *   unchecked; disabled while running (claude refuses to remove a running agent).
 */
export function planWorkers(workers, checks = {}) {
  return workers.map((w) => {
    const c = checks[w.id];
    const reasons = [];
    const running = w.state === 'working' || c?.running;
    if (running) reasons.push('running: stop it first');
    if (w.needsInput) reasons.push('waiting for your answer');
    if (c?.dirty?.length) reasons.push(`uncommitted changes (${c.dirty.length}) in its worktree: Delete would keep them`);
    if (!c && !running) reasons.push('could not check its worktree');
    return { id: w.id, name: w.name, state: w.state, defaultOn: reasons.length === 0, disabled: Boolean(running), reason: reasons.join('; ') };
  });
}
