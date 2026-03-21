---
name: brand
description: >
  TruePPM brand and design system reference. Use when writing any frontend code
  (React web, React Native mobile) to ensure correct colors, typography, spacing,
  components, interactions, and WCAG 2.1 AA compliance. Single source of truth —
  derived from TruePPM Design System v1.0 (March 2026).
---

# TruePPM Brand & Design System v1.0

Single source of truth for all frontend development. When any value here conflicts
with a component library default or a developer intuition, this document wins.

---

## 1. Logo

- Wordmark: "True" regular weight + "PPM" semibold, Blue 600 (`#185FA5`)
- On dark/colored backgrounds: white
- Minimum size: 80px wide (web), 60px wide (mobile)
- Never stretch, rotate, apply effects, or split the color between "True" and "PPM"

---

## 2. Color system

Colors encode **meaning**, not decoration. Every color has a specific semantic purpose.
Never use a color outside its defined meaning (e.g. don't use Red for non-critical states).

### 2.1 Semantic palette

| Meaning | Light — Bar | Light — Bg | Light — Text | Dark — Bar | Dark — Bg | Dark — Text |
|---------|------------|-----------|-------------|-----------|----------|------------|
| Critical / overdue / error | `#E24B4A` | `#FCEBEB` | `#791F1F` | `#E24B4A` | `#501313` | `#F7C1C1` |
| At risk / warning | `#BA7517` | `#FAEEDA` | `#633806` | `#EF9F27` | `#412402` | `#FAC775` |
| On track / success | `#639922` | `#EAF3DE` | `#27500A` | `#97C459` | `#173404` | `#C0DD97` |
| In progress / info / focus | `#378ADD` | `#E6F1FB` | `#0C447C` | `#85B7EB` | `#042C53` | `#B5D4F4` |
| Neutral / structural | `#888780` | `#F1EFE8` | `#444441` | `#B4B2A9` | `#2C2C2A` | `#D3D1C7` |

All semantic text/bg pairs achieve 8:1–9:1 contrast (WCAG AAA). ✓

### 2.2 Extended palette (color ramps — 400 stop)

| Name | Hex | Use |
|------|-----|-----|
| Red 400 | `#E24B4A` | Critical path tasks, error bars |
| Amber 400 | `#BA7517` | At-risk tasks, milestones |
| Green 400 | `#639922` | On-track tasks, success |
| Blue 400 | `#378ADD` | Active tasks, Gantt bars |
| Gray 400 | `#888780` | Summary bars, disabled, borders |
| Teal 400 | `#1D9E75` | Secondary: resource assignments, project tags |
| Purple 400 | `#7F77DD` | Secondary: project tagging |
| Blue 600 | `#185FA5` | Brand primary, logo, primary buttons, links |

Never use more than 4 color ramps on a single screen.

### 2.3 Surface colors

| Token | Light | Dark |
|-------|-------|------|
| bg-primary | `#FFFFFF` | `#1a1a19` |
| bg-secondary | `#f8f7f5` | `#2c2c2a` |
| bg-tertiary | `#f1efe8` | — |
| text-primary | `#1a1a19` (near black) | `#e8e6de` |
| text-secondary | `#6b6965` ⚠️ (see §11) | `#a8a5a0` |
| text-tertiary | (dimmer) | — |
| border | rgba(0,0,0,0.08) light | rgba(255,255,255,0.1) dark |

Never hardcode colors. Always go through CSS custom properties / Tailwind tokens.

---

## 3. Typography

Font: **Inter** (Google Fonts). Fallback: `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.
Monospace: **SF Mono / Fira Code**, 12px/400/1.4 — duration values, percentages, technical fields.

| Element | Size | Weight | Line height | Usage |
|---------|------|--------|-------------|-------|
| Page title | 20px | 600 | 1.3 | Screen titles, project names in headers |
| Section header | 15px | 600 | 1.3 | Panel headers, toolbar labels |
| Body / task name | 13–14px | 500 | 1.4 | Task names, resource names, primary content |
| Secondary text | 12–13px | 400 | 1.4 | Metadata, dates, descriptions |
| Caption / label | 11px | 500 | 1.3 | Column headers, badges, toolbar buttons |
| Gantt bar label | 10–11px | 500 | 1.0 | Text inside Gantt bars (see §11 for color rules) |

---

## 4. Spacing & layout tokens

| Token | Value | Usage |
|-------|-------|-------|
| space-xs | 4px | Inline gaps (icon to text) |
| space-sm | 8px | Compact lists, toolbar button gaps |
| space-md | 12px | Card internal padding, grid gaps |
| space-lg | 16px | Section spacing, panel padding |
| space-xl | 24px | Page margins, major section gaps |
| space-2xl | 32px | Page top/bottom padding |
| radius-sm | 4px | Badges, pills, Gantt bar corners |
| radius-md | 8px | Cards, panels, inputs, buttons |
| radius-lg | 12px | Modals, large cards, containers |
| radius-pill | 999px | Status badges, avatar circles |

---

## 5. Borders & surfaces

- **No drop shadows** — depth is communicated through surface color (bg-primary on bg-secondary) and borders only
- **0.5px** borders on cards, panels, and dividers
- **1px** on input fields
- **2px** on focus rings and the "featured" card accent
- **Hover states**: rgba(0,0,0,0.04) overlay on light; rgba(255,255,255,0.06) on dark — never solid color changes

---

## 6. Application shell (web)

| Component | Size | Background | Contents |
|-----------|------|-----------|---------|
| Top bar | 48px tall, full width | bg-secondary | Logo, view tabs (Gantt/Board/List/Calendar/Resources), Monte Carlo badge (P80 date), at-risk count, critical count, user avatar |
| Sidebar | 220px wide, full height | bg-primary | Portfolio section (enterprise), Projects list with health dots; 8px color dot + name; active: blue bg tint |
| Main area | Remaining space | bg-primary | Toolbar (36px) + content area |
| Status bar | 28px tall | bg-secondary | Task count, critical path count, last saved, online users, color legend |

Sidebar collapses to 60px icon rail at 1024px, hamburger at <768px.

---

## 7. Gantt view

### Task list panel

| Column | Width | Content | Interaction |
|--------|-------|---------|------------|
| Task name | flex | 16px indent per WBS level. Summary tasks bold. Critical tasks in Red 400 | Click to select. Double-click to edit inline. Drag handle to reorder |
| Duration | 60px | "5d", "2w". Right-aligned | Click to edit inline. Tab to next field |
| Start | 70px | "Mar 3". Short date format | Click to open date picker |
| Progress | 50px | "65%". Right-aligned. Milestones: "---" | Click to edit or drag progress handle on bar |

### Gantt bar types

| Bar type | Height | Fill | Notes |
|----------|--------|------|-------|
| Normal task | 18px | Blue 400 | 3px border-radius. Label inside if bar >80px, else right |
| Critical path | 18px | Red 400 | Zero total float |
| Complete | 18px | Green 400 | 100% progress overlay |
| Summary | 8px | Gray 400 | Spans earliest child start to latest child finish. Bracket ticks at ends |
| Milestone | 12px diamond | Amber 400 | Zero duration. Rotated square |
| Baseline ghost | 6px | Gray 200, 40% opacity | Below current bar when baseline overlay active |

**Gantt bar label color**: see §11 (WCAG compliance — use dark labels, not white).

### Dependency arrows

| Type | Visual | Interaction |
|------|--------|------------|
| FS (Finish-to-Start) | L-shaped path, right→left, Gray 400 1px, 4px corner radius | Click to select (Blue 400). Delete to remove. Hover tooltip with lag |
| SS (Start-to-Start) | Left→left arrow | Same |
| FF (Finish-to-Finish) | Right→right arrow | Same |
| SF (Start-to-Finish) | Left→right, dashed | Same |
| Critical dependency | Same path as type, Red 400 1.5px | Only when both ends on critical path |

### Zoom levels

| Level | Column width | Header labels |
|-------|-------------|--------------|
| Day | 40px/day | Day / Month |
| Week | 80px/week | Week / Month (default) |
| Month | 120px/month | Month / Year |
| Quarter | 200px/quarter | Q1–Q4 / Year |

### Live impact simulation

On drag START: WASM CPM runs downstream from that task. Ghost bars (Blue 100 fill, dashed) show new positions. Tooltip near most-impacted milestone. Critical change: Red 100 flash. On drag END: ghosts animate to final positions (200ms ease-out). Escape cancels immediately. Target: <10ms per frame at 60fps.

### Monte Carlo display

Below last task row: P50 bar (Green 200/400, solid), P80 bar (Amber 100/400, dashed), optional P95 (Red 50/200, dotted). P80 date also in top bar badge. Hover MC row → histogram tooltip.

---

## 8. Component library

### Buttons

| Type | Appearance | Usage |
|------|-----------|-------|
| Primary | Blue 600 fill, white text, 8px radius, 36px tall, 500 weight | Main action per screen |
| Secondary | Transparent, 0.5px border-secondary, text-primary, 8px radius, 36px | Toolbar buttons, alternative actions |
| Ghost | No fill, no border, text-secondary, hover: bg-secondary | Inline actions, toggle filters |
| Destructive | Red 600 fill, white text | Delete / remove — always behind confirm dialog |
| Disabled | bg-secondary fill, text-tertiary, no hover | Action not available |

### Badges & pills

- Status badge: semantic bg/text, radius-pill (8px), 10–11px, 500 weight, 2px 8px padding
- Count badge: Red 400 fill, white text, circular min-width 18px, 10px font
- Health score circle: 32–36px circle, semantic bg/text, 12–13px, 500 weight

### Cards

**Standard**: bg-primary, 0.5px border-tertiary, radius 10px mobile / 8px web, 12px padding. Hover: border transitions to border-secondary. Active: 2px Blue 400 border, bg-info tint.

**Metric card** (portfolio): bg-secondary (no border), 8px radius, 12px 16px padding. Label (11px, text-tertiary) above value (22px, 500) above delta (11px, green/red).

### Form elements

| Element | Height | Border | Focus state |
|---------|--------|--------|-------------|
| Text input | 36px | 1px border-secondary | 2px Blue 400 ring, border → Blue 400 |
| Select | 36px | Same | Same |
| Date picker | 36px trigger | Same | Opens calendar popover below |
| Number input | 36px | Same | Increment/decrement buttons on mobile |
| Progress slider | 4px track, 18px thumb | Track: gray-200 | Thumb: Blue 400, hover scale 1.2x |
| Checkbox | 18px | 1px border-secondary, 4px radius | Checked: Blue 600 fill, white checkmark |

### Panels & overlays

| Type | Width | Position | Usage |
|------|-------|----------|-------|
| Slide-over panel | 400px (web), full-screen (mobile) | Right side | Task detail, resource detail, conflict resolution |
| Modal dialog | 480px max | Centered, rgba(0,0,0,0.4) backdrop | Destructive confirmations, create project wizard |
| Bottom sheet (mobile) | Full width | Slides up, drag-to-dismiss | Action menus, date pickers, filter selection |
| Toast | 320px max | Bottom-right (web), top (mobile) | "Schedule recalculated", "Synced 12 changes" |

---

## 9. Mobile

### Navigation
Bottom tab bar, 52px tall, icon 20px + label 10px. Active: Blue 600. Inactive: text-tertiary.

| Tab | Default screen | Primary action |
|-----|---------------|---------------|
| Tasks | My Tasks (grouped by urgency) | Update progress, mark complete |
| Time | "What did you work on today?" | Log hours via swipe |
| Projects | Project cards with health scores | Drill into project summary |
| Settings | Profile, sync settings, notifications | Configure sync scope |

### Swipe gestures

| Gesture | Screen | Effect | Feedback |
|---------|--------|--------|---------|
| Swipe right | Time entry | Log suggested hours | Green background reveal, card off-screen |
| Swipe left | Time entry | Skip task | Gray reveal, card off-screen |
| Swipe right | My Tasks | Mark complete (100%) | Green checkmark reveal, move to Completed |
| Pull down | Any list | Trigger sync | Spinner + "Synced N changes" toast |
| Long press | Task card | Reorder mode | Scale 1.02, drag within section |

### Offline states

| State | Visual indicator | Behavior |
|-------|-----------------|---------|
| Online | None | WebSocket sync, push notifications active |
| Offline | Amber banner: "Working offline — N changes pending" | Reads from WatermelonDB. Writes queue locally. Local CPM via WASM |
| Syncing | Green banner: "Syncing…" with progress | Push/pull in progress. UI remains interactive |
| Sync conflict | Alert card: "This task was modified by [user] while you were offline" | Show both versions. User picks (WBS re-parenting). Time entries auto-merge |
| Sync error | Red banner: "Sync failed — will retry in 30s" | Exponential backoff. No data loss |

### My Tasks screen (mobile)

- Header: "My tasks" 17px/600 + subtitle "N due this week" 12px/text-secondary
- Section labels: "Overdue", "Due this week", "Upcoming" — 11px uppercase, text-secondary
- Task cards: 0.5px border, 10px radius. Overdue: 3px Red 400 left border
- Content: task name 14px/500, metadata row 11px, progress bar 4px tall
- Badges: "Critical path" (red), "Due Apr 18" (amber), "On track" (green)

### Time entry screen — north star metric: **15 seconds to log a day's work**

Every design decision must answer: does this make time entry faster or slower? If a user taps more than 3 times to log a day's work, we've failed.

---

## 10. Interaction patterns

### Keyboard navigation (web)

| Key | Context | Action |
|-----|---------|--------|
| Arrow Up/Down | Task list | Move selection |
| Arrow Left/Right | Gantt + task selected | Move start date 1 day (Shift: 1 week) |
| Enter | Task selected | Open task detail slide-over |
| Tab | Task list cell | Next editable cell |
| Delete / Backspace | Dependency selected | Remove dependency |
| Ctrl/Cmd+Z | Any | Undo (20-step history) |
| Ctrl/Cmd+S | Any | Force save (normally auto-saves) |
| Space | Task selected | Toggle complete |
| / | Any | Open command palette |

---

## 11. Responsive breakpoints

| Breakpoint | Width | Layout |
|-----------|-------|--------|
| Desktop XL | ≥1440px | Full layout. Gantt task list 280px. Sidebar 220px. Dashboard 4-column metrics, 2×2 panels |
| Desktop | 1280–1439px | Same as XL, tighter spacing. Dashboard may stack to 1 column |
| Laptop | 1024–1279px | Sidebar → 60px icon rail. Gantt task list 240px |
| Tablet landscape | 768–1023px | Sidebar hidden (hamburger). Dashboard metrics 2×2. Panels stack vertically |
| Tablet portrait | 600–767px | Gantt hides task list by default (toggle). Single-column layout |
| Phone | <600px | React Native. No Gantt editing. Task list + simplified timeline. Bottom tab bar |

---

## 12. Animation & motion

| Token | Duration | Easing | Usage |
|-------|----------|--------|-------|
| transition-fast | 100ms | ease-out | Button hover, focus rings, toggles |
| transition-normal | 200ms | ease-out | Panel open/close, card selection, bar position commit |
| transition-slow | 400ms | cubic-bezier(0.16, 1, 0.3, 1) | Slide-over panels, modal entrance, page transitions |
| transition-spring | 500ms | cubic-bezier(0.34, 1.56, 0.64, 1) | Task complete celebration, drag-drop settle |

**Motion principles:**
- **Causality**: animate FROM the old position, not just appear at new one
- **Restraint**: only animate things that help the user understand what happened
- **Accessibility**: wrap all animations in `@media (prefers-reduced-motion: no-preference)` — reduced motion = instant
- **Performance**: only animate `transform` and `opacity` (GPU-composited). Never `width`, `height`, `top`, or `left` during Gantt drag

---

## 13. Dark mode

Automatic via `prefers-color-scheme: dark`. All colors via CSS custom properties.

- Surfaces invert: bg-primary → `#1a1a19`, bg-secondary → `#2c2c2a`
- Text inverts: text-primary → `#e8e6de`
- Borders: rgba(255,255,255,0.1)
- Gantt bars: same hues, slightly lighter (400 → 300 stop equivalent)
- Health circles: 800 fill + 200 text (inverted from light 50 fill + 800 text)
- Never hardcode colors — always CSS variables

---

## 14. Implementation

- **Web**: Tailwind CSS. Custom theme extending Tailwind with TruePPM design tokens. All tokens in `tailwind.config.ts` as single source of truth
- **Mobile**: NativeWind (same Tailwind classes, compiled to React Native StyleSheet)
- **Gantt**: custom `gantt.css` for SVAR React Gantt overrides — matches design system, kept isolated
- **No CSS-in-JS**: no styled-components, no emotion. Tailwind utility classes only
- **Component structure**: one component per file, named exports only. Shared: `packages/web/src/components/`. Feature-specific: `packages/web/src/features/{feature}/components/`. Test co-located: `TaskCard.tsx` + `TaskCard.test.tsx`
- **Mobile mirrors web structure** where possible for concept parity

### Accessibility checklist (every component)

- Interactive elements: `role`, `aria-label` or `aria-labelledby`, `tabIndex`
- Dynamic content: `aria-live="polite"` for schedule recalculation and sync complete
- Color is **never** the only indicator — add icon, pattern, or text alongside
- Focus: visible focus ring on every interactive element, logical tab order
- Gantt bars: each bar is a focusable element with `aria-label` describing task name, dates, and status
- Screen reader announces "Critical path" and "Overdue" status when task is focused

---

## 15. ⚠️ WCAG 2.1 AA compliance issues (must fix before launch)

WCAG AA requires 4.5:1 for normal text (<18px regular / <14px bold) and 3:1 for large text.

### CRITICAL — Gantt bar labels (10–11px white text on colored bars)

All 400-stop bar colors with white text **fail AA** at label sizes:

| Bar color | Contrast | Required | Status |
|-----------|----------|----------|--------|
| Blue 400 `#378ADD` | 3.59:1 | 4.5:1 | ❌ FAIL |
| Red 400 `#E24B4A` | 3.93:1 | 4.5:1 | ❌ FAIL |
| Green 400 `#639922` | 3.44:1 | 4.5:1 | ❌ FAIL |
| Amber 400 `#BA7517` | 3.72:1 | 4.5:1 | ❌ FAIL |
| Gray 400 `#888780` | 3.61:1 | 4.5:1 | ❌ FAIL |

**Fix**: Use dark label text (`#1a1a19`) on Gantt bars instead of white. All 400-stop bars have sufficient contrast with near-black text (>7:1). Alternatively darken each bar to a 600-stop color — but this breaks the visual hierarchy since 400 is used for bars throughout the semantic system. **Dark text on bars is the correct fix.**

### HIGH — text-secondary on white background

`#888780` on white = 3.61:1. Fails AA for body text at 12–13px (metadata, dates, descriptions).

**Fix**: Darken text-secondary to `#6b6965` (≈4.6:1 on white). Update the token in `tailwind.config.ts`. This is a single token change — all text-secondary usages inherit the fix automatically.

### All other color pairs pass AA ✓

Semantic badge text/bg pairs all achieve 8:1–9:1. Primary button (white on Blue 600): 6.52:1. Destructive button (white on Red 600): 4.83:1.
