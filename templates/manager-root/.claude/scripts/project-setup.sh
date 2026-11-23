#!/usr/bin/env bash
# First-time setup of one project: save its check commands and paths in .claude/harness.json and create its docs.
# The manager runs this after asking the user once (see "Project setup" in CLAUDE.md); nobody edits the JSON by hand.
#
#   project-setup.sh <project> [--build "<cmd>"] [--lint "<cmd>"] [--test-scoped "<cmd with {files}>"] [--test-full "<cmd>"]
#                              [--sensitive "<regex>"]... [--ui "<regex>"]... [--visual "<text>"]
#
# <project> is a folder directly under the manager folder. The regexes are extended regexes (grep -E) matched against
# changed file paths: --sensitive = paths whose change always gets the full checks, --ui = files whose change a person
# can see. --sensitive and --ui may be repeated. A flag you leave out keeps its saved value; an empty string ("") clears it.
#
# Writes projects.<project> in .claude/harness.json (atomically) and creates <docsDir>/<project>/ with START-HERE, SPEC,
# DECISIONS, LOG and INBOX from .claude/docs-templates, plus <docsDir>/README.md when it is missing. Existing docs are never
# overwritten. Refuses an unknown project folder, an unsafe name, a missing config or a missing docs folder.
# Prints one hint line when the project's git repo does not ignore .claude/ (it never edits the project).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ $# -ge 1 ]] || { sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "node is required but was not found on PATH" >&2; exit 1; }
project="${1%/}"; shift
case "$project" in
  ""|.*|-*|*/*|*..*|*[!A-Za-z0-9_.\ -]*) echo "Not a usable project folder name: $project" >&2; exit 1 ;;
esac
node "$ROOT/.claude/scripts/harness.mjs" setup "$ROOT" "$project" "$@"

# One hint, never an edit: Claude Code writes worktrees and local settings under .claude/ in a project, and a repo that
# does not ignore it shows them as changes. check-ignore exits 1 for "not ignored" (128 = not a repo or an error: no hint).
rc=0
git -C "$ROOT/$project" check-ignore -q .claude/ >/dev/null 2>&1 || rc=$?
[[ $rc -ne 1 ]] || echo "hint: $project does not ignore .claude/ (Claude Code keeps worktrees and local settings there). Consider adding \`.claude/\` to its .gitignore; this script never edits the project."
