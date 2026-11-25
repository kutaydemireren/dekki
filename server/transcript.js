// ALL transcript (JSONL) parsing lives here. The format is undocumented and may change:
// ignore unknown record types, tolerate unknown tools and malformed lines, never throw on bad data.
// Everything else consumes the normalised "entries" produced by createParser().
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activeConfigDir } from './accounts.js';

// DEKKI_PROJECTS_DIR is a test seam (e.g. an empty dir to see "History expired").
const projectsDir = (configDir = activeConfigDir()) => process.env.DEKKI_PROJECTS_DIR || path.join(configDir, 'projects'); // default: the active account
const UUID_RE = /^[0-9a-f-]{36}$/;
const MAX_TEXT = 20000; // cap per tool input/result string sent to the browser
const MAX_DIFF_LINES = 400;

const pathCache = new Map();

/** Glob <config dir>/projects/*\/<sessionId>.jsonl (never encode cwd). configDir defaults to the active account's.
 *  Returns a path or null. */
export function findTranscript(sessionId, configDir) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return null;
  const pdir = projectsDir(configDir);
  const cached = pathCache.get(sessionId);
  if (cached && cached.startsWith(pdir + path.sep) && fs.existsSync(cached)) return cached; // a path from another account's dir is not reused
  pathCache.delete(sessionId);
  let dirs;
  try {
    dirs = fs.readdirSync(pdir);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const f = path.join(pdir, d, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) {
      pathCache.set(sessionId, f);
      return f;
    }
  }
  return null;
}

// ---- helpers ----

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function cap(s) {
  if (typeof s !== 'string') return { text: '', truncated: false };
  return s.length > MAX_TEXT ? { text: s.slice(0, MAX_TEXT), truncated: true } : { text: s, truncated: false };
}

/** Shrink big string values in a tool input before it goes to the browser. */
function trimInput(input) {
  if (!isObj(input)) return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === 'string' && v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) + '…' : v;
  }
  return out;
}

function summarise(name, input) {
  const i = isObj(input) ? input : {};
  const pick = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.description ?? i.url ?? i.query ?? i.prompt;
  if (typeof pick === 'string') return pick.replace(/\s+/g, ' ').slice(0, 160);
  for (const v of Object.values(i)) if (typeof v === 'string') return v.replace(/\s+/g, ' ').slice(0, 160);
  return '';
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : b?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

function hunksFromPatch(structuredPatch) {
  if (!Array.isArray(structuredPatch) || !structuredPatch.length) return null;
  const hunks = [];
  let n = 0;
  for (const h of structuredPatch) {
    if (!isObj(h) || !Array.isArray(h.lines)) continue;
    const lines = h.lines.filter((l) => typeof l === 'string').slice(0, Math.max(0, MAX_DIFF_LINES - n));
    n += lines.length;
    hunks.push({ header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, lines });
  }
  return hunks.length ? hunks : null;
}

function addLines(text, prefix) {
  return text.replace(/\n$/, '').split('\n').slice(0, MAX_DIFF_LINES).map((l) => prefix + l);
}

/** Diff available from the tool_use input alone (before/without a result). */
function diffFromInput(name, input) {
  if (!isObj(input) || typeof input.file_path !== 'string') return null;
  if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return { filePath: input.file_path, hunks: [{ header: '', lines: [...addLines(input.old_string, '-'), ...addLines(input.new_string, '+')] }] };
  }
  if (name === 'Write' && typeof input.content === 'string') {
    return { filePath: input.file_path, hunks: [{ header: '', lines: addLines(input.content, '+') }] };
  }
  return null;
}

function diffFromResult(tur) {
  if (!isObj(tur) || typeof tur.filePath !== 'string') return null;
  const hunks = hunksFromPatch(tur.structuredPatch);
  if (hunks) return { filePath: tur.filePath, hunks };
  if (tur.type === 'create' && typeof tur.content === 'string') {
    return { filePath: tur.filePath, hunks: [{ header: '', lines: addLines(tur.content, '+') }] };
  }
  return null;
}

