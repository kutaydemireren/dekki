# How I work with agents

This page is about the way of working that Dekki's setup wizard installs, not about the web UI. I built the UI to watch agents; the playbook, scripts and docs below are what I use to get work done through them. Take what fits and change the rest.

## The approach

**I talk in goals, not folders.** I say "add the export button" or "the login flow should do this", and a manager agent works out which projects are involved. It tells me its plan in a few lines and then delegates. A request can touch one project or five.

**A manager delegates, workers do.** The manager runs in a folder that holds all my projects. It does not edit code, build or run tests. For each project it starts a background worker inside that project's own folder, so the project's own config, skills and CLAUDE.md load. The manager follows the workers, compares what they report, and tells me the outcome in plain words. I talk to one agent, not five.

**Workers are isolated.** Each worker edits in its own git worktree on its own branch. Deny rules stop it from pushing to protected branches (main, master and develop by default), force-pushing, or pushing without naming the branch. These rules are a safety net, not a wall: a determined script can get around them. They catch the honest mistakes.

**Evidence is sized by the diff.** "Always run everything" wastes time on a typo fix, and "tests pass" is not enough for a payment change. So a small script (`classify-change.sh`) reads the diff and gives it a tier: docs only needs nothing, a mostly-removal change needs a build and lint, real logic adds scoped tests, and anything touching dependencies, CI, auth, payments, migrations or a large diff gets the full suite. Visible changes also need proof (for example a screenshot). The script is plain git and pattern counts, so the same diff gets the same tier every time. You set the commands and the sensitive paths per project; nothing is assumed.

**Every change leaves a trace.** Each project has five short docs outside its repo: START-HERE, SPEC, DECISIONS, LOG, INBOX. Before a worker changes anything it reads START-HERE and the newest LOG entry. After the change it updates the docs in the same session. A fact lives in one place: SPEC says what is true now, DECISIONS says why, LOG says what happened. This is what lets the next agent, who remembers nothing, pick up where the last one stopped.

**The human decides what is irreversible.** Pushes to protected branches, merges, releases, deleting things and anything that touches a live system stay with me. The manager asks me with a proper question prompt (not a sentence buried in a reply), and workers never ask me directly: they end with `result:`, `needs input:` or `failed:` and the manager relays it.

## What a worker sees, and what it does not

Claude Code loads the `CLAUDE.md` of every folder above the one it starts in. Every project folder sits inside the manager folder, so every worker in a project, whether the manager started it or you started it yourself, also reads the manager playbook. A note at the very top of the playbook tells a worker that the manager sections are not addressed to it: if its brief carries a report contract, it follows its brief and its project's own rules.

What differs is what `delegate.sh` adds. A worker started through the manager's `delegate.sh` gets, appended to its brief: the guardrails (what must never be touched, the protected branches, the secrets rule), the path of its project's docs with the instruction to read and update them, the project's check commands, and the report contract. It also runs with the rendered deny rules. A worker you start yourself in a project gets the playbook text and the project's own CLAUDE.md, but none of those additions: no docs path, no check commands, no deny rules, no report contract. If you want them for a worker you start by hand, go through the manager, or copy what you need into the project's CLAUDE.md.

A worker, like the manager, only starts in a folder you have trusted once. After the setup wizard creates the files, it lists the docs folder and the git repos it found, each with a one-line command to run once (`claude`, accept the prompt, then `/exit`).

The manager folder's own `CLAUDE.md` is the playbook the manager follows. The setup wizard owns three marked blocks in it (preferences, guardrails, docs) and rewrites only those when you run the wizard again. Everything else in the file is yours to edit. When you have edited the file and a newer template has playbook fixes, the wizard still refreshes the blocks, keeps the rest as it is, and saves the new playbook text next to it as `CLAUDE.md.new` (with your blocks rendered, so a diff shows only the playbook changes). You compare the two and copy over what you want.

## Per folder and per account

Some things belong to the working folder and some to the Claude account, and they are easy to mix up.

