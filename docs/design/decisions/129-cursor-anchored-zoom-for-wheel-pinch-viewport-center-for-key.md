# Rule 129 — Cursor-anchored zoom for wheel/pinch; viewport-center for keyboard/toolbar

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Schedule View Interaction Rules (Issues #351 / #491)*

**Cursor-anchored zoom for wheel/pinch; viewport-center for keyboard/toolbar.** Ctrl/Cmd+wheel (and trackpad pinch, delivered by the browser as a ctrl+wheel) zoom toward the pointer — the date under the cursor stays fixed (`setPxPerDay(px, { clientX })`: capture `anchorDate` + `viewportX` before the scale change, restore `scrollLeft = newAnchorCanvasX − viewportX`). The `−`/`+` buttons and `⌘=`/`⌘-` keyboard zoom use viewport-center anchoring (rule 80). Plain wheel over the timeline keeps scrolling; plain wheel over the left task-list pane keeps scrolling vertically — only the Ctrl/Cmd modifier zooms.
