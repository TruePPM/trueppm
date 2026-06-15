import { useNavigate } from 'react-router';
import { useShellStore } from '@/stores/shellStore';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useProjectPresence } from '@/hooks/useProjectPresence';
import { useProjectId } from '@/hooks/useProjectId';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { Logo } from './Logo';
import { ViewTabs, MethodWorkspaceLabel } from './ViewTabs';
import { ProgramTabs } from './ProgramTabs';
import { HealthCluster } from './HealthCluster';
import { TaskRunIndicator } from './TaskRunIndicator';
import { PresenceAvatarStack } from './PresenceAvatarStack';
import { NotificationBell } from './NotificationBell';
import { UserMenu } from './UserMenu';

interface Props {
  onHamburgerClick: () => void;
}

export function TopBar({ onHamburgerClick }: Props) {
  const sidebarCollapsed = useShellStore((s) => s.sidebarCollapsed);
  const setSelectedTaskId = useScheduleStore((s) => s.setSelectedTaskId);
  const scrollToTask = useScheduleStore((s) => s.scrollToTask);
  const navigate = useNavigate();
  const projectId = useProjectId() ?? null;
  const allOnlineUsers = useProjectPresence(projectId);
  const { user: currentUser } = useCurrentUser();
  const onlineUsers = allOnlineUsers.filter((u) => u.user_id !== currentUser?.id);

  function handleTaskNavigate(id: string) {
    setSelectedTaskId(id);
    scrollToTask(id);
    void navigate('/');
  }

  return (
    <header className="flex items-center h-12 px-4 gap-4 bg-chrome-surface border-b border-chrome-border">
      {/* Hamburger — visible only below md */}
      <button
        type="button"
        onClick={onHamburgerClick}
        aria-label="Open sidebar"
        aria-expanded={!sidebarCollapsed}
        className="md:hidden flex items-center justify-center w-11 h-11 rounded text-neutral-text-secondary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <rect y="3" width="20" height="2" rx="1" />
          <rect y="9" width="20" height="2" rx="1" />
          <rect y="15" width="20" height="2" rx="1" />
        </svg>
      </button>

      {/* Brand is mobile-only here — on desktop the v2 left rail carries it. */}
      <span className="md:hidden">
        <Logo />
      </span>
      <ViewTabs />
      <ProgramTabs />

      {/* Right cluster */}
      <div className="ml-auto flex items-center gap-3">
        {/* "{METHOD} Workspace" tag — right-aligned start of the cluster (ADR-0128). */}
        <MethodWorkspaceLabel />

        {/* v2 methodology-adaptive health cluster (ADR-0128) — replaces the three
            free-floating P80 / at-risk / critical badges. */}
        <HealthCluster onTaskNavigate={handleTaskNavigate} />

        {/* Background operations indicator — visible only when runs are active */}
        <TaskRunIndicator />

        {/* Online collaborators — desktop only (hidden md:flex inside component) */}
        <PresenceAvatarStack users={onlineUsers} />

        {/* Notification bell — visible at all widths; opens slide-out on md+,
            navigates to /me/notifications on mobile (frontend phase 3). */}
        <NotificationBell />

        {/* User menu — avatar chip with theme toggle, notifications, keyboard shortcuts, and sign out */}
        <UserMenu />
      </div>
    </header>
  );
}
