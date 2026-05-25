# Implementation notes — Notes / Mentions / Decisions (§12)

These notes reconcile `12-notes-mentions-decisions.md` against the TruePPM
code as it actually shipped, and record the scope decisions made on
2026-05-25. **Where this file and §12 disagree, this file wins** — §12 was
drawn against a hypothetical card-dialog layout that did not ship.

Scope of this reconciliation: **#740, #745, #748** (and a note on **#735**).
The other 11 specs in this batch map to unrelated board/schedule/import/
resource issues and are committed here unchanged for their own design-readiness.

## Layout: §12's 3-pane dialog → the shipped single-scroll drawer

§12 places its surfaces into a 3-pane dialog (Sidebar / Body / Activity rail)
from the #303 redesign. That layout never shipped: #303 closed with only the
detail drawer (#306) and the section extension point (#309) landed, and #306
shipped **variant B — a single-scroll 540px right drawer built from collapsible
sections** (`packages/web/src/features/schedule/TaskDetailDrawer.tsx`, the
`sections/` directory). Keep §12's *interactions, tokens, and copy*; drop its
3-pane *geometry*. Concrete placement:

| §12 surface | Shipped placement |
|---|---|
| #735 Blocker (sidebar field) | Field inside `sections/OverviewSection.tsx`, with §12's inline popover |
| #740 Notes (body pane) | New `sections/NotesSection.tsx` `CollapsibleSection`, sibling to Comments/Subtasks |
| #745 Mention picker (composer) | **Reuse the existing `sections/MentionAutocomplete.tsx`** (already wired to the comment composer) — do not build a second picker |
| #745 "My mentions" (top-level) | New top-level nav view — unchanged by the layout shift |
| #748 Decision chip + views | Chip in the drawer overview/header; project + sprint Decisions views unchanged |

Notes are distinct from Comments (§12): Comments (#311, `sections/CommentSection.tsx`)
already shipped and are *conversation*; Notes are *content* (kept, edited, decisioned).

## Scope decisions (2026-05-25)

1. **#740 search model — card-scoped dim only.** Ship §12's card-scoped
   client-side substring dim (`N of M notes`, 0.3 opacity, matches #323).
   Project-scoped Postgres FTS (GIN `SearchVector` + endpoint) is **split into a
   separate follow-up issue** — §12 itself defers it as "the future global notes
   search." #740 does **not** carry the FTS migration.
2. **#740 pinning — folded into #740.** Add a `pinned` bool to the notes model
   + sort `pinned > date desc` + pin affordance. It is part of the list §12 draws.
3. **#745 mention targets — RBAC auto-groups only.** Picker offers users +
   `@admins / @schedulers / @members / @viewers / @all / @scrum-team`. The §12
   "Teams" entity row (e.g. "Avionics — 7 people") is **dropped**: no standalone
   Team entity exists in OSS. Revisit only if workspace Groups (#519) are wired
   to project membership.
4. **#735 blocker states — issue model stands.** Keep `clear / at_risk / blocked`
   + `blocker_reason` + `blocker_assignee` (richer than §12's `none / blocked /
   self-blocked`). Treat §12's "self-blocked" as a reason nuance, not a 4th state.
