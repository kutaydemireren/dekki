#!/usr/bin/env bash
# Dry run of the scaffolded manager folder. A stub `claude` records the args and env that delegate.sh passes, so nothing
# real starts: no agent, no account, all in a temp dir and a temp HOME. Prints what it saw and exits non-zero on a failed check.
#
# Covers: new worker and --resume; an old root without .claude/harness.json (behaves as before); a configured root:
# the brief gets guardrails, the docs path and the check commands; the rendered deny rules deny `git push` to every
# protected branch and allow a named feature branch; delegate.sh --check passes and fails correctly; project-setup.sh;
# classify-change.sh on a tiny synthetic repo.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T=$(mktemp -d); mkdir -p "$T/bin" "$T/home" "$T/cfg/projects/p" "$T/docs"
trap 'rm -rf "$T"' EXIT
FAILS=0
fail() { echo "FAIL: $*"; FAILS=$((FAILS + 1)); }
ok() { echo "ok: $*"; }
expect() { # expect <description> <command...>: ok when the command succeeds
  local what="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$what"; else fail "$what"; fi
}
expect_not() { local what="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$what"; else ok "$what"; fi; }

node --input-type=module -e "
const {scaffold}=await import('$REPO/server/root.js');
console.log(JSON.stringify(scaffold('$T/root')));"
git init -q "$T/root/dekki-throwaway-proj"
cat > "$T/bin/claude" <<'S'
#!/bin/bash
if [ "$1" = agents ]; then exit 0; fi
if [ -n "${STUB_FAIL:-}" ]; then echo "$STUB_FAIL"; exit 1; fi
{ echo "PWD=$PWD"; echo "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-}"; echo "ARGS=$*"; } >> "$STUB_REC"
printf '%s\0' "$@" > "$STUB_ARGS"
echo "started 0123abcd"
S
chmod +x "$T/bin/claude"
export STUB_REC="$T/rec.txt" STUB_ARGS="$T/args.bin" HOME="$T/home" PATH="$T/bin:$PATH" CLAUDE_CONFIG_DIR="$T/cfg" CLAUDE_JOB_DIR="$T/jobs/deadbeef"
R="$T/root"; P=dekki-throwaway-proj
H="$REPO/templates/manager-root/.claude/scripts/harness.mjs"

# last argument claude received (the brief), and a deny-rule check through the same glob matcher the --check mode uses
brief() { node -e 'const a=require("fs").readFileSync(process.argv[1],"utf8").split("\0");a.pop();process.stdout.write(a[a.length-1])' "$STUB_ARGS"; }
denies() { # denies <settings.json> <command> -> exit 0 when a deny rule refuses it
  node --input-type=module -e "
import {denied} from '$H';
import fs from 'node:fs';
const rules=JSON.parse(fs.readFileSync(process.argv[1],'utf8')).permissions.deny;
process.exit(denied(rules, process.argv[2]) ? 0 : 1);" "$1" "$2"
}

echo "=== 1. old root: no harness.json, new worker and --resume"
"$R/.claude/scripts/delegate.sh" "$P" "trivial brief" --name x
touch "$T/cfg/projects/p/0123abcd-full-session.jsonl"
"$R/.claude/scripts/delegate.sh" --resume 0123abcd "$P" "follow up"
echo "--- recorded"
sed -E 's#--settings [^ ]+#--settings <DENY>#; s#(PWD|CLAUDE_CONFIG_DIR)=.*/(root|cfg)#\1=<tmp>/\2#; s/Report contract.*/<contract...>/' "$T/rec.txt" | cut -c1-230
echo "--- links.tsv"; cat "$T/home/.dekki/links.tsv"
echo "--- log"; cut -c1-120 "$R/.claude/delegations.log"
SET="$R/.claude/worker-settings.json"
for b in main master develop; do expect "old root: deny rules refuse git push to $b" denies "$SET" "git push -u origin $b"; done
expect_not "old root: a named feature branch is allowed" denies "$SET" "git push -u origin feature/login"
"$R/.claude/scripts/delegate.sh" "$P" "plain" >/dev/null
if [[ "$(brief)" == *"Harness rules"* ]]; then fail "old root: the brief has harness text"; else ok "old root: the brief has no harness text"; fi
expect "old root: --check passes with a note" "$R/.claude/scripts/delegate.sh" --check

echo "=== 2. configured root"
SECRETS="$T/secrets"; mkdir -p "$SECRETS"
node -e '
const [root, docs, secrets, proj] = process.argv.slice(1);
require("fs").writeFileSync(root + "/.claude/harness.json", JSON.stringify({
  version: 1, docsDir: docs, protectedBranches: ["main", "release/2.0"], neverTouch: "the production database", secretsDir: secrets,
  preferences: { replyStyle: "short", autonomy: "outward", prs: "me", language: "same" }, projects: {} }, null, 2));' "$R" "$T/docs" "$SECRETS" "$P"
