// Thin wrappers over the `claude` CLI. Always execFile (no shell strings); ids validated first.
import { execFile } from 'node:child_process';
import { claudeEnv } from './accounts.js';

const ID_RE = /^[0-9a-f]{8}$/;
export const isAgentId = (id) => typeof id === 'string' && ID_RE.test(id);

export function run(args, { cwd, timeout = 20000, account } = {}) { // account: default = the active one
  return new Promise((resolve) => {
    execFile('claude', args, { cwd, timeout, env: claudeEnv(account), maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
