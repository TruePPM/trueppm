import { useNavigate } from 'react-router';
import { useShellStore } from '@/stores/shellStore';
import { useScheduleStore } from '@/stores/scheduleStore';
import { modifierKeyLabel } from '@/lib/platform';
import { Logo } from './Logo';
import { LocationSwitcher } from './LocationSwitcher';
import { HealthCluster } from './HealthCluster';
import { MethodologyIndicator } from './MethodologyIndicator';
import { CreateMenu } from './CreateMenu';
import { TaskRunIndicator } from './TaskRunIndicator';
import { TimerChip } from '@/features/timer/TimerChip';
import { QuickLogTime } from '@/features/timeentry/QuickLogTime';
import { PresenceAvatarStack } from './PresenceAvatarStack';
import { SyncStatusBadge } from './SyncStatusBadge';
import { NotificationBell } from './NotificationBell';
import { UserMenu } from './UserMenu';
import { useProjectId } from '@/hooks/useProjectId';
import { useProjectPresence } from '@/hooks/useProjectPresence';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { StatusClusterScroller } from './StatusClusterScroller';

interface Props {
  onHamburgerClick: () => void;
}

/**
 * v2 unified shell bar (ADR-0134, amended by ADR-0203 / issue #1643) — one 56px
 * bar. After the shell-redesign v2 the left rail owns view switching (#1642), so
 * the bar no longer carries the view-tab strip: its left region is a **location
 * switcher** (`Program › Project › Leaf`) that replaces both the former breadcrumb
 * and the in-chrome `ProjectSwitcher`, and the view/program tab scroller is gone.
 *
 * Left → right: mobile hamburger / desktop rail re-open ≡ · mobile brand ·
 * `LocationSwitcher` · pinned right cluster (methodology indicator · health chip ·
 * timer · quick-log · + New · run indicator · presence · sync · notifications ·
 * user menu, which is the single home for the theme toggle).
 *
 * The right cluster was trimmed in #1680: Customize-views moved to the rail's
 * "This project" band, the current-sprint jump folded into the health popover's
 * sprint row, and the methodology label became a picker/rail subtitle. #1907
 * restored a compact bar indicator (`MethodologyIndicator`) because that rail
 * subtitle only renders while the rail is expanded, and the rail auto-collapses
 * below 1023px — leaving 768–1023px with no methodology signal on a fresh
 * session. The bar indicator self-gates to a collapsed rail so it never doubles
 * up with the subtitle.
 *
 * The location switcher's leaf is a plain `aria-current` label, not a dropdown —
 * the rail owns view switching, so the leaf is the one deliberate dedup.
 *
 * **Overflow contract (#2533, rule 290).** The right region is two groups, not
 * one row: a **status cluster** (methodology · health · timer) wrapped in
 * `StatusClusterScroller`, which scrolls horizontally when it outgrows the bar,
 * and a **pinned chrome group** (quick-log · + New · run indicator · presence ·
 * sync · bell · identity) that never scrolls. At md+ the region carries an
 * overwhelming `shrink` weight, so the location switcher keeps its natural width
 * and a segment added to the health cluster can no longer push the breadcrumb.
 * Adding a segment is therefore a cluster-local decision — which is the property
 * #2531 needs.
 */
