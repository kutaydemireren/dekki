// Browser-origin security (Host and Origin rules, see SECURITY.md). ONE check, used by HTTP and WebSocket upgrade.

export function allowedHosts(port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export function allowedOrigins(port) {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

/**
 * @param {{host?:string, origin?:string, secFetchSite?:string, method:string, path:string, isUpgrade:boolean, port:number}} r
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function checkRequest(r) {
  if (!r.host || !allowedHosts(r.port).includes(r.host.toLowerCase())) {
    return { ok: false, reason: 'bad Host' };
  }
  if (r.origin !== undefined) {
    if (!allowedOrigins(r.port).includes(r.origin.toLowerCase())) return { ok: false, reason: 'bad Origin' };
    return { ok: true };
  }
  // No Origin header from here on.
  if (r.isUpgrade) return { ok: false, reason: 'missing Origin on upgrade' };
  const isApi = r.path === '/api' || r.path.startsWith('/api/');
  if (r.method !== 'GET' && r.method !== 'HEAD') return { ok: false, reason: 'missing Origin on state-changing request' };
  if (!isApi) return { ok: true }; // static files
  // Browsers omit Origin on same-origin GET, so the UI's own API reads arrive without one.
  // Accept those only when the browser itself says same-origin (Sec-Fetch-Site cannot be set by a web page).
  if (r.secFetchSite === 'same-origin') return { ok: true };
  return { ok: false, reason: 'missing Origin on API request' };
}

export function checkNodeRequest(req, port, isUpgrade) {
  const url = new URL(req.url, 'http://x');
  return checkRequest({
    host: req.headers.host,
    origin: req.headers.origin,
    secFetchSite: req.headers['sec-fetch-site'],
    method: req.method,
    path: url.pathname,
    isUpgrade,
    port,
  });
}
