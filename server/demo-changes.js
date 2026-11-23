// Demo fixtures for the Changes tab (DEKKI_DEMO=1): fake changed files per demo agent, as raw unified diffs run through
// the real parser in changes.js. No git, no real paths. Agents without a fixture have "no git worktree" (calm empty state).
import { parseUnifiedDiff, capHunks, MAX_DIFF_LINES } from './changes.js';

const hunk = (head, lines) => `${head}\n${lines.join('\n')}\n`;

const SESSION_TS = hunk('@@ -38,9 +38,12 @@ import { verify } from "./token";', [
  ' export async function handleSession(req: Request) {',
  '   const token = req.cookies.get("sid");',
  '-  return verify(token, { maxAge: 900 });',
  '+  const maxAge = sessionMaxAge();',
  '+  const session = await verify(token, { maxAge });',
  '+  if (session && session.expiresIn < REFRESH_WINDOW) {',
  '+    session.refresh = true;',
  '+  }',
  '+  return session;',
  ' }',
  ' ',
  ' export function clearSession(res: Response) {',
]) + hunk('@@ -71,4 +74,4 @@ export function clearSession(res: Response) {', [
  '   res.cookies.delete("sid");',
  '-  res.cookies.delete("sid_legacy");',
  '+  res.cookies.delete("sid", { path: "/" });',
  ' }',
  ' ',
]);

const SESSION_TEST = hunk('@@ -9,6 +9,18 @@ describe("handleSession", () => {', [
  '   it("accepts a fresh token", async () => {',
  '     expect(await handleSession(reqWith(fresh()))).toBeTruthy();',
  '   });',
  '+',
  '+  it("uses SESSION_MAX_AGE when set", async () => {',
  '+    process.env.SESSION_MAX_AGE = "7200";',
  '+    expect(sessionMaxAge()).toBe(7200);',
  '+  });',
  '+',
  '+  it("falls back to one hour", () => {',
  '+    delete process.env.SESSION_MAX_AGE;',
  '+    expect(sessionMaxAge()).toBe(3600);',
  '+  });',
  ' ',
  '   it("rejects an expired token", async () => {',
  '     expect(await handleSession(reqWith(expired()))).toBeNull();',
]);

const DEFAULTS_TS = ['// Session defaults, read once at start-up.', 'export const REFRESH_WINDOW = 300; // seconds', '', 'export function sessionMaxAge(): number {', '  const n = Number(process.env.SESSION_MAX_AGE);', '  return Number.isFinite(n) && n > 0 ? n : 3600;', '}'];

const LEGACY = ['// Reads the pre-2024 cookie format. Nothing calls this any more.', 'export function readLegacyCookie(raw: string) {', '  const [id, sig] = raw.split(".");', '  return { id, sig };', '}'];

const REFRESH = hunk('@@ -3,7 +3,7 @@ import { sessionMaxAge } from "../config/session-defaults";', [
  ' ',
  ' export async function refreshToken(old: string) {',
  '-  const next = await issue(old, { maxAge: 900 });',
  '+  const next = await issue(old, { maxAge: sessionMaxAge() });',
  '   return next;',
  ' }',
  ' ',
]);

const SEARCH_INDEX = hunk('@@ -20,8 +20,10 @@ func Build(docs []Doc) *Index {', [
  '   idx := &Index{terms: map[string][]int{}}',
  '   for i, d := range docs {',
  '-    for _, t := range strings.Fields(d.Text) {',
  '+    for _, t := range tokenize(d.Text) {',
  '       idx.terms[t] = append(idx.terms[t], i)',
  '     }',
  '   }',
  '+  idx.sortPostings()',
  '   return idx',
  ' }',
]);

const SEARCH_TEST = hunk('@@ -5,3 +5,6 @@ func TestBuild(t *testing.T) {', [
  '   idx := Build(sampleDocs())',
  '   if len(idx.terms) == 0 {',
  '     t.Fatal("empty index")',
  '+  }',
  '+  if !sort.IntsAreSorted(idx.terms["login"]) {',
  '+    t.Fatal("postings must be sorted")',
  '   }',
]);

const bigGolden = Array.from({ length: 3400 }, (_, i) => `  { "id": "ord_${String(i).padStart(5, '0')}", "amount": ${(i * 37) % 9000 + 100}, "currency": "EUR", "status": "${i % 7 === 0 ? 'refunded' : 'paid'}" },`);
const BIG_ADDED = [`@@ -0,0 +1,${bigGolden.length} @@`, ...bigGolden.map((l) => `+${l}`)].join('\n') + '\n';

