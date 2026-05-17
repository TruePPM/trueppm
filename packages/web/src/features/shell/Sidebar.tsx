import { useEffect, useCallback, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { useShellStore, selectSidebarWidth } from '@/stores/shellStore';
import { useProjects } from '@/hooks/useProjects';
import { useMyWork } from '@/hooks/useMyWork';
import { ProjectListItem } from './ProjectListItem';
import { NewProjectModal } from './NewProjectModal';

interface Props {
  isDrawer?: boolean;
  onClose?: () => void;
}

export function Sidebar({ isDrawer = false, onClose }: Props) {
  const { sidebarCollapsed, sidebarUserControlled, toggleSidebar, setSidebarCollapsed } =
    useShellStore();
  const sidebarWidth = useShellStore(selectSidebarWidth);
  const { data: projects, isLoading, error } = useProjects();
  // My Work due-today count drives the actionable badge on the "My Work"
  // sidebar entry (issue #499). useMyWork is cached and shared with MyWorkPage,
  // so this adds at most one request per session unless the user opens the page.
  const { data: myWorkData } = useMyWork();
  const dueTodayCount = myWorkData?.pages[0]?.due_today_count ?? 0;
  const [showNewProject, setShowNewProject] = useState(false);
  const navigate = useNavigate();

  // Auto-collapse at < lg (1024px) unless user has manually set state
  const handleResize = useCallback(() => {
    if (sidebarUserControlled) return;
    const isNarrow = window.matchMedia('(max-width: 1023px)').matches;
    setSidebarCollapsed(isNarrow, false);
  }, [sidebarUserControlled, setSidebarCollapsed]);

  useEffect(() => {
    if (isDrawer) return; // drawer state is controlled externally
    handleResize();
    const mq = window.matchMedia('(max-width: 1023px)');
    mq.addEventListener('change', handleResize);
    return () => mq.removeEventListener('change', handleResize);
  }, [isDrawer, handleResize]);

  // Trap focus and close on Escape when used as a drawer
  useEffect(() => {
    if (!isDrawer) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isDrawer, onClose]);

  const widthClass = isDrawer ? 'w-[220px]' : `w-[${sidebarWidth}px]`;

  return (
    <>
    <aside
      aria-label="Projects"
      style={isDrawer ? undefined : { width: sidebarWidth, transition: 'width 200ms ease-out' }}
      className={[
        'flex flex-col h-full bg-chrome-surface overflow-hidden flex-shrink-0',
        'border-r border-chrome-border/8',
        isDrawer ? widthClass : '',
      ].join(' ')}
    >
      {/* Collapse toggle — hidden in drawer mode */}
      {!isDrawer && (
        <div className="flex justify-end px-2 pt-2">
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!sidebarCollapsed}
            className="flex items-center justify-center w-11 h-11 rounded text-chrome-text-secondary hover:text-chrome-text-primary hover:bg-neutral-text-primary/5
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden="true"
              style={{ transform: sidebarCollapsed ? 'rotate(180deg)' : 'none', transition: 'transform 200ms ease-out' }}
            >
              <path d="M10.5 8L6 3.5 4.5 5l3 3-3 3L6 12.5l4.5-4.5z" />
            </svg>
          </button>
        </div>
      )}

      {/* Me section — cross-project surfaces (issue #499). Sits above PROJECTS
          because contributors who don't think in projects need a one-tap path
          to their work. Badge shows the due-today count when actionable. */}
      {!sidebarCollapsed && !isDrawer && (
        <div className="shrink-0 px-2 py-2 border-b border-chrome-border/8">
          <h2
            className="px-1 pb-1 text-xs font-semibold tracking-widest uppercase text-chrome-text-secondary"
            aria-label="Me"
          >
            Me
          </h2>
          <NavLink
            to="/me/work"
            aria-label={
              dueTodayCount > 0
                ? `My Work, ${dueTodayCount} due today`
                : 'My Work'
            }
            className={({ isActive }) =>
              [
                'flex items-center justify-between gap-2 w-full px-2 py-2 rounded text-sm transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface',
                isActive
                  ? 'bg-brand-primary/10 border-l-2 border-brand-primary text-chrome-text-primary font-medium'
                  : 'border-l-2 border-transparent text-chrome-text-secondary hover:bg-neutral-text-primary/5 hover:text-chrome-text-primary',
              ].join(' ')
            }
          >
            <span className="inline-flex items-center gap-2 min-w-0">
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="currentColor"
                aria-hidden="true"
                className="shrink-0"
              >
                <path d="M2 3h10v2H2V3zm0 3h10v2H2V6zm0 3h6v2H2V9z" />
              </svg>
              My Work
            </span>
            {dueTodayCount > 0 && (
              <span
                aria-hidden="true"
                className="tppm-mono text-[11px] text-semantic-critical bg-semantic-critical-bg
                  rounded-full px-1.5 py-0.5 shrink-0"
              >
                {dueTodayCount}
              </span>
            )}
          </NavLink>
        </div>
      )}

      {/* Collapsed sidebar: icon-only My Work link */}
      {sidebarCollapsed && !isDrawer && (
        <div className="shrink-0 px-2 py-2 border-b border-chrome-border/8">
          <NavLink
            to="/me/work"
            aria-label="My Work"
            className={({ isActive }) =>
              [
                'relative flex items-center justify-center w-11 h-11 rounded transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface',
                isActive
                  ? 'bg-brand-primary/10 text-chrome-text-primary'
                  : 'text-chrome-text-secondary hover:bg-neutral-text-primary/5 hover:text-chrome-text-primary',
              ].join(' ')
            }
          >
            <svg width="16" height="16" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
              <path d="M2 3h10v2H2V3zm0 3h10v2H2V6zm0 3h6v2H2V9z" />
            </svg>
            {dueTodayCount > 0 && (
              <span
                aria-hidden="true"
                className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-semantic-critical"
              />
            )}
          </NavLink>
        </div>
      )}

      {/* Project list */}
      <nav aria-label="Project list" className="flex-1 overflow-y-auto overflow-x-hidden py-2">
        {/* Section header + New Project button — hidden when sidebar is collapsed (rule 36) */}
        {!sidebarCollapsed && !isDrawer && (
          <div className="flex items-center justify-between px-3 pb-1 pt-1">
            <h2
              className="text-xs font-semibold tracking-widest uppercase text-chrome-text-secondary"
              aria-label="Projects"
            >
              PROJECTS
            </h2>
            {/* Touch target is 44×44px; icon stays 12×12px visually (Rule 5) */}
            <button
              type="button"
              onClick={() => setShowNewProject(true)}
              aria-label="New project"
              className="flex items-center justify-center w-11 h-11 -mr-2 rounded
                text-chrome-text-secondary hover:text-chrome-text-primary hover:bg-neutral-text-primary/5
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        )}

        {isLoading ? (
          <ul className="space-y-1 px-2" aria-label="Loading projects">
            {[1, 2, 3, 4].map((i) => (
              <li key={i} className="h-9 rounded animate-pulse bg-white/20" aria-hidden="true" />
            ))}
          </ul>
        ) : error ? (
          <p
            role="alert"
            className="px-3 py-2 text-xs text-semantic-critical"
          >
            Failed to load projects
          </p>
        ) : (
          <ul className="space-y-0.5 px-2">
            {projects?.map((project) => (
              <ProjectListItem
                key={project.id}
                project={project}
                collapsed={!isDrawer && sidebarCollapsed}
              />
            ))}
            {projects?.length === 0 && (
              <li className="px-3 py-2 text-xs text-chrome-text-secondary">No projects yet</li>
            )}
          </ul>
        )}
      </nav>

      {/* Org-level section — Resources catalog link */}
      {!sidebarCollapsed && !isDrawer && (
        <div className="shrink-0 border-t border-chrome-border/8 px-2 py-2">
          <h2
            className="px-1 pb-1 text-xs font-semibold tracking-widest uppercase text-chrome-text-secondary"
            aria-label="Organization"
          >
            Org
          </h2>
          <NavLink
            to="/resources"
            aria-label="Resources catalog"
            className={({ isActive }) =>
              [
                'flex items-center gap-2 w-full px-2 py-2 rounded text-sm transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface',
                isActive
                  ? 'bg-brand-primary/10 border-l-2 border-brand-primary text-chrome-text-primary font-medium'
                  : 'border-l-2 border-transparent text-chrome-text-secondary hover:bg-neutral-text-primary/5 hover:text-chrome-text-primary',
              ].join(' ')
            }
          >
            {/* People / users icon */}
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true" className="shrink-0">
              <path d="M5 6.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm-3 4.5a3 3 0 0 1 6 0H2Zm7-4.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm1 1.5c.7.3 1.3.8 1.7 1.4A3 3 0 0 0 9 11h-.5A4 4 0 0 0 9 9a3 3 0 0 0-.3-1.3c.4-.1.8-.2 1.3-.2Z"/>
            </svg>
            Resources
          </NavLink>
        </div>
      )}

      {/* Collapsed sidebar: icon-only Resources link */}
      {sidebarCollapsed && !isDrawer && (
        <div className="shrink-0 border-t border-chrome-border/8 px-2 py-2">
          <NavLink
            to="/resources"
            aria-label="Resources catalog"
            className={({ isActive }) =>
              [
                'flex items-center justify-center w-11 h-11 rounded transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface',
                isActive
                  ? 'bg-brand-primary/10 text-chrome-text-primary'
                  : 'text-chrome-text-secondary hover:bg-neutral-text-primary/5 hover:text-chrome-text-primary',
              ].join(' ')
            }
          >
            <svg width="16" height="16" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
              <path d="M5 6.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm-3 4.5a3 3 0 0 1 6 0H2Zm7-4.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm1 1.5c.7.3 1.3.8 1.7 1.4A3 3 0 0 0 9 11h-.5A4 4 0 0 0 9 9a3 3 0 0 0-.3-1.3c.4-.1.8-.2 1.3-.2Z"/>
            </svg>
          </NavLink>
        </div>
      )}
    </aside>

      {/* New project modal — fixed overlay; rendered outside <aside> so it isn't clipped */}
      {showNewProject && (
        <NewProjectModal
          onClose={() => setShowNewProject(false)}
          onCreated={(projectId) => {
            setShowNewProject(false);
            if (isDrawer) onClose?.();
            void navigate(`/projects/${projectId}/overview`);
          }}
        />
      )}
    </>
  );
}
