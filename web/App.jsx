import React, { useEffect, useRef, useState } from 'react';
import { useViewing } from './useViewing.js';
import Sidebar from './Sidebar.jsx';
import AgentList from './AgentList.jsx';
import SessionTab from './SessionTab.jsx';
import HistoryTab from './HistoryTab.jsx';
import MainHeader from './MainHeader.jsx';
import Home from './Home.jsx';
import SkillsTab, { shouldPoll } from './SkillsTab.jsx';
import ChangesTab from './ChangesTab.jsx';
import ManagerChanges from './ManagerChanges.jsx';
import { hasChangesTab } from './changes-logic.js';
import { useChangeTotals } from './useChangeTotals.js';
import SkillsPanel from './SkillsPanel.jsx';
import NewAgentDialog from './NewAgentDialog.jsx';
import ContextMenu from './ContextMenu.jsx';
import DeleteDialog from './DeleteDialog.jsx';
import RenameDialog from './RenameDialog.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import PromptsPanel from './PromptsPanel.jsx';
import FolderTree from './FolderTree.jsx';
import useUnread from './useUnread.js';
import { nest } from './groups.js';
import { useViewFade } from './motion.jsx';
import { parseHash, buildHash } from './hash.js';
import Palette from './Palette.jsx';
import ShortcutSheet from './ShortcutSheet.jsx';
import ToastHost from './Toast.jsx';
import useToast from './useToast.js';
import useShortcuts from './useShortcuts.js';
import { nextNeedingId, pinnedOrder } from './shortcuts.js';
import { overlayCount } from './overlay-stack.js';
import SetupWizard from './SetupWizard.jsx';

const POLL_MS = 3000;
const ACCOUNT_COLORS = ['var(--acct-1)', 'var(--acct-2)', 'var(--acct-3)', 'var(--acct-4)']; // per account position, so accounts are never confused