// Claude wraps pasted text as <pasted_content id="x">…</pasted_content id="x"> (closing tag carries the id too; nesting and
// backslash-escaped variants <\pasted_content …> / <\/pasted_content …> occur). Only tags at a line start or end are
// wrappers: a mention in the middle of a sentence is the user's own text and stays.
const PASTED_TAG = '<\\\\?/?\\\\?pasted_content\\b[^>]*>';
const PASTED_TAG_RE = new RegExp(PASTED_TAG, 'g');
const TAGS_ONLY_RE = new RegExp(`^(?:[ \\t]*${PASTED_TAG})*[ \\t]*$`);

/**
 * Drops the wrapper tags and keeps where they were: [{text, pasted}] in order (adjacent same-kind runs merged, trimmed at
 * both ends), or null when nothing is left after stripping (the caller then keeps the original). Tags are only counted,
 * ids are ignored, so nested / mismatched / unclosed tags still come out sane.
 */
function pastedSegments(s) {
  if (!s.includes('pasted_content')) return null;
  const chunks = [];
  let pos = 0;
  let depth = 0;
  for (const m of s.matchAll(PASTED_TAG_RE)) {
    const tagEnd = m.index + m[0].length;
    const lineStart = s.lastIndexOf('\n', m.index - 1) + 1;
    const nl = s.indexOf('\n', tagEnd);
    const leftOk = TAGS_ONLY_RE.test(s.slice(lineStart, m.index));
    const rightOk = TAGS_ONLY_RE.test(s.slice(tagEnd, nl < 0 ? s.length : nl));
    if (!leftOk && !rightOk) continue; // mid-sentence mention: the user's own text
    let start = m.index;
    let end = tagEnd;
    while (start > pos && (s[start - 1] === ' ' || s[start - 1] === '\t')) start--;
    while (end < s.length && (s[end] === ' ' || s[end] === '\t')) end++;
    if (leftOk && rightOk && s[end] === '\n') end++; // a tag alone on its line takes the line with it
    chunks.push({ text: s.slice(pos, start), pasted: depth > 0 });
    depth = m[0].includes('/') ? Math.max(0, depth - 1) : depth + 1;
    pos = end;
  }
  chunks.push({ text: s.slice(pos), pasted: depth > 0 });
  const segs = [];
  for (const c of chunks) {
    if (!c.text) continue;
    const last = segs[segs.length - 1];
    if (last?.pasted === c.pasted) last.text += c.text;
    else segs.push({ ...c });
  }
  while (segs.length && !(segs[0].text = segs[0].text.trimStart())) segs.shift();
  while (segs.length && !(segs[segs.length - 1].text = segs[segs.length - 1].text.trimEnd())) segs.pop();
  return segs.length ? segs : null;
}

const decodeEntities = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const tagContent = (s, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s);
  return m ? m[1].trim() : null;
};

/**
 * One text block of a user record -> {k:'user'|'note', text} or null (hidden).
 *   /slash commands        <command-name>/pr-review</command-name> <command-args>…  -> "/pr-review …"
 *   ! shell commands       <bash-input>…  -> "! …" ;  <bash-stdout>/<bash-stderr>  -> note
 *   command output         <local-command-stdout>…  -> note ("(no content)" hidden)
 *   background tasks       <task-notification>…<summary>  -> note
 *   caveats / reminders    hidden
 *   pasted text            <pasted_content id="x">…</pasted_content id="x">  -> wrapper tags dropped from `text`; `segments`
 *                          [{text, pasted}] says which parts were pasted (only present when something was)
 */
