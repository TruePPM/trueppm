# #323 — Board full-text search (dim-in-place)

## Resolved decisions
- Search **dims** non-matching cards rather than removing them. This
  preserves spatial memory of the board.
- Field placement: leftmost slot in the board toolbar, next to view
  switcher. On mobile (`≤ 768px`) it collapses to a search icon button
  that expands into a top-of-content overlay input.
- Keyboard: `/` focuses, `Esc` clears + blurs, `↵` does nothing
  special (search is incremental).

## Components

### `<BoardSearch>` (toolbar slot)

```tsx
<BoardSearch
  value={query}
  onChange={setQuery}
  resultCount={matchedIds.size}
  totalCount={visibleCardIds.length}
/>
```

Desktop layout:
```
┌──────────────────────────────────────────────┐
│ 🔍  Search cards…           3 of 40       ×  │
└──────────────────────────────────────────────┘
   240px wide                  mono   reveal on hover
```

Mobile collapsed → expanded:
```
[🔍]   →   tap   →   full-width sheet at top with input + Cancel
```

- Width: `240px` at rest desktop. Grows to `360px` on focus.
- The result counter sits inside the field, right-aligned, `.tppm-mono`,
  `color: var(--neutral-text-secondary)`. Hidden when query is empty.
- Clear button (`×`) appears only when query is non-empty.

## Dim-in-place visual contract

```css
.board-card[data-search-dim="true"] {
  opacity: 0.18;
  filter: saturate(0.4);
  pointer-events: none;     /* dimmed cards can't be clicked/dragged */
}
.board-card[data-search-match="true"] {
  /* no positive treatment — un-dimmed *is* the highlight */
}
```

- Do NOT add a brand-colored ring/glow to matches. Quieter is better;
  the dim is the contrast.
- Within a matched card, the matching substring(s) get
  `background: var(--brand-accent-light); border-radius: 2px;` — amber
  text highlight, no font-weight change.
- When `query === ''`: `data-search-dim` and `data-search-match`
  attributes are removed entirely (no rules apply).

## Matching rules
- Searches: `title`, `id`, `assignee.name`, `labels[].name`,
  `description` (first 500 chars only — keep client-side cheap).
- Case-insensitive, accent-insensitive (`'Renée' ~~ 'renee'`).
- Tokenized: query `"valve test"` matches a card whose title contains
  both words in any order.
- Fuzzy: NO — straight substring after tokenization. Fuzzy hits hurt
  Sarah-on-site's confidence ("did I really mean that card?").

## States

| State | Behavior |
|---|---|
| empty (query: '') | counter hidden; all dim attrs removed; field placeholder visible |
| typing / results | debounce 80ms, then re-derive `matchedIds`. Counter updates aria-live polite |
| no-results | counter shows `"0 of 40"`; show inline secondary text below field: `"Nothing matches 'foo'. Try a card ID or assignee."` |
| cleared | snap back to empty in 1 frame; no transition |

## Persistence

Search query is **transient** — not persisted to `BoardSavedView` (D1
specifies this explicitly). It does NOT survive page reload, view
switch, or even tab focus loss.

## Keyboard

| Key | Effect |
|---|---|
| `/` (anywhere on board view) | focus + select-all in field |
| `Esc` (when focused) | clear value, blur field |
| `Esc` (with value, anywhere) | clear value (caught by board-view-level handler) |

`/` shortcut must yield to text inputs — bind on `keydown` and check
`event.target` is not an `<input>` / `<textarea>` / contenteditable.

## AA

- Field is `<input type="search" aria-label="Search board cards" />`.
- Counter has `aria-live="polite"`:
  `"3 cards match {query}"` (full sentence, not just "3 of 40", so SRs
  read sensibly). Debounce to once per ~600ms while typing.
- No-results inline message has `role="status"`.
- Dim is via opacity, not display:none — non-matching cards remain in
  the accessibility tree but are also `aria-hidden="true"` while
  `pointer-events: none`.

## Edge: search + selection (#276 interaction)

- Selecting a card that then becomes dimmed (via search) is fine — it
  stays in `selection`. The ActionBar count still reflects it.
- Clearing search un-dims selected cards visibly.
- Selecting from inside a search: hover behavior on a non-dimmed card
  reveals the checkbox as normal.

## Edge: search + groupBy (#324)

- A lane with zero matches in the current search collapses its label
  to dimmed and shows `"0 matches"` next to the count chip, but does
  NOT auto-collapse the lane.

## Definition of done

- [ ] `/` from anywhere on the board view focuses the field; not
      hijacked when an input has focus.
- [ ] Counter updates inside 100ms of last keystroke for ≤ 1000 cards.
- [ ] aria-live announces the count politely without spamming.
- [ ] No-results inline copy renders.
- [ ] Mobile collapse/expand works on iOS Safari.
- [ ] `visual-specs.html → §2` matches.
