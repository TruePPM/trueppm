# ADR-0845: A baseline freezes the working calendar it was computed against

## Status
Accepted

## Context

The commit moment (#2963) takes **baseline v1 automatically** on `draft → active`. That
baseline is the anchor every later variance number is measured from — the answer to "what
did we agree to."

Every date in it was computed by the CPM engine against a **working calendar**: which days
are working days, the holiday exceptions, `hours_per_day`. Change that calendar afterwards
and the engine recomputes; the question this ADR settles is whether the *baseline* moves
with it.

The design package raises this as its own open question and does not answer it. Left
unanswered it gets decided implicitly by whoever writes the capture code, which is the
worst outcome — it becomes a permanent semantic nobody chose.

## Decision

**A baseline freezes the working calendar it was computed against.** The captured dates,
and the calendar that produced them, are immutable together.

A later calendar edit changes the live schedule and therefore changes *variance*. It does
not silently move the thing variance is measured from.

### The correction case gets an explicit act, not silent drift

The real argument for a live calendar is a **correction**: you forgot a public holiday, and
now every baselined date is wrong in the same direction. Under a frozen baseline you are
measuring against a plan you know to be mistaken.

That case is served by **"rebaseline with the corrected calendar"** — a deliberate, logged
action that captures v2 and says why. It is not served by having v1 quietly change shape.

This is the same rule the rest of the package applies everywhere else: a structural change
to committed work carries a reason and reaches the people affected (#2964). A calendar
correction *is* a structural change to committed work. It should look like one.

## Consequences

**Variance stays falsifiable.** "We are 6 days late" means something you can check, because
both sides of the subtraction are fixed. Under a live calendar, adding one forgotten
holiday shifts the baseline and the variance quietly shrinks — the number improves at the
exact moment the plan got harder, and nothing on screen says so. That failure is silent,
directional, and flattering, which is the worst combination a metric can have.

**A steering committee can be shown the same number twice.** A baseline that moves is not
an anchor; it is a second live schedule wearing the word "baseline".

**Cost, stated plainly:** after a calendar correction, v1 is measurably wrong and stays
wrong until someone rebaselines. We accept that. A visibly stale anchor with a visible
remedy is better than an invisible one that silently agrees with whatever you last changed.

**Storage:** the baseline records the calendar id and a snapshot of the fields that affect
date arithmetic (`working_days` mask, `hours_per_day`, and the holiday exceptions in range).
The id alone is insufficient — calendars are editable, so a reference would give exactly
the drift this ADR rejects.

## Alternatives considered

**Live calendar (baseline dates recomputed on calendar change).** Rejected. It makes a
correction cheap and makes every variance number unfalsifiable, because you can no longer
tell whether a delta moved because the work slipped or because the calendar was edited. It
also fails the case the baseline exists for: showing a committee what changed since the
commitment.

**Freeze, with no rebaseline path.** Rejected as the same decision minus the escape hatch.
The correction case is real and common; refusing to serve it just means people stop trusting
the baseline instead of fixing it.

**Ask at commit time ("freeze this calendar?").** Rejected. It is a question with one
defensible answer, asked at the moment the user is least equipped to reason about it, and
whichever way they answer the resulting semantics differ per project — so no cross-project
variance comparison would mean the same thing twice.

**Freeze the calendar but not the dates.** Incoherent — the dates *are* the baseline.
Recorded only because it came up: freezing the inputs while letting the outputs float gives
neither reproducibility nor correction.

## Open, and deliberately not decided here

Whether a **calendar correction should prompt** "your baseline was computed against a
different calendar — rebaseline?" is a UX question for #2963's follow-on, not a semantic
one. The semantics are settled by this ADR either way; the prompt is an affordance over
them and can be added or dropped without changing what a baseline means.