export function userText(text) {
  const t = String(text).trim();
  if (!t) return null;
  if (/^<(local-command-caveat|system-reminder)>/.test(t)) return null;

  const name = tagContent(t, 'command-name');
  if (name) {
    const args = tagContent(t, 'command-args');
    return { k: 'user', text: args ? `${name} ${decodeEntities(args)}` : name };
  }
  const shell = tagContent(t, 'bash-input');
  if (shell !== null) return { k: 'user', text: `! ${decodeEntities(shell)}` };

  const out = tagContent(t, 'local-command-stdout');
  if (out !== null) return out && out !== '(no content)' ? { k: 'note', text: cap(decodeEntities(out)).text } : null;

  if (/^<bash-(stdout|stderr)>/.test(t)) {
    const combined = [tagContent(t, 'bash-stdout'), tagContent(t, 'bash-stderr')].filter(Boolean).map(decodeEntities).join('\n');
    return combined ? { k: 'note', text: cap(combined).text } : null;
  }
  if (t.startsWith('<task-notification>')) {
    const summary = tagContent(t, 'summary');
    return { k: 'note', text: summary ? `Background task: ${decodeEntities(summary)}` : 'Background task update' };
  }
  const segments = pastedSegments(t);
  if (!segments) return { k: 'user', text: t };
  const item = { k: 'user', text: segments.map((g) => g.text).join('') };
  return segments.some((g) => g.pasted) ? { ...item, segments } : item;
}

const KNOWN_LEADING = new Set(['user', 'assistant', 'attachment', 'ai-title', 'custom-title', 'agent-name']);
const LEADING_TYPE_RE = /^\{"type":"([^"]+)"/;

// ---- parser ----

/**
 * Stateful, incremental parser. feed(textOfCompleteLines) returns the entries that are new or changed
 * (upsert by `id`); meta is updated in place. Entry shapes:
 *   {id,k:'user'|'note'|'text'|'thinking', ts, text}   (user: also `segments` [{text,pasted}] when part was pasted; text is the plain whole)
 *   {id,k:'tool', ts, name, summary, input, result:null|{text,isError,truncated}, diff:null|{filePath,hunks}, agentId}
 */
