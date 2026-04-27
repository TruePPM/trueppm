import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useShellStore } from '@/stores/shellStore';
import { useShellStats } from '@/hooks/useShellStats';
import { useGanttStore } from '@/stores/ganttStore';
import { useProjectPresence } from '@/hooks/useProjectPresence';
import { useProjectId } from '@/hooks/useProjectId';
import { useThemeStore, type Theme } from '@/stores/themeStore';
import { WarningIcon, CriticalDotIcon } from '@/components/Icons';
import { Logo } from './Logo';
import { ViewTabs } from './ViewTabs';
import { BadgePopover } from './BadgePopover';
import { TaskRunIndicator } from './TaskRunIndicator';
import { PresenceAvatarStack } from './PresenceAvatarStack';

interface Props {
  onHamburgerClick: () => void;
}

const THEME_BUTTONS: { value: Theme; label: string; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'Light mode',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <line x1="12" y1="2" x2="12" y2="4" />
        <line x1="12" y1="20" x2="12" y2="22" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="2" y1="12" x2="4" y2="12" />
        <line x1="20" y1="12" x2="22" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
    ),
  },
  {
    value: 'auto',
    label: 'Auto (system) mode',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
  },
  {
    value: 'dark',
    label: 'Dark mode',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    ),
  },
];

export function TopBar({ onHamburgerClick }: Props) {
  const sidebarCollapsed = useShellStore((s) => s.sidebarCollapsed);
  const { data: stats } = useShellStats();
  const setSelectedTaskId = useGanttStore((s) => s.setSelectedTaskId);
  const scrollToTask = useGanttStore((s) => s.scrollToTask);
  const navigate = useNavigate();
  const projectId = useProjectId() ?? null;
  const onlineUsers = useProjectPresence(projectId);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

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

        {/* Theme toggle — desktop only; 3-way: light / auto (system) / dark */}
        <div
          role="group"
          aria-label="Color scheme"
          className="hidden md:flex items-center border border-neutral-border rounded"
        >
          {THEME_BUTTONS.map(({ value, label, icon }, i) => (
            <button
              key={value}
              type="button"
              onClick={() => setTheme(value)}
              aria-pressed={theme === value}
              aria-label={label}
              className={[
                'h-7 w-7 flex items-center justify-center text-xs',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                i === 0 ? 'rounded-l' : '',
                i === THEME_BUTTONS.length - 1 ? 'rounded-r' : 'border-r border-neutral-border',
                theme === value
                  ? 'bg-neutral-surface-sunken text-neutral-text-primary'
                  : 'text-neutral-text-secondary hover:text-neutral-text-primary hover:bg-neutral-surface-raised',
              ].join(' ')}
            >
              {icon}
            </button>
          ))}
        </div>

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
