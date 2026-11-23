# Contributing

Dekki is a small personal tool, kept deliberately simple. Bug reports and focused pull requests are welcome; for anything large, open an issue first.

## Setup

Needs Node 22.12 or newer, and (to use it with real agents) the `claude` CLI signed in.

```
npm ci
npm run build
npm start        # http://127.0.0.1:4317, PORT overrides
```

After a change under `web/` run `npm run build` and reload the tab; after a change under `server/` restart the deck too. `npm run dev` rebuilds the page on change and restarts the server.

Demo mode needs no agents and never touches `~/.claude` or `~/.dekki`:

```
DEKKI_DEMO=1 PORT=4350 npm start
```

## Tests

```
npm test
```

This is `node --test server/test/*.test.js`. Two test files use fixed ports and fail with `EADDRINUSE` if something else holds them: `root.test.js` uses 4398 and `security.test.js` uses 4399. Rerun them alone if they clash.

Browser checks live in `scripts/` (see `scripts/README.md`). They drive headless Edge or Chrome; set `DECK_TEST_BROWSER` to the browser executable if it is not at the default macOS Edge path. Run `npm run build` first.

## Safety rules for tests and scripts

People run the deck next to real background agents. Tests and scripts must never harm them:

- Never stop, remove, respawn or type into an existing agent. If a test needs a live agent, start a throwaway one named `dekki-throwaway-*` and remove it with `claude rm`.
- Use a throwaway deck: your own `PORT`, a temp `DEKKI_STATE` file, and a temp `DEKKI_PROMPTS` folder. Do not point tests at your real state, prompts or `~/.claude`.
- Never print secrets, and never commit anything from `~/.claude` or `~/.dekki`.
- Never push to main, master or develop, and never force-push.

## Code rules

- Keep it simple: the smallest thing that works, few dependencies, no database, no auth.
- All transcript (JSONL) parsing lives in `server/transcript.js`. The format is undocumented: ignore unknown record types and tolerate unknown tools and malformed lines.
- Drive Claude Code through the `claude` CLI; do not reimplement it. Use `execFile` with argument arrays.
- Code that calls `claude` or reads `jobs/` and `projects/` goes through `server/accounts.js`.
- Bind to `127.0.0.1` only and keep the Host and Origin checks.

`CLAUDE.md` has the same rules for coding agents.
