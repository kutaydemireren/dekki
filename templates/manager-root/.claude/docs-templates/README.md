# Project docs: index and rules

One subfolder per project. Each holds five short docs: the project's memory, for you and for the AI agents that work on it. The manager and every worker read them before changing a project and update them in the same session as the change.

| File | What it holds | Update when |
|---|---|---|
| `START-HERE.md` | Read first, under about 4 KB: what the project is, how to build and test, safety rules, a map of which doc covers what, open branches. Only points to the other docs. | commands, safety rules, the map or open branches change |
| `SPEC.md` | What the project is and does now: behaviour, interfaces, state, how to run. Present tense, current state only. | behaviour, an interface, state or how to run it changes |
| `DECISIONS.md` | Why things are the way they are. Dated entries, grouped by area. | a choice is made or reversed |
| `LOG.md` | What happened, per session: what was done, what is next, what the next agent should know. | the end of every session |
| `INBOX.md` | Bugs and ideas people reported, one block each, with a Status. | someone reports one; an entry is picked up or finished |

`archive/` inside a project folder holds text moved out of DECISIONS and LOG. Nobody reads it by default.

## Rules
- **Read first.** Before any change read START-HERE and the newest LOG entry, then only the SPEC and DECISIONS sections the change touches. Never read a whole big file when a section will do.
- **Same session, not later.** Behaviour, interface, state or how-to-run changed: update SPEC. A choice made or reversed: DECISIONS. At the end of the session add a dated LOG entry that names the docs you touched.
- **A fact lives in one place.** Link to it, don't copy it. SPEC says what is true now, DECISIONS says why, LOG says what happened.
- **Don't write guesses as facts.** Say "unverified" when it is. Don't delete someone else's wording, or anything you can't tell is obsolete, without asking; list in the LOG what you removed.
- **Housekeeping, a few minutes each session.** Re-read the SPEC parts your change touched: nothing may contradict the code or another doc. Fix it, don't just note it. Remove what is no longer true.

## DECISIONS maintenance
- Group entries by area (a short heading each), newest last within an area.
- One or two sentences per entry: the decision and the reason. The detail goes to the LOG or the commit message.
- When a decision is reversed, say so in the new entry and move the old one to `archive/DECISIONS-archive.md`. Decisions are not deleted, only moved.
- When the file passes about 20 KB, archive or merge entries until it is under again. Readers load only the area they need.

## LOG maintenance
- Newest entry last. Each entry: what you did, what is next, what the next agent should know, the docs you touched.
- When the file passes about 25 KB, compress entries older than two weeks into a short digest that keeps the facts the next agent needs. First check each fact is already in SPEC or DECISIONS. Keep the old text in `archive/`.

## INBOX
Each entry is a block (the format is at the top of the project's `INBOX.md`) with a Status: `open`, `picked up (branch)`, then `done (date, branch or commit)`. When someone asks you to log or note a bug or idea, append an entry under "Open" and do nothing else unless asked. When someone asks you to fix or improve the project with no specific target, read the INBOX first. A done entry moves to "Done".

## START-HERE
Keep it true and under about 4 KB. It only points to the owner docs; never copy long text into it.