- **Per working folder** (shared by any account that works in it): the playbook `CLAUDE.md`, `.claude/scripts`, the `delegate` skill, `.claude/settings.local.json`, and `.claude/harness.json` (docs folder, protected branches, your preferences, per-project commands and sensitive paths). `harness.json` is gitignored.
- **Per Claude account** (the Claude config directory, `~/.claude` by default): installed skills such as the optional unslop skill, global settings and Claude's own memory. A second account has its own config directory, so a skill installed for one is not there for the other, and Claude's memory does not carry over. The wizard does not copy any of this.
- **Per project**: the docs folder `<docs>/<project>/` and that project's entry in `harness.json`.

Dekki never reads your docs folder for another account; each account gets its own.

## How to adapt it

- **Change the tone or autonomy**: re-run the wizard (reply style, how often to ask, who opens pull requests, language), or edit the playbook text outside the marked blocks.
- **Change what counts as sensitive or visible**: edit the project's entry through `project-setup.sh <project> --sensitive '<regex>' --ui '<regex>'`. The regexes match changed file paths. The manager asks you once the first time it works on a project and saves the answer.
- **Change the tier thresholds**: they are variables at the top of `classify-change.sh`. Check a change to them against a few past commits (`classify-change.sh <repo> <rev>`) before trusting it.
- **Change the docs rules**: the docs folder's `README.md` holds them (size caps, how to archive decisions, how to compress the log). Edit it; workers are told to follow it. `delegate.sh` warns the manager when LOG, DECISIONS or START-HERE is over its cap.
- **Add your own skills**: put them in the Claude config directory of the account that should have them, or in a project's own `.claude/skills`.

## If you already have your own setup

You do not have to run the wizard. Take only the parts you like: `classify-change.sh` reads `.claude/harness.json` only when it exists and otherwise falls back to its built-in sensitive paths, and the docs rules are a plain `README.md` you can copy into your own docs folder.

If you do run it on a folder that already has files, it never overwrites an existing file. An existing `CLAUDE.md` with no setup markers is left untouched unless you tick the option to add the setup blocks to the end. That option is off by default, and the review screen shows the text so you can paste it yourself instead. When the file already has the three marked blocks, only those are rewritten.

The wizard records what it installed in `.claude/harness.manifest.json`, with a hash per file. When you run a newer version, files you did not edit are updated, and files you edited are flagged and left alone. For `CLAUDE.md`, the new playbook text is saved next to it as `CLAUDE.md.new`. Nothing of yours is overwritten; you decide what to copy over.

Before anything is written, the review screen lists what would be created, left alone, outdated or modified, and the counts at the top.

## How to expand

The pattern that works for me is: give agents somewhere to put what they learn, and read it later. For example, add a `FINDINGS.md` to a project's docs and add one line to the playbook: "When you learn something about this project that is not obvious from the code (how a service really behaves, a trap, a fact you verified), add it to FINDINGS.md with how you checked it, and say 'unverified' when you did not." Then workers report discoveries into one file instead of burying them in a transcript, and I can read the file when I want to know what the agents have found out. The same idea works for a `GLOSSARY.md`, a `RUNBOOK.md` or a list of known flaky tests.

To measure your own setup, the template also installs an optional check-in script. Run `python3 -I .claude/scripts/quality-baseline.py --since YYYY-MM-DD` from your working folder. It prints about ten lines from your session transcripts: how many workers ended with a proper `result:` / `needs input:` / `failed:` report, how often you had to follow up or correct them, how often the Stop hook asked for a rewrite, and how much of the cost sits in the top 10% of sessions. Use the numbers to decide what to tighten in your playbook. It is read-only, writes nothing, sends nothing anywhere, and never runs on its own: no schedule, no notifications.

Two cautions. Keep each new doc owned by one kind of fact, so it does not drift into a second copy of SPEC. And keep the first-read set small: START-HERE should point to the new file, not quote it.

## What I have not solved

The deny rules are pattern matches on commands, so they miss indirection. Workers cannot see each other, so two workers on one project can collide; the manager has to sequence them. The tier script knows about paths and diff shape, not about what the code means, so a one-line change to the wrong place can score low. I raise a tier by hand when I can see a reason the script cannot, and I never lower one.
