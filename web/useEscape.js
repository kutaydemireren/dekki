import { useEffect, useRef } from 'react';
import { pushOverlay } from './overlay-stack.js';

// Registers a popup (dialog, palette, popover, menu) on the overlay stack for as long as it is mounted. Esc then closes the
// top-most one through the single handler in overlay-stack.js; `onClose` is the popup's own close/cancel handler.
// Every new popup must call this once (Dialog, Palette, ContextMenu and AccountsPopover already do).
export default function useEscape(onClose) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => pushOverlay({ close: () => ref.current() }), []);
}
