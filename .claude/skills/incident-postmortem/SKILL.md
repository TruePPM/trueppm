---
name: incident-postmortem
model: sonnet
description: Run a structured postmortem after a TruePPM harness/process incident — a red main, a milestone that overran unnoticed, a gate that stayed green through something it should have caught, a lost-work collision. Reconstructs the timeline, separates root cause from contributing factors, checks whether an existing gate should have fired, and writes the lesson into the durable memory store instead of leaving it in a transcript. Reactive and incident-scoped — distinct from /kaizen, which is periodic and pattern-scoped.
argument-hint: "[incident description or issue/MR reference]"
---

# Incident Postmortem — Harness/Process Incident Review

You are running a postmortem on a **specific, already-resolved** TruePPM harness or
process incident — not auditing the harness for general friction (`/kaizen`) and not
auditing the codebase for defects (`/pre-release`, `/regression-check`). The incident is
the starting point; the job is to work backward to a cause, and forward to a durable
record that stops the same shape of failure from being rediscovered the hard way next
time.

**The deliverable is the memory entry, not the report.** A postmortem that produces a
good write-up in the conversation and nothing on disk has changed nothing — the next
session starts exactly as blind as this one did. Step 5 is not optional.

## Scope discipline

In scope — harness/process incidents:
- `main` red for an extended window, or red from a cause with no code fix (a label edit, a stale base, a quota exhaustion)
- A milestone, gate, or cap that silently stopped describing practice until someone noticed the gap (an unbounded milestone, a WIP cap routinely overridden)
- A gate that ran, reported clean, and something it was scoped to catch shipped anyway
- Lost or overwritten work from a tooling collision (shared `refs/stash`, a worktree prune race, a force-push)
- A release or MR that shipped something it shouldn't have (a stale-tense doc, an unshipped feature advertised, a boundary violation) that traces to a process gap rather than a one-off mistake