export function TopBar({ onHamburgerClick }: Props) {
  const sidebarCollapsed = useShellStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useShellStore((s) => s.toggleSidebar);
  const setSelectedTaskId = useScheduleStore((s) => s.setSelectedTaskId);
  const scrollToTask = useScheduleStore((s) => s.scrollToTask);
  const navigate = useNavigate();

  const projectId = useProjectId();

  // Ephemeral presence: collaborators currently viewing this project, minus self.
  // Empty off-project (hook disabled when projectId is undefined).
  const { user: currentUser } = useCurrentUser();
  const onlineUsers = useProjectPresence(projectId).filter((u) => u.user_id !== currentUser?.id);

  function handleTaskNavigate(id: string) {
    setSelectedTaskId(id);
    scrollToTask(id);
    // Route to the current project's Schedule so the store selection lands where
    // the task lives. `navigate('/')` was a stale single-project-era path that
    // `RootRedirect` resolves to the user's landing page (#2032), dumping the user
    // on My Work instead of the "what's on fire → take me there" target.
    if (projectId) {
      void navigate(`/projects/${projectId}/schedule`);
    }
  }

  return (
    <header className="flex items-center h-14 px-3 gap-2 bg-chrome-surface border-b border-chrome-border">
      {/* Hamburger — visible only below md (opens the rail drawer) */}
      <button
        type="button"
        onClick={onHamburgerClick}
        aria-label="Open sidebar"
        aria-expanded={!sidebarCollapsed}
        className="md:hidden flex shrink-0 items-center justify-center w-11 h-11 rounded-control text-neutral-text-secondary
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <rect y="3" width="20" height="2" rx="1" />
          <rect y="9" width="20" height="2" rx="1" />
          <rect y="15" width="20" height="2" rx="1" />
        </svg>
      </button>

      {/* Desktop rail ≡ — always visible. Kept as a TOGGLE, not a rescue
          (ADR-0979 §6): ADR-0127 made it non-negotiable because nav could be lost
          at 0px, and at 64px nav is never lost — but expand-from-icon-only would
          otherwise have no explicit affordance, and the cost is one button in a
          bar that already renders it. ⌘/Ctrl+B reaches the same toggle.

          The copy states the DIRECTION, not a disappearance: since ADR-0979 the
          rail never hides, so "Hide navigation" would name an outcome that no
          longer happens. */}
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}
        aria-controls="primary-nav-rail"
        aria-expanded={!sidebarCollapsed}
        title={`${sidebarCollapsed ? 'Expand' : 'Collapse'} navigation (${modifierKeyLabel()}B)`}
        className="hidden md:inline-flex shrink-0 w-8 h-8 items-center justify-center rounded-control text-chrome-text-secondary hover:text-chrome-text-primary hover:bg-neutral-text-primary/5 focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:ring-offset-chrome-surface"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <line x1="2" y1="4" x2="14" y2="4" strokeLinecap="round" />
          <line x1="2" y1="8" x2="14" y2="8" strokeLinecap="round" />
          <line x1="2" y1="12" x2="14" y2="12" strokeLinecap="round" />
        </svg>
      </button>

      {/* Brand — mobile only (desktop carries it in the left rail). Mark-only on a
          phone: the full wordmark crowds the fixed right cluster off the edge
          (#1788); the rail drawer (hamburger) still shows the full lockup. */}
      <span className="md:hidden shrink-0">
        <Logo showWordmark={false} />
      </span>

      {/* Location switcher (ADR-0203, #1643) — Program › Project › Leaf. Replaces the
          former breadcrumb + in-chrome ProjectSwitcher; the leaf is a plain
          "you are here" label because the rail owns view switching. Self-suppresses
          on settings routes and collapses to leaf-only off a project. */}
      <LocationSwitcher />

      {/* Program view nav moved to the left rail's "This program" tier (#1920,
          resolving the #1643 deferral): the rail now owns view switching for both
          projects (#1642) and programs, so the bar no longer carries either tab
          strip. The location switcher's leaf stays a plain "you are here" label. */}

      {/* Right region (#2533) — split into a **scrollable status cluster** and a
          **pinned chrome group**. Until #2533 the whole right cluster was a single
          `shrink-0` row with no overflow rule, so it did not wrap and did not
          scroll — it *pushed*. The #2483 design handoff (§5.1) measured the bar at
          1280 with a 640px budget against a cluster already ~470px at five
          segments, so the first surface to add a sixth silently squeezed the
          location switcher at whatever width the user happened to be on.

          `shrink-[9999]` gives this region an overwhelming share of any shrink, so
          the location switcher keeps its natural width — it is non-shrinking in
          every layout where the cluster still has room to give. Deliberately not
          `shrink-0` on the switcher: with the switcher rigid, a wide breadcrumb at
          1024 with the rail expanded can drive the cluster's `min-w-0` box to zero
          and collapse the health chip out of existence (the `min-w-0`-in-a-crowded-
          flex-nowrap-toolbar trap from #2208). Weighted shrink gets the same
          "breadcrumb never gives" behaviour with a graceful floor instead of a
          cliff — `StatusClusterScroller` owns that floor (`md:min-w-*`), so the
          strip stops shrinking while the health chip is still legible and the
          breadcrumb truncates past that point.

          Deliberately **no `min-w-0` on this region**. `min-w-0` here would
          remove its automatic minimum size, and because the region carries the
          9999 shrink weight it would then be the first thing driven to zero —
          taking the `shrink-0` pinned chrome with it, straight off the right
          edge of the bar, since the region has no overflow rule of its own. With
          the automatic minimum left in place the region's floor *is* the pinned
          chrome, so the shrink order is exactly the contract: status cluster
          scrolls → status cluster reaches zero → only then does the breadcrumb
          truncate. The account chip can never leave the viewport, which is the
          promise the pinned group is named for. (Both inner groups keep their own
          `min-w-0`; it is only the outer region that must retain its floor.)

          The **shrink weight** is held to md and up. The scroll container itself
          exists at every width but is inert below md, because there the region is
          `shrink-0` and its children therefore always get their natural width.
          That is deliberate: #1788 tuned the phone bar around a rigid cluster (the
          health chip drops its P80 fragment, the sync badge its word, the brand
          its wordmark, and the whole row fits 375px), and on a phone the
          *breadcrumb* is the right thing to give — it is non-interactive
          wayfinding whose two labels truncate cleanly, whereas a scrolling cluster
          at 375px puts the health chip half under the pinned chrome. The overflow
          rule is a desktop-width rule because the width budget it answers
          (#2483 §5.1) is measured at 1024/1280/1440.

          The gap tokens are repeated on the wrapper and both groups so the rhythm
          is byte-identical to the flat row this replaces — tighter below md so the
          phone-surfaced controls (#1770 quick-log, +New, sync, bell, user) fit a
          375px width without clipping (#1788), full gap-3 at md+. */}
      <div className="ml-auto flex shrink-0 md:shrink-[9999] items-center gap-1.5 md:gap-3">
        {/* Status cluster — the half that absorbs growth. `StatusClusterScroller`
            owns the whole overflow contract (rule 290): zero-layout scrollbar,
            both edge fades, the pointer-only chevron nudges, the motion gate, the
            min-width floor, and the focus-ring headroom. Only segments whose
            overlays portal or are `position: fixed` may live inside it. */}
        <StatusClusterScroller>
          {/* Always-visible methodology indicator (issue #1907) — fills the 768–1023px
              gap left when #1680 moved the signal to the rail subtitle, which only
              renders while the rail is expanded. Self-gates to project routes and to
              a collapsed rail, so it never doubles up with that subtitle. Its
              tooltip portals to `document.body`, so the scroller cannot clip it. */}
          <MethodologyIndicator />

          {/* v2 health status chip + popover (ADR-0128, #1644) — project routes only;
              one all-width chip (dot + worst-state word + neutral P80) opening a
              role="dialog" health popover. The popover is portaled and positioned
              `fixed` from the chip's rect (rule 253), and `MCResultPanel` is
              `position: fixed`, so neither is clipped by the scroll container. */}
          <HealthCluster onTaskNavigate={handleTaskNavigate} />

          {/* Running time-entry timer (issue 1415, ADR-0185 §C) — app-wide while a timer
              runs; renders nothing when idle. Started from a task-context surface
              (My Work row), stoppable from anywhere. Opens no overlay. */}
          <TimerChip />
        </StatusClusterScroller>

        {/* Pinned chrome — actions and app-wide anchors. Never scrolls and never
            shrinks: a "+ New" or an account chip that can scroll out of reach is a
            worse defect than a pushed breadcrumb. This is also why the split lands
            exactly here: `QuickLogTime` and `CreateMenu` open **in-flow**
            `absolute` panels (they predate rules 253/260), and an `overflow-x-auto`
            ancestor clips an in-flow popover — z-index does not defeat it. The
            scrolling half therefore holds only the three read-only status segments,
            whose overlays already escape: the health popover portals to
            `document.body` (rule 253), `MCResultPanel` is `position: fixed`, and
            `MethodologyIndicator`'s tooltip portals. Anything added to the scroller
            later must clear that same bar. */}
        <div className="flex shrink-0 items-center gap-1.5 md:gap-3">
          {/* Global quick-log time popover (issue 1416, ADR-0185 §C) — log effort
              from anywhere: task picker + duration presets, no timer needed. Anchored
              popover from md up; below md the same form opens in a bottom sheet
              (#1770), so the 15-second capture path exists on phones too. */}
          <QuickLogTime />

          {/* Context-aware "+ New" (ADR-0131) — self-gates by route + RBAC. */}
          <CreateMenu />

          {/* Background operations indicator — visible only when runs are active. */}
          <TaskRunIndicator />

          {/* Online collaborators — desktop only (hidden md:flex inside the component);
              renders nothing off-project or when no one else is online. */}
          <PresenceAvatarStack users={onlineUsers} />

          {/* Calm write-sync indicator (ADR-0205, issue 374) — persistent; reflects
              the client-side write queue (Synced / Syncing / Offline / Error) and
              opens a modal with the pending-write list and manual retry. Stays
              visible on mobile: offline trust matters most there. */}
          <SyncStatusBadge />

          {/* Notification bell — visible at all widths. */}
          <NotificationBell />

          {/* Vertical divider fencing the "me" identity chip off from the utility
              cluster (presence, sync, bell) so there is one unambiguous identity
              affordance (#1736, design §02). Decorative. */}
          <span className="h-6 w-px shrink-0 bg-chrome-border/40" aria-hidden="true" />

          {/* User menu — avatar chip; the single home for the theme toggle, plus
              notifications, keyboard shortcuts, and sign out. */}
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
