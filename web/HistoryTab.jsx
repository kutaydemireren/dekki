import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Entry, { ToolGroup } from './Entry.jsx';
import { foldEntries, MODES } from './history-fold.js';
import { nextPromptTarget } from './history-nav.js';

const PAGE = 300;
const STICK_PX = 80; // within this distance of the bottom counts as "following"
const MODE_KEY = 'dekki.historyMode';
const MODE_LABEL = { summary: 'Summary', normal: 'Normal', verbose: 'Verbose' };
const loadMode = () => { try { const m = localStorage.getItem(MODE_KEY); return MODES.includes(m) ? m : 'normal'; } catch { return 'normal'; } };

export default function HistoryTab({ agentId }) {
  const [state, setState] = useState({ status: 'loading', entries: [] });
  const box = useRef(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const [mode, setModeRaw] = useState(loadMode); // Summary hides tool groups and diff cards, Normal folds them, Verbose opens them
  const setMode = (m) => { setModeRaw(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* storage blocked */ } };
  const [shown, setShown] = useState(PAGE); // only the latest N entries are rendered; keeps huge transcripts fast
  const hidden = Math.max(0, state.entries.length - shown);

  useEffect(() => {
    setState({ status: 'loading', entries: [] });
    stick.current = true;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/history?id=${agentId}`);
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'init') setState({ status: 'ok', entries: m.entries });
      else if (m.type === 'expired') setState({ status: 'expired', entries: [] });
      else if (m.type === 'error') setState({ status: 'error', entries: [], error: 'agent not found' });
      else if (m.type === 'entries') {
        // upsert by id, keeping file order for existing entries
        setState((s) => {
          const index = new Map(s.entries.map((e, i) => [e.id, i]));
          const next = s.entries.slice();
          for (const e of m.entries) {
            if (index.has(e.id)) next[index.get(e.id)] = e;
            else { index.set(e.id, next.length); next.push(e); }
          }
          return { ...s, entries: next };
        });
      }
    };
    ws.onclose = () => setState((s) => (s.status === 'loading' ? { status: 'error', entries: [], error: 'connection closed' } : s));
    return () => ws.close();
  }, [agentId]);

  // Sticky prompt: when the prompt that started the current turn has scrolled out of view, pin it (one line)
  // at the top, like claude does in the terminal. Click jumps back to it.
  const [sticky, setSticky] = useState(null); // {id, text} | null
  const updateSticky = () => {
    const el = box.current;
    if (!el) return;
    let cur = null;
    for (const p of el.querySelectorAll("[data-uid]")) {
      if (p.offsetTop <= el.scrollTop + 4) cur = p; else break;
    }
    // pin only once that prompt has scrolled fully out of view above the top edge
    if (cur && cur.offsetTop + cur.offsetHeight > el.scrollTop + 1) cur = null;
    setHasNext(nextTarget(el) !== null);
    const id = cur ? cur.dataset.uid : null;
    setSticky((prev) => {
      if ((prev?.id ?? null) === id) return prev;
      const entry = id && state.entries.find((x) => x.id === id);
      return entry ? { id, text: entry.text.split("\n").find((l) => l.trim()) || entry.text } : null;
    });
  };
  // next prompt below the current position, anchored at the top of the view
  const [hasNext, setHasNext] = useState(false);
  const nextTarget = (el) => nextPromptTarget(
    [...el.querySelectorAll("[data-uid]")].map((p) => p.offsetTop), el.scrollTop, el.scrollHeight - el.clientHeight);
  const goToNext = () => {
    const el = box.current;
    const top = nextTarget(el);
    if (top !== null) el.scrollTo({ top, behavior: "smooth" });
  };
  const goToSticky = () => {
    const target = [...box.current.querySelectorAll("[data-uid]")].find((p) => p.dataset.uid === sticky.id);
    if (target) box.current.scrollTo({ top: target.offsetTop, behavior: "smooth" });
  };

  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
    updateSticky();
  }, [state.entries, shown]); // eslint-disable-line react-hooks/exhaustive-deps

  // the pinned bar takes its own row (the list shrinks below it), so keep following the bottom when it appears
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [!!sticky]);

  // the visible height and the content height decide how far the view can scroll: re-check when either changes
  const inner = useRef(null);
  const recheck = useRef(updateSticky);
  recheck.current = updateSticky;
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => recheck.current());
    ro.observe(el);
    if (inner.current) ro.observe(inner.current); // content growing/shrinking (tool block or paste toggled)
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = box.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    stick.current = atBottom;
    setAway(!atBottom);
    updateSticky();
  };
  const jump = () => {
    stick.current = true;
    box.current.scrollTop = box.current.scrollHeight;
    setAway(false);
  };

  return (
    <>
      {sticky && (
        <div className="sticky-prompt" onClick={goToSticky} title="Jump to this prompt">
          <span className="sp-mark">❯</span>
          <span className="sp-text">{sticky.text}</span>
        </div>
      )}
      <div className="hbar">
        <span className="lb">View</span>
        <div className="seg" role="group" aria-label="History detail">
          {MODES.map((m) => <button key={m} className={mode === m ? 'on' : ''} aria-pressed={mode === m} onClick={() => setMode(m)}>{MODE_LABEL[m]}</button>)}
        </div>
      </div>
      <div className={"history" + (sticky ? " has-pin" : "")} ref={box} onScroll={onScroll} data-mode={mode}>
        <div ref={inner} className="hist">
        {state.status === 'loading' && <div className="empty">Loading…</div>}
        {state.status === 'expired' && <div className="empty">History expired</div>}
        {state.status === 'error' && <div className="empty">Could not load history: {state.error}</div>}
        {state.status === 'ok' && !state.entries.length && <div className="empty">No messages yet</div>}
        {hidden > 0 && (
          <button onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, hidden)} earlier ({hidden} hidden)</button>
        )}
        {foldEntries(state.entries.slice(hidden)).map((it) => (it.type === 'tools'
          ? <ToolGroup key={`${it.id}-${mode}`} tools={it.tools} mode={mode} />
          : <Entry key={it.e.id} e={it.e} />))}
        </div>
      </div>
      {(away || hasNext) && (
        <div className="jump-bar">
          {hasNext && <button onClick={goToNext} title="Scroll to the next prompt">Next prompt ↓</button>}
          {away && <button className="primary" onClick={jump}>Jump to latest ↓</button>}
        </div>
      )}
    </>
  );
}
