#!/usr/bin/env bash
# Deterministic criticality tier for a change. Decides how much verification it needs, so neither
# the manager nor a worker improvises (and no repo-wide "always run everything" rule decides alone).
# Pure git + pattern counts: same diff in, same tier out. Language-neutral.
#
#   classify-change.sh <project-dir>              # uncommitted work (tracked changes + new files) vs HEAD
#   classify-change.sh <project-dir> <rev>        # one commit (rev^..rev)
#   classify-change.sh <project-dir> <a..b>       # a range, e.g. origin/main..HEAD
#   add  --project <folder>  when <project-dir> is not under that folder of the manager folder (a worktree elsewhere)
#
# First output line is machine-readable: TIER=<0-3> UI=<yes|no> VISUAL=<required|no>
# Then one line per reason, then the verification recipe (with the project's own commands when they are saved).
#
# Project settings come from .claude/harness.json (projects.<folder>): sensitivePaths and uiPaths are extended regexes
# (grep -E) matched against changed file paths. A small built-in set is always sensitive: dependency manifests and
# lockfiles, CI and container config, and auth/payment/migration-like names. Thresholds are defaults: tune them in the
# variables below, and check changes to them against past commits first (classify-change.sh <repo> <rev>).
set -euo pipefail

MAX_T1_ADDED=10        # T1: at most this many added code lines ...
T1_DELETE_RATIO=2      # ... and deletions at least this many times the additions (mostly removal)
MAX_T2_ADDED=150       # above this many added code lines the change counts as large (T3)
MAX_T2_FILES=12        # same, by number of code files

# Built-in sensitive files: dependency manifests, lockfiles, CI, container and build config, infrastructure files.
SENSITIVE_FILES='(^|/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Gemfile(\.lock)?|requirements[^/]*\.txt|Pipfile(\.lock)?|pyproject\.toml|poetry\.lock|uv\.lock|go\.(mod|sum)|Cargo\.(toml|lock)|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|Makefile|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|\.gitlab-ci\.yml|Jenkinsfile|azure-pipelines\.ya?ml|bitbucket-pipelines\.yml|[^/]*\.tfvars?|[^/]*\.tf)$|(^|/)(\.github|\.circleci|\.buildkite)/'
# Built-in risk areas: a directory or file name that is exactly one of these words. Matched in production code only
# (not tests or generated files), ignoring case.
SENSITIVE_AREAS='(^|/)(auth|authn|authz|authentication|authorization|oauth|login|credentials?|secrets?|tokens?|payments?|billing|checkout|migrations?|security|crypto|encryption|deploy|release|infra|infrastructure)(/|\.[^/]*$|$)'
NONCODE='\.(md|mdx|txt|rst|png|jpe?g|gif|svg|ico|pdf|gitignore)$'
TESTFILE='(^|/)(tests?|__tests__|specs?|e2e|fixtures?)(/|$)|(^|/)test_[^/]*|[._-](tests?|spec)\.[^/]+$|_test\.[^/]+$'
GENERATED='\.generated\.|\.min\.(js|css)$'
# Added lines that introduce logic or state: new declarations, control flow, async, imports and exports, queries.
RISKY='(^|[^[:alnum:]_])(function|def|class|struct|enum|interface|trait|impl|fn|func|fun|const|let|var|val|if|else|elif|for|while|switch|case|match|try|catch|except|finally|await|async|return|throw|raise|import|require|export|SELECT|INSERT|UPDATE|DELETE)([^[:alnum:]_]|$)|=>|&&|\|\|'
# In a UI file: an added string literal, markup tag, style declaration or chained call.
UIADDED='"[^"]+"|'"'"'[^'"'"']+'"'"'|<[A-Za-z]|^[[:space:]]*[A-Za-z-]+[[:space:]]*:[[:space:]]*[^[:space:]]|\.[A-Za-z_]+\('
COMMENT='^[[:space:]]*(//|/\*|\*|#|--|<!--)'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
usage() { echo "usage: $0 <project-dir> [<rev>|<a..b>] [--project <folder>]" >&2; exit 2; }
dir=""; spec=""; project=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) project="${2:?--project needs a folder name}"; shift 2 ;;
    -*) usage ;;
    *) if [[ -z "$dir" ]]; then dir="$1"; elif [[ -z "$spec" ]]; then spec="$1"; else usage; fi; shift ;;
  esac
