#!/usr/bin/env bash
# Stop hook for workers (wired in worker-deny.json). Checks only the headline block of a `result:` report.
#
# Reads the Stop payload (JSON on stdin: last_assistant_message, transcript_path, stop_hook_active).
# - Last assistant message does not start with `result:`  -> exit 0 (needs input:, failed:, anything else untouched).
# - `result:` with a `---` line and a headline block of <= 130 words -> exit 0.
# - Otherwise block ONCE: exit 2 with a fix message on stderr. A second stop (stop_hook_active true) always passes.
# Fail open: any error, missing field, unreadable transcript -> exit 0. It must never strand a worker.
MAX_WORDS=130
export MAX_WORDS
python3 -I -c '
import json, os, re, sys

def main():
    d = json.loads(sys.stdin.read() or "{}")
    if not isinstance(d, dict) or d.get("stop_hook_active") is True:
        return 0
    msg = d.get("last_assistant_message")
    if not isinstance(msg, str) or not msg.strip():
        # fall back to the last assistant text block in the transcript
        msg = ""
        path = d.get("transcript_path")
        if isinstance(path, str) and os.path.isfile(path):
            with open(path, encoding="utf-8", errors="replace") as f:
                for line in f:
                    try:
                        r = json.loads(line)
                    except Exception:
                        continue
                    if not isinstance(r, dict) or r.get("isSidechain") or r.get("type") != "assistant":
                        continue
                    c = (r.get("message") or {}).get("content")
                    if isinstance(c, str):
                        t = c
                    elif isinstance(c, list):
                        t = "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
                    else:
                        continue
                    if t.strip():
                        msg = t
    msg = msg.lstrip()
    if not msg.startswith("result:"):
        return 0
    limit = int(os.environ.get("MAX_WORDS", "130"))
    head, sep = [], False
    for line in msg.splitlines():
        if line.strip() == "---" and line == "---":
            sep = True
            break
        head.append(line)
    words = len(" ".join(head).split())
    if sep and words <= limit:
        return 0
    why = ("the headline block (text before the --- line) is %d words, limit %d" % (words, limit)) if sep else "there is no line that is exactly --- separating the headline block from the details"
    sys.stderr.write(
        "Report check: " + why + ". Rewrite your result: report once: keep the headline block to about 100 words "
        "(result:, Act:, Deviations:, Not run:, Where:, skills used:), put a line with only --- after it, "
        "and move evidence, file lists, test output and paths below it. Keep every Act, Deviations and Not run item above the line. "
        "Do not drop facts, only move them.\n")
    return 2

try:
    sys.exit(main())
except SystemExit:
    raise
except BaseException:
    sys.exit(0)
'
rc=$?
[[ $rc -eq 2 ]] && exit 2
exit 0
