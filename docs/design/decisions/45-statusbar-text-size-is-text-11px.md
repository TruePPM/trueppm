# Rule 45 — StatusBar text size is text-[11px]

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *UI Harmonization Rules (Issue #44)*

**StatusBar text size is `text-[11px]`** — this is a deliberate override of the 12px floor (rule 50) for the status bar only. 11px matches the design spec for this single component; do not apply `text-[11px]` elsewhere. The exception is documented here because the design system floor is 12px everywhere else.