done
[[ -n "$dir" && -d "$dir" ]] || usage
g() { git -C "$dir" "$@"; }

# Project name: given, or the first folder under the manager folder that holds <project-dir>.
if [[ -z "$project" ]]; then
  real="$(cd "$dir" && pwd -P)"; rroot="$(cd "$ROOT" && pwd -P)"
  case "$real" in "$rroot"/*) project="${real#"$rroot"/}"; project="${project%%/*}" ;; esac
fi

CFG_SENS=""; CFG_UI=""; VISUAL_PROOF=""
declare -a CMDS=()
if [[ -n "$project" && -f "$ROOT/.claude/harness.json" ]] && command -v node >/dev/null 2>&1; then
  # seven lines: sensitive regex, ui regex, visual proof, build, lint, scoped tests, full tests (nothing when the project has no settings)
  cfg="$(node "$ROOT/.claude/scripts/harness.mjs" get "$ROOT" "$project" all 2>/dev/null || true)"
  if [[ -n "$cfg" ]]; then
    { IFS= read -r CFG_SENS; IFS= read -r CFG_UI; IFS= read -r VISUAL_PROOF
      for _ in 0 1 2 3; do IFS= read -r line || line=""; CMDS+=("$line"); done; } <<<"$cfg"
  fi
fi
if [[ -n "$project" && ${#CMDS[@]} -eq 0 ]]; then
  echo "note: no settings for project '$project' in .claude/harness.json: only the built-in sensitive paths apply and no commands are known (run project-setup.sh)." >&2
fi

if [[ -z "$spec" ]]; then
  patch="$(g diff --no-color -U0 -M HEAD)"
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    patch+=$'\n'"$( (cd "$dir" && git diff --no-color -U0 --no-index /dev/null -- "$f") || true)"
  done < <(g ls-files --others --exclude-standard)
elif [[ "$spec" == *..* ]]; then
  patch="$(g diff --no-color -U0 -M "$spec")"
else
  patch="$(g diff --no-color -U0 -M "$spec^" "$spec")"
fi

# One record per file (F) and per added code line (L).
records="$(COMMENT="$COMMENT" awk '
  function flush() { if (path != "") printf "F\t%s\t%d\t%d\t%d\n", path, isnew, added, deleted }
  /^diff --git / { flush(); path=$0; sub(/^diff --git a\/.* b\//, "", path); isnew=0; added=0; deleted=0; inhunk=0; next }
  /^new file mode/ { isnew=1; next }
  /^@@/ { inhunk=1; next }
  inhunk && /^\+/ { t=substr($0,2)
    if (t ~ /^[[:space:]]*$/ || t ~ ENVIRON["COMMENT"]) next
    added++; printf "L\t%s\t%s\n", path, t; next }
  inhunk && /^-/ { deleted++; next }
  END { flush() }' <<<"$patch")"

[[ -n "$records" ]] || { echo "TIER=0 UI=no VISUAL=no"; echo "- empty diff"; exit 0; }

added=0; deleted=0; code_files=0; new_code=0; sensitive_hits=""; ui_files=""; tests_only=1
risky_hits=""; uimod_hits=""
while IFS=$'\t' read -r kind a b c d; do
  if [[ "$kind" == F ]]; then
    path="$a"; isnew="$b"
    grep -Eiq "$NONCODE" <<<"$path" && continue
    code_files=$((code_files+1)); added=$((added+c)); deleted=$((deleted+d))
    [[ "$isnew" == 1 ]] && new_code=$((new_code+1))
    if grep -Eq "$SENSITIVE_FILES" <<<"$path"; then sensitive_hits+="$path "
    elif [[ -n "$CFG_SENS" ]] && grep -Eq "$CFG_SENS" <<<"$path"; then sensitive_hits+="$path "
    elif ! grep -Eq "$TESTFILE|$GENERATED" <<<"$path" && grep -Eiq "$SENSITIVE_AREAS" <<<"$path"; then sensitive_hits+="$path "
    fi
    [[ -n "$CFG_UI" ]] && grep -Eq "$CFG_UI" <<<"$path" && ui_files+="$path "
    grep -Eq "$TESTFILE" <<<"$path" || tests_only=0
  else
    path="$a"; text="$b"
    grep -Eiq "$NONCODE" <<<"$path" && continue
    grep -Eq "$TESTFILE" <<<"$path" && continue
    grep -Eq "$RISKY" <<<"$text" && risky_hits+="$path "
    [[ -n "$CFG_UI" ]] && grep -Eq "$CFG_UI" <<<"$path" && grep -Eq "$UIADDED" <<<"$text" && uimod_hits+="$path "
  fi
done <<<"$records"

uniq_words() { tr ' ' '\n' <<<"$1" | sort -u | tr '\n' ' ' | sed 's/^ *//; s/ *$//'; }
sensitive_hits="$(uniq_words "$sensitive_hits")"; ui_files="$(uniq_words "$ui_files")"
risky_hits="$(uniq_words "$risky_hits")"; uimod_hits="$(uniq_words "$uimod_hits")"

