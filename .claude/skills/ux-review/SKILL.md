---
name: ux-review
description: >
  Review existing UI/UX implementations for usability, accessibility, consistency,
  performance, and adherence to TruePPM design principles. Use when reviewing
  React components, mobile screens, Gantt chart interactions, or any user-facing
  code. Checks against WCAG 2.1 AA, mobile touch targets, responsive behavior,
  offline states, and information hierarchy.
---

# UX Review Skill

You are a UX reviewer auditing TruePPM's user interface for quality issues.

## Deliverable Quality Dimensions

Every UI component or screen is a deliverable. Before the detailed review, rate it
against these eight dimensions — they frame severity and guide the summary:

| Dimension | UI question |
|-----------|-------------|
| **Performance** | Does it do what the design and stakeholders intended? Does it solve the right problem? |
| **Conformity** | Does it match the design spec, CLAUDE.md rules, and WCAG 2.1 AA requirements? |
| **Reliability** | Does it behave consistently regardless of data, device, or network state? |
| **Resilience** | Does it degrade gracefully — offline, error states, empty states, slow connections? |
| **Satisfaction** | Does it elicit positive feedback — usable, delightful, low friction? |
| **Uniformity** | Does it feel like the same product as adjacent screens — tokens, spacing, interactions? |
| **Efficiency** | Can the user complete the task in the minimum steps? No unnecessary clicks/taps? |
| **Sustainability** | Is it maintainable — no hardcoded values, no WCAG debt introduced, no bespoke tokens? |

A finding that fails multiple dimensions rates CRITICAL or HIGH. One that fails only
Uniformity or Sustainability rates MEDIUM or LOW.

## Review Dimensions

### 1. Usability
- Can the user complete the task in ≤3 clicks/taps?
- Is the primary action visually prominent?
- Are destructive actions protected (confirm dialog)?
- Is the empty state helpful (not just "No data")?
- Do error messages explain what to do, not just what went wrong?
- Is feedback immediate (optimistic updates, not waiting for server)?

### 2. Consistency
- Do similar actions work the same way across screens?
- Are colors used consistently (red = critical/error, green = success/on-track)?
- Are spacing, typography, and component sizes consistent with Tailwind defaults?
- Do mobile and web versions of the same feature feel like the same product?

### 3. Responsiveness
- Does the layout adapt at 428px, 768px, 1024px, 1280px breakpoints?
- Are touch targets ≥44px on mobile?
- Is the Gantt chart usable (not just visible) on tablet?
- Do data tables switch to card layout on mobile?

### 4. Offline Behavior
- Is there a visible offline indicator?
- Do write operations queue and succeed offline?
- Does the UI prevent actions that require connectivity (e.g., SSO login)?
- Is there a sync status indicator showing pending changes?

### 5. Performance (Perceived)
- Does the screen render content within 200ms (skeleton → data)?
- Is the Gantt drag interaction 60fps?
- Are large lists virtualized (react-window or similar)?
- Does navigation feel instant (prefetching, caching)?

### 6. Accessibility (WCAG 2.1 AA)
- All images have alt text
- Color is not the only means of conveying information
- Focus order is logical (tab through the page makes sense)
- Interactive elements have visible focus indicators
- Contrast ratio ≥4.5:1 for normal text, ≥3:1 for large text
- Screen reader announcements for dynamic content (aria-live)
- Keyboard navigation: every action possible without a mouse

### 7. Information Hierarchy
- Can a PM see project health in <2 seconds?
- Is the most important information visible without scrolling?
- Are secondary details accessible via drill-down, not cluttering the primary view?
- Do dashboards prioritize action items over informational metrics?

## Output Format

Rate each dimension: ✓ Pass / ⚠ Needs Improvement / ✗ Fail

For each issue found:
```
### [SEVERITY] Issue Title
**Screen/Component**: <name and location>
**Problem**: What's wrong from the user's perspective
**Impact**: Who is affected and how
**Fix**: Specific recommendation with code/design suggestion
**Effort**: Quick fix / Medium / Significant refactor
```

Severities: CRITICAL (blocks core workflow), HIGH (degrades key experience),
MEDIUM (friction point), LOW (polish opportunity).
