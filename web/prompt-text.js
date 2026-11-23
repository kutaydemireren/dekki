// Pure text helpers for saved prompts (also imported by the server tests).

// {{name}} or {{name|default value}}
const PLACEHOLDER = /\{\{\s*([^{}|]+?)\s*(?:\|([^{}]*))?\}\}/g;

/** The prompt text without a leading YAML frontmatter block (Obsidian adds those). */
export function stripFrontmatter(text) {
  return text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '').replace(/^\s*\n/, '');
}

/** Unique placeholders in order of first appearance: [{name, def}], def = the first non-empty default given, else undefined. */
export function fieldsOf(text) {
  const out = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    const def = m[2] === undefined || !m[2].trim() ? undefined : m[2].trim();
    const f = out.find((x) => x.name === m[1]);
    if (!f) out.push({ name: m[1], def });
    else if (f.def === undefined && def !== undefined) f.def = def;
  }
  return out;
}

export const placeholdersOf = (text) => fieldsOf(text).map((f) => f.name);

/**
 * Replace each placeholder with values[name]. Not given (undefined) -> its default, else the placeholder as written.
 * Given but empty -> empty text when the placeholder has a default (the user cleared it), else the placeholder as written.
 */
export function fill(text, values = {}) {
  const defs = Object.fromEntries(fieldsOf(text).map((f) => [f.name, f.def]));
  return text.replace(PLACEHOLDER, (whole, name) => {
    const v = values[name];
    const def = defs[name];
    if (v === undefined) return def !== undefined ? def : whole;
    if (v === '') return def !== undefined ? '' : whole;
    return v;
  });
}

/** What Insert and Copy use: frontmatter removed, trailing whitespace trimmed, placeholders filled. */
export function render(text, values) {
  return fill(stripFrontmatter(text), values).replace(/\s+$/, '');
}

/**
 * Chunks to type into Claude's input box (through the terminal's input, NOT a bracketed paste: Claude collapses a
 * long or multi-line paste into an uneditable "[Pasted text #1 +N lines]"). Each line break is ESC+CR (Alt+Enter),
 * which Claude treats as "newline, don't submit"; a plain CR would submit. One chunk per line so ESC and CR always
 * reach the pty together. A Tab character is typed as the Tab key by Claude (garbles the line), so it becomes 4 spaces;
 * other control characters are dropped. Never ends with a submit.
 */
export function toTerminalInput(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '').split('\n');
  return lines.map((l, i) => (i < lines.length - 1 ? l + '\x1b\r' : l)).filter(Boolean);
}
