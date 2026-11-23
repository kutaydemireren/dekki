import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ContextMenu from './ContextMenu.jsx';
import useEscape from './useEscape.js';
import Dialog from './Dialog.jsx';
import useToast from './useToast.js';
import PlaceholderDialog from './PlaceholderDialog.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import ImproveDialog from './ImproveDialog.jsx';
import { stripFrontmatter, fieldsOf, render } from './prompt-text.js';

const COLLAPSED_KEY = 'dekki.promptFolders'; // folders the user collapsed; per-browser convenience only

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return data;
}

const toFilePath = (v) => { const p = v.replace(/^\/+|\/+$/g, ''); return p.endsWith('.md') ? p : `${p}.md`; };
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

function buildTree(folders, items) {
  const root = { dirs: new Map(), files: [] };
  const dirAt = (p) => p.split('/').reduce((n, seg) => { if (!n.dirs.has(seg)) n.dirs.set(seg, { dirs: new Map(), files: [] }); return n.dirs.get(seg); }, root);
  folders.forEach(dirAt);
  items.forEach((it) => (dirOf(it.path) ? dirAt(dirOf(it.path)) : root).files.push(it));
  return root;
}

function NameDialog({ title, hint, initial, confirmLabel, onSubmit, onClose }) {
  const [v, setV] = useState(initial);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try { await onSubmit(v.trim()); } catch (x) { setErr(x.message); setBusy(false); }
  }
  return (
    <Dialog title={title} onClose={onClose} onSubmit={submit} actions={(
      <>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || !v.trim()}>{confirmLabel}</button>
      </>
    )}>
      {hint && <div className="hint">{hint}</div>}
      <input type="text" autoFocus maxLength={200} value={v} onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)} onChange={(e) => setV(e.target.value)} />
      {err && <div className="err">{err}</div>}
    </Dialog>
  );
}

