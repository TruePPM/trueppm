# Rule 162 — An aria-hidden visual column-header row is the correct pattern when every column's control already carries its own accessible name and the mobile layout re-labels inline

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Responsive labels & presentational headers (Issue #975 / #974)*

**An `aria-hidden` visual column-header row is the correct pattern when every column's control already carries its own accessible name and the mobile layout re-labels inline.** The Project → Team facet roster (`ProjectTeamPage.tsx`) renders a `hidden sm:flex` header row (`Member / Role / Scrum Master / Product Owner`) that is `aria-hidden="true"`: the role `<select>` and the two facet `role="switch"` toggles each own their `aria-label`, and the `< sm` layout labels each control inline per row, so a SR-exposed header would only duplicate. Do not "fix" such a header by removing `aria-hidden` (it re-introduces the duplication) and do not drop the header (sighted desktop users lose the column key). Column widths in the header must mirror the row's exactly (`flex-1 / w-32 / w-36 / w-36` + `gap-3 px-4`).
