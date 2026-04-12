import { useEffect, useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { useShellStore, selectSidebarWidth } from '@/stores/shellStore';
import { useProjects } from '@/hooks/useProjects';
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
        'flex flex-col h-full bg-gantt-surface overflow-hidden flex-shrink-0',
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
            className="flex items-center justify-center w-8 h-8 rounded text-gantt-text-secondary hover:text-gantt-text-primary hover:bg-white/10
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-1 focus-visible:ring-offset-gantt-surface"
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

      {/* Project list */}
      <nav aria-label="Project list" className="flex-1 overflow-y-auto overflow-x-hidden py-2">
        {/* Section header + New Project button — hidden when sidebar is collapsed (rule 36) */}
        {!sidebarCollapsed && !isDrawer && (
          <div className="flex items-center justify-between px-3 pb-1 pt-1">
            <h2
              className="text-xs font-semibold tracking-widest uppercase text-gantt-text-secondary"
              aria-label="Projects"
            >
              PROJECTS
            </h2>
            <button
              type="button"
              onClick={() => setShowNewProject(true)}
              aria-label="New project"
              className="flex items-center justify-center w-5 h-5 rounded text-gantt-text-secondary
                hover:text-gantt-text-primary hover:bg-white/10
                focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white"
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
            className="px-3 py-2 text-xs text-gantt-semantic-critical"
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
              <li className="px-3 py-2 text-xs text-gantt-text-secondary">No projects yet</li>
            )}
          </ul>
        )}
      </nav>
    </aside>

      {/* New project modal — fixed overlay; rendered outside <aside> so it isn't clipped */}
      {showNewProject && (
        <NewProjectModal
          onClose={() => setShowNewProject(false)}
          onCreated={(projectId) => {
            setShowNewProject(false);
            if (isDrawer) onClose?.();
            void navigate(`/gantt?project=${projectId}`);
          }}
        />
      )}
    </>
  );
}
