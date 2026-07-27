# Rule 159 — WIP-limit indicators use the shared three-band wipState() — never a local count > limit check

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Program visual identity & wayfinding (Issue #963)*

**WIP-limit indicators use the shared three-band `wipState()` — never a local `count > limit` check.** Every WIP-limit surface (board column header/badge, the sprint-panel header chip, future swimlane/column counters) imports `wipState(count, limit)` from `features/board/wip.ts` and maps the band to chrome identically: `under` → neutral, `at` (count === limit) → `text-semantic-at-risk` amber, `over` → `text-semantic-critical` red (rule 145 keeps those as the AA-dark text variants, never the brand fill hue), `none` (limit null) → suppressed/neutral. A `5/5` at-limit state must read amber everywhere and never neutral on one surface and amber on another — a two-band local check is the drift bug the #546 ux-review caught. Color is never the sole cue: pair the flagged bands with a `⚠` glyph (`aria-hidden`) and an aria-label that names the band ("at limit" / "over limit"), per rule 107 (WCAG 1.4.1).
