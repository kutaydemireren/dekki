// Theme setting: System | Dark | Light. The setting is kept in localStorage; the resolved value ('dark' | 'light')
// is written to <html data-theme>. index.html runs a copy of this logic before first paint (no flash).
export const THEME_KEY = 'dekki.theme';
export const THEMES = ['system', 'dark', 'light'];
export const THEME_LABEL = { system: 'System', dark: 'Dark', light: 'Light' };

export const normalizeTheme = (v) => (THEMES.includes(v) ? v : 'system');
export const nextTheme = (cur) => THEMES[(THEMES.indexOf(normalizeTheme(cur)) + 1) % THEMES.length];
export const resolveTheme = (setting, systemIsLight) => {
  const s = normalizeTheme(setting);
  return s === 'system' ? (systemIsLight ? 'light' : 'dark') : s;
};

export function readTheme() {
  try { return normalizeTheme(localStorage.getItem(THEME_KEY)); } catch { return 'system'; }
}
const systemIsLight = () => { try { return window.matchMedia('(prefers-color-scheme: light)').matches; } catch { return false; } };
export const currentResolved = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

/** Apply a setting: write data-theme, remember it, tell listeners (the terminals) when the resolved theme changed. */
export function applyTheme(setting, { save = true } = {}) {
  const s = normalizeTheme(setting);
  const resolved = resolveTheme(s, systemIsLight());
  const root = document.documentElement;
  const changed = root.dataset.theme !== resolved;
  root.dataset.theme = resolved;
  root.dataset.themeSetting = s;
  if (save) { try { localStorage.setItem(THEME_KEY, s); } catch { /* ignore */ } }
  if (changed) window.dispatchEvent(new CustomEvent('dekki-theme', { detail: resolved }));
  return resolved;
}

/** While the setting is System, follow macOS when it flips between light and dark. Returns an unsubscribe. */
export function watchSystemTheme() {
  let mq;
  try { mq = window.matchMedia('(prefers-color-scheme: light)'); } catch { return () => {}; }
  const on = () => { if (readTheme() === 'system') applyTheme('system', { save: false }); };
  mq.addEventListener?.('change', on);
  return () => mq.removeEventListener?.('change', on);
}
