# Dekki: guide for contributors and coding agents

A local web UI on top of Claude Code background agents, for one user on one machine. Keep it simple: no auth, no database, no scaling work, no over-engineering.

## Run and test
- `npm ci` (or `npm install`), then `npm start` (port 4317, `PORT` overrides). `npm run build` rebuilds the page into `dist/`; after a change under `web/` or `server/`, rebuild, restart the deck and reload the browser tab.
- `npm test` runs `node --test` (Node 22.12 or newer). `server/test/security.test.js` uses fixed port 4399 and `root.test.js` uses 4398: they fail with `EADDRINUSE` if something else holds the port, so rerun them alone.
- Demo mode needs no agents: `DEKKI_DEMO=1 PORT=4350 npm start`.
- Try changes on a throwaway deck: your own `PORT`, a temp `DEKKI_STATE` file, and a temp `DEKKI_PROMPTS` folder for prompt tests. Never point tests at your real state or prompts.
- See `CONTRIBUTING.md` and `scripts/README.md` for the rest.

## Code rules
- Keep it simple. Prefer the smallest thing that works, with few dependencies.
- All transcript (JSONL) parsing lives in ONE module, `server/transcript.js`. The format is undocumented and may change: ignore unknown record types, tolerate unknown tools and malformed lines. Find transcripts by globbing `<config dir>/projects/*/<sessionId>.jsonl` in the active account's config dir (default `~/.claude`), never by encoding `cwd`.
- Drive Claude Code through the `claude` CLI; do not reimplement it. Use `execFile` with an argument array, never a shell string built from input.
- Bind to `127.0.0.1` only, and keep the Host and Origin checks on every API and WebSocket request.
- Work one step at a time; each step must be runnable and tryable on its own.

## Accounts
The deck supports several Claude accounts, each a config directory selected through `CLAUDE_CONFIG_DIR` (default `~/.claude`). Code that calls `claude` or reads `jobs/` or `projects/` goes through `server/accounts.js` (`claudeEnv`, `configDirOf`) and may take an explicit account.

## Safety
Anyone running the deck has real background agents in use. Code and tests must keep them safe.
- Never stop, remove, respawn, or attach-and-type into an existing agent from a test or a script. If a test needs that, create a throwaway agent (`--name dekki-throwaway-*`) and clean it up with `claude rm`.
- `claude rm` already removes a clean worktree and keeps the branch. Never force-remove silently or discard uncommitted or unpushed work without explicit user confirmation. The deck never removes a worktree itself.
- Don't install anything globally.
- Never print secrets. Never commit anything from `~/.claude` or `~/.dekki`.
- Never push to main, master or develop, never force-push, never merge for the user.

## Gotchas
- node-pty on macOS needs `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper` (the `postinstall` script does it), or spawn fails with `posix_spawnp failed`.
- `claude --bg` refuses untrusted workspaces ("Workspace not trusted"). Surface the error; never bypass trust.
- A server restart alone keeps the old page code in an open tab: rebuild and reload the tab.
