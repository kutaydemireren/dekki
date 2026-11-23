// Open overlays (dialogs, palette, popovers, menus) in opening order. The ONE Esc handler lives here: a capture-phase keydown
// on window closes only the top-most overlay and consumes the key (preventDefault + stopPropagation), so nothing else sees it.
// preventDefault is what keeps WebKit from passing Esc on to the Mac window, where it would leave full screen.
// With no overlay open the key is left alone (the page and the window behave as before).
const stack = [];

export function pushOverlay(entry) {
  stack.push(entry);
  install();
  return () => { const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1); };
}
export const topOverlay = () => stack[stack.length - 1] || null;
export const overlayCount = () => stack.length;

/** Pure: should this keydown close the top overlay? IME composition Esc (isComposing, or keyCode 229 on Safari) and a key
 *  an earlier handler already claimed (defaultPrevented) are not ours. */
export function isEscapeClose(e, top) {
  if (!top || !e || e.key !== 'Escape') return false;
  if (e.isComposing || e.keyCode === 229 || e.defaultPrevented) return false;
  return true;
}

/** The handler body, exported for tests. Returns true when it closed an overlay. */
export function handleEscape(e) {
  const top = topOverlay();
  if (!isEscapeClose(e, top)) return false;
  e.preventDefault();
  e.stopPropagation();
  top.close();
  return true;
}

let installed = false;
function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', handleEscape, true);
}
