#!/usr/bin/env bash
# fixture: --check prints one line and succeeds; anything else fails like the real usage line
if [[ "${1:-}" == "--check" ]]; then
  # render the deny rules the way the real script does (health reads this file)
  d="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  node -e '
    const fs = require("fs"); const d = process.argv[1];
    const cfg = JSON.parse(fs.readFileSync(d + "/.claude/harness.json", "utf8"));
    const deny = ["Bash(git push)"].concat((cfg.protectedBranches || []).map((b) => "Bash(git push * " + b + ")"));
    fs.writeFileSync(d + "/.claude/worker-settings.json", JSON.stringify({ permissions: { deny } }));
  ' "$d"
  echo "ok: config and rendering fine"; exit 0
fi
echo "usage" >&2; exit 2
