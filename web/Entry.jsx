import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isPathLike, statusOf, calloutOf } from './md-style.js';
import { summarizeTools, groupHasError, groupPending, diffCounts } from './history-fold.js';

const time = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

// Assistant text is markdown (GitHub flavour: tables, task lists, strikethrough). react-markdown renders
// to React elements and ignores raw HTML, so transcript content can't inject markup.
// Small styling hooks on top of that (see md-style.js): file paths and inline code get their own colour, code blocks
// get a language label + Copy, ```diff blocks are coloured, and a leading `result:` / `needs input:` / `failed:`
// is highlighted. No syntax highlighter on purpose.
const hastText = (n) => (n.type === 'text' ? n.value : (n.children || []).map(hastText).join(''));
const langOf = (code) => {
  const c = code?.properties?.className;
  const m = (Array.isArray(c) ? c : []).find((x) => String(x).startsWith('language-'));
  return m ? String(m).slice(9) : '';
};
const textOf = (children) => React.Children.toArray(children).map((c) => (typeof c === 'string' ? c : '')).join('');

function CodeBlock({ lang, text, children }) {
  const [copied, setCopied] = React.useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* clipboard blocked */ }
  }
  return (
    <div className={`codeblock${lang ? '' : ' nolang'}`}>
      {lang && <span className="cb-lang">{lang}</span>}
      <button className="cb-copy" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      {children}
    </div>
  );
}

function DiffLines({ text }) {
  return (
    <pre className="cb-diff">
      {text.replace(/\n$/, '').split('\n').map((l, i) => (
        <span key={i} className={l.startsWith('@@') ? 'hunk' : l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : 'ctx'}>{l || ' '}{'\n'}</span>
      ))}
    </pre>
  );
}

// Wrap a leading status word of a paragraph/list item (plain text, or the text of a leading **bold**).
function withStatus(children) {
  const arr = React.Children.toArray(children);
  const first = arr[0];
  if (typeof first === 'string') {
    const st = statusOf(first);
    if (st) return [<span key="st" className={`st st-${st.kind}`}>{st.word}</span>, st.rest, ...arr.slice(1)];
  } else if (first?.type === MD_COMPONENTS.strong && typeof first.props.children === 'string' && statusOf(first.props.children)) {
    return [<strong key="st" className={`st st-${statusOf(first.props.children).kind}`}>{first.props.children}</strong>, ...arr.slice(1)];
  }
  return children;
}

const MD_COMPONENTS = {
  a: ({ node, ...p }) => <a {...p} target="_blank" rel="noopener noreferrer" />,
  code: ({ node, className, children }) => {
    const t = textOf(children);
    if (className || t.includes('\n')) return <code className={className}>{children}</code>; // fenced: `pre` handles it
    return <code className={`ic${isPathLike(t) ? ' path' : ''}`}>{children}</code>;
  },
  strong: ({ node, children }) => <strong className={isPathLike(textOf(children)) ? 'path' : undefined}>{children}</strong>,
  pre: ({ node, children }) => {
    const code = node.children?.[0];
    const lang = langOf(code);
    const text = code ? hastText(code) : '';
    return (
      <CodeBlock lang={lang} text={text.replace(/\n$/, '')}>
        {lang === 'diff' || lang === 'patch' ? <DiffLines text={text} /> : <pre>{children}</pre>}
      </CodeBlock>
    );
  },
  p: ({ node, children }) => <p>{withStatus(children)}</p>,
  li: ({ node, children }) => <li>{withStatus(children)}</li>,
};

function Text({ text }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{text}</Markdown>
    </div>
  );
}

