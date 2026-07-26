# Rule 156 — Edit rights follow the ADR-0078 §D low-consent split: project Admin+ OR explicit team Admin

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Team Settings + Facet Axis Rules (Issue #927, ADR-0078)*

**Edit rights follow the ADR-0078 §D low-consent split: project Admin+ OR explicit team Admin.** `canEdit` is `myRole >= ROLE_ADMIN` (project inheritance) **or** the caller's own team-membership row has `role === 'admin'`. Read-only callers (viewers, plain members) get the same roster with the role `<select>` replaced by static text and the switches `disabled` — facet badges stay visible so everyone can *see* who the SM/PO is. The server enforces the same gate (`IsTeamFacetEditor`) and 403s regardless; the render-gate is UX only.