export function createParser() {
  const entries = new Map();
  const userByParent = new Map(); // "<parentUuid>\n<text>" -> {id, seq}, to collapse a prompt recorded twice
  const meta = { title: null, cwd: null, gitBranch: null, sessionId: null };
  let changed;

  let agentSeq = 0; // counts entries from the agent (text, tools, ...) so we can tell if work happened between two prompts
  const put = (e) => {
    if (e.k !== 'user' && !entries.has(e.id)) agentSeq++;
    entries.set(e.id, e);
    changed.set(e.id, e);
  };

  function onUser(r) {
    if (r.isMeta || r.isSidechain) return;
    const content = r.message?.content;
    const ts = r.timestamp ?? null;
    const texts = [];
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (!isObj(b)) continue;
        if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
        else if (b.type === 'image') texts.push('[image]');
        else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          const tool = entries.get(`t:${b.tool_use_id}`);
          if (!tool) continue;
          const { text, truncated } = cap(resultText(b.content));
          put({
            ...tool,
            result: { text, truncated, isError: b.is_error === true },
            diff: diffFromResult(r.toolUseResult) || tool.diff,
            agentId: isObj(r.toolUseResult) && typeof r.toolUseResult.agentId === 'string' ? r.toolUseResult.agentId : tool.agentId,
          });
        }
      }
    }
    if (typeof r.uuid !== 'string') return;
    if (r.isCompactSummary) {
      if (texts.join('').trim()) put({ id: `u:${r.uuid}`, k: 'note', ts, text: 'Conversation compacted (summary hidden)' });
      return;
    }
    // Claude stores slash commands, shell commands and notifications as tag-wrapped "user" text: normalise.
    const items = [];
    for (const t of texts) {
      const item = userText(t);
      if (!item) continue;
      const last = items[items.length - 1];
      if (item.k === 'user' && last?.k === 'user') {
        const plain = (x) => x.segments ?? [{ text: x.text, pasted: false }];
        if (last.segments || item.segments) last.segments = [...plain(last), { text: '\n', pasted: false }, ...plain(item)];
        last.text += `\n${item.text}`;
      } else items.push(item);
    }
    // Claude sometimes records one submitted prompt twice as sibling records (same parent, identical text,
    // seconds to minutes apart; the first is an abandoned branch with no reply). Show it once, with the later
    // timestamp. Only when the agent recorded nothing in between: if work happened between two identical
    // prompts (resent after an interruption, a rewind), both prompts and that work stay in the history.
    const first = items[0];
    if (first?.k === 'user') {
      const key = `${r.parentUuid}\n${first.text}`;
      const prev = userByParent.get(key);
      if (prev && prev.seq === agentSeq && entries.has(prev.id)) {
        put({ ...entries.get(prev.id), ts });
        items.shift();
      } else {
        userByParent.set(key, { id: `u:${r.uuid}`, seq: agentSeq });
      }
    }
    items.forEach((item, i) => put({ id: i ? `u:${r.uuid}:${i}` : `u:${r.uuid}`, k: item.k, ts, text: item.text, ...(item.segments && { segments: item.segments }) }));
  }

  // A message the user sent while the agent was working and that was absorbed mid-turn is not a "user" record:
  // Claude stores it as an attachment {type:'queued_command', prompt, origin:{kind}, source_uuid, delivery_id, timestamp}.
  // Only human-origin ones are shown (task notifications and cross-session notices carry another origin kind).
  function onQueued(r) {
    const a = r.attachment;
    if (!isObj(a) || a.type !== 'queued_command' || !isObj(a.origin) || a.origin.kind !== 'human') return;
    if (typeof a.prompt !== 'string' || !a.prompt.trim()) return;
    const key = [a.source_uuid, a.delivery_id, r.uuid].find((k) => typeof k === 'string' && k);
    if (!key) return;
    const item = userText(a.prompt);
    if (item?.k !== 'user') return;
    const ts = typeof a.timestamp === 'string' ? a.timestamp : (r.timestamp ?? null);
    // the same message recorded as a normal user row with uuid = source_uuid reuses this id, so it shows once
    put({ id: `u:${key}`, k: 'user', ts, text: item.text, ...(item.segments && { segments: item.segments }) });
  }

  function onAssistant(r) {
    if (r.isSidechain) return;
    const content = r.message?.content;
    if (!Array.isArray(content) || typeof r.uuid !== 'string') return;
    const ts = r.timestamp ?? null;
    content.forEach((b, i) => {
      if (!isObj(b)) return;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        put({ id: `a:${r.uuid}:${i}`, k: 'text', ts, text: b.text });
      } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
        put({ id: `a:${r.uuid}:${i}`, k: 'thinking', ts, text: b.thinking });
      } else if (b.type === 'tool_use' && typeof b.id === 'string') {
        const name = typeof b.name === 'string' ? b.name : 'unknown';
        const prev = entries.get(`t:${b.id}`);
        put({
          id: `t:${b.id}`,
          k: 'tool',
          ts,
          name,
          summary: summarise(name, b.input),
          input: trimInput(b.input),
          result: prev?.result ?? null,
          diff: prev?.diff ?? diffFromInput(name, b.input),
          agentId: prev?.agentId ?? null,
        });
      }
    });
  }

  function onRecord(r) {
    if (!isObj(r)) return;
    if (typeof r.sessionId === 'string' && !meta.sessionId) meta.sessionId = r.sessionId;
    switch (r.type) {
      case 'user':
        if (r.cwd && !meta.cwd) meta.cwd = r.cwd;
        if (r.gitBranch && !meta.gitBranch) meta.gitBranch = r.gitBranch;
        return onUser(r);
      case 'assistant':
        return onAssistant(r);
      case 'attachment':
        return onQueued(r);
      case 'custom-title':
        if (typeof r.customTitle === 'string') meta.title = r.customTitle;
        return;
      case 'agent-name':
        if (typeof r.agentName === 'string' && !meta.title) meta.title = r.agentName;
        return;
      case 'ai-title':
        if (typeof r.aiTitle === 'string' && !meta.title) meta.title = r.aiTitle;
        return;
      default:
        return; // unknown record types are ignored
    }
  }

  return {
    meta,
    all: () => [...entries.values()],
    feed(text) {
      changed = new Map();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const m = LEADING_TYPE_RE.exec(line.length > 80 ? line.slice(0, 80) : line);
        if (m && !KNOWN_LEADING.has(m[1])) continue; // cheap skip of huge metadata records
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          continue; // malformed or half-written line
        }
        try {
          onRecord(r);
        } catch {
          // a surprising record shape must never take the deck down
        }
      }
      return [...changed.values()];
    },
  };
}