const added = (lines) => `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
const f = (path, status, diff, extra = {}) => ({ path, status, diff, wip: false, ...extra });

// wip = still uncommitted (shown in the "Uncommitted only" scope)
const FIXTURES = {
  c2d3e4f5: [
    f('src/auth/session.ts', 'modified', SESSION_TS),
    f('src/auth/session.test.ts', 'modified', SESSION_TEST, { wip: true }),
    f('src/config/session-defaults.ts', 'added', added(DEFAULTS_TS), { wip: true, untracked: true }),
    f('src/auth/legacy-cookie.ts', 'deleted', `@@ -1,${LEGACY.length} +0,0 @@\n${LEGACY.map((l) => `-${l}`).join('\n')}\n`),
    f('src/auth/refresh.ts', 'renamed', REFRESH, { oldPath: 'src/auth/refresh-token.ts', wip: true }),
    f('public/img/login-hero.png', 'modified', 'Binary files a/public/img/login-hero.png and b/public/img/login-hero.png differ\n'),
  ],
  // a large generated file: the diff is cut at MAX_DIFF_LINES with a visible marker
  d3e4f5a6: [
    f('internal/search/index.go', 'modified', SEARCH_INDEX),
    f('internal/search/index_test.go', 'modified', SEARCH_TEST, { wip: true }),
    f('internal/search/testdata/corpus.golden.json', 'added', BIG_ADDED, { untracked: true, wip: true }),
  ],
  e4f5a6b7: [], // a worktree with nothing changed
  // two workers of the demo manager ship-checkout-v2 (a1b2c3d4); its other workers have nothing to show
  b1000001: [
    f('src/payments/charge.ts', 'modified', SESSION_TS),
    f('src/payments/charge.test.ts', 'modified', SESSION_TEST, { wip: true }),
    f('src/payments/idempotency.ts', 'added', added(DEFAULTS_TS), { untracked: true, wip: true }),
  ],
  b1000003: [
    f('src/checkout/Form.tsx', 'modified', REFRESH),
    f('src/checkout/flags.ts', 'added', added(DEFAULTS_TS)),
  ],
};

function entry(fx) {
  const parsed = parseUnifiedDiff(fx.diff);
  let add = 0; let del = 0;
  for (const h of parsed.hunks) for (const l of h.lines) { if (l.t === 'add') add++; else if (l.t === 'del') del++; }
  return { parsed, add, del, binary: parsed.binary };
}

/** Same shape as listChanges(). `spec` = a demo agent spec ({ id, branch }) or null (no git worktree). */
export function demoChanges(spec, scope = 'all') {
  const fixtures = spec && FIXTURES[spec.id];
  if (!fixtures) return { status: 'none', reason: 'not-git' };
  const files = fixtures.filter((x) => scope === 'all' || x.wip).map((x) => {
    const e = entry(x);
    return { path: x.path, oldPath: x.oldPath || null, status: x.status, add: e.add, del: e.del, binary: e.binary, untracked: Boolean(x.untracked), mtime: 1 };
  }).sort((a, b) => a.path.localeCompare(b.path));
  return {
    status: 'ok', branch: spec.branch || 'main', base: scope === 'all' ? { name: 'develop', sha: '0'.repeat(40) } : null, note: null, scope, files,
    totals: { files: files.length, add: files.reduce((s, x) => s + x.add, 0), del: files.reduce((s, x) => s + x.del, 0) }, truncatedFiles: false, head: { sha: '3f9c2ab', subject: 'WIP' },
  };
}

/** Manager view in demo mode, same shape as listGroupChanges(). `specs` = demo specs of the workers; no worktree or no changes: left out. */
export function demoGroupChanges(specs, scope = 'all') {
  const groups = [];
  for (const spec of specs) {
    const r = demoChanges(spec, scope);
    if (r.status !== 'ok' || !r.files.length) continue;
    groups.push({ id: spec.id, name: spec.name, role: 'worker', branch: r.branch, base: r.base, totals: r.totals, files: r.files, truncatedFiles: false });
  }
  return { status: 'ok', scope, groups };
}

/** Same shape as fileDiff(). */
export function demoChangeFile(spec, relPath, scope = 'all') {
  const fx = ((spec && FIXTURES[spec.id]) || []).find((x) => x.path === relPath && (scope === 'all' || x.wip));
  if (!fx) return { status: 'unchanged' };
  const e = entry(fx);
  const meta = { path: fx.path, oldPath: fx.oldPath || null, fileStatus: fx.status, add: e.add, del: e.del };
  if (e.binary) return { status: 'ok', ...meta, binary: true, hunks: [], truncated: null };
  return { status: 'ok', ...meta, binary: false, ...capHunks(e.parsed.hunks, MAX_DIFF_LINES) };
}
