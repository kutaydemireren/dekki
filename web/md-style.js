// Pure helpers for styling Claude's markdown answers in History (also imported by the server tests).

const EXTS = 'swift|kt|kts|java|js|jsx|mjs|ts|tsx|json|md|yml|yaml|sh|py|gradle|plist|xcodeproj|xcworkspace|storyboard|xib|strings|tf|html|css|sql|txt|toml|xml|rb|m|h';
// optional :84 / :84-87 / :84:12 / #L12 / #L12-L20 suffix
const SUFFIX = '(?::\\d+(?:[-:]\\d+)?|#L\\d+(?:-L?\\d+)?)?';
const EXT_RE = new RegExp(`\\.(?:${EXTS})${SUFFIX}$`, 'i');
const PATHISH = /^[\w@~.\-+/…]+(?::\d+(?:[-:]\d+)?|#L\d+(?:-L?\d+)?)?$/; // no spaces, no ()[]{}

/** Does this inline text look like a file or folder path? Conservative: `startOver()` and `Foo.bar` are not. */
export function isPathLike(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!t || t.length > 200 || /\s/.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false;
  if (!PATHISH.test(t)) return false;
  const bare = t.replace(new RegExp(SUFFIX + '$'), '');
  if (/^\d+$/.test(bare) || /^[/.]+$/.test(bare)) return false;
  if (EXT_RE.test(t)) return true;
  return bare.includes('/') && /[A-Za-z]/.test(bare) && bare.replace(/\/+$/, '').length > 1 && !/\/\/|^\/{2}/.test(bare);
}

const STATUS = [
  [/^(result)\s*:/i, 'ok'],
  [/^(needs input)\s*:/i, 'ask'],
  [/^(failed)\s*:/i, 'fail'],
  [/^(warning)\s*:/i, 'warn'],
];

const CALLOUT_LABEL = { ok: 'Result', ask: 'Needs input', fail: 'Failed' };

/** A message that opens with `result:` / `needs input:` / `failed:` (plain or in a leading **bold**) becomes a
 *  callout: { kind, label, body, rest } where body is the first paragraph without the marker word and rest is
 *  everything after the first blank line. `warning:` is not a callout. Null otherwise. */
export function calloutOf(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/^\s+/, '');
  const m = /^(\*\*|__)?([A-Za-z ]+?)\s*:(\*\*|__)?/.exec(t);
  if (!m) return null;
  const st = statusOf(`${m[2]}:`);
  if (!st || !CALLOUT_LABEL[st.kind]) return null;
  const afterWord = t.slice(m[0].length);
  const cut = afterWord.search(/\n\s*\n/);
  const body = (cut === -1 ? afterWord : afterWord.slice(0, cut)).trim();
  const rest = cut === -1 ? '' : afterWord.slice(cut).trim();
  return { kind: st.kind, label: CALLOUT_LABEL[st.kind], body, rest };
}

/** Leading status marker of a paragraph/list item: { kind, word, rest } (word includes the colon) or null. */
export function statusOf(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/^\s+/, '');
  for (const [re, kind] of STATUS) {
    const m = re.exec(t);
    if (m) return { kind, word: t.slice(0, m[0].length), rest: t.slice(m[0].length) };
  }
  return null;
}
