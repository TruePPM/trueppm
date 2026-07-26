# Rule 155 — Role and facets are independent axes; the two facets are soft-singletons reassigned by the server

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Team Settings + Facet Axis Rules (Issue #927, ADR-0078)*

**Role and facets are independent axes; the two facets are soft-singletons reassigned by the server.** A `TeamMemberRow` carries a team-role `<select>` (Member/Admin) plus two `role="switch"` facet toggles (`FacetToggle`) for Scrum Master and Product Owner — never conflate them (an Admin need hold no facet; a Member can be Product Owner). Turning a facet **on** when another member already holds it does **not** PATCH immediately: the page shows an inline `role="alertdialog"` confirm ("{holder} is currently {facet}. Make {target} the {facet} instead?") with Reassign/Cancel, because the server clears the prior holder (at most one per team). Turning a facet **off** is immediate (the facet may sit vacant). On success, invalidate the whole `['team-members', teamId]` query — the prior holder's row changed too, so never patch a single row optimistically.
