// WebSocket <-> node-pty running `claude attach <id>`. The pty is killed when the socket closes
// (the agent keeps running; detaching never stops it).
import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import { isAgentId } from './claude.js';
import { claudeEnv } from './accounts.js';

const wss = new WebSocketServer({ noServer: true });
const live = new Set(); // open Session sockets; they belong to the account that was active when they attached

/** Close every open Session terminal (used when the active account changes). The agents keep running. */
export function closeAttachSessions() {
  for (const ws of live) { try { ws.close(); } catch {} }
}

function clampSize(v, def) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 2 && n <= 1000 ? n : def;
}

export function handleAttachUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id');
  if (!isAgentId(id)) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  const cols = clampSize(url.searchParams.get('cols'), 100);
  const rows = clampSize(url.searchParams.get('rows'), 30);
  wss.handleUpgrade(req, socket, head, (ws) => {
    const send = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    let term;
    try {
      term = pty.spawn('claude', ['attach', id], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: process.env.HOME,
        env: { ...claudeEnv(), TERM: 'xterm-256color' },
      });
    } catch (e) {
      send({ type: 'error', message: `could not start claude attach: ${e.message}` });
      return ws.close();
    }
    term.onData((data) => send({ type: 'output', data }));
    term.onExit(({ exitCode }) => {
      send({ type: 'exit', code: exitCode });
      ws.close();
    });
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'input' && typeof m.data === 'string') term.write(m.data);
      else if (m.type === 'resize') term.resize(clampSize(m.cols, cols), clampSize(m.rows, rows));
    });
    live.add(ws);
    const cleanup = () => { live.delete(ws); try { term.kill(); } catch {} };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });
}
