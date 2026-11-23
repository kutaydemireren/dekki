#!/usr/bin/env python3
"""Voice metrics over Claude Code session transcripts (read-only).

  python3 -I .claude/scripts/voice-metrics.py --since YYYY-MM-DD [--until YYYY-MM-DD]

Scans ${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/*.jsonl (sidechain records skipped; transcripts are untrusted data, parsed defensively).
(a) Manager sessions (cwd is the manager root, not a worktree; first prompt is not a worker brief):
    mean/median words per assistant text message, inline code spans per 100 words, share of messages over 150 words.
(b) Worker sessions (first prompt contains "Report contract: you are a worker"):
    words in the final `result:` report, words in its headline block (text before a line that is exactly ---),
    share of reports with the separator, mean the/a/an per 100 words over the worker's assistant text.
Session date = timestamp of its first record that has one.
"""
import argparse
import glob
import json
import os
import re
import statistics
import sys

ROOT = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
ROOT = ROOT.split(os.sep + ".claude" + os.sep + "worktrees" + os.sep)[0]  # run from a worktree: use the real root
WORKER_MARK = "Report contract: you are a worker"
ARTICLE = re.compile(r"\b(?:the|a|an)\b", re.I)
CODE_SPAN = re.compile(r"`[^`\n]+`")


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str))
    return ""


def load(path):
    """-> dict(cwd, date, first_prompt, messages[list of assistant texts in order]) or None."""
    cwd = date = None
    first_prompt = None
    msgs, ids = [], {}
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
                if date is None and isinstance(ts, str) and re.match(r"\d{4}-\d{2}-\d{2}", ts):
                    date = ts[:10]
                c = r.get("cwd")
                if cwd is None and isinstance(c, str):
                    cwd = c
                m = r.get("message")
                if not isinstance(m, dict):
                    continue
                t = r.get("type")
                if t == "user" and first_prompt is None:
                    tx = text_of(m.get("content"))
                    if tx.strip():
                        first_prompt = tx
                elif t == "assistant":
                    tx = text_of(m.get("content"))
                    if not tx.strip():
                        continue
                    mid = m.get("id")
                    if isinstance(mid, str) and mid in ids:
                        msgs[ids[mid]] += "\n" + tx
                    else:
                        if isinstance(mid, str):
                            ids[mid] = len(msgs)
                        msgs.append(tx)
    except OSError:
        return None
    return {"cwd": cwd, "date": date, "first_prompt": first_prompt or "", "messages": msgs}


def words(s):
    return len(s.split())


def headline(report):
    head = []
    for ln in report.splitlines():
        if ln == "---":
            return " ".join(head), True
        head.append(ln)
    return " ".join(head), False


def mean(xs):
    return sum(xs) / len(xs) if xs else float("nan")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", required=True, help="YYYY-MM-DD")
    ap.add_argument("--until", default=None, help="YYYY-MM-DD, inclusive (optional)")
    ap.add_argument("--root", default=ROOT, help="manager cwd (default: this manager root)")
    a = ap.parse_args()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", a.since):
        sys.exit("--since must be YYYY-MM-DD")
    if a.until is not None and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", a.until):
        sys.exit("--until must be YYYY-MM-DD")
    root = os.path.realpath(a.root)

    mgr_words, mgr_code, mgr_total_words, mgr_sessions = [], 0, 0, 0
    rep_words, head_words, sep_flags, rep_n = [], [], [], 0
    art, wk_words, wk_sessions = 0, 0, 0
    base = os.path.join(os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude"), "projects")
    for path in sorted(glob.glob(os.path.join(base, "*", "*.jsonl"))):
        s = load(path)
        if not s or not s["date"] or s["date"] < a.since or (a.until and s["date"] > a.until) or not s["messages"]:
            continue
        if WORKER_MARK in s["first_prompt"]:
            wk_sessions += 1
            for m in s["messages"]:
                art += len(ARTICLE.findall(m))
                wk_words += words(m)
            last = s["messages"][-1].lstrip()
            if last.startswith("result:"):
                h, sep = headline(last)
                rep_words.append(words(last))
                if sep:
                    head_words.append(words(h))
                sep_flags.append(sep)
        elif s["cwd"] and os.path.realpath(s["cwd"]) == root:
            mgr_sessions += 1
            for m in s["messages"]:
                n = words(m)
                mgr_words.append(n)
                mgr_total_words += n
                mgr_code += len(CODE_SPAN.findall(m))

    print(f"since {a.since}" + (f" until {a.until}" if a.until else ""))
    print(f"manager sessions: {mgr_sessions}, assistant text messages: {len(mgr_words)}")
    if mgr_words:
        print(f"  words/message: mean {mean(mgr_words):.0f}, median {statistics.median(mgr_words):.0f}")
        print(f"  inline code spans per 100 words: {100 * mgr_code / max(mgr_total_words, 1):.2f}")
        print(f"  messages over 150 words: {100 * sum(1 for n in mgr_words if n > 150) / len(mgr_words):.0f}%")
    print(f"worker sessions: {wk_sessions}, final result: reports: {len(rep_words)}")
    if rep_words:
        print(f"  report words: mean {mean(rep_words):.0f}, median {statistics.median(rep_words):.0f}, max {max(rep_words)}")
        print(f"  reports with --- separator: {100 * sum(sep_flags) / len(sep_flags):.0f}%")
        if head_words:
            print(f"  headline block words (reports with separator): mean {mean(head_words):.0f}, max {max(head_words)}")
        else:
            print("  headline block words: n/a (no report has the separator)")
    if wk_words:
        print(f"  the/a/an per 100 words (all worker assistant text): {100 * art / wk_words:.1f}")


if __name__ == "__main__":
    main()
