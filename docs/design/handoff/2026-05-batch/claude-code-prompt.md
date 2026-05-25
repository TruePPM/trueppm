# Claude Code: implement the 2026-05 design batch

Paste this into Claude Code with `handoff-2026-05-batch/` attached or
in the repo. The package covers 14 issues across 5 surfaces — read
the README first to get the map.

---

I'm handing you a packaged design pass covering these issues:

- **Board:** #276, #323, #324 (incl. #608), #325, #326, #379
- **Schedule:** #491 (paired with #351), #318
- **Import:** #68, #111
- **Resource:** #330, #489 (impl. lives in #747)
- **Card/Notes:** #735, #740, #745, #748

All open decisions in the original briefs are resolved in the spec
docs. Don't re-open them mid-build. If something feels wrong, flag it
and let me decide — don't drift.

## How to read the package

1. `handoff-2026-05-batch/README.md` — index + cross-cutting decisions
   (D1–D6).
2. `handoff-2026-05-batch/00-design-system-context.md` — tokens,
   file paths, AA baseline. Anchor every component to the paths in
   §"File path conventions."
3. Per-issue specs: `01-…md` through `12-…md`. Each has resolved
   decisions, component skeletons (with prop signatures), states,
   AA notes, definition-of-done checklist.
4. `visual-specs.html` — visual reference for the surfaces where a
   picture matters (bulk bar, dim treatment, group-by, activity rail,
   density tiers, cross-view drag layout, import wizard, overalloc
   language, notes + mentions + decisions). Open in browser.

## Build order (do NOT do it in ticket-number order — there are deps)

### Phase 0 — shared primitives (1–2 days)
Build these first; they unblock everything else.

1. **`<ActionBar>`** (used by #276; might be reused by future bulk-
   action surfaces). See `01-board-bulk-select.md`.
2. **`<OverallocBadge>` + `<OverallocBanner>`** (#330, #489).
   See `11-overalloc-language.md`.
3. **`<ImportModal>` shell + `<ImportDropzone>` + `<ImportProgress>`
   + `<ImportResults>`** (#68). See `09-import-pattern.md`.
4. **`useBoardSelection` hook** (#276). See `01-…`.
5. **`BoardSavedView` schema + migration** from `useBoardToolbarPrefs`.
   See README D1.

### Phase 1 — Board toolbar refactor (2–3 days)
Consolidate everything that touches the toolbar so we don't re-touch
it three times.

6. `<BoardSearch>` (#323).
7. `<BoardGroupByControl>` + `<SwimlaneRow>` (#324/#608 reconciled).
8. `<BoardZoomControl>` + density-tier CSS (#379).
9. Wire all three to `BoardSavedView`.

### Phase 2 — Board features built on the toolbar (2–3 days)
10. Bulk select interaction wiring on `<BoardCard>` (#276).
11. `<BoardActivityRail>` (#325).

### Phase 3 — Schedule (2–3 days)
12. Drag-to-pan + cursor states + discoverability hint (#491).
    Land alongside the existing #351 zoom work; share the `viewport`
    state.
13. Backlog rail + cross-view drag (#318). This depends on density
    tiers from #379 (cards in the rail render at `compact`).

### Phase 4 — Import wizard (2 days)
14. CSV/Excel wizard (#111) using the shell from #68. Auto-match
    dictionary, WBS detection, preview pane.

### Phase 5 — Card/Notes (3–4 days)
Assumes the #303 card dialog redesign is landed or close to it.

15. Blocker tri-state (#735) — simplest of the four, ship first.
16. Notes panel + composer + in-section search (#740).
17. Mention picker + in-app notifications + "My mentions" feed (#745).
18. Decision chip + project & sprint Decisions views (#748).

### Phase 6 — PDF export (1 day, can be parallel)
19. Print stylesheet + WeasyPrint route (#326). Doesn't depend on
    other phases; can be done by a separate engineer.

## Process expectations

- **For each component**, before writing it: show me 1) the file path
  you plan to put it at, 2) the prop signature, 3) which existing
  primitive you're reusing (if any). I'll thumbs-up or steer.
- **Don't add new colors.** If you reach for something not in
  `tokens.css`, stop and ask.
- **Don't add new icon sets.** Reuse the existing lucide-react inventory.
- **AA is not optional.** Every spec lists the AA requirements; if a
  component you write doesn't pass axe-core on its story, it's not done.
- **Don't try to land Phase 5 before #303 is in.** Notes/mentions
  assume the new dialog structure.

## What you should produce per phase

- A short PR per phase (or per ticket if the phase has a clear cut).
- Story-book entries (or whatever the project uses) for every new
  component.
- `[BACKEND]` notes flagged in the specs — call them out in the PR
  body if you need API work I haven't ordered yet.

## Open questions you can defer (don't block on these)

- Exact WebSocket channel name for the activity feed (#325).
- Whether the activity feed should display events from before the
  user joined the workspace (default: yes, but flag if it gets too
  noisy).
- Workspace-level threshold overrides for overallocation (#330/#489) —
  ship with defaults baked in, add settings UI in a follow-up.

When you're done with a phase, show me a video of the new surface
working end-to-end on desktop + mobile, and the AA report.
