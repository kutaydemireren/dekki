import React, { useEffect, useState } from 'react';
import { THEME_LABEL, applyTheme, nextTheme, readTheme, watchSystemTheme } from './theme.js';

const P = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false' };
const Sun = () => (<svg {...P}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>);
const Moon = () => (<svg {...P}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>);
const Auto = () => (<svg {...P}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>);
const ICON = { system: Auto, dark: Moon, light: Sun };

// Sidebar footer control: cycles System -> Dark -> Light. The tooltip names the current setting.
export default function ThemeButton() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => { applyTheme(theme, { save: false }); return watchSystemTheme(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const Ico = ICON[theme];
  const cycle = () => { const n = nextTheme(theme); setTheme(n); applyTheme(n); };
  const tip = `Theme: ${THEME_LABEL[theme]}. Click for ${THEME_LABEL[nextTheme(theme)]}`;
  return <button className="icon-btn ghost" title={tip} aria-label={`Theme: ${THEME_LABEL[theme]}`} onClick={cycle}><Ico /></button>;
}