expect "--check passes on the configured root" "$R/.claude/scripts/delegate.sh" --check "$P"
"$R/.claude/scripts/delegate.sh" --check "$P" | sed -n '1,8p' | cut -c1-160
echo "--- delegate before project setup: warns, does not block"
"$R/.claude/scripts/delegate.sh" "$P" "first brief" --name y 2>"$T/err.txt" >/dev/null
grep -q "has no settings" "$T/err.txt" && ok "warned that $P has no settings" || fail "no warning for a project without settings"
echo "--- project-setup.sh"
"$R/.claude/scripts/project-setup.sh" "$P" --build "make build" --lint "make lint" --test-scoped "make test FILES={files}" --test-full "make test" --sensitive '^db/' --ui '\.html$' --visual "a browser screenshot"
expect "project docs were created" test -f "$T/docs/$P/START-HERE.md" -a -f "$T/docs/$P/INBOX.md" -a -f "$T/docs/README.md"
expect_not "project-setup refuses an unknown folder" "$R/.claude/scripts/project-setup.sh" no-such-folder --build x
expect_not "project-setup refuses an unsafe name" "$R/.claude/scripts/project-setup.sh" '../x' --build x
echo "--- brief for a configured project"
"$R/.claude/scripts/delegate.sh" "$P" "second brief" --name z >/dev/null
B="$(brief)"
for needle in "Never touch: the production database" "never read" "Never push to main, release/2.0" "$T/docs/$P/" "START-HERE.md" "newest LOG.md entry" "- Build: make build" "- Lint: make lint" "- Full tests: make test" "Report contract"; do
  [[ "$B" == *"$needle"* ]] && ok "brief contains: $needle" || fail "brief is missing: $needle"
done
[[ "$(node -e 'const a=require("fs").readFileSync(process.argv[1],"utf8").split("\0");const i=a.indexOf("--add-dir");console.log(a[i+1])' "$STUB_ARGS")" == "$T/docs" ]] && ok "docs folder passed with --add-dir" || fail "--add-dir missing"
echo "--- deny rules rendered from the protected branches"
for b in main release/2.0; do
  for form in "git push origin $b" "git push -u origin $b" "git push origin HEAD:$b" "git push origin HEAD:refs/heads/$b" "git push origin +$b"; do expect "refused: $form" denies "$SET" "$form"; done
done
for form in "git push -u origin feature/login" "git push -u origin worktree-fix-docs" "git push -u origin develop"; do expect_not "allowed: $form" denies "$SET" "$form"; done
expect "refused: bare git push" denies "$SET" "git push"
expect "refused: force push" denies "$SET" "git push --force origin feature/x"
grep -q "Read(/$SECRETS" "$SET" && ok "secrets folder is not readable by a worker" || fail "no read rule for the secrets folder"

echo "=== 3. --check fails correctly"
cp "$R/.claude/harness.json" "$T/good.json"
echo '{ "version": 1, "docsDir": "relative" }' > "$R/.claude/harness.json"
expect_not "--check fails on a relative docsDir" "$R/.claude/scripts/delegate.sh" --check
echo 'not json' > "$R/.claude/harness.json"
expect_not "--check fails on broken JSON" "$R/.claude/scripts/delegate.sh" --check
expect_not "delegate.sh refuses to start with broken JSON" "$R/.claude/scripts/delegate.sh" "$P" "x"
cp "$T/good.json" "$R/.claude/harness.json"
expect "--check passes again with the good config" "$R/.claude/scripts/delegate.sh" --check