function Diff({ diff }) {
  return (
    <div className="diff">
      {diff.hunks.map((h, i) => (
        <div key={i}>
          {h.header && <div className="hunk">{h.header}</div>}
          {h.lines.map((l, j) => (
            <div key={j} className={l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx'}>{l || ' '}</div>
          ))}
        </div>
      ))}
    </div>
  );
}

// Edit / Write with a parsed diff: a file card (name, +N -M, coloured lines). Stays visible in Normal mode, hidden in Summary.
function DiffCard({ e }) {
  const { add, del } = diffCounts(e.diff);
  const err = e.result?.isError;
  return (
    <div className={`diffcard${err ? ' err' : ''}`}>
      <div className="dh">
        <span className="dn">{e.name}</span>
        <span className="df path">{e.diff.filePath}</span>
        <span className="dst"><span className="p">+{add}</span><span className="m">-{del}</span></span>
      </div>
      <Diff diff={e.diff} />
      {err && <pre className="derr">{e.result.text || 'error'}</pre>}
    </div>
  );
}

function inputView(e) {
  const i = e.input || {};
  if (e.name === 'Bash' && typeof i.command === 'string') return i.command;
  if (e.diff) return null; // the diff says it all
  try { return JSON.stringify(i, null, 2); } catch { return ''; }
}

function Tool({ e, open }) {
  const input = inputView(e);
  const status = !e.result ? '…' : e.result.isError ? 'error' : '';
  return (
    <details className={`tool${e.result?.isError ? ' err' : ''}`} open={open}>
      <summary>
        <span className="tn">{e.name}</span>
        <span className="ts">{e.summary}</span>
        {status && <span>{status}</span>}
      </summary>
      <div className="tbody">
        {input && <pre>{input}</pre>}
        {e.agentId && <div className="lbl">sub-agent {e.agentId}</div>}
        {e.result && (
          <>
            <div className="lbl">result{e.result.truncated ? ' (truncated)' : ''}</div>
            <pre>{e.result.text || '(empty)'}</pre>
          </>
        )}
      </div>
    </details>
  );
}

const Chevron = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
);

// Consecutive tool calls folded into one collapsed line; opens to the per-tool detail. Verbose mode opens it and every tool in it.
export function ToolGroup({ tools, mode }) {
  const verbose = mode === 'verbose';
  const err = groupHasError(tools);
  const pending = groupPending(tools);
  return (
    <details className={`act${err ? ' err' : ''}`} open={verbose}>
      <summary>
        <Chevron />
        <span className="act-text">{summarizeTools(tools)}</span>
        {err && <span className="act-mark err" title="A tool call in this group failed">error</span>}
        {!err && pending && <span className="act-mark">…</span>}
      </summary>
      <div className="act-lines">
        {tools.map((t) => <Tool key={t.id} e={t} open={verbose} />)}
      </div>
    </details>
  );
}

// A prompt with pasted text (e.segments from the parser): typed parts as they were, each pasted part in a block with a
// muted "pasted" tag. From COLLAPSE_LINES lines up the block is a native <details>, closed, so a pasted log or file
// doesn't push the conversation off screen; shorter pastes stay open.
const COLLAPSE_LINES = 12;
const trimNl = (s) => s.replace(/^\n+|\n+$/g, '');

function Pasted({ text }) {
  const lines = text.split('\n').length;
  if (lines < COLLAPSE_LINES) return <div className="pasted"><span className="pasted-tag">pasted</span><pre>{text}</pre></div>;
  return (
    <details className="pasted">
      <summary><span className="pasted-tag">pasted</span><span className="pasted-n">{lines} lines</span><span className="pasted-first">{text.split('\n').find((l) => l.trim()) || ''}</span></summary>
      <pre>{text}</pre>
    </details>
  );
}

function UserText({ e }) {
  if (!e.segments) return <div className="text" style={{ whiteSpace: 'pre-wrap' }}>{e.text}</div>;
  return (
    <div className="text">
      {e.segments.map((g, i) => {
        const t = trimNl(g.text);
        if (!t) return null;
        return g.pasted ? <Pasted key={i} text={t} /> : <div key={i} style={{ whiteSpace: 'pre-wrap' }}>{t}</div>;
      })}
    </div>
  );
}

export default React.memo(function Entry({ e }) {
  if (e.k === 'tool') return e.diff ? <DiffCard e={e} /> : <ToolGroup tools={[e]} mode="normal" />;
  if (e.k === 'user') {
    return (
      <div className="msg user" data-uid={e.id}>
        <div className="who">You<span className="time">{time(e.ts)}</span></div>
        <UserText e={e} />
      </div>
    );
  }
  if (e.k === 'note') return <div className="msg note">{e.text}</div>;
  if (e.k === 'thinking') {
    return (
      <details className="msg thinking">
        <summary>thinking</summary>
        <div style={{ whiteSpace: 'pre-wrap' }}>{e.text}</div>
      </details>
    );
  }
  const co = calloutOf(e.text);
  if (co) {
    return (
      <div className="msg assistant">
        <div className={`rep rep-${co.kind}`}>
          <div className="rk">{co.label}</div>
          <div className="rb"><Text text={co.body} /></div>
        </div>
        {co.rest && <Text text={co.rest} />}
      </div>
    );
  }
  return (
    <div className="msg assistant">
      <div className="who">Claude<span className="time">{time(e.ts)}</span></div>
      <Text text={e.text} />
    </div>
  );
});
