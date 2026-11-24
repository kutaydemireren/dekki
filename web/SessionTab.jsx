import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { toTerminalInput } from './prompt-text.js';
import { TERM_FONT, TERM_FONT_SIZE, termThemeFor, remeasureWhenFontLoads } from './term-theme.js';
import { currentResolved } from './theme.js';
import { termLinkHandler } from './term-links.js';

// xterm.js <-> WebSocket <-> node-pty running `claude attach <id>`. Closing the socket kills the pty;
// the agent keeps running.
export default function SessionTab({ agentId, active }) {
  const host = useRef(null);
  const fitRef = useRef(null);
  const [status, setStatus] = useState('connecting');
  const [attempt, setAttempt] = useState(0);
  const [dropping, setDropping] = useState(false);
  const [hint, setHint] = useState(null); // visible reason when the terminal is not showing the session yet
  const retries = useRef(0);
  const wsRef = useRef(null);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: TERM_FONT,
      fontSize: TERM_FONT_SIZE,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true, // term.unicode (width table)
      linkHandler: termLinkHandler,
      theme: termThemeFor(currentResolved()),
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    // Emoji are 2 cells wide for Claude's TUI; xterm's default (Unicode 6) table counts them as 1, which shifts
    // every later cell on that line and garbles partial redraws ("line 86:n the…").
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.open(host.current);
    try { fit.fit(); } catch {}
    let live = true;
    const onTheme = (e) => { term.options.theme = termThemeFor(e.detail); };
    window.addEventListener('dekki-theme', onTheme);
    remeasureWhenFontLoads(term, fit, () => live);

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/attach?id=${agentId}&cols=${term.cols}&rows=${term.rows}`);
    wsRef.current = ws;
    setStatus('connecting');
    setHint('Attaching to the session…');
    let gotOutput = false, closed = false;
    // `claude attach` can print nothing for a while (it may be starting or restarting the background service), which
    // used to look like a blank black pane. Say so, and retry quietly a few times on a transient failure.
    const slow = setTimeout(() => {
      if (!gotOutput) setHint('Still waiting for output from `claude attach`. The agent or its background service may be restarting; this often clears by itself.');
    }, 6000);
    let retryTimer = null;
    const failed = (msg) => {
      if (closed) return;
      if (!gotOutput && retries.current < 3) {
        const delay = 2000 * 2 ** retries.current++;
        setHint(`${msg} Retrying in ${delay / 1000}s (attempt ${retries.current} of 3)…`);
        retryTimer = setTimeout(() => setAttempt((n) => n + 1), delay);
      } else setHint(msg);
    };
    const send = (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    ws.onopen = () => { setStatus('connected'); send({ type: 'resize', cols: term.cols, rows: term.rows }); };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'output') {
        if (!gotOutput) { gotOutput = true; retries.current = 0; setHint(null); }
        if (/\[worker crashed/.test(m.data)) setHint('The agent worker crashed; claude is restarting it. If it keeps failing, the agent is dead: check `claude agents`.');
        term.write(m.data);
      } else if (m.type === 'exit') {
        setStatus(`detached (exit ${m.code})`);
        if (!gotOutput) failed(`claude attach exited with code ${m.code} and printed nothing.`);
      } else if (m.type === 'error') { setStatus('error'); failed(m.message); }
    };
    ws.onerror = () => failed('Could not open the terminal connection to the deck server.');
    ws.onclose = (ev) => {
      setStatus((s) => (s.startsWith('detached') || s === 'error' ? s : 'disconnected'));
      if (!gotOutput && ev.code !== 1000) failed(`Connection closed before any output (code ${ev.code}).`);
    };
    term.onData((data) => send({ type: 'input', data }));
    term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));

    const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
    ro.observe(host.current);
    // Saved prompts: typed (not pasted: Claude collapses a long paste into an uneditable placeholder), newlines as
    // ESC+CR so they don't submit. Never sends Enter.
    const onInsert = (e) => {
      if (e.detail?.agentId !== agentId) return;
      for (const chunk of toTerminalInput(e.detail.text)) term.input(chunk, true);
      setTimeout(() => term.focus(), 50); // the tab may only just have become visible
    };
    window.addEventListener('dekki:insert', onInsert);
    return () => { live = false; closed = true; clearTimeout(slow); clearTimeout(retryTimer); window.removeEventListener('dekki:insert', onInsert); window.removeEventListener('dekki-theme', onTheme); ro.disconnect(); ws.close(); term.dispose(); };
  }, [agentId, attempt]);

  const manualRetry = () => { retries.current = 0; setAttempt((n) => n + 1); };
  useEffect(() => {
    if (active) setTimeout(() => { try { fitRef.current?.fit(); } catch {} }, 0);
  }, [active]);

  // Drop files: upload them, then type their saved paths into the terminal (like dropping into a terminal).
  async function onDrop(e) {
    e.preventDefault();
    setDropping(false);
    const paths = [];
    for (const f of e.dataTransfer.files) {
      try {
        const res = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error);
        paths.push(body.path);
      } catch (err) {
        setStatus(`upload failed: ${err.message}`);
      }
    }
    const ws = wsRef.current;
    if (paths.length && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: paths.join(' ') + ' ' }));
  }

  const down = status !== 'connected' && status !== 'connecting';
  return (
    <div className="session">
      {status !== 'connected' && (
        <div className="term-status">
          {status}{down && <> · <a href="#" onClick={(e) => { e.preventDefault(); manualRetry(); }}>reconnect</a></>}
        </div>
      )}
      <div
        className={`term${dropping ? ' dropping' : ''}`}
        ref={host}
        onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
        onDragLeave={() => setDropping(false)}
        onDrop={onDrop}
      />
      {hint && (
        <div className="term-hint">
          <div>{hint}</div>
          <button onClick={manualRetry}>Retry</button>
        </div>
      )}
    </div>
  );
}
