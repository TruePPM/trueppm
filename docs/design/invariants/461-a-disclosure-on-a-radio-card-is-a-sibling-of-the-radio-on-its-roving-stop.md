# Rule 461 — A disclosure on a `role="radio"` card is a sibling of the radio, and its Tab stop rides the roving index

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md). The index carries the headline; this file carries the full text (#3821).

**When a card that is itself a `role="radio"` button needs its own control — a "show more" disclosure, a details toggle — that control is rendered as a sibling of the radio inside a shared box, never inside the radio.** A `<button>` may not contain interactive content, and ARIA makes a button's children presentational: a toggle nested in the radio is invalid HTML, and a list nested in it is flattened into the radio's accessible name, so a screen reader announces every row before the template's name. The shared box carries the border and the selected tint, so the two still read as one card; the radio keeps the focus ring and the summary as its name.

**The sibling's `tabIndex` follows the group's roving index** (`useRovingTabIndex`, rule 167): only the focused card's toggle — and, once open, its scroll region — is a Tab stop. Tab moves radio → its toggle → out of the list, instead of through one toggle per card, and the arrow keys keep roving the radios from the radios and their toggles because the group's `onKeyDown` handles them, but NOT from the scrollable list: the list stops those keys from bubbling so ArrowUp/Down/Home/End scroll it instead of jumping to another card. Toggling never selects the card. A disclosed region that scrolls is focusable on the same stop, so a keyboard user can read past its fold.

Reference: `TemplateOutlineDisclosure` in `packages/web/src/features/shell/TemplateCard.tsx` and `TemplateOption` in `TemplateGallery.tsx` (#3084).
