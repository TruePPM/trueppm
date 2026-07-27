# Rule 76 — Performance budget (enforced in CI visual regression):

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Performance*

**Performance budget (enforced in CI visual regression):**
- First render of 2,000 tasks: < 200ms
- Frame budget during drag (500 tasks): < 16ms (60fps)
- Zoom level change: < 100ms
- Smooth scroll at 60fps with no dropped frames
Any PR that regresses these targets must include a profiler screenshot.
