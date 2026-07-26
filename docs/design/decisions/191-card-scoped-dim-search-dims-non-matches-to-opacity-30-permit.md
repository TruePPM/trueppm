# Rule 191 — Card-scoped dim-search dims non-matches to opacity-30 — permitted ONLY because the dim is transient, user-initiated, and never the sole signal

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Task notes (Issue 740, ADR-0143)*

**Card-scoped dim-search dims non-matches to `opacity-30` — permitted ONLY because the dim is transient, user-initiated, and never the sole signal.** The notes search filters the already-fetched list client-side (substring over body + author name); matches stay `opacity-100`, non-matches drop to `opacity-30` (they remain visible, not removed). Dimmed text at 0.3 is below the AA contrast floor, so it is allowed **only** with all of: (a) the dim is driven by the user typing and clears on empty/`Escape`; (b) matched bodies carry a `<mark>` highlight (`bg-brand-primary/20`) so the match is conveyed by more than opacity; (c) a `role="status" aria-live="polite"` "N of M notes" counter announces the result count to AT. Never use `opacity-30` as a persistent or load-time state for text the user must read — it is a search-affordance pattern, not a disabled/secondary style (use `text-neutral-text-secondary`/`-disabled` tokens for those).
