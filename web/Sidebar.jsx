import React, { useEffect, useState } from 'react';
import ThemeButton from './ThemeButton.jsx';
import { FolderTreeIcon, SkillsIcon, PromptsIcon, BellIcon, PlusIcon } from './icons.jsx';

const CollapseIcon = ({ collapsed }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 3v18" />
    {collapsed ? <path d="m14 9 3 3-3 3" /> : <path d="m17 9-3 3 3 3" />}
  </svg>
);

const Mark = () => (
  <span className="brand-mark" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="var(--on-ac)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h10M4 12h16M4 17h7" /></svg>
  </span>
);

// The sidebar shell: head (brand, account menu, collapse), the agent list (children), quiet footer for the utility icons.
// Collapsed = a narrow rail; the list stays mounted (hidden) so its N shortcut and counts keep working.
export default function Sidebar({ multi, accounts, activeAccount, accountColor, onSwitchAccount, onBrand, onNew, error, tools, children }) {
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('dekki.sidebarCollapsed') === '1'; } catch { return false; } });
  const setC = (v) => { setCollapsed(v); try { localStorage.setItem('dekki.sidebarCollapsed', v ? '1' : '0'); } catch { /* ignore */ } };
  useEffect(() => { // the palette action "Toggle sidebar"
    const f = () => setCollapsed((v) => { try { localStorage.setItem('dekki.sidebarCollapsed', v ? '0' : '1'); } catch { /* ignore */ } return !v; });
    window.addEventListener('dekki:toggle-sidebar', f);
    return () => window.removeEventListener('dekki:toggle-sidebar', f);
  }, []);
  const { showTree, showSkills, showPrompts, notify, onTree, onSkills, onPrompts, onNotify } = tools;
  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`} data-account={multi ? activeAccount : undefined} style={multi ? { '--account': accountColor } : undefined}>
      <header className="sb-head">
        <button className="brand" title="Dekki: clear the selection" onClick={onBrand}><Mark /><span className="brand-name">Dekki</span></button>
        {multi && !collapsed && (
          <label className="acct-menu" title="Active Claude account: the list shows only this account's agents">
            <span className="account-dot" />
            <select aria-label="Claude account" value={activeAccount} onChange={(e) => onSwitchAccount(e.target.value)}>
              {accounts.map((a) => <option key={a.id} value={a.id} disabled={a.missing}>{a.label}{a.missing ? ' (config dir missing)' : ''}</option>)}
            </select>
          </label>
        )}
        <button className="icon-btn ghost sb-collapse" title={collapsed ? 'Show the sidebar' : 'Hide the sidebar'} aria-label={collapsed ? 'Show the sidebar' : 'Hide the sidebar'} aria-pressed={collapsed} onClick={() => setC(!collapsed)}><CollapseIcon collapsed={collapsed} /></button>
      </header>
      {collapsed && <button className="rail-new" title="New agent (C)" aria-label="New agent" onClick={onNew}><PlusIcon size={16} /></button>}
      {error && !collapsed && <div className="error">{error}</div>}
      <div className="sb-body" hidden={collapsed}>{children}</div>
      <footer className="sb-foot" hidden={collapsed}>
        <button className={`icon-btn ghost${showTree ? ' on' : ''}`} title="Folder tree" aria-label="Folder tree" aria-pressed={showTree} onClick={onTree}><FolderTreeIcon /></button>
        <button className={`icon-btn ghost${showSkills ? ' on' : ''}`} title="Skill usage over all sessions" aria-label="Skill usage over all sessions" aria-pressed={showSkills} onClick={onSkills}><SkillsIcon /></button>
        <button className={`icon-btn ghost${showPrompts ? ' on' : ''}`} title="Saved prompts" aria-label="Saved prompts" aria-pressed={showPrompts} onClick={onPrompts}><PromptsIcon /></button>
        <span className="spacer" />
        <ThemeButton />
        <button className="icon-btn ghost" title={notify ? 'macOS notifications on (needs input, finished). Click to turn off' : 'macOS notifications off. Click to turn on'} aria-label="macOS notifications" aria-pressed={notify} onClick={onNotify}><BellIcon off={!notify} /></button>
      </footer>
    </aside>
  );
}