export default function App() {
  const [agents, setAgents] = useState([]);
  const [error, setError] = useState(null); // the list poll failed (persistent banner)
  const { toast } = useToast(); // a button action failed (transient)
  const [notify, setNotify] = useState(true); // server-side macOS notifications (pref in state.json)
  useEffect(() => { fetch('/api/config').then((r) => r.json()).then((b) => setNotify(b.notify !== false)).catch(() => {}); }, []);
  const toggleNotify = () => fetch('/api/prefs/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !notify }) }).then((r) => r.json()).then((b) => b.ok && setNotify(b.notify)).catch(() => {});
  // Accounts (server/accounts.js). The switcher shows only with 2+ accounts. A switch reloads the page: every list, history,
  // selection and terminal then starts clean for the new account (the server already closed the old Session terminals).
  const [acct, setAcct] = useState({ active: 'default', accounts: [] });
  useEffect(() => { fetch('/api/accounts').then((r) => r.json()).then((b) => Array.isArray(b.accounts) && setAcct(b)).catch(() => {}); }, []);
  const switchAccount = async (id) => {
    try {
      const res = await fetch('/api/accounts/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      const b = await res.json();
      if (!res.ok) throw new Error(b.error || `HTTP ${res.status}`);
      location.hash = '';
      location.reload();
    } catch (e) {
      toast(`Could not switch account: ${e.message}`, 'error');
    }
  };
  const acctRef = useRef(null); // the account this page loaded with (from the first /api/agents reply)
  const linkSwitching = useRef(false); // a notification link is switching the account: the poll below must not reset the hash
  const [listAccount, setListAccount] = useState(null); // the account the shown agent list belongs to (for the viewing report)
  const acctIndex = Math.max(0, acct.accounts.findIndex((a) => a.id === acct.active));
  const multi = acct.accounts.length > 1;
  const [accountsReq, setAccountsReq] = useState(false); // palette "Accounts": mission control opens its Accounts popover
  const [prefs, setPrefs] = useState({ pinned: [], archived: [] });
  // location hash: "#<agentId>" or "#<agentId>/history"
  // A link that names an account ("#<account>:<id>") is NOT selected at once: applyHash checks it against the deck's
  // active account first (switching the account if needed), so the selection never lands on the wrong account.
  const [selectedId, setSelectedIdRaw] = useState(() => { const h = parseHash(location.hash); return h.account ? null : h.id; });
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const setSelectedId = (id) => { history.replaceState(null, '', `#${id}`); setSelectedIdRaw(id); };
  const clearSelection = () => { history.replaceState(null, '', '#'); setSelectedIdRaw(null); };
  const [tab, setTab] = useState(() => parseHash(location.hash).tab);
  useViewFade(`${selectedId}|${tab}`);
  // A notification click rewrites the hash of this open tab (history.replaceState above does not fire hashchange).
  // Links: "#<id>[/history]" = this account; "#<account>:<id>[/history]" = that account: same account -> select (no
  // reload); another known account -> switch (reload) and the link is applied again after it; unknown account -> ignored.
  useEffect(() => {
    let alive = true;
    const applyHash = async () => {
      const { account, id, tab: t } = parseHash(location.hash);
      const stayPut = () => history.replaceState(null, '', selectedRef.current ? `#${selectedRef.current}` : '#'); // hash back to what is selected
      if (!account && !id && location.hash.replace('#', '')) { stayPut(); return; } // a link that does not validate: ignore it
      if (!account) { setSelectedIdRaw(id); setTab(t); return; }
      let b;
      try { b = await (await fetch('/api/accounts')).json(); } catch { return; }
      if (!alive) return;
      const target = Array.isArray(b?.accounts) && b.accounts.find((a) => a.id === account);
      if (!target || target.missing) { stayPut(); return; } // unknown/removed account: stay put
      if (b.active === account) { history.replaceState(null, '', buildHash(id, null, t)); setSelectedIdRaw(id); setTab(t); return; }
      try {
        linkSwitching.current = true; // the list poll must not see the new account first and wipe the link
        const res = await fetch('/api/accounts/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: account }) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        location.reload(); // the hash stays; the reload comes back on `account` and selects the agent
      } catch (e) {
        linkSwitching.current = false;
        stayPut();
        toast(`Could not switch account: ${e.message}`, 'error');
      }
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => { alive = false; window.removeEventListener('hashchange', applyHash); };
  }, []);
  const [reload, setReload] = useState(0);
  const [changesSeen, setChangesSeen] = useState(null); // same for the Changes tab
  const [historySeen, setHistorySeen] = useState(null); // the chat whose History tab was opened (kept mounted)
  const [creating, setCreating] = useState(false);
  const [rootKey, setRootKey] = useState(0); // bumped when the working folder changes: the tree and the Manager-sessions label refetch
  const [wizard, setWizard] = useState(null); // setup wizard: null | 'setup' | 'check'
  const [setupCfg, setSetupCfg] = useState(null); // {root, rootReady, demo} of the active account, for the Home hint
  useEffect(() => { fetch('/api/config').then((r) => r.json()).then((b) => setSetupCfg({ root: b.root, rootReady: b.rootReady, demo: b.demo === true })).catch(() => {}); }, [rootKey]);
  const [menu, setMenu] = useState(null); // right-click menu {x, y, agent}
  const [deleting, setDeleting] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [stopAsk, setStopAsk] = useState(null); // a busy agent waiting for "stop anyway?"
  const [showTree, setShowTree] = useState(false);
  const [showPrompts, setShowPrompts] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [treeMenu, setTreeMenu] = useState(null);
  const unread = useUnread(agents, selectedId);

  // Drafts: chats created here that nobody has sent a prompt to yet. Leaving one discards it (the server
  // re-checks that it is really empty before `claude rm`), so empty sessions never pile up in claude agents.
  const [drafts, setDrafts] = useState(() => { try { return new Set(JSON.parse(localStorage.getItem('dekki.drafts')) || []); } catch { return new Set(); } });
  const updateDrafts = (fn) => setDrafts((prev) => {
    const next = new Set(prev);
    fn(next);
    try { localStorage.setItem('dekki.drafts', JSON.stringify([...next])); } catch { /* ignore */ }
    return next;
  });
  const discardDraft = (id) => {
    updateDrafts((s) => s.delete(id));
    fetch(`/api/agents/${id}?draft=1`, { method: 'DELETE', keepalive: true }).finally(() => setReload((n) => n + 1));
  };
  const prevSelected = useRef(selectedId);
  useEffect(() => {
    const prev = prevSelected.current;
    prevSelected.current = selectedId;
    if (prev && prev !== selectedId && drafts.has(prev)) discardDraft(prev);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onHide = () => { if (selectedId && drafts.has(selectedId)) fetch(`/api/agents/${selectedId}?draft=1`, { method: 'DELETE', keepalive: true }); };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [selectedId, drafts]);

  const alive = (a) => a.status != null || a.state === 'working'; // has a live process
  async function stopAgent(a, confirmed = false) {
    if (a.status === 'busy' && !confirmed) { setStopAsk(a); return; }
    try {
      const res = await fetch(`/api/agents/${a.id}/stop`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setReload((n) => n + 1);
    } catch (e) {
      toast(`Could not stop ${a.name}: ${e.message}`, 'error');
    }
  }

  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const res = await fetch('/api/agents');
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        // Another tab switched the account: this page's list is now for a different account, so start clean.
        if (body.account && acctRef.current == null) acctRef.current = body.account;
        if (!stop && body.account && body.account !== acctRef.current) { if (!linkSwitching.current) { location.hash = ''; location.reload(); } return; }
        if (!stop) { setListAccount(body.account ?? null); setAgents(body.agents); setPrefs({ pinned: body.pinned || [], archived: body.archived || [] }); setError(null); }
      } catch (e) {
        if (!stop) setError(e.message);
      }
    }
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => { stop = true; clearInterval(t); };
  }, [reload]);

  async function toggle(kind, id, on) {
    try {
      const res = await fetch(`/api/agents/${id}/${kind}`, { method: on ? 'POST' : 'DELETE' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setPrefs({ pinned: body.pinned, archived: body.archived });
      if (kind === 'mine') setReload((n) => n + 1); // `mine` is computed server-side: refetch so the row moves now
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function openPath(rel) {
    try {
      const res = await fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: rel }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    } catch (e) {
      toast(`Could not open ${rel}: ${e.message}`, 'error');
    }
  }

  // Palette, shortcuts (web/useShortcuts.js is the one keyboard layer), shortcut sheet.
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const selected = agents.find((a) => a.id === selectedId) || null;
  const goTo = (id) => { if (id && id !== selectedRef.current) setSelectedId(id); };
  const goNext = () => goTo(nextNeedingId(agents, prefs, selectedId));
  const togglePalette = (toggle) => setPalette((open) => (open ? !toggle : overlayCount() === 0));
  const toggleTree = () => setShowTree((v) => !v);
  const toggleSkills = () => { setShowSkills((v) => !v); setShowPrompts(false); };
  const togglePrompts = () => { setShowPrompts((v) => !v); setShowSkills(false); };
  useShortcuts({
    selectedId,
    // An open skills or prompts panel is one overlay itself; any other overlay (dialog, palette, menu) blocks the toggle.
    onPanel: (p) => { if (overlayCount() <= (showSkills || showPrompts ? 1 : 0)) ({ tree: toggleTree, skills: toggleSkills, prompts: togglePrompts })[p](); },
    onSelect: goTo,
    onPalette: togglePalette,
    onNext: goNext,
    onNew: () => setCreating(true),
    onHelp: () => setHelp(true),
    onPinned: (n) => goTo(pinnedOrder(agents, prefs)[n - 1]),
  });
  const paletteActions = [
    { id: 'new', label: 'New agent', keys: 'C', run: () => setCreating(true) },
    { id: 'setup', label: 'Set up', keywords: 'wizard manager folder docs preferences first time', run: () => setWizard('setup') },
    { id: 'check-setup', label: 'Check setup', keywords: 'health check wizard manager folder', run: () => setWizard('check') },
    { id: 'next', label: 'Next agent that needs you', keys: 'N', disabled: !nextNeedingId(agents, prefs, selectedId), run: goNext },
    { id: 'prompts', label: 'Saved prompts', run: () => { setShowPrompts(true); setShowSkills(false); } },
    { id: 'skills', label: 'Skill usage', run: () => { setShowSkills(true); setShowPrompts(false); } },
    { id: 'notify', label: `Notifications: turn ${notify ? 'off' : 'on'}`, keywords: 'toggle notifications bell', run: toggleNotify },
    { id: 'sidebar', label: 'Toggle sidebar', run: () => window.dispatchEvent(new Event('dekki:toggle-sidebar')) },
    { id: 'filter', label: 'Filter the agent list', keywords: 'search', run: () => setTimeout(() => window.dispatchEvent(new Event('dekki:focus-search')), 0) },
    { id: 'help', label: 'Show shortcuts', keys: '?', run: () => setHelp(true) },
    { id: 'accounts', label: 'Accounts', keywords: 'account switch add claude login', run: () => { clearSelection(); setAccountsReq(true); } },
    ...(multi ? acct.accounts.filter((a) => a.id !== acct.active && !a.missing).map((a) => ({ id: `acct:${a.id}`, label: `Switch account: ${a.label}`, keywords: 'account', run: () => switchAccount(a.id) })) : []),
  ];
  // Changes tab: shown for a session with a git worktree or a manager with workers (never depends on current changes).
  // A manager's tab lists its workers' changes (ManagerChanges). A hash/notification asking for a hidden tab shows Session.
  const mgrWorkers = selected ? nest(agents, prefs.archived).children.get(selected.id) || [] : [];
  const showChanges = hasChangesTab(selected, mgrWorkers.length);
  const shownTab = tab === 'changes' && !showChanges ? 'session' : tab;
  const openWorkerChanges = (id) => { setSelectedId(id); setTab('changes'); };
  useViewing(selected?.id ?? null, shownTab, listAccount);
  useEffect(() => { if (tab === 'history' && selected) setHistorySeen(selected.id); }, [tab, selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (shownTab === 'changes' && selected) setChangesSeen(selected.id); }, [shownTab, selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const changeTotals = useChangeTotals(selected?.id ?? null, selected ? shouldPoll(selected) : false, selected?.lastActivityAt ?? null);

  // Saved prompts: close the panel, show the Session tab and let that terminal paste the text (never sends it).
  function insertPrompt(text) {
    if (!selected) return;
    setShowPrompts(false);
    setTab('session');
    window.dispatchEvent(new CustomEvent('dekki:insert', { detail: { agentId: selected.id, text } }));
  }

  // The Prompts panel started an agent ("Improve with Claude", "Start new agent with this"): close the panel and chat with it
  // in the Session tab (not a draft: it already has its first message).
  function agentStarted(id) {
    setShowPrompts(false);
    if (id) { setSelectedId(id); setTab('session'); }
    setReload((n) => n + 1);
  }

  return (
    <div className="app">
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: prefs.pinned.includes(menu.agent.id) ? 'Unpin' : 'Pin', onClick: () => toggle('pin', menu.agent.id, !prefs.pinned.includes(menu.agent.id)) },
            { label: prefs.archived.includes(menu.agent.id) ? 'Unarchive' : 'Archive (hide in the deck)', onClick: () => toggle('archive', menu.agent.id, !prefs.archived.includes(menu.agent.id)) },
            { label: menu.agent.mine === false ? 'Show in my list' : 'Move to Other agents', onClick: () => toggle('mine', menu.agent.id, menu.agent.mine === false) },
            { label: 'Rename', onClick: () => setRenaming(menu.agent) },
            { label: 'Stop', disabled: !alive(menu.agent), onClick: () => stopAgent(menu.agent) },
            { label: 'Delete', danger: true, onClick: () => setDeleting(menu.agent) },
          ]}
        />
      )}
      {deleting && (
        <DeleteDialog
          agent={deleting}
          workers={nest(agents).children.get(deleting.id) || []}
          onClose={() => { setDeleting(null); setReload((n) => n + 1); }}
          onDeleted={(id) => { if (id === selectedId) clearSelection(); }}
        />
      )}
      {stopAsk && (
        <ConfirmDialog
          title={`Stop “${stopAsk.name}”?`}
          text="It looks busy right now. Stopping ends its current work; the conversation is kept."
          confirmLabel="Stop anyway"
          onClose={() => setStopAsk(null)}
          onConfirm={async () => { const a = stopAsk; setStopAsk(null); await stopAgent(a, true); }}
        />
      )}
      {renaming && <RenameDialog agent={renaming} onClose={() => setRenaming(null)} onSaved={() => { setRenaming(null); setReload((n) => n + 1); }} />}
      {creating && (
        <NewAgentDialog
          onClose={() => setCreating(false)}
          onRootChanged={() => setRootKey((n) => n + 1)}
          onCreated={(id, hasPrompt) => { setCreating(false); if (id) { setShowSkills(false); setShowPrompts(false); if (!hasPrompt) updateDrafts((s) => s.add(id)); setSelectedId(id); setTab('session'); } setReload((n) => n + 1); }}
        />
      )}
      {treeMenu && (
        <ContextMenu
          x={treeMenu.x}
          y={treeMenu.y}
          onClose={() => setTreeMenu(null)}
          items={[{ label: treeMenu.node.kind === 'dir' ? 'Open in Finder' : 'Open', onClick: () => openPath(treeMenu.node.rel) }]}
        />
      )}
      {wizard && <SetupWizard mode={wizard} onClose={() => setWizard(null)} onChanged={() => setRootKey((n) => n + 1)} onSetup={() => setWizard('setup')} />}
      {palette && <Palette agents={agents} actions={paletteActions} onSelectAgent={goTo} onClose={() => setPalette(false)} />}
      {help && <ShortcutSheet onClose={() => setHelp(false)} />}
      <ToastHost />
      {showTree && <FolderTree rootKey={rootKey} onOpen={openPath} onMenu={(e, node) => setTreeMenu({ x: e.clientX, y: e.clientY, node })} />}
      <Sidebar
        multi={multi}
        accounts={acct.accounts}
        activeAccount={acct.active}
        accountColor={ACCOUNT_COLORS[acctIndex % ACCOUNT_COLORS.length]}
        onSwitchAccount={switchAccount}
        onBrand={clearSelection}
        onNew={() => setCreating(true)}
        error={error}
        tools={{ showTree, showSkills, showPrompts, notify, onTree: toggleTree, onSkills: toggleSkills, onPrompts: togglePrompts, onNotify: toggleNotify }}
      >
        <AgentList
          rootKey={rootKey}
          agents={agents}
          selectedId={selectedId}
          onSelect={(id) => (id === selectedId ? clearSelection() : setSelectedId(id))}
          onNew={() => setCreating(true)}
          onNext={goNext}
          onPalette={togglePalette}
          prefs={prefs}
          unread={unread}
          drafts={drafts}
          onContext={(e, agent) => setMenu({ x: e.clientX, y: e.clientY, agent })}
        />
      </Sidebar>
      <main className="main">
        {showSkills && <SkillsPanel onClose={() => setShowSkills(false)} />}
        {showPrompts && <PromptsPanel target={selected} onInsert={insertPrompt} onAgent={agentStarted} onClose={() => setShowPrompts(false)} />}
        {selected ? (
          <>
            <MainHeader agent={selected} tab={shownTab} onTab={setTab} changes={changeTotals} showChanges={showChanges} canStop={alive(selected)} onStop={() => stopAgent(selected)} onRename={setRenaming} />
            <div className="tab-body">
              <div style={{ display: shownTab === 'session' ? 'block' : 'none', position: 'absolute', inset: 0 }}>
                <SessionTab key={selected.id} agentId={selected.id} active={shownTab === 'session'} />
              </div>
              {tab === 'skills' && (
                <div style={{ position: 'absolute', inset: 0, overflow: 'auto' }}>
                  <SkillsTab agentId={selected.id} active running={shouldPoll(selected)} lastActivityAt={selected.lastActivityAt} />
                </div>
              )}
              {/* Changes stays mounted once opened for this chat (hidden, not unmounted): scroll position and collapsed cards survive. */}
              {showChanges && (shownTab === 'changes' || changesSeen === selected.id) && (
                <div style={{ position: 'absolute', inset: 0, visibility: shownTab === 'changes' ? 'visible' : 'hidden' }}>
                  {mgrWorkers.length > 0 ? (
                    <ManagerChanges
                      key={selected.id} agentId={selected.id} workers={mgrWorkers} active={shownTab === 'changes'} onOpen={openWorkerChanges}
                      running={shouldPoll(selected) || mgrWorkers.some(shouldPoll)}
                      lastActivityAt={Math.max(selected.lastActivityAt ?? 0, ...mgrWorkers.map((w) => w.lastActivityAt ?? 0)) || null}
                    />
                  ) : (
                    <ChangesTab key={selected.id} agentId={selected.id} active={shownTab === 'changes'} running={shouldPoll(selected)} lastActivityAt={selected.lastActivityAt} />
                  )}
                </div>
              )}
              {/* Once opened for this chat, History stays mounted (hidden, not unmounted) so its scroll position and
                  live updates survive switching to Session and back. visibility keeps the layout, so scrollTop is kept. */}
              {(tab === 'history' || historySeen === selected.id) && (
                <div style={{ position: 'absolute', inset: 0, visibility: tab === 'history' ? 'visible' : 'hidden' }}>
                  <HistoryTab key={selected.id} agentId={selected.id} />
                </div>
              )}
            </div>
          </>
        ) : (
          <Home setup={setupCfg} onSetup={() => setWizard('setup')} agents={agents} prefs={prefs} onSelect={setSelectedId} accounts={acct.accounts} activeAccount={acct.active} accountColors={ACCOUNT_COLORS} onSwitchAccount={switchAccount} autoOpenAccounts={accountsReq} onAccountsOpened={() => setAccountsReq(false)} />
        )}
      </main>
    </div>
  );
}
