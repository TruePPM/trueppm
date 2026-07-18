# Design — Custom Fields on Board Cards (#1989)

**Status:** Design phase (pre-implementation). **Pending user approval.** OSS / Apache-2.0.
**Owner issue:** #1989 — `design(web): custom fields on board cards — UX review & design (VoC-informed)`.
**Related:** #521 (custom-field *definitions* — `ProjectCustomField`, shipped) · #103
(Extension SDK — custom fields/views/widgets epic; this is the narrow board-card
*presentation* slice, not the SDK) · card-readability precedent **#1924 / #1925** · the
worst-offender calm-card principle **#1305 / ADR-0191** · compact/mobile board reflow
**web-rule 193** · coarse-pointer peek **web-rule 256** · clamped-value recovery
**web-rule 255**.
**Scope of this doc:** the **card-face presentation** of task custom-field values plus the
**per-field visibility config**. It is a `/voice-of-customer` + `/ux-design` design note.
**It is not a build**, and it deliberately does **not** design the prerequisite value model
(see §0).

---

## 0. Honest-tense callout — what exists today vs. what this design assumes

> **Read this first. It governs the whole document.** The issue frames this as "custom
> fields exist as data but are not surfaced on cards." That is **half true**: field
> **definitions** exist; per-task **values do not**. This design is drawn in full now so
> the value surface can be built against it, but the card cannot render a value that is
> not yet persisted.

