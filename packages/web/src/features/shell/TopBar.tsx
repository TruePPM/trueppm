import { useNavigate, useSearchParams } from 'react-router';
import { useShellStore } from '@/stores/shellStore';
import { useShellStats } from '@/hooks/useShellStats';
import { useGanttStore } from '@/stores/ganttStore';
import { useProjectPresence } from '@/hooks/useProjectPresence';
import { WarningIcon, CriticalDotIcon } from '@/components/Icons';
import { Logo } from './Logo';
import { ViewTabs } from './ViewTabs';
import { BadgePopover } from './BadgePopover';
import { TaskRunIndicator } from './TaskRunIndicator';
import { PresenceAvatarStack } from './PresenceAvatarStack';

interface Props {
  onHamburgerClick: () => void;
}

export function TopBar({ onHamburgerClick }: Props) {
  const sidebarCollapsed = useShellStore((s) => s.sidebarCollapsed);
  const { data: stats } = useShellStats();
  const setSelectedTaskId = useGanttStore((s) => s.setSelectedTaskId);
  const scrollToTask = useGanttStore((s) => s.scrollToTask);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get('project');
  const onlineUsers = useProjectPresence(projectId);

  function handleTaskNavigate(id: string) {
    setSelectedTaskId(id);
    scrollToTask(id);
    void navigate('/');
  }

  return (
    <header className="flex items-center h-12 px-4 gap-4 bg-neutral-surface-raised border-b border-neutral-border">
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

      <Logo />
      <ViewTabs />

      {/* Badges — pushed to the right */}
      <div className="ml-auto flex items-center gap-2">
        {/* P80 badge — desktop only; mobile sees it in StatusBar (issue #33) */}
        {stats?.monteCarlop80 && (
          <span
            className="hidden md:flex items-center gap-1 px-2 py-0.5 rounded border border-semantic-at-risk/80 bg-transparent text-xs font-medium text-semantic-at-risk"
            aria-label={`Monte Carlo P80 completion: ${stats.monteCarlop80}`}
          >
            P80:{' '}
            {new Date(stats.monteCarlop80).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            })}
          </span>
        )}

        {/* At-risk badge — clickable popover (issue #32) */}
        {stats && stats.atRiskCount > 0 && (
          <BadgePopover
            label={`${stats.atRiskCount} at risk tasks`}
            count={stats.atRiskCount}
            items={stats.atRiskTasks}
            colorVariant="at-risk"
            icon={<WarningIcon aria-hidden="true" />}
            onItemClick={handleTaskNavigate}
          />
        )}

        {/* Critical badge — clickable popover (issue #32) */}
        {stats && stats.criticalCount > 0 && (
          <BadgePopover
            label={`${stats.criticalCount} critical tasks`}
            count={stats.criticalCount}
            items={stats.criticalTasks}
            colorVariant="critical"
            icon={<CriticalDotIcon aria-hidden="true" />}
            onItemClick={handleTaskNavigate}
          />
        )}

        {/* Background operations indicator — visible only when runs are active */}
        <TaskRunIndicator />

        {/* Online collaborators — desktop only (hidden md:flex inside component) */}
        <PresenceAvatarStack users={onlineUsers} />

        {/* User avatar — menu deferred to auth feature */}
        <button
          type="button"
          aria-label="User menu"
          aria-haspopup="menu"
          className="flex items-center justify-center w-8 h-8 rounded-full text-xs font-semibold
            bg-brand-primary-light text-brand-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          U
        </button>
      </div>
    </header>
  );
}
