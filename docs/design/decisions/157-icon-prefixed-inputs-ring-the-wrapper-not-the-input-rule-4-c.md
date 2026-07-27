# Rule 157 — Icon-prefixed inputs ring the wrapper, not the input (rule 4 corollary)

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Icon-prefixed input focus (Issue #933)*

**Icon-prefixed inputs ring the wrapper, not the input (rule 4 corollary).** When an `<input>` sits inside a bordered `<span>`/`<div>` alongside a leading icon — the `flex items-center gap-2 rounded-md border … h-9` field pattern used in `PromoteMilestoneDialog` (`CreateModeBody`, `BindModeBody`) — the rule-4 focus ring goes on the **wrapper** via `focus-within:ring-2 focus-within:ring-brand-primary focus-within:ring-offset-1`, with `focus-visible:outline-none` on the inner input. Stripping the input's outline without a wrapper ring leaves the field with **no** focus indicator (WCAG 2.4.7) — the regression the #933 ux-review caught. A bare text/date input with no icon wrapper rings itself directly, per `PlanSprintModal`. (Same `focus-within` rationale as rule 124's settings search box.)