Out of scope:
- A domain/product bug with no process angle — fix it and, if the lesson is durable, write the memory entry directly; that is normal practice, not a postmortem (see `~/.claude/CLAUDE.md`'s memory-discipline rules)
- General friction with no specific triggering incident — that is `/kaizen`
- The fix itself — this skill runs **after** the incident is resolved, not instead of resolving it

**Relationship to `/kaizen`:** kaizen starts from steady-state signals (cycle time, gate
yield, skip rate) and looks forward for friction that hasn't caused visible damage yet.
Postmortem starts from a known bad outcome and works backward to cause. A kaizen finding
can be the trigger for a postmortem ("gate X has 0% yield, and separately something it
covers just broke `main`") — when that happens, hand the postmortem its own Step 1
rather than re-deriving kaizen's signal work.

## When to run

- After an incident is fixed and `main` (or the affected surface) is confirmed green — do not run mid-incident. A postmortem written before the fix lands conflates the fix with the record of the fix, and the timeline in Step 2 will be incomplete.
- When a release retrospective surfaces a process failure that has no memory entry yet
- On demand, whenever the user asks for a postmortem on a named incident

## Arguments

- `[incident description or issue/MR reference]` — required. An issue/MR number
  (`#2977`, `!1352`) if one exists, or a free-text description if the incident was never
  tracked (common for label-edit or tooling-collision incidents, which rarely get their
  own issue).

---

## Step 1 — Establish the incident record

Pull the mechanical facts rather than working from recollection.

If an issue or MR was given:
```bash
glab issue view <N> -R trueppm/trueppm 2>&1
glab mr view <N> -R trueppm/trueppm 2>&1
```

If only a free-text description was given, ask the user for the minimum facts needed
to anchor Step 2: approximately when it started, how it was noticed (who/what surfaced
it — a person, a CI failure, a user report), and current status.

Record: what broke, when it started, how long it was broken, how it was noticed, and
blast radius (pipeline blocked for everyone? one branch? a release shipped wrong? work
lost?).

## Step 2 — Reconstruct the timeline

Build the timeline from the mechanical trail, not from what anyone remembers happening:

```bash
# commits in the incident window
git log --since="<window start>" --until="<window end>" --oneline --all

# pipeline history if it's a CI/main incident
glab api "projects/trueppm%2Ftrueppm/pipelines?ref=main&per_page=50" 2>/dev/null \
  | python3 -c "import json,sys; [print(p['id'], p['status'], p['created_at']) for p in json.load(sys.stdin)]"
```

Produce four timestamps: **introduced** (the commit/action that created the bad state),
**noticed** (when a human or system first flagged it), **understood** (when the root
cause was identified), **resolved** (when the fix landed). The gap between *introduced*
and *noticed* is frequently the real finding — a fast fix for a slow-to-notice problem
still leaves the detection gap in place for the next occurrence.

## Step 3 — Root cause vs contributing factors

Do not stop at the triggering commit. Ask three questions in order:

1. **What was the single mechanical trigger?** (the commit, the label edit, the merge
   order, the stash pop.)
2. **What let that trigger cause this much damage?** — i.e., why didn't something catch
   or contain it sooner? This is almost always the more useful finding, and the one most
   often skipped. A memory entry that only names the triggering commit prevents that
   exact commit from recurring and nothing else — state the class of trigger, not just
   the instance (the same discipline the project already applies to fixing a failing
   test: fix the class, not the one call site that happened to be covered).
3. **Was this foreseeable?** Check whether a memory entry, ADR, or CLAUDE.md rule already
   existed that should have caught this shape of failure — and if so, why it wasn't
   consulted, or wasn't specific enough to. (`grep` the memory index and `docs/adr/` for
   the affected surface before concluding "nothing existed.")

State root cause and contributing factors as separate lines in the report — collapsing
them into one narrative is how the second question gets lost.

## Step 4 — Did a gate exist, and did it fire

Check CLAUDE.md's gate reference table for whichever gate class should have covered the
change that caused this. Three possible outcomes, and they call for different fixes:

- **No gate covered this class of change** → candidate for a new gate or a fast-path
  table row. Hand this to `/kaizen`'s next run, or file it directly (Step 6) if it's
  clear-cut and doesn't need kaizen's broader signal gathering.
- **A gate covered it, ran, and reported clean** → the gate has a blind spot. Name the
  exact check that should have caught this and didn't — "ran" is not the same as
  "checked for this."
- **A gate covered it but was skipped or marked `n/a` incorrectly** → this is a process
  compliance gap, not a coverage gap. Name where the skip happened (an MR's `## Gates`
  section, a conversation turn) rather than proposing a new check.

## Step 5 — Write the durable memory entry

This is the step that actually closes the loop. Follow the memory-discipline rules
already established in `~/.claude/CLAUDE.md` verbatim — this skill does not redefine
them, it applies them:

- **Type**: almost always `feedback` (a rule the harness should follow going forward).
  Use `project` only if the entry is describing current, still-changing state rather
  than a durable rule.
- **One fact per file**, with `description:` carrying the retrieval hook — the file is
  invisible to future recall without it.
- **Lead with the rule, not the incident narrative.** "`main` red 6.5h" is the incident;
  "a label edit on an open OSS issue reds `boundary:check`" is the memory. The hook test
  from CLAUDE.md applies directly: would a session that never reads this file still make
  the right call?
- **`Why:` and `How to apply:` lines are mandatory**, not optional prose — they are what
  let a future session judge edge cases this exact incident didn't cover.
- **Check for an existing memory covering the same lesson first.** If Step 3/4 landed on
  something an existing file already half-covers, update that file (with a dated
  **Superseded** note if it contradicts the old belief) instead of writing a sibling —
  this is the on-write eviction trigger from CLAUDE.md's memory-discipline section, not
  optional cleanup.
- Add the one-line pointer to `MEMORY.md` (or `MEMORY-archive.md` if the entry is a
  closeout record with no reusable rule — CLAUDE.md's own decision table applies).

## Step 6 — Propose a process fix (optional)

Only if Step 4 found a real, actionable gap — not for a gate that was correctly scoped
and simply hadn't run enough times to catch a rare miss. Route it exactly like a kaizen
finding: against the **next open minor milestone**, resolved the same way `/kaizen`
resolves it (smallest open milestone strictly greater than the current working release —
the incident just fixed is already in motion, and a process change landing late in it
adds risk without benefit):

```bash
NEXT_MILESTONE=$(glab api "projects/trueppm%2Ftrueppm/milestones?state=active" 2>/dev/null \
  | python3 -c "import json,sys; ms=json.load(sys.stdin); print(sorted(m['title'] for m in ms if m.get('due_date'))[0])")

glab issue create --repo trueppm/trueppm \
  --milestone "$NEXT_MILESTONE" \
  --label "chore,tooling,dx" \
  --title "<slug>" \
  --description "<finding body, heredoc>"
```

Cross-reference the incident issue/MR and, if related, a prior or upcoming `/kaizen`
finding, so the two don't get investigated twice.

## Step 7 — Report

```
## Postmortem — <incident> — <date>

### Timeline
introduced: <ts>  noticed: <ts>  understood: <ts>  resolved: <ts>
detection gap: <noticed - introduced>

### Root cause
<the mechanical trigger>

### Contributing factors
<what let it cause this much damage — usually the more important line>

### Gate coverage
<no gate covered this | gate ran clean, blind spot: X | gate skipped at: Y>

### Memory entry
<file path> — <one-line hook> (new | updated <prior file>)

### Process fix filed
<issue # | "none — existing gate already covers this correctly">
```

---

## What this does not do

- Fix the underlying incident — it is already resolved by the time this runs
- Replace `/kaizen`'s periodic, pattern-scoped audit
- Audit product code for bugs — that's `/pre-release` and the day-to-day gates
- Decide or apply `release::` labels, relabel issues, or edit CLAUDE.md/CI config
  directly — this skill only proposes; the user lands any resulting change through a
  normal branch and MR

## Anti-patterns to refuse

- Running while the incident is still unresolved
- A memory entry that narrates what happened without a `Why:`/`How to apply:` structure
- Filing a process-fix issue for a gate that worked correctly and simply hadn't run
  enough times yet — that is noise, not a finding
- Writing a sibling memory file when an existing one already covers the lesson — update
  it in place instead
- Treating this as a recurring loop on one incident — one incident, one pass
