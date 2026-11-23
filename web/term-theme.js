// xterm theme and font, matched to the design tokens in styles/base.css (xterm takes plain colour strings,
// so the values are repeated here: keep them in step with --b1, --f1, --ac and the status colours).
export const TERM_FONT = "'JetBrains Mono', ui-monospace, Menlo, monospace";
export const TERM_FONT_SIZE = 13;

export const TERM_THEME = {
  background: '#13141a', // --b1
  foreground: '#e8e9ee', // --f1
  cursor: '#8c99ff', // --ac
  cursorAccent: '#13141a',
  selectionBackground: 'rgba(140, 153, 255, 0.30)',
  // 16-colour ANSI palette: the status colours (red, green, yellow, blue = accent) plus matching magenta and cyan.
  black: '#242632', // --b3
  red: '#ff7676', // --rd
  green: '#5fd3a0', // --gr
  yellow: '#f2b45c', // --am
  blue: '#8c99ff', // --ac
  magenta: '#d291f2', // --acct-4
  cyan: '#63d0e0',
  white: '#c3c6d3',
  brightBlack: '#7d8296', // between --f3 and --f2, so dim text stays readable
  brightRed: '#ff9c9c',
  brightGreen: '#8ae6bb',
  brightYellow: '#f8cd8c',
  brightBlue: '#b0baff',
  brightMagenta: '#e3b5f7',
  brightCyan: '#92e2ee',
  brightWhite: '#e8e9ee', // --f1
};

// Light variant: the --b1 / --f1 / --ac / status values of :root[data-theme="light"]; ANSI colours darkened for white-ish paper.
export const TERM_THEME_LIGHT = {
  background: '#fbfbfd', // --b1 (light)
  foreground: '#1a1b22', // --f1
  cursor: '#4f5de0', // --ac
  cursorAccent: '#fbfbfd',
  selectionBackground: 'rgba(79, 93, 224, 0.25)',
  black: '#2c2f3d',
  red: '#cc3a3a',
  green: '#17895c',
  yellow: '#a86400',
  blue: '#4f5de0',
  magenta: '#9a4cc4',
  cyan: '#0e7c8c',
  white: '#8a8fa2',
  brightBlack: '#6b7083',
  brightRed: '#e05555',
  brightGreen: '#1fa370',
  brightYellow: '#c27c0a',
  brightBlue: '#6b78ee',
  brightMagenta: '#b268dc',
  brightCyan: '#1596a8',
  brightWhite: '#1a1b22',
};
export const termThemeFor = (resolved) => (resolved === 'light' ? TERM_THEME_LIGHT : TERM_THEME);

/** xterm measures its cell size when it opens. If the web font is not loaded yet it measures the fallback, so after
 *  the font arrives re-apply the font (a different value first: xterm ignores a set to the same value) and refit. */
export function remeasureWhenFontLoads(term, fit, isLive) {
  if (!document.fonts?.load) return;
  document.fonts.load(`${TERM_FONT_SIZE}px 'JetBrains Mono'`).then(() => {
    if (!isLive()) return;
    term.options.fontFamily = 'monospace';
    term.options.fontFamily = TERM_FONT;
    try { fit.fit(); } catch {}
  }).catch(() => {});
}