/** Parse a whole transcript file. Returns {entries, meta, size} (size = bytes consumed, complete lines only). */
export function readTranscript(file) {
  const buf = fs.readFileSync(file);
  const end = buf.lastIndexOf(0x0a) + 1; // only complete lines
  const parser = createParser();
  parser.feed(buf.subarray(0, end).toString('utf8'));
  return { entries: parser.all(), meta: parser.meta, size: end, parser };
}

// ---- is there a conversation at all? (guards deleting a draft) ----

// Record types Claude writes for a session nobody has talked in yet. Anything else counts as "can't tell".
const META_TYPES = new Set(['file-history-snapshot', 'last-prompt', 'cost-state', 'isolation-latch', 'atis-latch', 'ai-title', 'custom-title', 'agent-name', 'mode', 'permission-mode']);
const EMPTY_MAX_BYTES = 256 * 1024; // a transcript without messages is tiny: a big file is never "empty"

/**
 * 'missing' (no file), 'empty' (only known metadata records), 'messages' (any user/assistant record, or a big
 * file) or 'unknown' (unreadable, malformed line, unrecognised record type). Deliberately independent of the
 * entry parser and fail-safe: only 'missing'/'empty' may lead to deleting a chat, and only with other evidence.
 */
export function conversationState(file) {
  if (!file) return 'missing';
  let st;
  try { st = fs.statSync(file); } catch (e) { return e.code === 'ENOENT' ? 'missing' : 'unknown'; }
  if (st.size > EMPTY_MAX_BYTES) return 'messages';
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return 'unknown'; }
  let metaOnly = true;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { return 'unknown'; } // includes a line still being written
    if (r?.type === 'user' || r?.type === 'assistant') return 'messages';
    if (!META_TYPES.has(r?.type)) metaOnly = false;
  }
  return metaOnly ? 'empty' : 'unknown';
}

// ---- when did the conversation last move? ----

const activityCache = new Map(); // file -> {mtimeMs, size, ts}

/**
 * Timestamp (ms) of the last real user/assistant record, or null. Claude also appends timestamp-less metadata
 * (cost-state, ai-title…) whenever a process starts or stops for the session, e.g. when the deck attaches, so the
 * file's mtime and the job's lastTerminalAt are not conversation activity; this is. Reads only the tail, widening
 * the window if the last record is huge; cached per file (mtime/size).
 */
export function lastRealActivity(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const cached = activityCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.ts;
  let ts = null;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      for (const window of [128 * 1024, 1024 * 1024, 8 * 1024 * 1024]) {
        const len = Math.min(st.size, window);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        const lines = buf.toString('utf8').split('\n');
        if (len < st.size) lines.shift(); // the first line may be cut in half
        for (let i = lines.length - 1; i >= 0 && ts === null; i--) {
          try {
            const r = JSON.parse(lines[i]);
            const queued = r?.type === 'attachment' && r.attachment?.type === 'queued_command' && r.attachment.origin?.kind === 'human';
            const stamp = queued ? (r.attachment.timestamp ?? r.timestamp) : r?.timestamp;
            if (typeof stamp === 'string' && (queued || ((r?.type === 'user' || r?.type === 'assistant') && !r.isMeta && !r.isSidechain))) {
              const t = Date.parse(stamp);
              if (Number.isFinite(t)) ts = t;
            }
          } catch { /* partial or malformed line: keep looking */ }
        }
        if (ts !== null || len >= st.size) break;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { ts = null; }
  activityCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, ts });
  return ts;
}

// ---- did a worker end with a report? ----

const lastTextCache = new Map(); // file -> {mtimeMs, size, text}

/**
 * Text of the last main-conversation assistant record that has a text block (its text blocks joined with newlines),
 * '' when the file has no such record, null when the file is unreadable. Reads only the tail, widening the window
 * if needed; malformed lines are skipped; cached per file (mtime/size).
 */