reasons=()
if (( code_files == 0 )); then tier=0; reasons+=("only docs/assets changed")
elif [[ -n "$sensitive_hits" ]]; then tier=3; reasons+=("sensitive path: $sensitive_hits")
elif (( added > MAX_T2_ADDED || code_files > MAX_T2_FILES )); then
  tier=3; reasons+=("large change: $added added code lines in $code_files code files")
elif (( tests_only )); then tier=2; reasons+=("test files only: run the changed tests")
elif (( new_code == 0 && added <= MAX_T1_ADDED && added * T1_DELETE_RATIO <= deleted )) \
     && [[ -z "$risky_hits" && -z "$uimod_hits" ]]; then
  tier=1; reasons+=("mostly removal: +$added/-$deleted code lines, no new declarations, control flow or UI text")
else
  tier=2
  (( new_code > 0 )) && reasons+=("$new_code new code file(s)")
  [[ -n "$risky_hits" ]] && reasons+=("added declarations/control flow in: $risky_hits")
  [[ -n "$uimod_hits" ]] && reasons+=("added markup, style or text in UI files: $uimod_hits")
  (( ${#reasons[@]} == 0 )) && reasons+=("+$added/-$deleted code lines: not a pure removal")
fi

ui=no; [[ -n "$ui_files" ]] && ui=yes
vis=no; [[ "$ui" == yes && $tier -ge 2 ]] && vis=required
[[ "$ui" == yes ]] && reasons+=("UI-visible files: $ui_files")

echo "TIER=$tier UI=$ui VISUAL=$vis"
for r in "${reasons[@]}"; do echo "- $r"; done
cmd_line() { [[ -n "${CMDS[$1]:-}" ]] && echo "  $2: ${CMDS[$1]}" || true; }
case "$tier" in
  0) echo "verify: nothing to run." ;;
  1) echo "verify: the floor: one build + lint on touched files. No tests." ;;
  2) echo "verify: the floor + scoped tests for what changed. Full suite not needed." ;;
  3) echo "verify: the floor + the full test suite." ;;
esac
if (( tier >= 1 && ${#CMDS[@]} > 0 )); then
  cmd_line 0 build; cmd_line 1 lint
  (( tier == 2 )) && cmd_line 2 "scoped tests"
  (( tier == 3 )) && cmd_line 3 "full tests"
fi
if [[ "$vis" == required ]]; then
  echo "verify: also produce the visual proof of the changed screen${VISUAL_PROOF:+: $VISUAL_PROOF}."
fi
exit 0
