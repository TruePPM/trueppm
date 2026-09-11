# Persona Calibration Ledger

Whether the modeled personas in `.claude/personas.md` predict anything is an empirical
question. This file is where it gets answered.

The personas drive real decisions — `/voc` gates feature work, and `voc-audit`-labeled
findings become milestone issues. A model that steers the backlog and is never checked
against reality is not a research method, it is a mirror. This ledger is the check.

## The method

After each release that reaches real users, `/voc-audit` runs a calibration pass and
appends one cycle entry below. It scores three things:

1. **Hits** — a 🔴 or 🟡 the panel raised that real users independently reported. Cite
   both: the VoC finding (issue or MR) and the real report.
2. **Misses** — something real users reported that no persona raised. These are the
   valuable rows: a miss names a gap in the persona model itself, not just in the
   product. Each miss should either amend a persona definition or be recorded as
   knowingly out of model.
3. **False alarms** — a 🔴 the panel raised whose falsification condition was met (the
   thing users would have said, nobody said). A persona with repeated false alarms on a
   topic loses weight on that topic in future panels, per `/voc` Step 0.

Only findings that carried a **falsification line** can be scored — that is what the
line is for. An unfalsifiable 🔴 is recorded as `unscoreable` and counts against the
panel, not for it.

## The rules this ledger enforces

- **A persona's grounding tier may only be raised here.** T0 → T1 → T2 requires a cited
  real report in a cycle entry below. Editing a tier in `personas.md` without a
  corresponding entry here is invalid and may be reverted by anyone.
- **A miss is not a failure to fix quietly.** Amending a persona so that last cycle's
  miss would now be caught is fine and expected — but the miss stays in the ledger. The
  history is the point; a ledger that only records successes measures nothing.
- **Do not backfill.** Entries are written from the evidence available in that cycle, at
  that time. Re-scoring an old cycle with hindsight destroys the trend.

## Standing limitation

Everything here is subject to survivorship bias: it can only score predictions against
the users who showed up and spoke. People who evaluated TruePPM, found it unsuitable,
and left silently are invisible to this method and are exactly the population the
personas are most likely to be wrong about. Read every hit rate below as an upper bound.

---

## Pending assumptions (scoreable at the next cycle)

An assumption recorded here is not yet a cycle entry — no real-user signal exists to
score it against. It is documented in advance, with its falsification line fixed
*before* the data arrives, per the rule above ("Only findings that carried a
falsification line can be scored"). Move an entry out of this section and into a dated
cycle entry once it is actually scored; do not backfill the falsification line after
the fact.

### Task ceiling assumption (#3388)

**Claim:** projects in TruePPM's declared market do not exceed the ~1,000-task
Schedule ceiling (`administration/sizing.md`) often enough to matter. This is
load-bearing for the roadmap and is held at **T0 (modeled)** — see the Sarah persona's
2026-07 revision in `personas.md`, which moved "schedules above ~1,000 activities" from
a job requirement into the documented-gap list on modeled evidence alone.

**Falsifies the ceiling assumption:** two or more independent reports of a project
above 1,000 tasks in the first calibration cycle, from users who were not prompted
about size.

**Confirms it:** a cycle in which project size is never volunteered as a limitation.
Score a confirming cycle as *weak* evidence only, and say so in the entry — per the
Standing limitation above, the population that would falsify this leaves silently by
construction, so silence is not proof.

**Inputs now available (#3388):**
- The CSV/Excel import preview warns when a file would carry a project past the
  ~1,000-task line, and the Schedule shows a dismissible banner when a project is
  already past it. Both are pure UI, nothing transmitted (shipped part 1).
- The report-a-bug prefill (#2392) includes the task count of the project in view, when
  the page already has it cached, in the editable body the user submits themselves
  (shipped part 2). This is a channel, not a measurement — see its own doc comment
  (`packages/web/src/lib/feedbackContext.ts`) for why it will never be a complete
  sample.
- Part 3 (asking directly on the hosted demo) is **deferred**, blocked on the demo
  deployment itself (#2271) — not yet an available input.

## Cycle entries

### Pre-0.4 — baseline (no data)

**Status:** no calibration possible. TruePPM has not shipped a beta, so there is no
real-user signal to score against. All eleven personas are T0 (modeled).

Every persona-derived finding in the 0.4 milestone was produced by a simulated panel
with no real corroboration. That is a legitimate pre-launch position — it is recorded
here so it is never mistaken for a validated one.

**First real entry is due after 0.4 reaches users.** Inputs available at that point:
the in-product feedback link (#2392, now including project size per #3388), issues
filed by self-hosting operators, and the hosted demo (once #2271 ships). Until that
entry exists, no persona may be raised above T0 and no VoC output may claim
corroboration.
