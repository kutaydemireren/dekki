#!/usr/bin/env bash
# Block until every listed background worker has finished its turn, then print one line per worker.
# Run it with run_in_background so the manager gets woken when it exits.
#
#   wait-worker.sh <id> [<id> ...]     # returns when ALL listed workers are finished
#
# Finished = `state` is no longer "working", OR `status` is "idle" on two polls in a row.
# Why both: `state` is a label the harness writes at the end of a turn and it can be wrong. A worker that
# ended its turn with a result: report was seen stuck on state=working for 20+ minutes while status=idle.
# `status` is the live signal. A worker that is only waiting on a long background build also shows idle
# for a while, so an early wake is possible: the output line carries the worker's last message, so the
# manager can tell "finished" (result:/needs input:/failed:) from "mid-task" and simply start the wait again.
#
# WAIT_POLL_SECS (default 20) is the poll interval.
set -euo pipefail
[[ $# -ge 1 ]] || { echo "usage: $0 <worker-id> [<worker-id> ...]" >&2; exit 2; }
POLL="${WAIT_POLL_SECS:-20}"

# prints "<state> <status>" for the worker, or "gone gone" when it is not in the list
probe() {
  claude agents --json 2>/dev/null | python3 -I -c '
import json,sys
want=sys.argv[1]
try:
    agents=json.load(sys.stdin)
except Exception:
    print("? ?"); raise SystemExit
for a in agents:
    if a.get("id")==want:
        print(a.get("state","?"), a.get("status","?")); break
else:
    print("gone gone")' "$1"
}

# first 160 chars of the worker's last assistant message, newlines collapsed
last_message() {
  local f
  f="$(ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$1"-*.jsonl 2>/dev/null | head -1 || true)"
  [[ -n "$f" ]] || return 0
  python3 -I -c '
import json,sys
last=""
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    try: r=json.loads(line)
    except Exception: continue
    m=r.get("message") or {}
    if r.get("type")!="assistant" or not isinstance(m,dict): continue
    c=m.get("content")
    t=c if isinstance(c,str) else "\n".join(b.get("text","") for b in (c or []) if isinstance(b,dict) and b.get("type")=="text")
    if t.strip(): last=t
print(" ".join(last.split())[:160])' "$f"
}

for id in "$@"; do
  idle=0
  while :; do
    out="$(probe "$id")"; st="${out%% *}"; stat="${out##* }"
    [[ "$st" == "?" ]] && { sleep "$POLL"; continue; }   # the CLI hiccuped: ask again
    [[ "$st" != "working" ]] && break
    if [[ "$stat" == "idle" ]]; then idle=$((idle + 1)); (( idle >= 2 )) && break; else idle=0; fi
    sleep "$POLL"
  done
  echo "worker $id: state=$st status=$stat | last: $(last_message "$id")"
done
