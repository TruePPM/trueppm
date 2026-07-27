# Rule 108 — Canonical view tab order is Overview · Board · Schedule · WBS · Table · Calendar · Team · Risks

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Shell Navigation Rules (Issues #204–#205)*

**Canonical view tab order is `Overview · Board · Schedule · WBS · Table · Calendar · Team · Risks`** (issue #204, updated per VoC review 2026-04-29). Overview is first — it is the canonical landing/orientation surface (ADR-0030). Board is second — the execution surface. The route segment for the Schedule view is `/schedule`. Never change this order without a design review. `ViewTabs.tsx` is the source of truth. The mobile `BottomNav` mirrors this order and omits Risks (infrequent on mobile). The methodology-gated **Backlog** tab (`product-backlog`, #1096) sits between **Board** and **Sprints**, visible only on Agile/Hybrid projects (gated via `methodologyTabs.ts`, the same mechanism as Sprints — web-rule 154); it links to the existing `/projects/:id/product-backlog` grooming page. It is desktop-only: `BottomNav` deliberately does **not** mirror it (an 8th mobile tab harms phone UX; mobile backlog cards are tracked in #1044).