echo "=== 3b. trust errors, docs read line, .claude/ hint, playbook rules"
export STUB_FAIL="Workspace not trusted. Run claude in $R/$P once."
set +e; "$R/.claude/scripts/delegate.sh" "$P" "x docs read: yes" >"$T/out.txt" 2>"$T/err.txt"; rc=$?; set -e
(( rc != 0 )) && ok "project folder not trusted: delegate.sh exits non-zero" || fail "trust error did not fail delegate.sh"
[[ "$(grep -c 'not trusted yet' "$T/err.txt")" == 1 ]] && ok "one plain trust line" || fail "expected exactly one trust line"
grep -qF "cd \"$R/$P\" && CLAUDE_CONFIG_DIR=\"$T/cfg\" claude" "$T/err.txt" && ok "the line carries the exact project command" || fail "project command missing: $(cat "$T/err.txt")"
export STUB_FAIL="Error: Added folder not trusted: $T/docs"
set +e; "$R/.claude/scripts/delegate.sh" "$P" "x docs read: yes" >"$T/out.txt" 2>"$T/err.txt"; rc=$?; set -e
(( rc != 0 )) && grep -qF "The docs folder is not trusted yet." "$T/err.txt" && grep -qF "cd \"$T/docs\" &&" "$T/err.txt" && ok "docs folder not trusted: the line names the docs folder command" || fail "docs trust line wrong: $(cat "$T/err.txt")"
export STUB_FAIL="Error: something else"
set +e; "$R/.claude/scripts/delegate.sh" "$P" "x docs read: yes" >"$T/out.txt" 2>"$T/err.txt"; rc=$?; set -e
(( rc == 1 )) && grep -q "something else" "$T/err.txt" && ! grep -q "not trusted" "$T/err.txt" && ok "another failure is printed as it was" || fail "other failure mishandled"
export STUB_FAIL="Workspace not trusted. Run claude in $R/$P once."
set +e; "$R/.claude/scripts/delegate.sh" "$P" "no docs line" >"$T/out.txt" 2>"$T/err.txt"; set -e
[[ "$(wc -l < "$T/err.txt" | tr -d ' ')" == 1 ]] && ! grep -q "docs read" "$T/err.txt" && ok "trust failure prints only the trust line, not the docs-read warning" || fail "trust failure printed more than the trust line: $(cat "$T/err.txt")"
unset STUB_FAIL
"$R/.claude/scripts/delegate.sh" "$P" "no docs line" 2>"$T/err.txt" >/dev/null
grep -q 'does not say "docs read: yes"' "$T/err.txt" && ok "warned: brief without docs read: yes" || fail "no docs-read warning"
"$R/.claude/scripts/delegate.sh" "$P" "with docs read: yes" 2>"$T/err.txt" >/dev/null
grep -q 'docs read' "$T/err.txt" && fail "warned although the brief says docs read: yes" || ok "no warning with docs read: yes"
echo "--- docs size warning (manager stderr only; never blocks, never in the brief)"
D="$T/docs/$P"
head -c 30000 /dev/zero | tr '\0' 'x' > "$D/LOG.md"; head -c 25000 /dev/zero | tr '\0' 'x' > "$D/DECISIONS.md"; rm -f "$D/START-HERE.md"
set +e; "$R/.claude/scripts/delegate.sh" "$P" "size check docs read: yes" 2>"$T/err.txt" >/dev/null; rc=$?; set -e
(( rc == 0 )) && ok "over-cap docs do not block" || fail "over-cap docs blocked delegation"
grep -q "LOG.md is 29 KB, over its cap of about 25 KB.*housekeeping pass" "$T/err.txt" && ok "LOG over cap warns" || fail "no LOG warning: $(cat "$T/err.txt")"
grep -q "DECISIONS.md is 24 KB, over its cap of about 20 KB" "$T/err.txt" && ok "DECISIONS over cap warns" || fail "no DECISIONS warning"
grep -q "START-HERE.md" "$T/err.txt" && fail "warned about a missing START-HERE.md" || ok "missing file stays silent"
[[ "$(brief)" == *"housekeeping pass"* ]] && fail "warning leaked into the brief" || ok "warning is not in the brief"
[[ "$(brief)" == *"which docs you read"* ]] && ok "brief asks the report to name docs read" || fail "brief lacks the docs-read requirement"
head -c 1000 /dev/zero | tr '\0' 'x' > "$D/LOG.md"; head -c 1000 /dev/zero | tr '\0' 'x' > "$D/DECISIONS.md"; head -c 1000 /dev/zero | tr '\0' 'x' > "$D/START-HERE.md"
"$R/.claude/scripts/delegate.sh" "$P" "size check docs read: yes" 2>"$T/err.txt" >/dev/null
grep -q "over its cap" "$T/err.txt" && fail "warned for under-cap docs" || ok "under-cap docs stay silent"
echo "--- project-setup.sh hint about .claude/ (never edits the project)"
"$R/.claude/scripts/project-setup.sh" "$P" --build "make build" >"$T/ps.txt"
[[ "$(grep -c '^hint:' "$T/ps.txt")" == 1 ]] && ok "one hint when the project does not ignore .claude/" || fail "expected one hint"
[[ ! -e "$R/$P/.gitignore" ]] && ok "the project was not edited" || fail "project .gitignore was created"
echo '.claude/' > "$R/$P/.gitignore"
"$R/.claude/scripts/project-setup.sh" "$P" --lint "make lint" | grep -q '^hint:' && fail "hint although .claude/ is ignored" || ok "no hint when .claude/ is ignored"
rm "$R/$P/.gitignore"
echo "--- playbook"
PB="$R/CLAUDE.md"
[[ "$(head -c 2 "$PB")" == "> " ]] && grep -q "you are a worker, not the manager" "$PB" && ok "worker note at the top" || fail "worker note missing"
grep -q "Read the project's docs before you brief a worker (hard rule)" "$PB" && grep -q 'docs read: yes' "$PB" && ok "docs-read hard rule inline" || fail "docs-read rule missing"
grep -q "Added folder not trusted" "$PB" && grep -q "every project folder" "$PB" && ok "trust section names the folders" || fail "trust section incomplete"
grep -q 'amend its dated `LOG.md` entry with the checks that actually ran' "$PB" && grep -q 'amend the dated `LOG.md` entry with the checks that actually ran' "$R/.claude/skills/delegate/SKILL.md" && ok "playbook and SKILL: amend the LOG entry after the extra checks" || fail "LOG amend rule missing"
grep -q "Verification tier: 3" "$PB" && fail "playbook still presets tier 3 for features" || ok "no expected tier in the brief guidance"
echo "--- wizard apply lists worker-settings.json (setup.js, real template, throwaway folders)"
node --input-type=module -e "
const S = await import('$REPO/server/setup.js');
import fs from 'node:fs';
const root = '$T/wizroot', docs = '$T/wizdocs';
fs.mkdirSync(root + '/app/.git', { recursive: true }); fs.mkdirSync(docs);
const ctx = { state: { root, accounts: [], activeAccount: 'default' }, home: '$T/home', env: { ...process.env, DEKKI_TEMPLATE: '' } };
const a = S.applySetup({ docsDir: docs }, ctx), b = S.applySetup({ docsDir: docs }, ctx);
const WS = S.WORKER_SETTINGS_REL;
const bad = [];
if (!a.ok || !a.created.includes(WS)) bad.push('first apply does not create ' + WS);
if (!b.skipped.includes(WS) || b.created.includes(WS) || b.updated.includes(WS)) bad.push('re-apply does not skip ' + WS);
if (!a.trust || a.trust.dirs[0].kind !== 'docs' || a.trust.dirs[1].name !== 'app') bad.push('trust list wrong');
if (S.FILE_STATES.join() !== 'new,current,outdated,modified') bad.push('file states');
if (S.previewSetup({ docsDir: docs }, ctx).files.some((f) => f.state !== 'current')) bad.push('states after apply are not all current');
const WSP = S.previewSetup({ docsDir: docs }, ctx).files.find((f) => f.path === WS);
if (!WSP || WSP.state !== 'current') bad.push('preview does not list ' + WS + ' as current after apply');
// edited CLAUDE.md + a newer template: blocks refreshed, CLAUDE.md.new written, never listed as updated
const mdp = root + '/CLAUDE.md';
fs.writeFileSync(mdp, fs.readFileSync(mdp, 'utf8').replace('# ', '# My edit: '));
const man = JSON.parse(fs.readFileSync(root + '/.claude/harness.manifest.json', 'utf8'));
man.files['CLAUDE.md'] = 'stale-hash'; fs.writeFileSync(root + '/.claude/harness.manifest.json', JSON.stringify(man));
const c = S.applySetup({ docsDir: docs }, ctx);
if (!c.ok || !c.flagged.some((f) => f.path === 'CLAUDE.md') || c.updated.includes('CLAUDE.md')) bad.push('flagged CLAUDE.md listed wrongly');
if (!fs.existsSync(root + '/CLAUDE.md.new') || !fs.readFileSync(mdp, 'utf8').includes('My edit: ')) bad.push('CLAUDE.md.new missing or CLAUDE.md overwritten');
if (c.newPlaybook !== 'CLAUDE.md.new' || !c.newPlaybookNote.includes('saved as CLAUDE.md.new')) bad.push('result lacks the new-playbook note');
console.log(bad.length ? 'BAD ' + bad.join('; ') : 'OK');
process.exit(bad.length ? 1 : 0);" && ok "apply lists worker-settings.json (created, then skipped), trust list, file states, CLAUDE.md.new path" || fail "wizard apply check"

echo "=== 4. classify-change.sh on a synthetic repo"
git -C "$R/$P" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false commit -q --allow-empty -m base
printf 'x\n' > "$R/$P/notes.txt"
"$R/.claude/scripts/classify-change.sh" "$R/$P" | head -3
printf '{}\n' > "$R/$P/package.json"
"$R/.claude/scripts/classify-change.sh" "$R/$P" | head -3

echo
if (( FAILS )); then echo "dry run: $FAILS check(s) failed"; exit 1; fi
echo "dry run: all checks passed"