// Saved prompts: tree + search on the left, plain-text editor on the right. All data lives in the prompts
// folder (server/prompts.js); the panel only calls the API. `target` is the open agent (or null): Insert types
// the prompt into its terminal without sending it.
export default function PromptsPanel({ target, onInsert, onAgent, onClose }) {
  const [data, setData] = useState(null); // {root, exists, folders, items}
  const [err, setErr] = useState(null);
  const [query, setQuery] = useState('');
  const [base, setBase] = useState(null); // the selected prompt as loaded: {path, body, mtime}
  const [draft, setDraft] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [menu, setMenu] = useState(null);
  const [dialog, setDialog] = useState(null); // {type: 'new'|'folder'|'rename'|'delete'|'fill', ...}
  const { toast } = useToast();
  const [hints, setHints] = useState(false);
  const drag = useRef(null); // {path, folder} while a drag is in progress
  const [dropAt, setDropAt] = useState(null); // folder path ('' = top level) under the drag
  const [collapsed, setCollapsed] = useState(() => { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || []); } catch { return new Set(); } });
  const editor = useRef(null);

  const dirty = !!base && draft !== base.body;
  const say = (t) => toast(t, /fail|could not|too long|not trusted/i.test(t) ? 'error' : 'info');

  const load = useCallback(async () => {
    try { const d = await api('GET', '/api/prompts'); setData(d); setErr(null); return d; } catch (e) { setErr(e.message); return null; }
  }, []);
  useEffect(() => {
    load();
    window.addEventListener('focus', load); // pick up edits made in Obsidian
    return () => window.removeEventListener('focus', load);
  }, [load]);

  // Keep the open prompt in step with the disk: an untouched one follows external edits, a dirty one raises the conflict banner.
  useEffect(() => {
    if (!data || !base) return;
    const it = data.items.find((i) => i.path === base.path);
    if (!it) { if (!dirty) { setBase(null); setDraft(''); } return; }
    if (it.mtime === base.mtime) return;
    if (dirty) setConflict(true);
    else { setBase({ path: it.path, body: it.body, mtime: it.mtime }); setDraft(it.body); }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc: its own menu and dialogs sit above it on the overlay stack and close first; then the hints, then the panel.
  useEscape(() => { if (hints) setHints(false); else onClose(); });

  // Run `run` now, or after the user agrees to discard unsaved edits of the open prompt (in-app popup, not the native confirm).
  const guard = (run) => { if (!dirty) return run(); setDialog({ type: 'discard', run }); };
  const openItem = (it) => { setBase({ path: it.path, body: it.body, mtime: it.mtime }); setDraft(it.body); setConflict(false); };
  const select = (it) => { if (it.path !== base?.path) guard(() => openItem(it)); };
  const reveal = (path) => setCollapsed((s) => { const n = new Set(s); for (let d = dirOf(path); d; d = dirOf(d)) n.delete(d); return n; });
  const toggleFolder = (p) => setCollapsed((s) => {
    const n = new Set(s);
    if (n.has(p)) n.delete(p); else n.add(p);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...n])); } catch { /* ignore */ }
    return n;
  });

  const textFor = (it) => (it.path === base?.path ? draft : it.body);

  async function save(overwrite = false) {
    setSaving(true);
    try {
      const r = await api('POST', '/api/prompts', { path: base.path, body: draft, baseMtime: overwrite ? undefined : base.mtime });
      setBase({ path: base.path, body: draft, mtime: r.mtime });
      setConflict(false);
      await load();
      return true;
    } catch (e) {
      if (e.status === 409) setConflict(true); else say(`Save failed: ${e.message}`);
      return false;
    } finally { setSaving(false); }
  }

  async function createFile(path, body) {
    await api('POST', '/api/prompts', { path, body, create: true });
    const d = await load();
    reveal(path);
    const it = d?.items.find((i) => i.path === path);
    if (it) openItem(it);
  }

  const duplicate = (it) => guard(() => duplicateNow(it));
  async function duplicateNow(it) {
    const dir = dirOf(it.path) ? `${dirOf(it.path)}/` : '';
    let path;
    for (let i = 1; ; i++) { path = `${dir}${it.name} copy${i > 1 ? ` ${i}` : ''}.md`; if (!data.items.some((x) => x.path === path)) break; }
    try { await createFile(path, textFor(it)); } catch (e) { say(e.message); }
  }

  async function move(from, toRaw, isFolder, discarded = false) {
    const to = isFolder ? toRaw.replace(/^\/+|\/+$/g, '') : toFilePath(toRaw);
    const affected = base && (base.path === from || base.path.startsWith(`${from}/`));
    if (affected && dirty && !discarded) { setDialog({ type: 'discard', run: () => move(from, toRaw, isFolder, true) }); return; }
    await api('POST', '/api/prompts/move', { from, to });
    const d = await load();
    setDialog(null);
    if (affected) {
      const np = base.path === from ? to : to + base.path.slice(from.length);
      const it = d?.items.find((i) => i.path === np);
      if (it) openItem(it); else { setBase(null); setDraft(''); }
      reveal(np);
    }
  }

  async function trash(path) {
    await api('DELETE', `/api/prompts?path=${encodeURIComponent(path)}`);
    if (base && (base.path === path || base.path.startsWith(`${path}/`))) { setBase(null); setDraft(''); setConflict(false); }
    await load();
    setDialog(null);
    say('Moved to .trash');
  }

  // Insert / Copy: ask for placeholders first when there are any.
  function act(kind, it) {
    if (kind === 'insert' && !target) { say('Open an agent first'); return; }
    const text = textFor(it);
    if (fieldsOf(stripFrontmatter(text)).length) setDialog({ type: 'fill', kind, text, name: it.name });
    else perform(kind, render(text, {}));
  }
  async function startAgent(text) {
    if (text.length > 20000) { say('Too long to start an agent with (20,000 characters max)'); return; }
    try {
      const res = await fetch('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: text }) });
      const body = await res.json();
      if (!res.ok || !body.ok) say(body.trust ? `Workspace not trusted. Run claude once in ${body.dir}` : body.error || 'Could not start the agent');
      else onAgent(body.id);
    } catch (e) { say(e.message); }
  }
  function perform(kind, text) {
    setDialog(null);
    if (kind === 'insert') { onInsert(text); return; }
    if (kind === 'start') { startAgent(text); return; }
    navigator.clipboard.writeText(text).then(() => say('Copied'), () => say('Copy failed'));
  }

  const q = query.trim().toLowerCase();
  const results = useMemo(() => (q && data ? data.items.filter((i) => i.path.toLowerCase().includes(q) || i.body.toLowerCase().includes(q)) : null), [q, data]);
  const tree = useMemo(() => (data ? buildTree(data.folders, data.items) : null), [data]);

  // Drag and drop: a prompt or folder dropped on a folder moves into it; on a sibling prompt = into that prompt's
  // folder; on blank space = top level. Same server move as Rename / Move (never overwrites).
  const canDrop = (d, dir) => {
    if (!d) return false;
    const to = dir ? `${dir}/${d.path.split('/').pop()}` : d.path.split('/').pop();
    return to !== d.path && !(d.folder && (dir === d.path || dir.startsWith(`${d.path}/`)));
  };
  const dropProps = (dir) => results ? {} : {
    onDragOver: (e) => { if (!canDrop(drag.current, dir)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; if (dropAt !== dir) setDropAt(dir); },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget) && dropAt === dir) setDropAt(null); },
    onDrop: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const d = drag.current;
      drag.current = null;
      setDropAt(null);
      if (!canDrop(d, dir)) return;
      const to = dir ? `${dir}/${d.path.split('/').pop()}` : d.path.split('/').pop();
      try { await move(d.path, to, d.folder); reveal(to); } catch (x) { say(x.message); }
    },
  };
  const dragProps = (path, folder) => results ? {} : {
    draggable: true,
    onDragStart: (e) => { drag.current = { path, folder }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', path); },
    onDragEnd: () => { drag.current = null; setDropAt(null); },
  };

  const fileRow = (it, depth, sub) => (
    <div
      key={it.path}
      className={`p-row${base?.path === it.path ? ' selected' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      title={it.path}
      {...dragProps(it.path, false)}
      {...dropProps(dirOf(it.path))}
      onClick={() => select(it)}
      onDoubleClick={() => act('insert', it)}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, kind: 'file', it }); }}
    >
      <span className="p-name">{it.name}</span>
      {sub && <span className="p-sub">{sub}</span>}
      {base?.path === it.path && dirty && <span className="p-dirty">●</span>}
    </div>
  );

  function renderNode(node, prefix, depth) {
    const rows = [];
    for (const [name, child] of node.dirs) {
      const p = prefix ? `${prefix}/${name}` : name;
      const open = !collapsed.has(p);
      rows.push(
        <div
          key={`d:${p}`}
          className={`p-row dir${dropAt === p ? ' drop' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          {...dragProps(p, true)}
          {...dropProps(p)}
          onClick={() => toggleFolder(p)}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, kind: 'dir', path: p }); }}
        >
          <span className="tree-caret">{open ? '▾' : '▸'}</span>
          <span className="p-name">{name}</span>
        </div>,
      );
      if (open) rows.push(...renderNode(child, p, depth + 1));
    }
    for (const it of node.files) rows.push(fileRow(it, depth, null));
    return rows;
  }

  async function showInFinder(path, trash = false) {
    try { await api('POST', '/api/prompts/reveal', trash ? { trash: true } : { path }); } catch (e) { say(e.message); }
  }

  const menuItems = !menu ? [] : menu.kind === 'blank'
    ? [
        { label: 'New prompt', onClick: () => setDialog({ type: 'new', dir: '' }) },
        { label: 'New folder', onClick: () => setDialog({ type: 'folder', dir: '' }) },
        { label: 'Show in Finder', onClick: () => showInFinder('') },
      ]
    : menu.kind === 'file'
    ? [
        { label: 'Insert', disabled: !target, onClick: () => act('insert', menu.it) },
        { label: 'Start new agent with this', onClick: () => act('start', menu.it) },
        { label: 'Copy', onClick: () => act('copy', menu.it) },
        { label: 'Improve with Claude', onClick: () => setDialog({ type: 'improve', path: menu.it.path }) },
        { label: 'Rename / Move', onClick: () => setDialog({ type: 'rename', path: menu.it.path, folder: false }) },
        { label: 'Duplicate', onClick: () => duplicate(menu.it) },
        { label: 'Show in Finder', onClick: () => showInFinder(menu.it.path) },
        { label: 'Delete', danger: true, onClick: () => setDialog({ type: 'delete', path: menu.it.path, folder: false }) },
      ]
    : [
        { label: 'New prompt here', onClick: () => setDialog({ type: 'new', dir: menu.path }) },
        { label: 'New folder here', onClick: () => setDialog({ type: 'folder', dir: menu.path }) },
        { label: 'Rename / Move', onClick: () => setDialog({ type: 'rename', path: menu.path, folder: true }) },
        { label: 'Show in Finder', onClick: () => showInFinder(menu.path) },
        { label: 'Delete', danger: true, onClick: () => setDialog({ type: 'delete', path: menu.path, folder: true }) },
      ];

  const curItem = base && data?.items.find((i) => i.path === base.path);
  const delCount = dialog?.type === 'delete' && dialog.folder ? data.items.filter((i) => i.path.startsWith(`${dialog.path}/`)).length : 0;

  return (
    <div className="prompts">
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
      {dialog?.type === 'new' && (
        <NameDialog
          title="New prompt"
          hint={<>Use <code>Folder/Name</code> to put it in a folder. A number prefix (<code>1 PRD</code>) keeps your order.</>}
          initial={dialog.dir ? `${dialog.dir}/` : ''}
          confirmLabel="Create"
          onClose={() => setDialog(null)}
          onSubmit={(v) => guard(async () => { await createFile(toFilePath(v), ''); setDialog(null); setTimeout(() => editor.current?.focus(), 50); })}
        />
      )}
      {dialog?.type === 'folder' && (
        <NameDialog
          title="New folder"
          initial={dialog.dir ? `${dialog.dir}/` : ''}
          confirmLabel="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (v) => { const p = v.replace(/^\/+|\/+$/g, ''); await api('POST', '/api/prompts/folder', { path: p }); await load(); reveal(`${p}/x`); setDialog(null); }}
        />
      )}
      {dialog?.type === 'rename' && (
        <NameDialog
          title={dialog.folder ? 'Rename / move folder' : 'Rename / move prompt'}
          hint={<>Change the name, or the folder with <code>Folder/Name</code>. Nothing is overwritten.</>}
          initial={dialog.folder ? dialog.path : dialog.path.replace(/\.md$/, '')}
          confirmLabel="Save"
          onClose={() => setDialog(null)}
          onSubmit={(v) => move(dialog.path, v, dialog.folder)}
        />
      )}
      {dialog?.type === 'discard' && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          text={<>“{base?.path}” has changes that are not saved. Continuing throws them away.</>}
          confirmLabel="Discard changes"
          onClose={() => setDialog(null)}
          onConfirm={async () => { const run = dialog.run; setDialog(null); try { await run(); } catch (e) { say(e.message); } }}
        />
      )}
      {dialog?.type === 'delete' && (
        <ConfirmDialog
          title={`Delete “${dialog.path}”?`}
          text={<>{dialog.folder ? `The folder and its ${delCount} prompt${delCount === 1 ? '' : 's'} are` : 'The prompt is'} moved to <code>Prompts/.trash</code> (hidden here, recoverable in Finder). Nothing is erased.</>}
          confirmLabel="Move to trash"
          onClose={() => setDialog(null)}
          onConfirm={() => trash(dialog.path)}
        />
      )}
      {dialog?.type === 'improve' && (
        <ImproveDialog
          path={dialog.path}
          dirty={dirty && dialog.path === base?.path}
          onSave={() => save()}
          onClose={() => setDialog(null)}
          onStarted={(id) => { setDialog(null); onAgent(id); }}
        />
      )}
      {dialog?.type === 'fill' && (
        <PlaceholderDialog
          title={`Fill in “${dialog.name}”`}
          fields={fieldsOf(stripFrontmatter(dialog.text))}
          confirmLabel={dialog.kind === 'insert' ? 'Insert' : dialog.kind === 'start' ? 'Start agent' : 'Copy'}
          onClose={() => setDialog(null)}
          onSubmit={(values) => perform(dialog.kind, render(dialog.text, values))}
        />
      )}

      <div className="prompts-side">
        <div className="prompts-tools">
          <button className="primary" onClick={() => setDialog({ type: 'new', dir: '' })}>+ Prompt</button>
          <button onClick={() => setDialog({ type: 'folder', dir: '' })}>+ Folder</button>
          <span className="spacer" />
          {data?.trash > 0 && (
            <button className="icon-btn" aria-label="Open the trash" title={`Trash: ${data.trash} deleted item${data.trash === 1 ? '' : 's'}. Opens in Finder.`} onClick={() => showInFinder('', true)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.6 9h6.8l.6-9M6.6 6.5v4.5M9.4 6.5v4.5" />
              </svg>
            </button>
          )}
          <button title="Tips" className={hints ? 'primary' : ''} onClick={() => setHints((v) => !v)}>?</button>
          <button title="Close (Esc)" onClick={onClose}>✕</button>
        </div>
        {hints && (
          <div className="prompts-hints">
            <ul>
              <li>Type <code>{'{{name}}'}</code> anywhere in a prompt: Insert and Copy ask for it first. <code>{'{{name|default}}'}</code> prefills a default.</li>
              <li>Double-click a prompt (or Insert) to type it into the open agent. It is not sent: you press Enter.</li>
              <li>Drag a prompt or folder onto a folder to move it. Right-click for rename, duplicate and delete.</li>
              <li>Numbers in names (<code>1 PRD</code>, <code>2 Design</code>) keep your order. Search looks in names and text.</li>
              <li>The prompts are plain <code>.md</code> files in the folder shown below, so any editor (Obsidian, VS Code) can edit them too. Deleted ones go to <code>.trash</code>.</li>
            </ul>
          </div>
        )}
        <div className="prompts-search">
          <input type="text" placeholder="Search names and text…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className={`prompts-list${dropAt === '' ? ' drop-root' : ''}`} {...dropProps('')} onContextMenu={(e) => { e.preventDefault(); if (!results) setMenu({ x: e.clientX, y: e.clientY, kind: 'blank' }); }}>
          {err && <div className="error">{err}</div>}
          {data && !data.exists && <div className="prompts-empty">The folder does not exist yet. It is created when you save your first prompt.</div>}
          {data && data.exists && !data.items.length && !data.folders.length && <div className="prompts-empty">No prompts yet. Create one, or put <code>.md</code> files in the folder below.</div>}
          {results
            ? (results.length ? results.map((it) => fileRow(it, 0, dirOf(it.path))) : <div className="prompts-empty">No match.</div>)
            : tree && renderNode(tree, '', 0)}
        </div>
        {data && <div className="prompts-root" title={data.root}>{data.root}</div>}
      </div>

      <div className="prompts-main">
        {base ? (
          <>
            <div className="prompts-bar">
              <div className="path" title={base.path}>{base.path}{dirty && <span className="p-dirty"> ●</span>}</div>
              <button className="primary" disabled={!dirty || saving} onClick={() => save()}>{saving ? 'Saving…' : 'Save'}</button>
              <button
                title={target ? `Type it into “${target.name}”, without sending` : 'Open an agent first'}
                disabled={!target}
                onClick={() => curItem && act('insert', curItem)}
              >
                Insert
              </button>
              <button title="Start a new agent whose first message is this prompt (sent right away)" onClick={() => curItem && act('start', curItem)}>New agent</button>
              <button onClick={() => curItem && act('copy', curItem)}>Copy</button>
              <button title="Start an agent that helps you rework this prompt" onClick={() => setDialog({ type: 'improve', path: base.path })}>Improve</button>
              <button style={{ color: 'var(--rd)' }} onClick={() => setDialog({ type: 'delete', path: base.path, folder: false })}>Delete</button>
            </div>
            {conflict && (
              <div className="prompts-banner">
                This prompt changed on disk since you opened it (maybe in Obsidian).
                <button onClick={() => { const it = data?.items.find((i) => i.path === base.path); if (it) openItem(it); else { setBase(null); setDraft(''); setConflict(false); } }}>Reload from disk (lose my edits)</button>
                <button onClick={() => save(true)}>Keep mine and overwrite</button>
              </div>
            )}
            <textarea
              ref={editor}
              className="prompt-editor"
              spellCheck={false}
              value={draft}
              placeholder="Write the prompt. Use {{name}} for parts you fill in each time, or {{name|default}} to prefill one."
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (dirty && !saving) save(); } }}
            />
          </>
        ) : (
          <div className="placeholder">Select a prompt, or create one</div>
        )}
      </div>
    </div>
  );
}