export function lastAssistantText(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const cached = lastTextCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.text;
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      for (const window of [128 * 1024, 1024 * 1024, 8 * 1024 * 1024]) {
        const len = Math.min(st.size, window);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        const lines = buf.toString('utf8').split('\n');
        if (len < st.size) lines.shift(); // the first line may be cut in half
        let found = null;
        for (let i = lines.length - 1; i >= 0 && found === null; i--) {
          try {
            const r = JSON.parse(lines[i]);
            if (r?.type !== 'assistant' || r.isSidechain || !Array.isArray(r.message?.content)) continue;
            const parts = r.message.content.filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim()).map((b) => b.text);
            if (parts.length) found = parts.join('\n');
          } catch { /* partial or malformed line: keep looking */ }
        }
        if (found !== null) { text = found; break; }
        if (len >= st.size) break;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { return null; }
  lastTextCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, text });
  return text;
}

/** Worker report contract: some line starts with `result:`, `needs input:` or `failed:`. */
export function hasWorkerReport(text) {
  return typeof text === 'string' && /^[ \t]*(result|needs input|failed):/im.test(text);
}

// ---- which projects did an agent work on? ----

const touchCache = new Map(); // file -> {mtimeMs, size, at, result}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * For agents started in the projects root (managers, or sessions that moved into a project later) the start
 * folder says nothing. Look at what the agent's tools referenced: paths under the root, `cd <project>`,
 * `--cwd <project>`, `delegate.sh <project>`. Returns up to 3 project folder names, most referenced first
 * (others only if referenced at least twice and a third as often as the top one). Cached per file.
 */
export function projectsTouched(file, root, folders) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  const cached = touchCache.get(file);
  if (cached && ((cached.mtimeMs === st.mtimeMs && cached.size === st.size) || Date.now() - cached.at < 15000)) return cached.result;

  const home = os.homedir();
  const tilde = root.startsWith(home) ? `~${root.slice(home.length)}` : root;
  const patterns = folders.map((fo) => {
    const alts = [`${root}/${fo}`, `${tilde}/${fo}`, `--cwd ${fo}`, `delegate.sh ${fo}`, `cd ${fo}`].map(escapeRe).join('|');
    return [fo, new RegExp(`(?:${alts})(?![\\w.-])`, 'g')];
  });
  const counts = new Map();
  try {
    for (const e of readTranscript(file).entries) {
      if (e.k !== 'tool') continue;
      const blob = JSON.stringify(e.input);
      for (const [fo, re] of patterns) {
        const n = (blob.match(re) || []).length;
        if (n) counts.set(fo, (counts.get(fo) || 0) + n);
      }
    }
  } catch {
    return [];
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const top = ranked[0]?.[1] ?? 0;
  const result = ranked.filter(([, n], i) => i === 0 || (n >= 2 && n * 3 >= top)).slice(0, 3).map(([fo]) => fo);
  touchCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, at: Date.now(), result });
  return result;
}

// ---- skill / tool usage stats (derived from the transcript only: no hooks, no storage) ----

const statsCache = new Map(); // file -> {sig, stats}
const TOP_TOOLS = 8;

/** Sub-agent transcripts of a session: <session>/subagents/agent-*.jsonl, next to the session file. [] when none. */
function subagentFiles(file) {
  const dir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const res = [];
  for (const n of names.sort()) {
    if (!n.startsWith('agent-') || !n.endsWith('.jsonl')) continue; // skips *.meta.json, *.forked-skill*.json
    const f = path.join(dir, n);
    try { res.push({ file: f, st: fs.statSync(f) }); } catch { /* vanished between readdir and stat */ }
  }
  return res;
}

/**
 * Usage stats of one session, cached by the mtime+size of the main file AND of every sub-agent file (a change in
 * any of them recomputes). Counting rule: the totals include the sub-agents' activity (`<session>/subagents/*.jsonl`);
 * `fromSubagents` says how much of it came from them. `available` comes from the main file only. Shape:
 *   {sessionId, cwd, firstTs, lastTs, durationMs, toolCalls, topTools:[[name,n]], mcp:{server:{calls,tools:{tool:n}}},
 *    subagents, skills:{name:{count, slash, sub, first, last}}, available:[name]|null,
 *    fromSubagents:{files, toolCalls, skillCalls, mcpCalls}}
 * Skill use = a `Skill` tool_use (input.skill), or a typed `/name` slash command (main file only) whose name is in the
 * session's skill listing. `sub` = how many of `count` were made inside sub-agents. Timestamps (first/last, duration)
 * span the main file and the sub-agent files.
 */
