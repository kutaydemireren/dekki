// Returns the normalized URL when `uri` is a well-formed http(s) URL, else null.
export function safeLinkUrl(uri) {
  if (typeof uri !== 'string') return null;
  let u;
  try { u = new URL(uri.trim()); } catch { return null; }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
}

// xterm linkHandler: open OSC 8 links straight in a new tab (the Mac shell hands them to the browser).
export const termLinkHandler = {
  allowNonHttpProtocols: false,
  activate(_event, uri) {
    const url = safeLinkUrl(uri);
    if (!url) return;
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.click();
  },
};
