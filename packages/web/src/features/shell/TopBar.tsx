import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router';
import type { ShellStats } from '@/types';
import { useShellStore } from '@/stores/shellStore';
import { useShellStats } from '@/hooks/useShellStats';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useProjectPresence } from '@/hooks/useProjectPresence';
import { useProjectId } from '@/hooks/useProjectId';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { WarningIcon, CriticalDotIcon } from '@/components/Icons';
import { Logo } from './Logo';
import { ViewTabs } from './ViewTabs';
import { ProgramTabs } from './ProgramTabs';
import { CommandPaletteTrigger } from './commandPalette/CommandPaletteTrigger';
import { BadgePopover } from './BadgePopover';
import { TaskRunIndicator } from './TaskRunIndicator';
import { PresenceAvatarStack } from './PresenceAvatarStack';
import { MCResultPanel } from './MCResultPanel';
import { NotificationBell } from './NotificationBell';
import { UserMenu } from './UserMenu';

interface Props {
  onHamburgerClick: () => void;
}

// ---------------------------------------------------------------------------
// HealthDropdown — mobile collapse of the three status pills (issue #205).
// Visible below lg: (1024px); individual pills are hidden lg:flex above that.
// ---------------------------------------------------------------------------

interface HealthDropdownProps {
  stats: ShellStats | undefined;
  onTaskNavigate: (id: string) => void;
}

function HealthDropdown({ stats, onTaskNavigate }: HealthDropdownProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const hasBadge =
    Boolean(stats?.monteCarlop80) ||
    (stats?.atRiskCount ?? 0) > 0 ||
    (stats?.criticalCount ?? 0) > 0;

  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [open]);

  if (!hasBadge || !stats) return null;

  return (
    <div ref={wrapperRef} className="lg:hidden relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Project health summary"
        className="flex items-center gap-1 h-6 px-2 rounded border border-neutral-border
          text-[12px] font-medium text-neutral-text-secondary
          hover:bg-neutral-surface-raised
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        Health <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Project health summary"
          className="absolute top-full right-0 mt-1 z-50 min-w-[180px] bg-neutral-surface border border-neutral-border rounded p-1"
        >
          {stats.monteCarlop80 && (
            <div role="presentation" className="flex items-center gap-1 px-2 py-1.5 text-xs">
              <span className="font-medium text-semantic-at-risk">P80:</span>
              <span className="tppm-mono text-neutral-text-primary">
                {new Date(stats.monteCarlop80).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
            </div>
          )}
          {stats.atRiskTasks.map((item) => (
            <button
              key={item.id}
              role="menuitem"
              type="button"
              onClick={() => { onTaskNavigate(item.id); setOpen(false); }}
              className="w-full text-left px-2 py-1.5 rounded text-xs text-semantic-at-risk
                hover:bg-neutral-surface-raised
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset"
            >
              <span className="text-neutral-text-secondary mr-1">{item.wbs}</span>
              {item.name}
            </button>
          ))}
          {stats.criticalTasks.map((item) => (
            <button
              key={item.id}
              role="menuitem"
              type="button"
              onClick={() => { onTaskNavigate(item.id); setOpen(false); }}
              className="w-full text-left px-2 py-1.5 rounded text-xs text-semantic-critical
                hover:bg-neutral-surface-raised
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset"
            >
              <span className="text-neutral-text-secondary mr-1">{item.wbs}</span>
              {item.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


export function TopBar({ onHamburgerClick }: Props) {
  const sidebarCollapsed = useShellStore((s) => s.sidebarCollapsed);
  const { data: stats } = useShellStats();
  const setSelectedTaskId = useScheduleStore((s) => s.setSelectedTaskId);
  const scrollToTask = useScheduleStore((s) => s.scrollToTask);
  const navigate = useNavigate();
  const projectId = useProjectId() ?? null;
  const allOnlineUsers = useProjectPresence(projectId);
  const { user: currentUser } = useCurrentUser();
  const onlineUsers = allOnlineUsers.filter((u) => u.user_id !== currentUser?.id);
  const [showMCPanel, setShowMCPanel] = useState(false);
  const { data: mcResult } = useMonteCarloResult(projectId ?? undefined);

  function handleTaskNavigate(id: string) {
    setSelectedTaskId(id);
    scrollToTask(id);
    void navigate('/');
  }

  return (
    <>
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

      <Logo />
      <ViewTabs />
      <ProgramTabs />

      {/* Command palette trigger (v2 design system) — pushed right, before the badges */}
      <div className="ml-auto" />
      <CommandPaletteTrigger />

      {/* Badges */}
      <div className="flex items-center gap-2">
        {/* Status pills — lg+ shows individually; below lg collapses to Health dropdown */}
        <div className="hidden lg:flex items-center gap-2">
          {/* P80 — outlined at-risk pill; click opens MC distribution panel (issue #196). */}
          {stats?.monteCarlop80 && (
            <button
              type="button"
              onClick={() => setShowMCPanel(true)}
              aria-label={`Monte Carlo P80 completion: ${stats.monteCarlop80}. Click to view distribution.`}
              aria-haspopup="dialog"
              aria-expanded={showMCPanel}
              className="flex items-center gap-1 h-6 px-2 rounded border border-semantic-at-risk/80 bg-semantic-at-risk-bg text-[12px] font-medium text-semantic-at-risk
                hover:bg-semantic-at-risk/10
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              P80:{' '}
              {new Date(stats.monteCarlop80).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
              })}
            </button>
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
        </div>

        {/* Mobile health dropdown — visible below lg:, hidden at lg+ (rule 205) */}
        <HealthDropdown stats={stats} onTaskNavigate={handleTaskNavigate} />

        {/* Background operations indicator — visible only when runs are active */}
        <TaskRunIndicator />

        {/* Online collaborators — desktop only (hidden md:flex inside component) */}
        <PresenceAvatarStack users={onlineUsers} />

        {/* Notification bell — visible at all widths; opens slide-out on md+,
            navigates to /me/notifications on mobile (#311 frontend phase 3). */}
        <NotificationBell />

        {/* User menu — avatar chip with theme toggle, notifications, keyboard shortcuts, and sign out */}
        <UserMenu />
      </div>
    </header>

    {/* MC distribution panel — opened by clicking the P80 pill (issue #196) */}
    {showMCPanel && mcResult && (
      <MCResultPanel result={mcResult} onClose={() => setShowMCPanel(false)} />
    )}
  </>
  );
}
