// Server-sent events for the Mac app: GET /api/app/events. While at least one subscriber is connected, notification events
// go to it (the app posts them natively) and the server does NOT also send through terminal-notifier / osascript.
// Which agents notify and when stays in notify.js; this only delivers what it decided. In memory only.
export const KEEPALIVE_MS = 20_000;
const MAX_SUBSCRIBERS = 8; // a hostile local page cannot hold sockets open without bound

export function createSubscribers({ keepAliveMs = KEEPALIVE_MS } = {}) {
  const subs = new Set(); // http.ServerResponse
  const write = (res, text) => { try { res.write(text); return true; } catch { return false; } }; // backpressure (write() false) is not a failure
  return {
    count: () => subs.size,
    /** Take over `res` as an event stream. Returns false (and writes nothing) when full. */
    add(res) {
      if (subs.size >= MAX_SUBSCRIBERS) return false;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      subs.add(res);
      // A comment line every so often: a dead socket then fails its write and closes, so the count never stays inflated.
      const ping = setInterval(() => write(res, ': ping\n\n'), keepAliveMs);
      ping.unref();
      const drop = () => { clearInterval(ping); subs.delete(res); };
      res.on('close', drop);
      res.on('error', drop);
      write(res, 'event: hello\ndata: {}\n\n');
      return true;
    },
    /** Send one event to every subscriber. Returns how many accepted it (0 = nobody got it). */
    broadcast(payload) {
      const text = `event: notify\ndata: ${JSON.stringify(payload)}\n\n`;
      let n = 0;
      for (const res of subs) if (!res.destroyed && write(res, text)) n++;
      return n;
    },
  };
}

export const subscribers = createSubscribers();

/** GET /api/app/events. After the shared Host/Origin check like every route. */
export function appEventsRoute({ subscribers: subs = subscribers } = {}) {
  return async (req, res, url) => {
    if (req.method !== 'GET' || url.pathname !== '/api/app/events') return false;
    if (!subs.add(res)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'too many subscribers' }));
    }
    return true;
  };
}
