---
name: accessibility
model: sonnet
description: >
  WCAG 2.2 AA compliance review for TruePPM web and mobile interfaces. Use when
  auditing components for accessibility, adding ARIA attributes, or ensuring keyboard
  navigation works. Covers screen reader compatibility, color contrast, focus management,
  and touch accessibility on mobile.
---

# Accessibility Skill

## WCAG 2.2 AA Requirements for TruePPM

The floor is **WCAG 2.2 Level AA**, which includes every 2.1 A/AA criterion. 2.2 adds nine
success criteria and removes one. **4.1.1 Parsing is obsolete and removed in 2.2** — do not
report duplicate IDs or malformed markup as a 4.1.1 failure; the real failures are caught by
4.1.2 (Name, Role, Value) and the axe `duplicate-id-*` rules.

### The nine new 2.2 success criteria

| SC | Name | Level | Status here |
|---|---|---|---|
| **2.5.8** | Target Size (Minimum) | AA | **Floor.** Pointer targets >= 24x24 CSS px, or 24px of clear spacing. **Highest impact for this app** (dense Gantt rows, table-row controls, chips). House rule 5 (44x44) is stricter and still governs; 24px is the legal minimum, never a reason to relax 44. |
| **2.4.11** | Focus Not Obscured (Minimum) | AA | **Floor.** A focused control must not be *entirely* hidden by author-created content. **Highest impact for this app:** sticky headers, the context header, the Gantt frozen columns/sticky toolbar, bottom bars, toasts, and the docked panels cover focused rows on scroll. Check by Tabbing through a scrolled list; add `scroll-padding`/`scroll-margin` equal to the sticky chrome height. |
| 2.5.7 | Dragging Movements | AA | **Floor.** Every drag has a single-pointer alternative (click-to-select + buttons, or keyboard). Gantt bar moves, board card moves, column resize, reorder. |
| 3.3.8 | Accessible Authentication (Minimum) | AA | **Floor.** No cognitive-function test to log in (no transcribing, no puzzle) without an alternative; do not block paste or password managers. |
| 3.2.6 | Consistent Help | A | **Floor.** Help/contact/support entry points appear in the same relative place across pages. |
| 3.3.7 | Redundant Entry | A | **Floor.** Do not ask the user to re-enter information already given in the same flow (wizards, multi-step create, import mapping); auto-populate or offer to select it. |
| 2.4.12 | Focus Not Obscured (Enhanced) | AAA | Informational. No part of the focused control hidden. Aim for it when 2.4.11 is already clean. |
| 2.4.13 | Focus Appearance | AAA | Informational. Rule 4's ring (2px, offset) is designed to meet it; do not report a AAA miss as a failure. |
| 3.3.9 | Accessible Authentication (Enhanced) | AAA | Informational. Stricter than 3.3.8 (no object/image recognition either). |

Report AAA items as notes, never as findings that block a merge.

### Critical for Gantt Chart
- Gantt bars: keyboard navigable (arrow keys to move between tasks)
- Task details: accessible via Enter key on focused bar
- Dependency arrows: described via aria-describedby
- Zoom controls: keyboard accessible
- Drag-and-drop: alternative keyboard method (select task → arrow keys to move dates); WCAG 2.2 SC 2.5.7 also requires a *single-pointer* alternative (buttons/menu), not only a keyboard one
- Color alone never conveys critical path — use pattern/icon alongside red color

### General Web
- All interactive elements focusable with visible focus ring
- **2.4.7 Focus Visible is decided by `outline-none`, not by the absence of a ring class.** Grep `outline-none` and `outline-0` across `packages/web/src`. For each hit, the element or a wrapper must supply a replacement indicator (`focus-visible:ring-*`, or `focus-within:ring-*` on the wrapper of an input). An element with neither class keeps the browser default and passes. Weight a hit higher when focus lands on that element automatically (`autoFocus`, `useFocusTrap`'s initial focus), because a keyboard user arrives there with no visible cue at all.
- Tab order follows visual layout
- Skip-to-main-content link
- **2.4.11 Focus Not Obscured:** Tab through a scrolled list/table/Gantt with sticky chrome present; the focused control must not sit entirely under a sticky header, toolbar, bottom bar, or toast.
- **2.5.8 Target Size (Minimum):** every pointer target is >= 24x24 CSS px or has 24px clear spacing (house rule 5 asks for 44).
- Headings in logical hierarchy (h1 → h2 → h3, no skips)
- Form labels associated with inputs (htmlFor / aria-labelledby)
- Error messages: announced via aria-live="polite"
- Modal dialogs: focus trapped inside, Escape to close
- Contrast: ≥4.5:1 normal text, ≥3:1 large text
- Settings-surface density exception: under `features/settings/`, `packages/web/CLAUDE.md` rule 118 permits `text-[11px]`/`text-[10px]` secondary and label text (and rule 121 *requires* `text-[10px]` on `EnterpriseBadge`) — do not report these as a legibility/WCAG failure. The hard floor is `text-[10px]`; `text-[9px]` and below are a failure everywhere. Contrast minimums (≥4.5:1 / ≥3:1) still apply at every text size.

### Mobile
- Touch targets: ≥44×44 points (house floor, stricter than WCAG 2.2 SC 2.5.8's 24x24 CSS px minimum)
- Swipe gestures have button alternatives
- VoiceOver (iOS) and TalkBack (Android) tested
- Dynamic content updates announced

### Testing
- axe-core in CI (automated checks on every PR)
- Manual testing with screen reader (quarterly)
- Keyboard-only navigation test (every new feature)

### Auditing the a11y gate itself (not just the components)
A green axe run proves only that the rules axe was *allowed to check* passed. Audit the suppressions with the same rigor as the code:

- **Every rule exclusion must name an OPEN issue.** Read each `disableRules` / `exclude` / rule-off in `packages/web/e2e/a11y.spec.ts` and resolve the issue it cites. An exclusion citing a **closed** issue is the worst case: the failure it hides is real, nothing tracks it, and the pipeline is green — the gate is actively concealing a regression rather than deferring a known one. When you find one, verify independently whether the underlying failure still reproduces before deciding to drop the exclusion or re-file it.
- **A suppression comment is not a suppression.** Check that the mechanism actually suppresses what the comment claims, and that the comment's stated condition ("remove when #N lands") is re-read when #N does land. Nothing enforces that automatically.
- **Count what is excluded, and say so in the report.** "axe passes" and "axe passes with `aria-required-attr`, `aria-required-children`, and `nested-interactive` disabled on the three densest surfaces" are very different claims. Always report the second form — the excluded set is the finding.
- **Check the gate's coverage, not just its result.** Which routes and themes does the spec actually scan? A contrast gate that never opens the dark theme, or a keyboard gate that never visits the canvas, is passing on a subset it does not disclose.

## Recurring-class check: modal focus containment

A dialog that sets `aria-modal="true"` promises that keyboard focus stays inside it (WCAG 2.4.3). Implementing Escape and initial focus is not enough; Tab and Shift+Tab must also be contained. For every component that renders `aria-modal="true"`, verify it either uses the shared `useFocusTrap()` hook or hand-rolls equivalent Tab containment, and check that a test covers the wrap. This class has been fixed and has recurred, so a lint rule or unit gate that pairs the attribute with a trap beats re-auditing it.
