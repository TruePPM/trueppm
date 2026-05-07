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

### Mobile
- Touch targets: ≥44×44 points
- Swipe gestures have button alternatives
- VoiceOver (iOS) and TalkBack (Android) tested
- Dynamic content updates announced

### Testing
- axe-core in CI (automated checks on every PR)
- Manual testing with screen reader (quarterly)
- Keyboard-only navigation test (every new feature)
