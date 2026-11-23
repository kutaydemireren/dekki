import { useSyncExternalStore } from 'react';

// One toast at a time, shown by <ToastHost> (web/Toast.jsx). A new toast replaces the current one and restarts the timer.
let current = null;
let seq = 0;
let timer = null;
const subs = new Set();
const emit = () => subs.forEach((f) => f());

/** kind: 'info' | 'error' | 'ok'. Errors stay a little longer. */
export function showToast(text, kind = 'info', ms = kind === 'error' ? 6000 : 2500) {
  clearTimeout(timer);
  current = { id: ++seq, text: String(text), kind };
  emit();
  timer = setTimeout(dismissToast, ms);
}
export function dismissToast() { clearTimeout(timer); current = null; emit(); }

export const useCurrentToast = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => current);

/** Hook for components: `const { toast } = useToast(); toast('Copied'); toast(err.message, 'error');` */
export default function useToast() { return { toast: showToast, dismiss: dismissToast }; }
