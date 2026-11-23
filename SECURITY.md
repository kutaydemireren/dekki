# Security

## Reporting a vulnerability

Please report it privately through GitHub security advisories: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for it. I will answer as soon as I can; this is a personal project, so there is no fixed response time.

## Threat model

Dekki is a single-user tool for your own machine. It has no authentication, on purpose.

What it does to stay safe:

- It listens on `127.0.0.1` only. Never bind it to another interface or put it behind a proxy or tunnel: anyone who can reach the port can read your agents' transcripts and type into your agents.
- Every HTTP request and WebSocket upgrade must carry a `Host` of `127.0.0.1:<port>` or `localhost:<port>`. A request with an `Origin` header must come from the same two origins; state-changing requests and WebSocket upgrades without an `Origin` are refused. An `/api` GET without an `Origin` is accepted only when the browser says `Sec-Fetch-Site: same-origin`, which a web page cannot forge. This keeps other websites in your browser (including DNS-rebinding pages) from reaching the API. It also means a plain `curl http://127.0.0.1:4317/api/agents` gets `403`; add `-H 'Origin: http://127.0.0.1:4317'` to try the API by hand.
- It starts other programs with `execFile` and argument arrays, never through a shell string built from input. Values that reach a command line (ports, 8-hex agent ids, account ids) are validated first.
- Paths from the browser are validated: the saved-prompts folder refuses anything that resolves outside it, uploads are written with mode 0600, and "delete" in saved prompts moves files to a `.trash` folder instead of erasing them.
- The deck never stops, removes or restarts an agent on its own; those are buttons you press.

In scope: bypasses of the Host and Origin checks, path traversal out of the prompts folder, uploads or file access outside the intended folders, command injection through any input, and ways for a web page to make the deck act without you.

Out of scope: anything that needs an attacker who already runs code as your user or can reach `127.0.0.1` from your machine, the missing authentication itself, running the deck on a non-loopback address, and problems in Claude Code, the `claude` CLI or your browser.

## Dependencies

The page is built with Vite 8 and `@vitejs/plugin-react` 6 (they need Node 22.12 or newer). `npm audit` reports no known vulnerabilities at the time of writing. Dependabot opens update pull requests weekly.
