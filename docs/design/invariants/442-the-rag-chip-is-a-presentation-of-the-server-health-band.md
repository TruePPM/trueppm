# Rule 442 — The RAG chip is a presentation of the server's health band; no client threshold, no second health vocabulary

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Signal encoding*. The index carries the rule's headline; this file carries its full text (#3744, ADR-0653 amendment). Binding everywhere, not only on the surface that produced it.

**Wherever shell v2 shows red / amber / green health, it renders `HealthBandChip` (`src/components/page2/StatusChip.tsx`) with the band the server returned as `health_band`. The chip takes a `HealthBand`, not counts or a percentage, so it has nowhere to put a client-side threshold; its word comes from `HEALTH_BAND_LABEL` (rule 397).**

**Why.** The Pass 2 design drew a RAG chip and left open whether it was a new health vocabulary. The maintainer ruled on 2026-11-07 (#4795, recorded on the issue): RAG *is* the server band `lib/healthBand` already prints. A second vocabulary — a client "amber at 80% complete", a "red if more than three overdue" — would disagree with the band the server computes (including the PM's manual override), and rule 397 records what that disagreement looked like in production (#3470, #3501).

**How to apply.**

1. A payload that should show RAG but carries no `health_band` gets the field added server-side; the client never derives one (rule 397(b)).
2. The shell context header's health chip renders through `HealthBandChip`; a new surface does the same rather than mapping the band onto its own classes.
3. Band → tone is fixed: `critical` → red (▲), `at_risk` → amber (◆), `on_track` → `ok` (✓), per rule 440.

Binds #4799. Reference: `lib/healthBand.ts`, `features/shell2/ContextHeader2.tsx`.