| Element | Status on `main` today (2026-07) | Tense |
|---|---|---|
| `ProjectCustomField` definition model (TEXT/NUMBER/DATE/SINGLE_SELECT/MULTI_SELECT/USER/BOOLEAN, `options[{value,label,color?}]`, `required`, `order`, `server_version`, cap 32/project) | **Real** (#521, `projects/models.py`) | present |
| `ProjectCustomFieldSerializer` + `/projects/{id}/fields/` CRUD; Settings → Workflow → Fields config UI (`ProjectWorkflowPage.tsx` `FieldsSection` + `CustomFieldModal`) | **Real** (#521) | present |
| Per-task custom-field **values** (`TaskCustomFieldValue` or equivalent), on the Task read payload, offline-syncable via `server_version` | **Does not exist** — the model docstring calls it a "follow-up" | **future** — a **prerequisite** issue (§9, issue A) |
| `show_on_card` boolean on `ProjectCustomField` | **Does not exist** — additive field (§6, issue A) | **future** |
| Card-face rendering + config toggle (this design) | **Design only** | **future** — issue B (§9) |

**Sequencing consequence:** the card-rendering work (issue B) is **blocked on** the value
model (issue A). This design describes the end state; §9 splits it into the shippable
issues in dependency order.

---

## 1. Decision summary (read first)

1. **Visibility is a per-field opt-in flag, `show_on_card`, off by default.** Not
   per-board, not type-aware auto-defaults, not "show all." A field appears on the card
   face only when an author with Scheduler+ role flips its `Show on card` toggle in
   Settings → Workflow → Fields. Everything else stays drawer-only. (§2, §6.)
2. **A board-level master switch, `Show custom fields on cards` (default ON), lets the
   people who live on the board suppress the whole class in one click** without touching
   any project-admin field config — the OSS answer to Morgan's consent concern (§6).
3. **Custom-field marks are the *lowest-priority* occupants of the card.** They render
   **after** every existing element (health badge, story points, dep/risk chips, labels,
   assignees) and are the **first** to collapse into overflow. A custom field can never
   push the worst-offender health badge or the story-point pill off the scarce row
   (Alex's blocker, §3).
4. **Type-aware compact rendering, one treatment per field type** — colored chip
   (selects), glyph (boolean), `Label: value` key:value (text/number/date), avatar
   (person) — with option color always paired with a text/label channel (WCAG 1.4.1, §8).
5. **Hard per-density caps:** compact/mobile **0 on the bar + all flagged behind one
   tap-to-peek button**; comfortable **up to 3 inline + `+N` disclosure**; detailed **all
   inline**. Empty values are **hidden**, never placeheld (§4).
6. **Values are a first-class server fact** — on the Task read payload, syncable, agent-
   readable (ADR-0112) — never a UI-only bolt-on (Nadia's win, delivered by issue A).

---

## 2. Object → Lens Map (OOUX, ADR-0266)

| Object | Scope | Edition | Relationships | Lens (persona → view) |
|--------|-------|---------|---------------|-----------------------|
| `ProjectCustomField` (definition) | project | OSS | has-many options; ordered; gains `show_on_card` | Sarah/Alex (Scheduler+): a card-legibility knob in Settings · Priya: invisible (never configures) |
| `TaskCustomFieldValue` (value — **prerequisite**) | task | OSS | belongs-to Task + ProjectCustomField; syncable | Priya: a read-only fact she scans on the card · Nadia/agent: a first-class field on the Task payload |
| `Task` (board card) | project | OSS | has-many values; the render host | Priya: "what is this, at a glance" · Alex: must not bury story-point/WIP/health |
| Board (view) | project | OSS | renders cards; owns the master switch | Alex/Morgan: the team's own working surface — they can mute the whole class |

**Boundary check (rule 231):** everything here is single-project and team-operational →
**OSS**. Cross-project aggregation, portfolio roll-up of a field, and filtering the
portfolio by a custom value are **Enterprise** and explicitly out of scope (Marcus/Janet's
low scores are the boundary working correctly, not a gap). No ambient padlock appears in
the OSS daily path.

---

## 3. Presentation matrix — one treatment per field type

Marks reuse the existing card chip vocabulary: `rounded-chip`, `text-xs`, `border`,
`tppm-mono` for numeric/enum tokens, semantic/neutral `-bg` tokens (web-rule 8b). Values
are **read-only** on the card — editing stays in the drawer (non-goal §7).

| Field type | Compact / mobile (peek only) | Comfortable (inline, capped) | Detailed (all inline) | Color / icon | Truncation |
|---|---|---|---|---|---|
| **SINGLE_SELECT** | in peek: `Label: chip` | neutral chip, option `color` as a 2px left dot or tinted bg **+ the option label text** | same | option `color` is reinforcement only; label carries meaning (1.4.1) | label `truncate` at ~14ch, full value in `title` (rule 255) |
| **MULTI_SELECT** | in peek: `Label: chipchip +N` | first chip + `+N` disclosure (same `+N` peek as labels) | all chips wrap | as above, per chip | per-chip truncate; count in `+N` |
| **BOOLEAN** | in peek row: `Label ✓/—` | glyph chip: `✓` (set-true) with label in `aria-label`; **false renders nothing** unless `required` | `Label: ✓/✗` key:value | `✓` neutral, never green (not a health signal) | none |
| **DATE** | in peek: `Label: 12 Aug` | key:value `Label: {relative-or-short}` in `tppm-mono` (e.g. `Due: 3d`, `Review: 12 Aug`) | absolute `Label: 12 Aug 2026` | neutral; no RAG (a custom date is not CPM float — §7) | none (dates are short) |
| **NUMBER** | in peek: `Label: 1,240` | key:value `Label: {value}` in `tppm-mono`, thousands-separated | same, with unit if defined later | neutral | right-clamp very long numbers |
| **TEXT** | in peek: `Label: value` | key:value `Label: {value}`, value `truncate` ~18ch, full in `title` | fuller value, `line-clamp-2` | neutral | `truncate`/`line-clamp`, full via `title` + `aria-label` (rule 255) |
| **USER (person)** | in peek: `Label: Name` | avatar initials pill (reuse the assignee initials treatment) + `Label` in `aria-label`; **distinct from assignees** — grouped after them, with a role prefix in `aria-label` (e.g. "Reviewer: AB") so it is not misread as an assignee | initials + name text | brand-primary initials pill (matches assignee visual, disambiguated by aria) | initials only; name in `title` |

**Key:value label rule.** Every non-select, non-person mark renders as `Label: value`
where `Label` is the field's `name` in `text-neutral-text-secondary` and `value` in
`text-neutral-text-primary`, so the datum is self-describing without a legend (a bare
`1,240` chip is meaningless). Selects and booleans may drop the visible label at
comfortable density **only when the option label is self-evident** — but the `name` always
lives in `aria-label`.

---

## 4. Render order, overflow, and caps (Alex's blocker)

**Card render order is fixed and custom fields are last.** Within the comfortable badge
row and the compact bar the order is:

```
[worst-offender health badge] [story-point pill] [dep chip] [risk chip]
  [label pills (2 + overflow)] [assignees (3 + overflow)]  ← existing, unchanged
  ▸ [custom-field marks …] [+N more]                        ← NEW, always last
```

Custom-field marks are appended to the existing `flex-wrap` badge row **after** assignees,
and are the **first** content to fall into the `+N more` disclosure when space is
contested. **A custom field can never displace or reorder an existing element.** This is
the concrete answer to Alex's "story-point + health badge must always win the scarce row."

**Hard caps per density:**

| Density | Inline custom-field marks | Overflow |
|---|---|---|
| **compact / mobile** (web-rule 193) | **0 on the 36px bar** | **all** flagged fields live behind one `CardPeekButton` (web-rule 256) rendered as a trailing `⊕N` glyph chip; tap opens a portaled `role="note"` listing `Label: value` rows. Suppressed when 0 values present. |
| **comfortable** | up to **3** (in field `order`) | remainder collapse into a single `+N more` `CardPeekButton` whose peek lists the rest, mirroring the label-overflow and health-peek patterns already on the card |
| **detailed** | **all** flagged fields, inline, no peek (parity with detailed showing the full chip set) | none |

The inline cap counts **populated** flagged fields only (empty ones never consume a slot,
§5). Selection order for the inline slots follows `ProjectCustomField.order` (the same
order the Settings list and drawer use) — deterministic, author-controlled, never
"whichever loaded first."

**Compact-bar discipline (#1924/#1925).** The 36px bar stays glyph-only: custom fields add
**at most one** trailing `⊕N` peek affordance, never inline chips — identical restraint to
the worst-offender badge going glyph-only on the bar.

---

## 5. Empty-state behavior

- **Unset value → render nothing.** No placeholder, no `—`, no empty chip. An unset custom
  field consumes zero card real estate and zero overflow count. Rationale: the card is a
  scannable status surface (#1305 calm-card); a grid of `Field: —` placeholders is exactly
  the noise the worst-offender principle exists to prevent, and Priya's 🟢 was explicitly
  contingent on "empty values hidden."
- **`required` but empty edge.** A required custom field with no value is a *task-quality*
  signal, but the **board card is not the enforcement surface** — the drawer/validation is.
  On the card a required-empty field still renders nothing (no scolding chip); if a future
  issue wants a "missing required field" nudge it is a *health-peek* row, not an always-on
  card mark. Out of scope here (§7).
- **Master switch off / field flag off → nothing renders**, no reserved space.

---

## 6. Config UX — where visibility is turned on

**Two controls, two scopes, both OSS:**

**(a) Per-field `Show on card` toggle — Project Settings → Workflow → Fields.**
Lives in `FieldsSection` (`ProjectWorkflowPage.tsx`), on each field row and inside
`CustomFieldModal`. A compact switch (settings-density exception, web-rule 118) labeled
**Show on card**, with a `FieldHelp` (web-rule 263) ⓘ explaining "Adds this field's value
to task cards on the board. Off by default to keep cards scannable." **Off by default.**
Gated on **Scheduler+** (`role >= ROLE_SCHEDULER`), matching the existing
`canEditStatusesOrFields` gate — no new permission. Persists as the additive
`show_on_card` boolean on `ProjectCustomField` (§9 issue A).

**(b) Board-level master switch `Show custom fields on cards` — Board settings panel
(`BoardSettingsPanel`), default ON.** This is the **consent lever** for Morgan's concern.
The field flags are a project-admin decision (Scheduler+); the master switch lets **anyone
who can see the board** collapse the entire custom-field class off their working surface in
one click, without needing project-settings access and without touching another view. It is
a **view preference**, persisted the way the board's existing density/EVM/cost toggles are
(per-user board view state), so one team member muting cards never changes what another
sees. Copy frames it as the team's choice, not an override of the admin.

**Morgan-consent resolution (OSS, no Enterprise governance):**
- off by default per field → nothing appears without a deliberate Scheduler+ action;
- board master switch → the board's residents can always opt the whole class out;
- **person and number fields are shown but the design explicitly warns (in the `FieldHelp`
  copy and in §7 non-goals) against using them as imposed productivity/status columns** —
  the tool stays value-neutral, and the surveillance blast radius is one project with a
  one-click team-side mute. Org-policy enforcement of field visibility would be Enterprise
  governance and is **not** built here.

---

## 7. Non-goals (explicit)

1. **The value model itself** — `TaskCustomFieldValue`, its serializer, sync, and Task-
   payload surface — is a **prerequisite**, designed and built in a separate issue (§9 A),
   not here.
2. **Editing custom-field values from the card face.** Cards are read-only for custom
   fields; editing stays in the task drawer (direct-manipulation is reserved for
   dates/status/progress, not arbitrary metadata).
3. **Swimlane grouping / sorting the board by a custom field** (Jordan's ask). Valuable,
   but a separate board-grouping feature — filed as a follow-up idea, not in this design.
4. **Filtering the board (or `boardFacets`) by a custom-field value.** Separate issue.
5. **Portfolio / cross-project aggregation or roll-up of a custom field** (Marcus/Janet) —
   **Enterprise**, out of the OSS boundary.
6. **Webhooks / near-real-time value-change events** (Nadia's 🟡) — deferred; sync is via
   the existing `server_version` offline delta at first.
7. **RAG/semantic coloring of custom date or number values** — a custom "Due" date is not
   CPM float; it renders neutral. Health semantics stay owned by the worst-offender badge.
8. **A "missing required field" card scold** — belongs to the health-peek/validation
   surface, not an always-on card mark.

---

## 8. Accessibility

- **Color is never the sole channel (WCAG 1.4.1).** A select option's `color` is only ever
  a dot/tinted-bg *behind* the option label text; a color with no adjacent label is
  prohibited. Boolean `✓` carries its meaning in `aria-label` (`"{field name}: yes"`), not
  in color — and is neutral-toned, never green (green is reserved for health/on-track,
  rule 5).
- **Every glyph/chip mark has an `aria-label`** naming the field and value
  (`"Environment: Staging"`, `"Reviewer: Aisha Bello"`), because the visible form may drop
  the label at comfortable density.
- **Truncated values are recoverable (web-rule 255):** any `truncate`/`line-clamp` custom
  value carries `title` (all pointers) and `aria-label` (when the clamped line is the sole
  channel).
- **The compact/mobile peek is a real disclosure (web-rule 256):** `CardPeekButton` with
  `aria-expanded` / `aria-controls`, portaled `role="note"`, Escape/outside-close, focus
  return, ≥44px hit target.
- **`tppm-mono`** for numeric/date/enum tokens so columns of values align and scan.
- **Person marks are disambiguated from assignees** in the accessible name (role prefix),
  so a screen-reader user does not mistake a "Reviewer" field for a task assignee.

---

## 9. Follow-up implementation issues (dependency-ordered)

**Issue A — API: `TaskCustomFieldValue` model + `show_on_card` flag (backend, prerequisite).**
- New value model (or JSON value surface) keyed to Task + ProjectCustomField, typed per
  `field_type`, on the Task read payload, offline-syncable via `server_version`, agent-
  readable (ADR-0112). Documented 400 error shapes for typed writes; write path idempotent.
- Additive `show_on_card` boolean on `ProjectCustomField` + serializer (non-breaking).
- Gates: `migration-check`, `rbac-check`, `perf-check` (N+1 on values prefetch),
  `api-docs`, `security-review`. **Blocks issue B.**

**Issue B — Web: render flagged custom fields on board cards + config toggles (frontend).**
- `BoardCard` render-order/overflow/caps per §3–§5; per-field `Show on card` toggle in
  `FieldsSection`/`CustomFieldModal`; board master switch in `BoardSettingsPanel`; mobile
  peek via `CardPeekButton`. Three-layer tests (vitest + Playwright e2e per web-rule for
  board surfaces). Gates: `ux-review`, `regression-check` (grep `packages/web/e2e/` for
  card-anatomy assertions), `test-scaffold`. **Depends on A.**

(If A turns out genuinely small it may fold into B, but the value model is the larger risk
and is best isolated.)

---

## 10. Wireframes

**Comfortable card (2 flagged fields inline, 1 overflow):**
```
┌─────────────────────────────────────────────┐
│▎ [Ready]                                  ⋯  │
│▎ ◐ Redesign the checkout flow                │
│▎ • CRM-142                            8 pts   │
│▎ ⚠ Blocked  🔗2   ●Backend  AB +2            │
│▎ Env: ● Staging   Sev: ● High     +1 more ▸  │   ← custom fields, last, capped at 3
│▎ Entered at 40% · 3d ago                     │
└─────────────────────────────────────────────┘
```

**Compact / mobile bar (all flagged fields behind one peek):**
```
┌───────────────────────────────────────────┐
│▎ Redesign the checkout flow  ⚠ 🔗2 ●● ⊕3 ⋯│   ← ⊕3 = tap to peek 3 custom values
└───────────────────────────────────────────┘
        (peek → note)  ┌──────────────────┐
                       │ Environment: Staging
                       │ Severity: High
                       │ Reviewer: Aisha Bello
                       └──────────────────┘
```

**Config — Settings → Workflow → Fields row:**
```
Environment   Single-select   [Custom]   Show on card [ ●]  ⓘ   Edit  ⋯
Severity      Single-select   [Custom]   Show on card [ ●]  ⓘ   Edit  ⋯
Cost center   Number          [Custom]   Show on card [○ ]  ⓘ   Edit  ⋯
```

---

## 11. API dependencies (consumed by issue B)

- `GET /api/v1/projects/{id}/fields/` — definitions incl. new `show_on_card` (exists +
  additive field).
- `GET /api/v1/projects/{id}/tasks/` (+ board task feed) — Task payload now carrying
  custom-field **values** (issue A).
- `PATCH /api/v1/projects/{id}/fields/{fieldId}/` — toggle `show_on_card` (Scheduler+).
- Board master switch — client-side board view preference (no endpoint).
- Sync: values carried in the offline delta via `server_version` (issue A).

---

**Approval gate:** this note is **pending user approval**. On approval, issues A and B in
§9 are the build path; A must merge before B.
