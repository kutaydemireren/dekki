# scripts

Helper scripts for development and checks. Run them from the repo root. None of them is needed to use the deck.

Browser checks start headless Edge or Chrome. The default is the macOS Microsoft Edge path; set `DECK_TEST_BROWSER` to the executable of any Chromium-based browser to use another one, for example `DECK_TEST_BROWSER="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`. They need `npm run build` first.

| Script | What it does | Real agents? |
|---|---|---|
| `add-account.mjs <label> <configDir>` | Records a second Claude account in the deck state file. Does not log in. | Writes the real state file (or `DEKKI_STATE`); no agents. |
| `accounts-browser-check.mjs [screenshot-dir]` | Browser check of the account switcher. Starts two decks of its own (one account, two accounts). | No: temp state and config dir, a stub `claude`. |
| `accounts-live-check.mjs` | Starts one agent named `dekki-throwaway-acct`, attaches a terminal, switches accounts, then removes it with `claude rm`. | Starts a throwaway agent; needs a real `claude` and a throwaway deck (`PORT`, temp `DEKKI_STATE`). |
| `root-browser-check.mjs` | Browser check of the per-account working folder. Starts its own deck. | No: temp state and a stub `claude`. |
| `setup-wizard-browser-check.mjs` | Browser check of the setup wizard (four screens, dark and light, health result). Starts its own deck, prints screenshot paths. | No: temp HOME and state, a fixture template and a stub `claude`. |
| `manager-changes-browser-check.mjs [screenshot-dir]` | Browser check of the manager's Changes tab. Starts its own demo-mode deck. | No: demo mode, temp state. |
| `manager-status-browser-check.mjs` | Browser check of the manager status line. Starts its own deck. | No: temp state and a stub `claude`. |
| `shortcuts-browser-check.mjs` | Browser check of `Cmd+B`, `Cmd+Shift+S` and `Cmd+Shift+P` (toggle the folder tree, skill usage, saved prompts). Starts its own demo-mode deck. | No: demo mode, temp state. |
| `notify-links-browser-check.mjs` | Checks cross-account notifications and deep links. Starts its own deck, notifications off. | No: temp state and a stub `claude`. |
| `demo-screenshots.mjs <label> [out-dir]` | Screenshots of the main states from a demo-mode deck. | No: demo mode never calls `claude`. |
| `template-dry-run.sh` | Dry run of the manager folder template with a stub `claude`. | No: all temp. |
| `mac-app-check.sh` | Smoke check of the Mac app on its own port with temp state. | No real agents; builds and launches the Mac app. |
| `../mac/icon/make-icon.sh` | Regenerates the Mac app icon (`mac/icon/AppIcon.icns`) from `render.swift`. Needs the Xcode command line tools. | No. |
| `ws-reject-check.mjs` | Sends bad WebSocket upgrades to a running deck and expects them to be refused. | Talks to the deck at `PORT` (default 4317); sends only invalid requests. |
| `history-live-check.mjs <agentId> [seconds]` | Prints live history events of one agent from a running deck. | Read-only on the agent you name. |
| `dump-transcript.js <file or id>` | Prints a transcript to the terminal. | Read-only. |
| `parse-all.mjs` | Parses every transcript under `~/.claude/projects` and reports counts and timing. | Read-only on your real session files. |
| `peek.mjs <file>` | Prints record types and keys of a transcript file. | Read-only. |
