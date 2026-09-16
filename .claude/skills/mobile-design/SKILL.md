---
name: mobile-design
model: sonnet
description: >
  UI/UX design for a TruePPM React Native mobile app — which is NOT currently
  scheduled. Native mobile left the roadmap on 2026-09-16 (#3834); the installable
  PWA is the mobile story through 1.0, and PWA/responsive web work goes through
  `ux-design`, not this skill. Use only when native mobile has been put back on a
  numbered release, or for an explicitly exploratory native design. Design from
  mobile constraints upward; offline is the default, not an afterthought.
---

# Mobile Design Skill

**Check first: is native mobile on a numbered release?** As of 2026-09-16 it is not (#3834). The installable PWA (#1393) plus push (#2132) is the mobile story through 1.0, and that is web work — use `ux-design` / `ux-review` for it. If you are here for PWA or responsive-web design, stop and switch skills. Native returns to a milestone only when **real user reports** (not a persona finding, not an AI analysis) name a workflow the PWA cannot serve; confirm on the roadmap before designing native screens as committed work.

If native work is legitimately in scope, the mobile app is **the offline-first edge of the system**, not a port of the web UI.

**Whose constraints.** The contributor (Priya in `.claude/personas.md`) is the modeled mobile user: 15-second time entry from a phone and blocker-only notifications. The older premise that the PM (Sarah) is "on a job site three days a week with no signal" is **retired** — `personas.md` classes construction/field ops as a market-fit failure and specifically not a reason to build offline schedule editing. Do not design native schedule/Gantt editing on that premise.

## Platform order (if native is reinstated)

The previous plan — Android phones at 0.6, Android tablets 0.6 → 0.7, iPhone at 1.0 — was withdrawn with the native app. If native returns, it is the starting point, not a commitment; the roadmap sets the actual order and milestones:

1. **Android phones** — primary reference design. Material 3 conventions are the default; spec screens against Pixel-class hardware (Pixel 6/7 baseline).
2. **Android tablets** — second. Add split-view and two-pane layouts only after the phone shell stabilizes.
3. **iPhone** — after Android. RN keeps the codebase portable, so designs should remain platform-fair, but Material 3 wins ties until iPhone is on a milestone.

When a design choice forces a tradeoff between platforms, choose Android. Note iOS deltas inline so a later iPhone pass can pick them up without re-deriving the design.

## Mobile-first constraints (the brief that overrides every other design rule)

1. **Offline is the default state** — design every screen for "no signal." Online is a privileged state where extra capabilities unlock. Reverse the typical "online-first, offline-fallback" frame.
2. **Touch is primary** — minimum 44×44pt tap targets (Apple HIG) / 48×48dp (Material 3). No hover, no right-click, no keyboard shortcuts as primary affordances.
3. **Bandwidth is limited** — assume 3G or worse. Optimistic UI on every write. Sync deltas only.
4. **Battery matters** — no background polling. Push, not pull. WebSocket reconnect is exponential-backoff with a ceiling.
5. **Outdoor visibility** — high contrast (WCAG AAA where feasible, AA minimum). No relying on color alone for state.

## Per-platform conventions

Android is the **primary** column; iOS is captured for a later iPhone pass but should not drive design choices.

| Convention | Android (Material 3) — primary | iOS (Apple HIG) — later |
|---|---|---|
| Back navigation | Top-left arrow + system back gesture | Top-left chevron + swipe-from-edge |
| Tab bar | Bottom navigation bar (3–5) | Bottom (5 max) |
| Action sheet | Bottom sheet | Bottom modal |
| Destructive confirmation | AlertDialog with red text | Action sheet with red text |
| Form input | Native pickers, FAB for primary action | Native pickers (date, time, contact) |
| Pull-to-refresh | Default | Default |
| Empty state | Centered illustration + single CTA | Same |

Use platform-native components (React Native's platform-specific APIs) — do not unify a custom look across platforms unless the design system explicitly mandates it. When iOS conventions differ, note the delta inline but spec the Android version as the build target.

## Offline patterns (TruePPM-specific)

- **Optimistic write** → local DB → background sync → conflict resolution per `server_version`
- **Pending state badge** on items not yet synced; tappable to retry
- **Conflict UI**: surface conflicts as a notification queue, never as a blocking modal — a contributor logging time between meetings cannot stop to triage
- **Sync status indicator** in the header: green dot (synced), amber (pending), red (conflict needs attention)
- **Local-first navigation** — all reads must work from local DB without a server round-trip

## Touch gesture vocabulary

| Gesture | Standard meaning | TruePPM use |
|---|---|---|
| Tap | Primary action | Open detail, toggle |
| Long-press | Context menu | Reorder mode (drag handle), multi-select |
| Swipe horizontal | Navigation between siblings | Day-to-day on schedule, swimlane scroll |
| Swipe-to-action | Quick action on a row | Mark task complete (right) / archive (left) |
| Pull-down | Refresh | Sync now |
| Pinch | Zoom | Schedule timeline zoom |
| Two-finger pan | Pan large canvas | Gantt timeline pan |

Distinguish gestures by minimum hold-time (long-press = 500ms) and minimum displacement (swipe = 24pt) so they don't collide.

## Persona resonance check

Run the design through these filters before producing the spec:

- **Sarah (PM)**: Is the most common action one tap from the home screen? (Do not use the retired "from her truck on a job site" framing.)
- **Priya (Team Member)**: Is time entry under 30 seconds end-to-end? Is the notification opt-in rather than opt-out?
- **Mobile in general**: Does it work one-handed? Is the primary action reachable by thumb?

## Output

1. **Screen spec** — wireframe (ASCII or described), interaction flow, state diagram including offline / pending / conflict states
2. **Component composition** — which RN components, native vs custom; design tokens used
3. **Gesture map** — what each gesture does, with collision matrix if multiple gestures overlap
4. **Offline-state inventory** — list every state the screen can be in when offline; specify the UI for each
5. **Accessibility annotations** — VoiceOver / TalkBack labels, focus order, contrast at minimum AA
6. **Animation budget** — every animation declared with reduced-motion fallback; respect `prefers-reduced-motion` (or the RN equivalent)

## Out of scope

- iPhone-specific flows or iOS-only affordances — deferred until iPhone is on a milestone
- iPad layouts — deferred with iPhone
- Watch-OS or wearable integrations
- Web-mobile responsive and the installable PWA (handled by `ux-design`, not this skill)
