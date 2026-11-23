// Read-only routes for the Mac app shell (mac/main.swift). Called after the shared Host/Origin check like every route.
import { attention as defaultAttention } from './attention.js';

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function appShellRoutes({ attention = defaultAttention } = {}) {
  return async (req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/api/attention') {
      json(res, 200, attention.snapshot());
      return true;
    }
    return false;
  };
}
