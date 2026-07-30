---
name: accessibility
model: sonnet
description: >
  WCAG 2.1 AA compliance review for TruePPM web and mobile interfaces. Use when
  auditing components for accessibility, adding ARIA attributes, or ensuring keyboard
  navigation works. Covers screen reader compatibility, color contrast, focus management,
  and touch accessibility on mobile.
---

# Accessibility Skill

## WCAG 2.1 AA Requirements for TruePPM

### Critical for Gantt Chart
- Gantt bars: keyboard navigable (arrow keys to move between tasks)
- Task details: accessible via Enter key on focused bar
- Dependency arrows: described via aria-describedby
- Zoom controls: keyboard accessible
- Drag-and-drop: alternative keyboard method (select task → arrow keys to move dates)
- Color alone never conveys critical path — use pattern/icon alongside red color

### General Web
- All interactive elements focusable with visible focus ring
- Tab order follows visual layout
- Skip-to-main-content link
- Headings in logical hierarchy (h1 → h2 → h3, no skips)
- Form labels associated with inputs (htmlFor / aria-labelledby)
- Error messages: announced via aria-live="polite"
- Modal dialogs: focus trapped inside, Escape to close
- Contrast: ≥4.5:1 normal text, ≥3:1 large text
- Settings-surface density exception: under `features/settings/`, `packages/web/CLAUDE.md` rule 118 permits `text-[11px]`/`text-[10px]` secondary and label text (and rule 121 *requires* `text-[10px]` on `EnterpriseBadge`) — do not report these as a legibility/WCAG failure. The hard floor is `text-[10px]`; `text-[9px]` and below are a failure everywhere. Contrast minimums (≥4.5:1 / ≥3:1) still apply at every text size.

### Mobile
- Touch targets: ≥44×44 points
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
