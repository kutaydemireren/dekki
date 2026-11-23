// History for one agent: resolve agent id -> sessionId -> transcript file, parse it, then tail it live.
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { listAgents } from './agents.js';
import { isAgentId } from './claude.js';
import { findTranscript, readTranscript } from './transcript.js';

const POLL_MS = 1500; // safety net: fs.watch can miss events

/** @returns {Promise<{status:'unknown'}|{status:'expired'}|{status:'ok', file, meta, entries, size, parser}>} */
export async function loadHistory(agentId) {
  const agent = (await listAgents()).find((a) => a.id === agentId);
  if (!agent) return { status: 'unknown' };
  const file = agent.sessionId ? findTranscript(agent.sessionId) : null;
  if (!file) return { status: 'expired' }; // transcript retention (~30 days) or never written
  try {
    return { status: 'ok', file, ...readTranscript(file) };
  } catch {
    return { status: 'expired' }; // file vanished between find and read
  }
}

const wss = new WebSocketServer({ noServer: true });

/**
 * WS /ws/history?id=<agentId>. Messages to the client:
 *   {type:'init', meta, entries} | {type:'entries', entries} (upsert by id) | {type:'expired'}
 */
export function handleHistoryUpgrade(req, socket, head) {
  const id = new URL(req.url, 'http://x').searchParams.get('id');
  if (!isAgentId(id)) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const send = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    let closed = false;
    let cleanup = () => {};
    ws.on('close', () => { closed = true; cleanup(); });
    ws.on('error', () => { closed = true; cleanup(); });

    loadHistory(id).then((h) => {
      if (closed) return;
      if (h.status !== 'ok') return send({ type: h.status === 'unknown' ? 'error' : 'expired' });
      let { parser, size: offset } = h;
      send({ type: 'init', meta: parser.meta, entries: parser.all() });

      let busy = false;
      const pump = () => {
        if (busy || closed) return;
        busy = true;
        try {
          const st = fs.statSync(h.file);
          if (st.size < offset) { // file replaced/truncated: start over
            const fresh = readTranscript(h.file);
            parser = fresh.parser;
            offset = fresh.size;
            send({ type: 'init', meta: parser.meta, entries: parser.all() });
          } else if (st.size > offset) {
            const fd = fs.openSync(h.file, 'r');
            try {
              const buf = Buffer.alloc(st.size - offset);
              const n = fs.readSync(fd, buf, 0, buf.length, offset);
              const end = buf.subarray(0, n).lastIndexOf(0x0a) + 1; // complete lines only
              if (end > 0) {
                const changed = parser.feed(buf.subarray(0, end).toString('utf8'));
                offset += end;
                if (changed.length) send({ type: 'entries', entries: changed });
              }
            } finally {
              fs.closeSync(fd);
            }
          }
        } catch {
          // file gone or unreadable: keep the connection; the next tick may recover
        } finally {
          busy = false;
        }
      };
      let watcher = null;
      try { watcher = fs.watch(h.file, pump); } catch {}
      const timer = setInterval(pump, POLL_MS);
      cleanup = () => { clearInterval(timer); watcher?.close(); };
    }).catch(() => send({ type: 'error' }));
  });
}
