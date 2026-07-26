# Rule 254 — A semantic-toned status value must also differ in *text*, not tone alone (WCAG 1.4.1): give each band its own label/delta string so on-track vs at-risk vs over never read identically to a colorblind user

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *A neutral read-state chip may become a tap-to-explain disclosure (Issue #1472)*

**A semantic-toned status value must also differ in *text*, not tone alone (WCAG 1.4.1): give each band its own label/delta string so on-track vs at-risk vs over never read identically to a colorblind user.** Reference: `features/me/myWorkFocus.ts` (`utilizationCard` — "of capacity" / "near capacity" / "over capacity" per band, #1912).
