#!/usr/bin/env bash
# Launch (or follow up with) a background Claude worker inside a project folder,
# so the project's own .mcp.json, skills, CLAUDE.md and settings.local.json load.
#
#   delegate.sh <project> "<brief>" [--name <slug>] [--effort <level>]
#   delegate.sh --resume <id> <project> "<follow-up>" [--effort <level>]   # only for a worker that has exited; a live one gets SendMessage
#       without --effort the SAME session continues (same id, its saved name, permission mode, deny rules and effort);
#       with --effort the CLI starts a COPY under a new id, which gets --permission-mode auto and the deny rules like a new worker
#   delegate.sh --check [<project>]    # validate .claude/harness.json, render the worker settings, print what a brief gets; starts nothing
#
# Workers start at medium effort whatever the manager session or settings.json say; ask for
# another level with --effort (low|medium|high|xhigh|max). CLAUDE_CODE_EFFORT_LEVEL in the environment still wins over the flag.
#
# Config: .claude/harness.json (written by the Dekki setup wizard and by project-setup.sh; read with node by harness.mjs).
# When it exists, every brief gets the guardrails, the project's docs path and its check commands appended, and the deny
# rules are rendered from its protected branches. When it does not exist (an old root) the script behaves as it always did.
set -euo pipefail

EFFORT=medium
# Doc size caps in bytes, matching the docs README (about 25 KB, 20 KB, 4 KB). Over a cap only warns the manager.
LOG_CAP=25600; DECISIONS_CAP=20480; START_HERE_CAP=4096
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="$ROOT/.claude/delegations.log"
HARNESS="$ROOT/.claude/scripts/harness.mjs"
# Deny rules every worker runs under (force push, pushes to the protected branches, bare `git push`).
# Passed with --settings, which was verified to hold under --permission-mode auto.
# Not a hard boundary: indirection (scripts, variables, gh api) can still get around it.
# It also wires the Stop hook check-report.sh (headline-block check for result: reports).
# worker-deny.json is a template: it holds __MANAGER_ROOT__ where the hook script lives and __BRANCH__ in the push rules
# that are repeated per protected branch. harness.mjs renders it per root into .claude/worker-settings.json (gitignored)
# and this script passes that file, so a root created anywhere works and nothing depends on an environment variable.
DENY="$ROOT/.claude/worker-settings.json"
[[ -f "$ROOT/.claude/scripts/worker-deny.json" ]] || { echo "Missing deny rules file: $ROOT/.claude/scripts/worker-deny.json" >&2; exit 1; }
[[ -f "$HARNESS" ]] || { echo "Missing helper: $HARNESS" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required (it reads .claude/harness.json) but was not found on PATH" >&2; exit 1; }
case "$ROOT" in *[\'\"\\\&]*) echo "Manager folder path must not contain quotes, ampersands or backslashes: $ROOT" >&2; exit 1 ;; esac

if [[ "${1:-}" == "--check" ]]; then
  [[ $# -le 2 ]] || { echo "usage: $0 --check [<project>]" >&2; exit 2; }
  exec node "$HARNESS" check "$ROOT" ${2:+"${2%/}"}
fi

CONTRACT='

---
Report contract: you are a worker run by a manager session; the user will not read your terminal. When finished, verify as the Verification paragraph below says, then end with exactly one of three forms: (1) a result: report in the shape below, (2) needs input: <exactly what you need>, or (3) failed: <reason>.
Shape of a result: report:
result: <one-line headline>
Act: <what the manager or user must decide or do, or "none">
Deviations: <from the brief, or "none">
Not run: <checks skipped and why, or "none">
Where: <branch/commit/PR/path>
skills used: <names, or none; if a project skill clearly applied and you did not use it, say why>
---
<details: evidence, file lists, test output, paths. No length cap. Give an artifact for each claim you make (test output, screenshot path, commit).>
Everything the manager must act on goes above the --- line, which is on its own line. The part above it is the headline block, about 100 words; a Stop hook checks it once and asks you to shorten it if it is over 130 words or has no --- line. needs input: and failed: reports are never shortened or checked.
Voice (no skill call needed): answer first; no greeting, recap, closer or filler. Drop articles only when the sentence still reads in one pass; never drop not, never, no, only or except. Code, commands, paths, numbers and error text stay exact. No text between routine tool calls, except a one-line status at a phase change. Security warnings, irreversible actions and anything ambiguous get full plain sentences. Text a human keeps (PR descriptions, docs, commit messages, user-facing copy) is plain prose, not clipped shorthand.
Before you commit or hand over text a human keeps, check for the unslop scanner at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/unslop/scripts/banned_phrase_scan.py". If that file exists, run it over the text: python3 -I <scanner> < <file> (or pipe the text in; exit 1 means hits). Fix only hits that are real filler or AI phrasing: a match alone does not authorise an edit, and facts, numbers, names, code and negations stay exact. No hits means do nothing more. If the file does not exist, skip this step silently.
Secrets: never read or print the contents of secret or credential files (.env files, key files, token files, anything the guardrails above name): no cat, no Read, no head, grep or sed of them, and never put a secret value in a command line, log, screenshot, report or commit. To use one, load it inside the command that needs it (for example: set -a; . <file>; set +a; then the command using the variable) and make sure nothing echoes it. If a secret value shows up anyway (tool output, log, screenshot), say so at once in your report: which secret, where it appeared, and that it needs rotating. Never hide an exposure.
Verification: the user, who owns this session, set a tiered verification policy for this work (tiers 0 to 3, decided from the diff by a script the manager runs). For tiers 0 to 2 it replaces generic wording in the project'"'"'s own rules such as "always run the entire suite". Until the manager sends you a tier, verify with the floor only: the build and lint commands from the checks above (when none are given: one build of the affected part and lint on the touched files). Do not run the full test suite on your own. Report the git diff and the build and lint result; the manager classifies the diff and tells you any extra checks (scoped tests, the full suite, visual proof). If the brief presets a tier ("Verification tier: N"), follow that tier right away; at tier 3 the project'"'"'s verification rules apply in full. Run an extra check beforehand only when a failure needs it to diagnose. This paragraph covers code changes you make. It does not apply to review or verification tasks, where the task itself says what to run.
Project rules: follow this project'"'"'s CLAUDE.md. Claude Code does not load AGENTS.md or .cursor/rules/*.mdc on its own, so if either exists, read it before you start and follow it too. If those rules tell you to ask the user (AskUserQuestion or a question in text, e.g. an interview or a branch choice), do not ask: end with needs input: and the exact question; the manager asks the user and replies. Where the project'"'"'s rules are stricter than this contract, the project wins, except for how much to verify: the Verification paragraph decides that. Never touch live/production systems, accounts or release tooling; never push to a protected branch or force-push. When you push, always name the branch (git push -u origin <branch>): bare git push and git push origin HEAD are refused by your deny rules.'

# Tell Dekki which manager started this worker, so it can nest the worker under the manager.
# $1 = `claude --bg` output (contains the new agent id). The manager's own id is the name of its job dir,
# which only exists inside a background agent: anywhere else nothing is recorded. Never fails the delegation.
#
# The new worker's id is the one on the "claude attach <id>" line. A --resume output can mention the old
# session id first, so "first 8-hex token" linked resumed workers as their predecessors.
new_id() {
  local id
  id="$(sed -nE 's/^ *claude attach ([0-9a-f]{8})( .*)?$/\1/p' <<<"$1" | head -1)"
  [[ -n "$id" ]] || id="$(grep -oE '\b[0-9a-f]{8}\b' <<<"$1" | head -1 || true)"
  printf '%s' "$id"
}

link() {
  local w m
  w="$(new_id "$1")"
  m="$(basename "${CLAUDE_JOB_DIR:-}")"
  [[ -n "$w" && "$m" =~ ^[0-9a-f]{8}$ ]] || return 0
  mkdir -p "$HOME/.dekki" && printf '%s\t%s\t%s\n' "$w" "$m" "$(date -u +%FT%TZ)" >> "$HOME/.dekki/links.tsv"
}

# $1 = a path. Printed inside double quotes for a shell line: backslash, quote, dollar and backtick are escaped.
dq() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//\$/\\\$}"; s="${s//\`/\\\`}"
  printf '"%s"' "$s"
}

# $1 = what `claude --bg` printed when it failed, $2 = project folder, $3 = docs folder (empty when none was passed).
# `claude --bg` refuses a folder the user has not trusted once ("Added folder not trusted: <path>" for --add-dir,
# "Workspace not trusted. Run claude in <path> once" for the project). Print one plain line with the exact command and
# exit non-zero: the manager asks the user once and runs the same call again. Any other failure: print it and exit 1.
claude_failed() {
  local out="$1" dir="$2" docs="${3:-}" target="" what="" env=""
  if [[ -n "$docs" ]] && grep -qi 'added folder not trusted' <<<"$out"; then target="$docs"; what="The docs folder is not trusted yet."
  elif grep -qi 'not trusted' <<<"$out"; then target="$dir"; what="The project folder is not trusted yet."
  fi
  if [[ -n "$target" ]]; then
    [[ -z "${CLAUDE_CONFIG_DIR:-}" ]] || env=" CLAUDE_CONFIG_DIR=$(dq "$CLAUDE_CONFIG_DIR")"
    echo "$what Run this once in a terminal, accept the trust prompt, type /exit, then run delegate.sh again: cd $(dq "$target") &&$env claude" >&2
    exit 1
  fi
  [[ -z "${DOCS_WARN:-}" ]] || echo "$DOCS_WARN" >&2
  echo "$out" >&2
  exit 1
}

usage() { echo "usage: $0 <project> \"<brief>\" [--name <slug>] [--effort <level>] | $0 --resume <id> <project> \"<follow-up>\" [--effort <level>] | $0 --check [<project>]" >&2; exit 2; }

# $1 = level. Exits on an unknown level; warns when the environment would override the flag.
check_effort() {
  case "$1" in low|medium|high|xhigh|max) ;; *) echo "Unknown effort level: $1 (low|medium|high|xhigh|max)" >&2; exit 2 ;; esac
  [[ -z "${CLAUDE_CODE_EFFORT_LEVEL:-}" ]] || echo "warning: CLAUDE_CODE_EFFORT_LEVEL=$CLAUDE_CODE_EFFORT_LEVEL is set and overrides --effort" >&2
}

# $1 = project folder name. A plain folder name directly under the manager folder: no slashes, no leading dot or dash, no "..".
check_project_name() {
  case "$1" in
    ""|.*|-*|*/*|*..*|*[!A-Za-z0-9_.\ -]*) echo "Not a usable project folder name: $1" >&2; exit 1 ;;
  esac
}

# Render the worker settings from the template and .claude/harness.json (or the defaults when there is none).
render_settings() { node "$HARNESS" render "$ROOT" || exit 1; }

if [[ "${1:-}" == "--resume" ]]; then
  # Only for a worker that has exited, always from inside its project folder.
  # Verified with the CLI: `claude --bg --resume <full id>` with NO flags wakes that same session with its saved options
  # (name, permission mode, --settings deny rules, effort, model). Any flag (--effort here) makes the CLI start a COPY under
  # a new id that keeps only the flags passed now, and a still-running session is copied too. A copy is therefore given
  # --permission-mode auto and --settings like a new worker, and is linked under its own new id.
  [[ $# -ge 4 ]] || usage
  id="$2"; project="${3%/}"; msg="$4"; shift 4
  copy_effort=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --effort) copy_effort="${2:?--effort needs a value}"; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ -z "$copy_effort" ]] || check_effort "$copy_effort"
  check_project_name "$project"
  dir="$ROOT/$project"
  [[ -d "$dir" ]] || { echo "No such project folder: $dir" >&2; exit 1; }
  if claude agents --json 2>/dev/null | grep -q "\"id\": \"$id\""; then
    echo "Worker $id is still alive: send the follow-up with SendMessage (notify_when_idle: true) instead of --resume." >&2; exit 1
  fi
  # a short id forks a copy; the full session id continues the same session
  # transcripts live under ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects
  full="$(basename "$(ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$id"-*.jsonl 2>/dev/null | head -1)" .jsonl)"
  [[ -n "$full" ]] || { echo "No transcript found for $id" >&2; exit 1; }
  if [[ -n "$copy_effort" ]]; then
    echo "note: --effort starts a COPY of $id with effort $copy_effort (new id, not the same session). Drop --effort to continue $id itself with its saved options." >&2
    render_settings
    cd "$dir"
    out="$(claude --bg --effort "$copy_effort" --settings "$DENY" --permission-mode auto --resume "$full" "$msg" 2>&1)" || claude_failed "$out" "$dir" ""
  else
    cd "$dir"
    out="$(claude --bg --resume "$full" "$msg" 2>&1)" || claude_failed "$out" "$dir" ""
  fi
  echo "$out"
  # Link only an id the CLI actually started: the same session is linked already, a copy is new.
  nid="$(new_id "$out")"
  if [[ -n "$nid" && "$nid" != "$id" ]]; then link "$out" || true; fi
  printf '%s\tresume\t%s\t%s\n' "$(date -u +%FT%TZ)" "$id" "$msg" >> "$LOG"
  exit 0
fi

[[ $# -ge 2 ]] || usage
project="${1%/}"; brief="$2"; shift 2
slug=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) slug="${2:?--name needs a value}"; shift 2 ;;
    --effort) EFFORT="${2:?--effort needs a value}"; shift 2 ;;
    *) usage ;;
  esac
done
check_effort "$EFFORT"
check_project_name "$project"

dir="$ROOT/$project"
if [[ ! -d "$dir" ]]; then echo "No such project folder: $dir" >&2; exit 1; fi
if [[ ! -e "$dir/.git" && ! -f "$dir/CLAUDE.md" ]]; then
  echo "$project is not a repo or Claude project; work in place instead of delegating." >&2; exit 1
fi

[[ -n "$slug" ]] || slug="$(date +%H%M%S)"
name="$project-$slug"

render_settings
# Guardrails, docs path and check commands for this project (empty without .claude/harness.json). Warns on stderr when the
# project has no settings yet: the manager then runs the first-time project setup (project-setup.sh).
extra="$(node "$HARNESS" brief "$ROOT" "$project")" || exit 1
# The docs folder is outside the project, so the worker needs access to it. --add-dir is variadic: keep it before another flag.
docs="$(node "$HARNESS" docs-dir "$ROOT")" || exit 1

# The manager reads the project's START-HERE.md and newest LOG.md entry before it briefs a worker, and says so in the brief.
if [[ -n "$docs" ]] && ! grep -qiE 'docs read: *yes' <<<"$brief"; then
  # held back: a trust failure prints only the trust line (the manager re-runs the same call after the user trusts the folder)
  DOCS_WARN="warning: the brief does not say \"docs read: yes\". Read $docs/$project/START-HERE.md and the newest LOG.md entry first, then add that line to the brief."
fi

# Warn the manager (never the worker brief: parallel workers would all compress the same file) when a doc is over its cap.
if [[ -n "$docs" ]]; then
  for pair in "LOG.md:$LOG_CAP" "DECISIONS.md:$DECISIONS_CAP" "START-HERE.md:$START_HERE_CAP"; do
    f="$docs/$project/${pair%%:*}"; cap="${pair##*:}"
    [[ -f "$f" ]] || continue
    size="$(wc -c < "$f" | tr -d ' ')"
    if [[ "$size" =~ ^[0-9]+$ ]] && (( size > cap )); then
      echo "warning: $f is $((size / 1024)) KB, over its cap of about $((cap / 1024)) KB. Ask a worker to do the housekeeping pass described in $docs/README.md." >&2
    fi
  done
fi

cd "$dir"
if [[ -n "$docs" ]]; then
  out="$(claude --bg --add-dir "$docs" --name "$name" --effort "$EFFORT" --settings "$DENY" --permission-mode auto "$brief$extra$CONTRACT" 2>&1)" || claude_failed "$out" "$dir" "$docs"
else
  out="$(claude --bg --name "$name" --effort "$EFFORT" --settings "$DENY" --permission-mode auto "$brief$extra$CONTRACT" 2>&1)" || claude_failed "$out" "$dir" ""
fi
[[ -z "${DOCS_WARN:-}" ]] || echo "$DOCS_WARN" >&2
echo "$out"
link "$out" || true
printf '%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$name" "$project" "$brief" >> "$LOG"
# Remind the manager: a turn that ends with no wake-up pending is never resumed when the worker finishes.
wid="$(new_id "$out")"
[[ -z "$wid" ]] || echo "NEXT: before ending your turn, start the wait (run_in_background): .claude/scripts/wait-worker.sh $wid" >&2
