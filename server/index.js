import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNodeRequest } from './security.js';
import { handleAttachUpgrade } from './pty.js';
import { handleHistoryUpgrade } from './history.js';
import { apiRoutes } from './routes.js';
import { appShellRoutes } from './appshell.js';
import { appEventsRoute } from './appevents.js';
import { startNotifyPoller } from './notify.js';
import { startUnarchivePoller } from './unarchive.js';
import { demoEnabled, DEMO_PORT, prepareDemo, demoRoutes, demoHistoryUpgrade, demoAttachUpgrade } from './demo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

const HELLO = '<!doctype html><title>Dekki</title><body style="background:#1e1e1e;color:#ddd;font:14px sans-serif"><h1>Dekki</h1><p>Server is up. (Frontend not built yet.)</p>';

export function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(DIST, rel);
  if (!file.startsWith(DIST + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    if (pathname === '/' && !fs.existsSync(path.join(DIST, 'index.html'))) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end(HELLO);
    }
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

/**
 * routes: array of (req, res, url) => boolean (true if handled). Called only after the security check.
 * onUpgrade: (req, socket, head) => void, called only after the security check.
 */
export function createServer({ port, routes = [], onUpgrade } = {}) {
  const server = http.createServer(async (req, res) => {
    const verdict = checkNodeRequest(req, port, false);
    if (!verdict.ok) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Forbidden');
    }
    const url = new URL(req.url, 'http://x');
    try {
      for (const route of routes) if (await route(req, res, url)) return;
    } catch (e) {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
      return;
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/api') return sendJson(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    serveStatic(req, res, url.pathname);
  });
  server.on('upgrade', (req, socket, head) => {
    const verdict = checkNodeRequest(req, port, true);
    if (!verdict.ok || !onUpgrade) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    onUpgrade(req, socket, head);
  });
  return server;
}

export function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => resolve(server));
  });
}

export async function main() {
  // Demo mode (DEKKI_DEMO=1, server/demo.js): fictional agents, temp state, no real claude, no pollers.
  const demo = demoEnabled();
  const demoRoot = demo ? prepareDemo().root : null;
  const port = Number(process.env.PORT) || (demo ? DEMO_PORT : 4317);
  const upgradeRoutes = demo
    ? { '/ws/attach': demoAttachUpgrade, '/ws/history': demoHistoryUpgrade }
    : { '/ws/attach': handleAttachUpgrade, '/ws/history': handleHistoryUpgrade };
  const onUpgrade = (req, socket, head) => {
    const handler = upgradeRoutes[new URL(req.url, 'http://x').pathname];
    if (!handler) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    handler(req, socket, head);
  };
  const routes = demo ? [demoRoutes(demoRoot), apiRoutes()] : [appShellRoutes(), appEventsRoute(), apiRoutes()];
  const server = createServer({ port, routes, onUpgrade });
  await listen(server, port);
  if (!demo) {
    startNotifyPoller({ port: server.address().port });
    startUnarchivePoller();
  }
  console.log(`Dekki${demo ? ' (DEMO, fictional data)' : ''}: http://${HOST}:${port}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