export function sessionStats(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const subs = subagentFiles(file);
  const sig = [st, ...subs.map((x) => x.st)].map((x) => `${x.mtimeMs}:${x.size}`).join('|') + `#${subs.map((x) => x.file).join(',')}`;
  const cached = statsCache.get(file);
  if (cached && cached.sig === sig) return cached.stats;

  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const out = {
    sessionId: path.basename(file, '.jsonl'), cwd: null, firstTs: null, lastTs: null, durationMs: 0, toolCalls: 0, topTools: [], mcp: {}, subagents: 0, skills: {}, available: null,
    fromSubagents: { files: 0, toolCalls: 0, skillCalls: 0, mcpCalls: 0 },
  };
  const tools = new Map();
  const seen = new Set(); // tool_use ids: one call can be written in more than one record (also across files)
  const slash = []; // [name, ts], resolved after the loop when the whole skill listing is known
  const available = new Set();
  let listed = false;
  const skill = (name) => (out.skills[name] ??= { count: 0, slash: 0, sub: 0, first: null, last: null });
  const touch = (s, ts) => {
    if (!ts) return;
    if (!s.first || ts < s.first) s.first = ts;
    if (!s.last || ts > s.last) s.last = ts;
  };

  // sub = the text is a sub-agent file: every record is a sidechain record there, and its skill listing is not the session's
  const scan = (body, sub) => {
    for (const line of body.split('\n')) {
      // cheap prefilter: skip huge api-request blobs and other record types without parsing them
      if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"') && !(!sub && line.includes('skill_listing'))) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!isObj(r)) continue;
      const ts = typeof r.timestamp === 'string' && Number.isFinite(Date.parse(r.timestamp)) ? r.timestamp : null;
      if (!sub && r.type === 'attachment' && isObj(r.attachment) && r.attachment.type === 'skill_listing') {
        listed = true;
        const a = r.attachment;
        if (Array.isArray(a.names)) { for (const n of a.names) if (typeof n === 'string') available.add(n); }
        else if (typeof a.content === 'string') for (const m of a.content.matchAll(/^- ([^:\n]+):/gm)) available.add(m[1].trim());
        continue;
      }
      if ((r.type !== 'user' && r.type !== 'assistant') || (!sub && r.isSidechain)) continue;
      if (ts) {
        if (!out.firstTs || ts < out.firstTs) out.firstTs = ts;
        if (!out.lastTs || ts > out.lastTs) out.lastTs = ts;
      }
      if (!sub && !out.cwd && typeof r.cwd === 'string') out.cwd = r.cwd;
      const content = r.message?.content;
      if (r.type === 'user') {
        if (sub || r.isMeta) continue;
        const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => b.text) : [];
        for (const t of texts) {
          const name = tagContent(t, 'command-name');
          if (name && name.startsWith('/')) slash.push([name.slice(1), ts]);
        }
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (!isObj(b) || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
        if (typeof b.id === 'string') {
          if (seen.has(b.id)) continue;
          seen.add(b.id);
        }
        out.toolCalls++;
        if (sub) out.fromSubagents.toolCalls++;
        tools.set(b.name, (tools.get(b.name) || 0) + 1);
        if (b.name === 'Skill' && isObj(b.input) && typeof b.input.skill === 'string' && b.input.skill) {
          const s = skill(b.input.skill.replace(/^\//, ''));
          s.count++;
          if (sub) { s.sub++; out.fromSubagents.skillCalls++; }
          touch(s, ts);
        } else if (b.name === 'Agent' || b.name === 'Task') out.subagents++;
        else if (b.name.startsWith('mcp__')) {
          const [, server, ...rest] = b.name.split('__');
          const m = (out.mcp[server || '?'] ??= { calls: 0, tools: {} });
          const tool = rest.join('__') || '?';
          m.calls++;
          m.tools[tool] = (m.tools[tool] || 0) + 1;
          if (sub) out.fromSubagents.mcpCalls++;
        }
      }
    }
  };

  scan(text, false);
  for (const sf of subs) {
    let body;
    try { body = fs.readFileSync(sf.file, 'utf8'); } catch { continue; } // unreadable sub-agent file: skip it
    out.fromSubagents.files++;
    scan(body, true);
  }
  for (const [name, ts] of slash) {
    if (!available.has(name)) continue; // /model, /compact, /exit... are not skills
    const s = skill(name);
    s.count++;
    s.slash++;
    touch(s, ts);
  }
  if (listed) out.available = [...available].sort();
  out.topTools = [...tools].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_TOOLS);
  if (out.firstTs && out.lastTs) out.durationMs = Date.parse(out.lastTs) - Date.parse(out.firstTs);
  statsCache.set(file, { sig, stats: out });
  return out;
}

/**
 * Copy of cached `stats` for an API response. While the agent is running (state working and not the idle/stalled
 * status), the duration runs to `now` and `live` is true; otherwise it is the cached first-to-last-record span.
 */
export function liveStats(stats, agent, now = Date.now()) {
  const running = agent?.state === 'working' && agent.status !== 'idle';
  const first = stats.firstTs ? Date.parse(stats.firstTs) : NaN;
  if (!running || !Number.isFinite(first)) return { ...stats, live: false };
  return { ...stats, live: true, durationMs: Math.max(stats.durationMs, now - first) };
}

/** Every top-level session transcript under the projects dir: [{file, sessionId}] (sub-agent files excluded). */
export function allTranscripts() {
  const res = [];
  let dirs;
  try { dirs = fs.readdirSync(projectsDir()); } catch { return res; }
  for (const d of dirs) {
    let files;
    try { files = fs.readdirSync(path.join(projectsDir(), d)); } catch { continue; } // .DS_Store etc.
    for (const f of files) if (f.endsWith('.jsonl')) res.push({ file: path.join(projectsDir(), d, f), sessionId: f.slice(0, -6) });
  }
  return res;
}

function projectOf(cwd, root) {
  if (!cwd) return null;
  if (root && (cwd === root || cwd.startsWith(root + path.sep))) return cwd.slice(root.length + 1).split(path.sep)[0] || path.basename(root);
  return path.basename(cwd);
}

/**
 * All-time skill table over every session (optionally only sessions of one `project`: the first folder under
 * `root` the session's cwd is in, else the cwd's basename; `projects` lists all names seen).
 * Per skill: uses, sessions it fired in, sessions it was available in, last used. Skills that were available
 * but never used are included with uses 0. Pure function of the cached per-file stats.
 */
export function skillAggregate({ project = '', root = '' } = {}) {
  const skills = new Map();
  const row = (name) => {
    let s = skills.get(name);
    if (!s) skills.set(name, (s = { name, uses: 0, sessions: 0, availableIn: 0, lastUsed: null }));
    return s;
  };
  const projects = new Set();
  let sessions = 0;
  let withListing = 0;
  for (const { file } of allTranscripts()) {
    const s = sessionStats(file);
    if (!s) continue;
    const proj = projectOf(s.cwd, root);
    if (proj) projects.add(proj);
    if (project && proj !== project) continue;
    sessions++;
    if (s.available) { withListing++; for (const n of s.available) row(n).availableIn++; }
    for (const [n, u] of Object.entries(s.skills)) {
      const r = row(n);
      r.uses += u.count;
      r.sessions++;
      if (u.last && (!r.lastUsed || u.last > r.lastUsed)) r.lastUsed = u.last;
    }
  }
  const list = [...skills.values()].sort((a, b) => b.uses - a.uses || b.availableIn - a.availableIn || a.name.localeCompare(b.name));
  return { sessions, sessionsWithListing: withListing, projects: [...projects].sort(), rootProject: root ? path.basename(root) : '', skills: list };
}
