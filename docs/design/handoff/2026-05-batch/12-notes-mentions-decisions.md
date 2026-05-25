# #735, #740, #745, #748 — Notes, blocker, mentions, decisions

The card/task-dialog redesign (epic #303,
`docs/design/handoff/2026-05-card-task-dialogs/`) is the parent
surface. This spec lives inside that redesign — anywhere here that
says "card dialog" means **the new dialog from that handoff, not the
current one**.

Read that handoff first. The component names below assume its
structure.

## Children covered here

| ID | What |
|---|---|
| #735 | Structured Blocker tri-state field |
| #740 | Notes list + composer + full-text search |
| #745 | @mention autocomplete + in-app mentions + "My mentions" feed |
| #748 | Decisions views (project + sprint) + Decision toggle |

## Card dialog placement

The new card dialog has three vertical panes (per #303):
```
┌───────────────────────────────────────────────────────────┐
│  Header (title, id, status, breadcrumb)                   │
├──────────────┬───────────────────────┬────────────────────┤
│  Sidebar     │  Body                 │  Activity rail     │
│  (fields)    │  (description, notes) │  (events, mentions)│
└──────────────┴───────────────────────┴────────────────────┘
```

- **Blocker (#735)** → sidebar field, between Status and Assignee.
- **Notes (#740)** → body, below Description, above Subtasks.
- **Mentions (#745)** → composer-scoped; "My mentions" is a top-level
  app view (NOT in the dialog).
- **Decisions (#748)** → per-note toggle (in composer) + sidebar chip
  (in the dialog) + standalone view (project & sprint level).

---

## #735 — Structured Blocker (sidebar field)

### Tri-state field

```
Blocker
( • ) None
( ) Blocked       reason: __________________________
( ) Self-blocked  reason: __________________________
```

States:
- `none` — default. No badge, no halo.
- `blocked` — externally blocked. Reason text required (1-200 chars).
- `self-blocked` — the assignee themselves is the cause (e.g. waiting
  on themselves to finish something else). Reason optional but
  recommended.

### Sidebar UI

```
Blocker      [ None      ▾ ]
```

Click → opens a small inline popover:

```
┌──────────────────────────────────┐
│  Blocker                         │
│  ( ) None                        │
│  (•) Blocked                     │
│      Reason                      │
│      [ Waiting on vendor for     │
│        valve spec confirmation. ]│
│  ( ) Self-blocked                │
│                                  │
│             [ Cancel ] [ Save ]  │
└──────────────────────────────────┘
```

### How a blocked card reads on the board (reuses existing badges)

- `blocked` → existing red "blocked" badge on the card (no new badge
  surface). Reason shown on hover via tooltip + revealed at all densities
  ≥ `roomy` (#379).
- `self-blocked` → existing amber "self-blocked" badge (already in
  use? if not, add it parallel to blocked; same shape, amber bg).
- `none` → no badge.

### API

```ts
type Blocker =
  | { state: 'none' }
  | { state: 'blocked'; reason: string }
  | { state: 'self-blocked'; reason?: string };
```

### Definition of done — #735

- [ ] Tri-state radio + reason field.
- [ ] Validation: blocked requires reason.
- [ ] Board badge surfaces re-used, not reinvented.
- [ ] Reason visible at roomy + detail tiers.

---

## #740 — Notes (list + composer + search)

A card has zero or many **Notes**. Notes are timestamped, authored,
support @mentions (#745), and can be marked as Decisions (#748).
Distinct from Comments in the activity rail — Notes are content (kept,
edited, decisioned); comments are conversation.

### Layout in the dialog body

```
Description
…

────────────────────────────────────────────────────

Notes  (12)                              [ 🔍 Search notes ]

🟢 Decision · May 23 · Diego R.
   We're switching to the 12V LED panel. Vendor confirmed
   lead time.   [edit] [delete] [📌 pinned]

📝 May 22 · Amelia P.
   Field test revealed flicker at low duty cycle …
   [edit] [delete]

📝 May 20 · Diego R.
   Talked to procurement, awaiting confirmation on …
   [edit] [delete]

────────────────────────────────────────────────────

[ Add a note… ]                                ☐ Decision
                                               [ Save ]
```

### Note row

```tsx
<NoteRow
  note={note}             // { id, body, author, createdAt, isDecision, pinned }
  highlighted={searchMatch}
  onEdit={…}
  onDelete={…}
  onToggleDecision={…}
  onTogglePin={…}
/>
```

- 12px gap between notes; subtle 1px divider below each (use
  `--neutral-border`).
- Decision notes get a green dot before the timestamp and a tinted
  background `var(--brand-primary-light)` at 30% opacity.
- Pinned notes float to the top (sort order: pinned > date desc).
  Pin icon shows in the meta row.
- Body supports markdown (bold, italic, links, lists, inline code, @
  mention). Rendered via existing markdown lib.

### Composer

```
┌────────────────────────────────────────────────────┐
│  Add a note… (markdown supported)                  │
│                                                    │
│                                                    │
│  ────────────────────────────────────────────────  │
│  [B] [I] [↗] [`] [@]      ☐ Decision   [ Save ]    │
└────────────────────────────────────────────────────┘
```

- Auto-grow textarea, min 60px, max 320px (then internal scroll).
- Toolbar bottom-left: minimal formatting + `@` to trigger mention
  picker.
- "Decision" checkbox — pre-saves the note's `isDecision: true`.
- Cmd/Ctrl+Enter saves; Esc clears.
- Markdown preview tab? **No**. Render markdown on save; the composer
  is plain. Keep it lightweight.

### Mobile composer

- Toolbar collapses to a single `+` button → bottom sheet with
  formatting choices.
- Decision toggle becomes a chip at the bottom of the composer.
- Save button is full-width at bottom.

### Full-text search (note-scoped)

`[ 🔍 Search notes ]` in the section header. Click → expands inline
to an input. Match logic: substring across body + author name +
markdown-stripped text.

- Matching notes stay visible at full opacity.
- Non-matching notes dim to 0.3 opacity (same dim treatment as #323,
  for consistency).
- A counter inline with the search: `3 of 12 notes`.
- Esc clears + closes.

This is card-scoped search — distinct from board search (#323) and
the future global notes search.

### Edit / Delete

- Edit: in-place — note body becomes a composer with the existing
  body; Save/Cancel.
- Delete: confirm `"Delete this note? This can't be undone."`.
  Decisions show a stronger confirm `"This note is marked as a
  Decision and will be removed from the Decisions view."`.

### Definition of done — #740

- [ ] Notes list renders, sorted (pinned > date desc).
- [ ] Composer creates new notes with optional Decision flag.
- [ ] Edit + delete work with appropriate confirms.
- [ ] Markdown rendering matches existing description rendering.
- [ ] In-section search dims correctly.
- [ ] aria-live announces save success.

---

## #745 — @mention (autocomplete + in-app + "My mentions")

### Trigger

Typing `@` in any note composer (and the description editor — wire it
to the same hook). Opens a popover positioned below the caret.

### `<MentionPicker>`

```
┌──────────────────────────────────────┐
│  @  am                               │
│  ────────────────────────────────── │
│  👤 Amelia Park       Engineering    │
│  👤 Amir Hadid        Procurement    │
│  ────────────────────────────────── │
│  Teams                                │
│  👥 Avionics          7 people        │
│  ────────────────────────────────── │
│  Roles                                │
│  🎩 @ admins          notify all admins│
└──────────────────────────────────────┘
```

- Max 6 visible rows; arrow-key nav; Enter or Tab inserts; Esc closes.
- Insert format: rich token. In the composer it renders as a chip:
  `[Amelia Park]`; serialized to markdown as `@[Amelia Park](user:abc123)`.
- Types: users, teams, roles (admins, editors). Roles are rare and
  appear only after typing 3+ chars or scrolling.

### Mobile mention picker

- Popover becomes a bottom-anchored sheet (200px tall, scrollable).
- Renders above the soft keyboard.

### In-app notifications (mention received)

When a user is mentioned in a note:
- A notification arrives via the existing notification system
  (`[BACKEND]` reuses the existing pipeline).
- Type: `mention`. Payload: `{ noteId, cardId, projectId, byUserId }`.
- Renders in the notification bell dropdown:
  ```
  💬 Diego mentioned you in Pad lighting study
     "Hey @Amelia — can you confirm the …"
     2m ago        [ Open card ]
  ```

### "My mentions" feed (top-level view)

A new sidebar nav item, `Mentions`, opens a dedicated feed.

```
Mentions
[ All ] [ Unread ] [ Last 7 days ] [ This project ]

────  Today  ────

💬 Diego mentioned you in T-001 · Pad lighting study
   "Hey @Amelia — can you confirm the …"
   2m ago                          [ Open card → ]

💬 Sarah mentioned you in T-018 · Vendor RFQ
   "Can you push back on the @Amelia ..."
   1h ago                          [ Open card → ]

────  Yesterday  ────
…
```

- Same row pattern as the activity rail (#325).
- Filter chips: All / Unread / Last 7 days / This project.
- Click row → opens the card dialog scrolled to the note + the note
  briefly highlights (200ms pulse, `--brand-primary-light` bg).
- Marking read: rows visited become "read" automatically. A "Mark
  all as read" button at the top right.

### Definition of done — #745

- [ ] Mention picker triggers on `@` with typeahead.
- [ ] Users / teams / roles all selectable.
- [ ] Selected mention renders as a chip in the composer.
- [ ] Markdown serialization is round-trippable.
- [ ] In-app notification fires on mention.
- [ ] "My mentions" feed view + filters work.
- [ ] Click-through opens card + highlights note.

---

## #748 — Decisions views + Decision chip

### Decision chip

When a card has any note flagged as `isDecision: true`:
- Sidebar chip appears below status:
  ```
  ✓ 2 decisions
  ```
- Click → scrolls the body to the first decision note (smooth scroll
  + 200ms highlight pulse on each decision in sequence).

### Project-level Decisions view

A new tab in the project nav: `Decisions`.

```
┌──────────────────────────────────────────────────────────┐
│  Decisions in Artemis IV                                  │
│  ──────────────────────────────────────────────────────  │
│  All · Last sprint · This sprint · Search…                │
│  ──────────────────────────────────────────────────────  │
│  🟢 May 23 · Diego R.                                     │
│     T-001 Pad lighting study                              │
│     "We're switching to the 12V LED panel. Vendor         │
│      confirmed lead time."                                │
│                            [ Open card → ]                │
│                                                          │
│  🟢 May 19 · Amelia P.                                    │
│     T-014 LED replacement test                            │
│     "Field test passed at 24V; we're going with this."   │
│                            [ Open card → ]                │
└──────────────────────────────────────────────────────────┘
```

- Sorted by note `createdAt` desc.
- Each row: author + date + card breadcrumb + body excerpt
  (first 240 chars, truncated).
- Click → opens card with note highlighted (same behavior as
  mentions feed).
- Filter: `All`, `Last sprint`, `This sprint`, plus a search field.

### Sprint-level Decisions view

Inside each sprint detail page, a `Decisions` section showing
decisions made during that sprint (note.createdAt ∈ sprint range).

- Same row layout as project view, scoped to the sprint.
- Used in sprint retros: "What did we decide this sprint?"

### Definition of done — #748

- [ ] Decision toggle in composer + edit form.
- [ ] Sidebar chip count + click-to-scroll.
- [ ] Project Decisions tab + filters.
- [ ] Sprint Decisions section.
- [ ] Decision notes carry green-dot styling everywhere.

---

## AA — shared across this spec

- All popovers (mention picker, blocker editor, decision toggle) trap
  focus and close on Esc.
- Composer textarea has visible label `<label>Add a note</label>`,
  visually hidden but present.
- Decision toggle: `<input type="checkbox" aria-label="Mark this note
  as a decision">`.
- Mention chip: `<span role="link" aria-label="Mention of Amelia
  Park">` (a chip is a permanent reference, not interactive — but
  click-to-open-profile is OK if it does anything).
- Search inputs follow the #323 pattern (aria-live counter).

## Cross-references to other specs

- Composer + dialog density: align with #303 redesign tokens.
- Mention picker on mobile: same sheet primitive as #318 dialog.
- Notes search dim: same visual rule as #323 board search.
- Decision green dot: same `--brand-primary` family as on-track signal.

## Definition of done (overall)

- [ ] All four children land their surfaces.
- [ ] Decision toggle in composer + sidebar chip + project view +
      sprint view are visually linked (same dot + green family).
- [ ] Notes section in dialog feels like one cohesive surface, not
      four bolted-on features.
- [ ] `visual-specs.html → §10` matches.
