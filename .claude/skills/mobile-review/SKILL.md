---
name: mobile-review
model: sonnet
description: >
  Review React Native mobile code for TruePPM against mobile-specific requirements:
  touch target size, offline state handling, gesture correctness, platform-native
  conventions, and battery/bandwidth efficiency. Use when reviewing any mobile MR.
  Distinct from ux-review (web-leaning) — mobile constraints are stricter and
  platform-specific.
---

# Mobile Review Skill

You are reviewing React Native code for the TruePPM mobile app. Apply mobile-specific rules first; these are stricter than the web equivalents and platform-divergent.

## Touch & interaction

- [ ] Every interactive element has a hit-target ≥ 44×44pt (iOS) / 48×48dp (Android). If the visual target is smaller, `hitSlop` extends it.
- [ ] No hover-only affordances — every interaction must work via tap or long-press
- [ ] Long-press threshold ≥ 500ms; does not collide with swipe gestures (swipe minimum displacement 24pt)
- [ ] Destructive actions require confirmation via action sheet (iOS) / AlertDialog (Android), not via direct tap
- [ ] Form fields use native pickers for date, time, color, file — not custom JS components

## Platform-native conventions

- [ ] Back-navigation matches platform (chevron + swipe on iOS; arrow + system back on Android)
- [ ] Bottom tab bar uses `BottomTabNavigator`, not a custom hand-rolled component
- [ ] Action sheets / modals respect platform: `ActionSheetIOS` on iOS, bottom sheet on Android
- [ ] `Platform.OS` branches are explicit and tested on both — no untested platform-specific code

## Offline-first

- [ ] Every read renders from local DB without a network round-trip
- [ ] Every write is optimistic; UI does not block on the server response
- [ ] Pending-sync state is visible to the user (badge, indicator, or both)
- [ ] Conflict resolution uses a notification queue, not a blocking modal
- [ ] Sync status indicator is present and reflects real state (not stale)
- [ ] No screen depends on data from a server response that arrived less than `lastSyncedAt`

## Network & battery

- [ ] No `setInterval` polling — use WebSocket subscriptions or push notifications
- [ ] WebSocket reconnect uses exponential backoff with a ceiling (typically 30s)
- [ ] Background tasks respect platform limits (iOS: `BackgroundFetch` budget; Android: WorkManager constraints)
- [ ] Image assets are sized appropriately (no 3000×3000 PNGs being thumbnailed at runtime)
- [ ] Sync payloads are deltas, not full object graphs

## Accessibility

- [ ] Every `Pressable` / `TouchableOpacity` has `accessibilityLabel` and `accessibilityHint` where the label alone is insufficient
- [ ] `accessibilityRole` is set (`button`, `header`, `link`, `switch`, etc.)
- [ ] Focus order matches visual order; tested with VoiceOver (iOS) and TalkBack (Android)
- [ ] Color contrast meets WCAG AA in both light and dark modes
- [ ] No state communicated by color alone — pair with icon, text, or shape
- [ ] Reduced-motion preference is honored (`AccessibilityInfo.isReduceMotionEnabled()`)

## Sync correctness (TruePPM-specific)

- [ ] Mutations write `server_version` from the local copy and include it in the sync payload
- [ ] Conflict events trigger the conflict-resolution UI, not silent data loss
- [ ] The local DB schema migrations are versioned and forward-only (no data loss on upgrade)
- [ ] Background sync respects the user's "sync over cellular" preference

## Animation

- [ ] Animations use `react-native-reanimated` (UI thread) for anything touched by gesture; JS-thread animations only for non-gesture decorative motion
- [ ] All animations have a reduced-motion fallback (instant transition or fade-only)
- [ ] No animation > 300ms unless it is functionally necessary (e.g., a meaningful loading state)

## Common failure patterns to scan for

| Symptom | Root cause to look for |
|---|---|
| Janky gesture | Animation on JS thread instead of UI thread |
| Battery drain | `setInterval`, polling fetch, or WebSocket without backoff |
| Lost write | Optimistic update without server-write retry on reconnect |
| Stale data | Render path bypasses local DB, fetches from server only |
| Crash on rotate | State held in component instance, not persisted; or unsupported orientation lock |
| iOS-only / Android-only bug | `Platform.OS` branch lacking the other side; or platform-specific API used unguarded |

## Output

State the verdict: **PASS**, **FAIL**, or **NEEDS REVIEW**.

For each issue:

```
### [CRITICAL|HIGH|MEDIUM|LOW] Issue Title
**File**: path:line
**Platform**: iOS | Android | both
**Problem**: What is wrong
**Fix**: Exact code or pattern needed
```

If no issues: confirm the screens reviewed, the platforms tested, and that offline + reduced-motion + AA contrast all hold.
