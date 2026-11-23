import React, { useEffect, useState } from 'react';

// Folder tree under the configured root, loaded lazily one level at a time. Hidden items are shown.
// Single click on a folder expands it; double click or right-click > Open opens it like Finder would
// (folders in Finder, files and packages such as .xcodeproj in their default app).

// Finder icons come from the server (one PNG per file type, cached). fetch() + blob URL so the request
// goes through the same-origin API path; the map caches the result per type for the whole session.
const iconCache = new Map(); // type -> Promise<objectURL | null>
function iconUrl(type) {
  if (!iconCache.has(type)) {
    iconCache.set(
      type,
      fetch(`/api/icon?type=${encodeURIComponent(type)}`)
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => (b ? URL.createObjectURL(b) : null))
        .catch(() => null),
    );
  }
  return iconCache.get(type);
}

function Icon({ type }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let stop = false;
    iconUrl(type).then((u) => !stop && setSrc(u));
    return () => { stop = true; };
  }, [type]);
  return src ? <img className="tree-icon" src={src} alt="" draggable={false} /> : <span className="tree-icon" />;
}

function Node({ rel, node, depth, onOpen, onMenu }) {
  const { name, kind, icon } = node;
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState(null);

  async function toggle() {
    if (kind !== 'dir') return;
    if (!open && entries === null) {
      try {
        const r = await fetch(`/api/tree?path=${encodeURIComponent(rel)}`);
        setEntries((await r.json()).entries || []);
      } catch {
        setEntries([]);
      }
    }
    setOpen(!open);
  }

  return (
    <>
      <div
        className="tree-row"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={toggle}
        onDoubleClick={() => onOpen(rel)}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onMenu(e, { rel, name, kind }); }}
        title={rel}
      >
        <span className="tree-caret">{kind === 'dir' ? (open ? '▾' : '▸') : ''}</span>
        <Icon type={icon} />
        <span className="tree-name">{name}</span>
      </div>
      {open && entries?.map((n) => <Node key={n.name} rel={`${rel}/${n.name}`} node={n} depth={depth + 1} onOpen={onOpen} onMenu={onMenu} />)}
      {open && entries?.length === 0 && <div className="tree-row empty" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>(empty)</div>}
    </>
  );
}

export default function FolderTree({ onOpen, onMenu, rootKey = 0 }) {
  const [top, setTop] = useState(null);
  useEffect(() => {
    fetch('/api/tree?path=').then((r) => r.json()).then((b) => setTop(b.entries ? b : { root: '', entries: [] })).catch(() => setTop({ root: '', entries: [] }));
  }, [rootKey]);
  if (!top) return <div className="tree-panel">Loading…</div>;
  return (
    <div className="tree-panel">
      <div className="tree-root">{top.root}</div>
      {top.entries.map((n) => <Node key={n.name} rel={n.name} node={n} depth={0} onOpen={onOpen} onMenu={onMenu} />)}
    </div>
  );
}
