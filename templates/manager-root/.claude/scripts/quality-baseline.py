#!/usr/bin/env python3
"""Quality baseline over Claude Code session transcripts (read-only).

  python3 -I .claude/scripts/quality-baseline.py [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--root DIR] [--projects DIR]

Read-only check-in on how your agents are doing. It only reads transcripts, writes nothing and sends nothing anywhere.
Scans <config dir>/projects/*/*.jsonl (config dir: CLAUDE_CONFIG_DIR, default ~/.claude; sidechain records skipped;
transcripts are untrusted data, parsed defensively).
Session date = date of its first record that has a timestamp; --since and --until are inclusive.
Worker sessions: first prompt contains "Report contract: you are a worker".
Manager sessions: cwd is the working folder this script is installed in (not a worktree) and the first prompt is not a worker brief.

Workers: final message type shares, follow-ups after the brief, correction-style phrases in follow-ups,
"skills used:" share, Stop hook feedback ("Report check:") share and compliance afterwards, assistant turns,
cost concentration (weights: input 1, cache write 1.25, cache read 0.1, output 5; max per message id).
Managers: correction-style phrase share in user messages (first message of each session excluded).
"""
import argparse
import glob
import json
import os
import re
import statistics
import sys

ROOT = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
ROOT = ROOT.split(os.sep + ".claude" + os.sep + "worktrees" + os.sep)[0]
WORKER_MARK = "Report contract: you are a worker"
HOOK_MARK = "Report check:"
SKIP_PREFIX = ("<task-notification", "<system", "<command", "<local-command", "[Cross-session", "<cross-session")
CORR = re.compile(r"\b(no[,.!]|wrong|not what i|that's not|i said|i asked|you missed|again|still (broken|wrong|not)|"
                  r"doesn't work|didn't work|incorrect|revert|undo|why did you)\b", re.I)
DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str))
    return ""


def num(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) else 0


def cost_of(usage):
    if not isinstance(usage, dict):
        return 0.0
    return (num(usage.get("input_tokens")) + 1.25 * num(usage.get("cache_creation_input_tokens"))
            + 0.1 * num(usage.get("cache_read_input_tokens")) + 5 * num(usage.get("output_tokens")))


def load(path):
    s = {"cwd": None, "date": None, "users": [], "texts": [], "turns": 0, "cost": 0.0, "hook": False}
    ids = {}  # message id -> max weighted cost
    anon = 0.0
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                if not isinstance(r, dict) or r.get("isSidechain") is True:
                    continue
                ts = r.get("timestamp")
                if s["date"] is None and isinstance(ts, str) and DATE.match(ts):
                    s["date"] = ts[:10]
                if s["cwd"] is None and isinstance(r.get("cwd"), str):
                    s["cwd"] = r["cwd"]
                t = r.get("type")
                if t != "assistant" and HOOK_MARK in line:
                    s["hook"] = True
                m = r.get("message")
                if not isinstance(m, dict):
                    continue
                c = m.get("content")
                if t == "user" and not r.get("isMeta"):
                    tx = text_of(c)
                    if tx.strip() and not tx.lstrip().startswith(SKIP_PREFIX):
                        s["users"].append(tx)
                elif t == "assistant":
                    mid = m.get("id")
                    cst = cost_of(m.get("usage"))
                    if isinstance(mid, str):
                        ids[mid] = max(ids.get(mid, 0.0), cst)
                    else:
                        anon += cst
                        s["turns"] += 1
                    tx = text_of(c)
                    if tx.strip():
                        s["texts"].append(tx)
    except OSError:
        return None
    s["turns"] += len(ids)
    s["cost"] = sum(ids.values()) + anon
    return s


def pct(a, b):
    return f"{100 * a / b:.0f}%" if b else "n/a"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="0000-00-00", help="YYYY-MM-DD, inclusive")
    ap.add_argument("--until", default="9999-12-31", help="YYYY-MM-DD, inclusive")
    ap.add_argument("--root", default=ROOT, help="manager working folder (default: the folder this script is installed in)")
    ap.add_argument("--projects", default=None, help="transcripts folder (default: <config dir>/projects)")
    a = ap.parse_args()
    for v in (a.since, a.until):
        if not DATE.fullmatch(v):
            sys.exit("--since/--until must be YYYY-MM-DD")
    root = os.path.realpath(a.root)

    W, M = [], []
    cfg = os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude"
    pdir = a.projects or os.path.join(os.path.expanduser(cfg), "projects")
    for path in sorted(glob.glob(os.path.join(pdir, "*", "*.jsonl"))):
        s = load(path)
        if not s or not s["date"] or not (a.since <= s["date"] <= a.until) or not s["users"]:
            continue
        if WORKER_MARK in s["users"][0]:
            W.append(s)
        elif s["cwd"] and os.path.realpath(s["cwd"]) == root:
            M.append(s)

    n = len(W)
    print("window " + (f"{a.since}..{a.until}" if (a.since, a.until) != ("0000-00-00", "9999-12-31") else "all sessions"))
    print(f"worker sessions: {n}")
    if n:
        kinds = {"result": 0, "needs input": 0, "failed": 0, "none/other": 0}
        for s in W:
            last = s["texts"][-1].lstrip() if s["texts"] else ""
            k = ("result" if last.startswith("result:") else "needs input" if last.startswith("needs input:")
                 else "failed" if last.startswith("failed:") else "none/other")
            kinds[k] += 1
        print("  final message type: " + ", ".join(f"{k} {v} ({pct(v, n)})" for k, v in kinds.items()))
        fu = [len(s["users"]) - 1 for s in W]
        print(f"  follow-ups after the brief: mean {statistics.mean(fu):.2f}, share with >=1: {pct(sum(1 for x in fu if x >= 1), n)}")
        print(f"  workers with a correction-style phrase in follow-ups: "
              f"{pct(sum(1 for s in W if any(CORR.search(x) for x in s['users'][1:])), n)}")
        res = [s for s in W if s["texts"] and s["texts"][-1].lstrip().startswith("result:")]
        print(f"  result: reports with 'skills used:' line: "
              f"{pct(sum(1 for s in res if 'skills used:' in s['texts'][-1]), len(res))} of {len(res)}")
        hk = [s for s in W if s["hook"]]
        comp = sum(1 for s in hk if s["texts"] and any(l == "---" for l in s["texts"][-1].splitlines()))
        print(f"  workers with Stop hook feedback ('{HOOK_MARK}'): {pct(len(hk), n)} ({len(hk)})")
        print(f"  of those, last message has a '---' line: {pct(comp, len(hk))} ({comp} of {len(hk)})")
        turns = [s["turns"] for s in W]
        print(f"  assistant turns per worker session: mean {statistics.mean(turns):.0f}, median {statistics.median(turns):.0f}")
        costs = sorted((s["cost"] for s in W), reverse=True)
        total = sum(costs)
        top = max(1, round(n * 0.1))
        print(f"  weighted cost carried by top 10% of worker sessions ({top} of {n}): {pct(sum(costs[:top]), total)}")
    print(f"manager sessions: {len(M)}")
    uu = [x for s in M for x in s["users"][1:]]
    if uu:
        cc = sum(1 for x in uu if CORR.search(x))
        print(f"  user messages (first of each session excluded): {len(uu)}, with correction-style phrase: {100 * cc / len(uu):.1f}%")
    else:
        print("  user messages (first of each session excluded): 0")


if __name__ == "__main__":
    main()
