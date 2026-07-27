# Rule 228 — Touch-target size compaction keys off md: (≥768px), NEVER sm: (≥375px)

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Touch targets and calendar day-type encoding (Issue #906)*

**Touch-target size compaction keys off `md:` (≥768px), NEVER `sm:` (≥375px).** A control that is 44px on touch and collapses to a compact desktop size (32/36/38px) must express the shrink with a `md:` variant — `min-h-[44px] md:min-h-[32px]`, `h-11 w-11 md:h-8 md:w-8` — not `sm:`. The subtlety: `useBreakpoint`'s `sm` tier is "< 768px" (touch/mobile), but Tailwind's `sm:` utility fires at **375px**, which is still a phone. So `min-h-[44px] sm:min-h-[32px]` silently drops the target below the 44px WCAG 2.5.5 minimum on every real phone from 375px up — the compaction fires exactly where you needed the large target. Compact only at `md:`+, where a pointer is the primary input. Reference: the month-pager, row-remove, Retry, empty-state CTA, and bottom-sheet footer buttons in the Working-calendars panel (`features/settings/project/ProjectCalendarsPage.tsx`, `AddCalendarPicker.tsx`) — all `md:`-keyed.
