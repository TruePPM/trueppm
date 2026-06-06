import { useEffect, useCallback, useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { useShellStore, selectSidebarWidth } from '@/stores/shellStore';
import { useProjects } from '@/hooks/useProjects';
import { usePrograms } from '@/hooks/usePrograms';
import { useMyWork } from '@/hooks/useMyWork';
import { ProjectListItem } from './ProjectListItem';
import { ProjectGroup } from './ProjectGroup';
import { ProjectScopePicker } from './ProjectScopePicker';
import { NewProjectModal } from './NewProjectModal';
import { NewProgramModal } from '@/features/programs/NewProgramModal';
import { ImportProjectModal } from '@/components/import/ImportProjectModal';
import { ProgramsSection } from './ProgramsSection';

interface Props {
  isDrawer?: boolean;
  onClose?: () => void;
}

export function Sidebar({ isDrawer = false, onClose }: Props) {
  const { sidebarCollapsed, sidebarUserControlled, toggleSidebar, setSidebarCollapsed } =
    useShellStore();
  const sidebarWidth = useShellStore(selectSidebarWidth);
  const projectScope = useShellStore((s) => s.projectScope);
  const setProjectScope = useShellStore((s) => s.setProjectScope);
  const { data: projects, isLoading, error } = useProjects();
  const { data: programs } = usePrograms();
  // My Work due-today count drives the actionable badge on the "My Work"
  // sidebar entry (issue #499). useMyWork is cached and shared with MyWorkPage,
  // so this adds at most one request per session unless the user opens the page.
  const { data: myWorkData } = useMyWork();
  const dueTodayCount = myWorkData?.pages[0]?.due_today_count ?? 0;
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewProgram, setShowNewProgram] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [query, setQuery] = useState('');
  // Collapsed program groups in the "All programs" scope, keyed by group id.
  // Default (absent key) is expanded — matches the design's open groups.
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const navigate = useNavigate();

  // The full redesign (scope picker + search + one-line list) renders in the
  // expanded desktop sidebar and the mobile drawer. The collapsed desktop rail
  // stays an icon-only column (#959, Direction C).
  const showScopedList = !sidebarCollapsed || isDrawer;

  // Project counts for the scope picker, derived from the cached project list.
  const totalCount = projects?.length ?? 0;
  const noProgramCount = useMemo(
    () => projects?.filter((p) => !p.programId).length ?? 0,
    [projects],
  );
  const countFor = useCallback(
    (programId: string) => projects?.filter((p) => p.programId === programId).length ?? 0,
    [projects],
  );

  // Projects narrowed by the active program scope, then by the in-scope search.
  // Drives the PROJECTS · N header count and the flat (single-program) list.
  const scopedProjects = useMemo(() => {
    let list = projects ?? [];
    if (projectScope === 'none') list = list.filter((p) => !p.programId);
    else if (projectScope !== 'all') list = list.filter((p) => p.programId === projectScope);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((p) => p.name.toLowerCase().includes(q));
    return list;
  }, [projects, projectScope, query]);

  // In the "All programs" scope the list is grouped under collapsible program
  // headers (#959, Direction C "grouped"); orphan projects fall under a final
  // "No program" group. Only groups with at least one matching project render.
  const NONE_GROUP = '__none__';
  const programGroups = useMemo(() => {
    if (projectScope !== 'all') return [];
    const q = query.trim().toLowerCase();
    const allProjects = projects ?? [];
    const matches = (p: (typeof allProjects)[number]) => !q || p.name.toLowerCase().includes(q);
    const groups: {
      id: string;
      name: string;
      color: string | null;
      projects: typeof allProjects;
    }[] = [];
    for (const prog of programs ?? []) {
      const kids = allProjects.filter((p) => p.programId === prog.id && matches(p));
      if (kids.length)
        groups.push({ id: prog.id, name: prog.name, color: prog.color, projects: kids });
    }
    const orphans = allProjects.filter((p) => !p.programId && matches(p));
    if (orphans.length)
      groups.push({ id: NONE_GROUP, name: 'No program', color: null, projects: orphans });
    return groups;
  }, [projectScope, programs, projects, query]);

  const scopeName =
    projectScope === 'all'
      ? 'All programs'
      : projectScope === 'none'
        ? 'No program'
        : (programs?.find((p) => p.id === projectScope)?.name ?? 'All programs');

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

  // Non-drawer width comes from the inline style (animated); only the drawer
  // needs a static width class.
  const widthClass = 'w-[220px]';

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
                style={{
                  transform: sidebarCollapsed ? 'rotate(180deg)' : 'none',
                  transition: 'transform 200ms ease-out',
                }}
              >
                <path d="M10.5 8L6 3.5 4.5 5l3 3-3 3L6 12.5l4.5-4.5z" />
              </svg>
            </button>
          </div>
        )}

        {/* My Work — cross-project surface (issue #499), pinned at the top so
            contributors who don't think in projects have a one-tap path to their
            work. The badge shows the due-today count when actionable. */}
        {showScopedList ? (
          <div className="shrink-0 px-2 py-2 border-b border-chrome-border/8">
            <NavLink
              to="/me/work"
              aria-label={dueTodayCount > 0 ? `My Work, ${dueTodayCount} due today` : 'My Work'}
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
                  className="tppm-mono text-xs text-semantic-critical bg-semantic-critical-bg rounded-full px-1.5 py-0.5 shrink-0"
                >
                  {dueTodayCount}
                </span>
              )}
            </NavLink>
          </div>
        ) : (
          /* Collapsed sidebar: icon-only My Work link */
          <div className="shrink-0 px-2 py-2 border-b border-chrome-border/8">
            <NavLink
              to="/me/work"
              aria-label={dueTodayCount > 0 ? `My Work, ${dueTodayCount} due today` : 'My Work'}
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
              <svg
                width="16"
                height="16"
                viewBox="0 0 14 14"
                fill="currentColor"
                aria-hidden="true"
              >
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

        {/* Program scope (#959) — searchable picker replaces the flat program
            list and narrows the project list below. Collapsed desktop keeps the
            icon-only Programs entry from ProgramsSection. */}
        {showScopedList ? (
          <ProjectScopePicker
            scope={projectScope}
            onScope={setProjectScope}
            programs={programs ?? []}
            countFor={countFor}
            totalCount={totalCount}
            noProgramCount={noProgramCount}
            onNewProgram={() => setShowNewProgram(true)}
          />
        ) : (
          <ProgramsSection collapsed isDrawer={false} onNavigated={onClose} />
        )}

        {/* Project list */}
        <nav aria-label="Project list" className="flex-1 flex flex-col overflow-hidden">
          {showScopedList && (
            <>
              <div className="flex items-center justify-between px-3 pt-1 pb-1">
                <h2
                  className="text-xs font-semibold tracking-widest uppercase text-chrome-text-secondary"
                  aria-label={`Projects, ${scopedProjects.length}`}
                >
                  PROJECTS{' '}
                  <span className="tppm-mono normal-case tracking-normal">
                    · {scopedProjects.length}
                  </span>
                </h2>
                {/* Touch targets are 44×44px; icons stay 12×12px visually (Rule 5) */}
                <div className="flex items-center -mr-2">
                  <button
                    type="button"
                    onClick={() => setShowImport(true)}
                    aria-label="Import a project"
                    title="Import a project from a file"
                    className="flex items-center justify-center w-11 h-11 rounded
                      text-chrome-text-secondary hover:text-chrome-text-primary hover:bg-neutral-text-primary/5
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                      focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path
                        d="M6 8V1m0 0L3.5 3.5M6 1l2.5 2.5M2 8.5v1A1.5 1.5 0 003.5 11h5A1.5 1.5 0 0010 9.5v-1"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowNewProject(true)}
                    aria-label="New project"
                    className="flex items-center justify-center w-11 h-11 rounded
                      text-chrome-text-secondary hover:text-chrome-text-primary hover:bg-neutral-text-primary/5
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                      focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path
                        d="M6 1v10M1 6h10"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
              </div>

              {/* In-scope project search (#959). Hidden until there is something
                  to search to keep the empty state quiet. */}
              {totalCount > 0 && (
                <div className="px-2 pb-2">
                  <div className="flex h-8 items-center gap-2 rounded-md border border-chrome-border/15 bg-chrome-surface-raised px-2 focus-within:border-brand-primary">
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 16 16"
                      fill="none"
                      aria-hidden="true"
                      className="shrink-0 text-chrome-text-secondary"
                    >
                      <path
                        d="M7 11.5a4.5 4.5 0 100-9 4.5 4.5 0 000 9zM10.6 10.6l2.9 2.9"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <input
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={
                        projectScope === 'all' ? 'Search all projects…' : `Search in ${scopeName}…`
                      }
                      aria-label="Search projects"
                      className="min-w-0 flex-1 bg-transparent text-sm text-chrome-text-primary outline-none placeholder:text-chrome-text-secondary"
                    />
                  </div>
                </div>
              )}
            </>
          )}

          {/* Scrollable list region */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden pb-2">
            {isLoading ? (
              <ul className="space-y-1 px-2" aria-label="Loading projects">
                {[1, 2, 3, 4].map((i) => (
                  <li
                    key={i}
                    className="h-8 rounded animate-pulse bg-neutral-text-primary/5"
                    aria-hidden="true"
                  />
                ))}
              </ul>
            ) : error ? (
              <p role="alert" className="px-3 py-2 text-xs text-semantic-critical">
                Failed to load projects
              </p>
            ) : totalCount === 0 ? (
              <p className="px-3 py-2 text-xs text-chrome-text-secondary">No projects yet</p>
            ) : !showScopedList ? (
              /* Collapsed desktop rail: all projects as dots, ungrouped. */
              <ul className="space-y-0.5 px-2">
                {(projects ?? []).map((project) => (
                  <ProjectListItem key={project.id} project={project} collapsed />
                ))}
              </ul>
            ) : projectScope === 'all' ? (
              /* All programs: grouped under collapsible program headers. */
              <ul className="space-y-1 px-2">
                {programGroups.length > 0 ? (
                  programGroups.map((g) => (
                    <ProjectGroup
                      key={g.id}
                      name={g.name}
                      color={g.color}
                      projects={g.projects}
                      collapsed={!!collapsedGroups[g.id]}
                      onToggle={() => setCollapsedGroups((s) => ({ ...s, [g.id]: !s[g.id] }))}
                    />
                  ))
                ) : (
                  <li
                    role="status"
                    className="px-3 py-3 text-center text-xs text-chrome-text-secondary"
                  >
                    No projects match
                  </li>
                )}
              </ul>
            ) : (
              /* Scoped to one program (or "No program"): flat list. */
              <ul className="space-y-0.5 px-2">
                {scopedProjects.map((project) => (
                  <ProjectListItem key={project.id} project={project} collapsed={false} />
                ))}
                {scopedProjects.length === 0 && (
                  <li
                    role="status"
                    className="px-3 py-3 text-center text-xs text-chrome-text-secondary"
                  >
                    No projects match
                  </li>
                )}
              </ul>
            )}
          </div>
        </nav>

        {/* Org-level section — Resources and Settings links */}
        {showScopedList ? (
          <div className="shrink-0 border-t border-chrome-border/8 px-2 py-2">
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
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="currentColor"
                aria-hidden="true"
                className="shrink-0"
              >
                <path d="M5 6.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm-3 4.5a3 3 0 0 1 6 0H2Zm7-4.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm1 1.5c.7.3 1.3.8 1.7 1.4A3 3 0 0 0 9 11h-.5A4 4 0 0 0 9 9a3 3 0 0 0-.3-1.3c.4-.1.8-.2 1.3-.2Z" />
              </svg>
              Resources
            </NavLink>
            <NavLink
              to="/settings"
              aria-label="Workspace settings"
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
              {/* Gear / settings icon */}
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                aria-hidden="true"
                className="shrink-0"
              >
                <path
                  d="M5.5 1.5h3l.5 1.5a4 4 0 0 1 1.2.7l1.5-.5 1.5 2.6-1.2 1.1a4 4 0 0 1 0 1.2l1.2 1.1-1.5 2.6-1.5-.5A4 4 0 0 1 9 12l-.5 1.5h-3L5 12a4 4 0 0 1-1.2-.7l-1.5.5L.8 9.2 2 8.1a4 4 0 0 1 0-1.2L.8 5.8 2.3 3.2l1.5.5A4 4 0 0 1 5 2.5L5.5 1ZM7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
              </svg>
              Settings
            </NavLink>
          </div>
        ) : (
          /* Collapsed sidebar: icon-only Resources and Settings links */
          <div className="shrink-0 border-t border-chrome-border/8 px-2 py-2 flex flex-col gap-1">
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
              <svg
                width="16"
                height="16"
                viewBox="0 0 14 14"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M5 6.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm-3 4.5a3 3 0 0 1 6 0H2Zm7-4.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm1 1.5c.7.3 1.3.8 1.7 1.4A3 3 0 0 0 9 11h-.5A4 4 0 0 0 9 9a3 3 0 0 0-.3-1.3c.4-.1.8-.2 1.3-.2Z" />
              </svg>
            </NavLink>
            <NavLink
              to="/settings"
              aria-label="Workspace settings"
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
              <svg width="16" height="16" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path
                  d="M5.5 1.5h3l.5 1.5a4 4 0 0 1 1.2.7l1.5-.5 1.5 2.6-1.2 1.1a4 4 0 0 1 0 1.2l1.2 1.1-1.5 2.6-1.5-.5A4 4 0 0 1 9 12l-.5 1.5h-3L5 12a4 4 0 0 1-1.2-.7l-1.5.5L.8 9.2 2 8.1a4 4 0 0 1 0-1.2L.8 5.8 2.3 3.2l1.5.5A4 4 0 0 1 5 2.5L5.5 1ZM7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
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

      {/* New program modal — triggered from the scope picker's "+" affordance (#959). */}
      {showNewProgram && (
        <NewProgramModal
          onClose={() => setShowNewProgram(false)}
          onCreated={(programId) => {
            setShowNewProgram(false);
            if (isDrawer) onClose?.();
            void navigate(`/programs/${programId}/projects`);
          }}
        />
      )}

      {/* Import-a-project modal — creates a project from an MS Project file (#797). */}
      {showImport && (
        <ImportProjectModal
          onClose={() => setShowImport(false)}
          onCreated={(projectId) => {
            setShowImport(false);
            if (isDrawer) onClose?.();
            void navigate(`/projects/${projectId}/overview`);
          }}
        />
      )}
    </>
  );
}
