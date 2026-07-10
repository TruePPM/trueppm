import { useNavigate } from 'react-router';
import { useShellStore } from '@/stores/shellStore';
import { useScheduleStore } from '@/stores/scheduleStore';
import { modifierKeyLabel } from '@/lib/platform';
import { Logo } from './Logo';
import { ProgramTabs } from './ProgramTabs';
import { ShellNavScroller } from './ShellNavScroller';
import { LocationSwitcher } from './LocationSwitcher';
import { HealthCluster } from './HealthCluster';
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
 * `LocationSwitcher` · pinned right cluster (health chip · timer · quick-log ·
 * + New · run indicator · presence · sync · notifications · user menu, which is
 * the single home for the theme toggle).
 *
 * The right cluster was trimmed in #1680: Customize-views moved to the rail's
 * "This project" band, the current-sprint jump folded into the health popover's
 * sprint row, and the methodology label became a picker/rail subtitle.
 *
 * The location switcher's leaf is a plain `aria-current` label, not a dropdown —
 * the rail owns view switching, so the leaf is the one deliberate dedup.
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
    void navigate('/');
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

      {/* Desktop rail re-open ≡ — always visible: the only affordance that re-opens
          the 0px-hidden rail (ADR-0127 Decision D); ⌘/Ctrl+B and ⌘K also reach it. */}
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={sidebarCollapsed ? 'Show navigation' : 'Hide navigation'}
        aria-controls="primary-nav-rail"
        aria-expanded={!sidebarCollapsed}
        title={`${sidebarCollapsed ? 'Show' : 'Hide'} navigation (${modifierKeyLabel()}B)`}
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

      {/* Brand — mobile only (desktop carries it in the left rail). */}
      <span className="md:hidden shrink-0">
        <Logo />
      </span>

      {/* Location switcher (ADR-0203, #1643) — Program › Project › Leaf. Replaces the
          former breadcrumb + in-chrome ProjectSwitcher; the leaf is a plain
          "you are here" label because the rail owns view switching. Self-suppresses
          on settings routes and collapses to leaf-only off a project. */}
      <LocationSwitcher />

      {/* Program view nav (ADR-0095) — self-gates to program routes (renders nothing
          on project/global routes). Project views moved to the left rail in #1642,
          but program views have no rail home yet, so the program tab strip stays in
          the bar. Scrolls horizontally on overflow; the right cluster stays pinned. */}
      <ShellNavScroller>
        <ProgramTabs />
      </ShellNavScroller>

      {/* Right cluster — pinned, never compresses. */}
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {/* v2 health status chip + popover (ADR-0128, #1644) — project routes only;
            one all-width chip (dot + worst-state word + neutral P80) opening a
            role="dialog" health popover. Stays pinned, never behind a tab scroll. */}
        <HealthCluster onTaskNavigate={handleTaskNavigate} />

        {/* Running time-entry timer (issue 1415, ADR-0185 §C) — app-wide while a timer
            runs; renders nothing when idle. Started from a task-context surface
            (My Work row), stoppable from anywhere. */}
        <TimerChip />

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
    </header>
  );
}
