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

## Cycle entries

### Pre-0.4 — baseline (no data)

**Status:** no calibration possible. TruePPM has not shipped a beta, so there is no
real-user signal to score against. All eleven personas are T0 (modeled).

Every persona-derived finding in the 0.4 milestone was produced by a simulated panel
with no real corroboration. That is a legitimate pre-launch position — it is recorded
here so it is never mistaken for a validated one.

**First real entry is due after 0.4 reaches users.** Inputs available at that point:
the in-product feedback link (#2392), issues filed by self-hosting operators, and the
hosted demo. Until that entry exists, no persona may be raised above T0 and no VoC
output may claim corroboration.
