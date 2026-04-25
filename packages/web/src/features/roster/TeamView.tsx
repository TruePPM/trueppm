/**
 * "Team" tab wrapper — segmented sub-nav between Roster and Allocation views.
 * Rendered at /projects/:projectId/resources with children:
 *   resources/roster     → RosterPage
 *   resources/allocation → ResourceView (existing utilization/timeline)
 */
import { NavLink, Outlet, useLocation } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';

export function TeamView() {
  const projectId = useProjectId() ?? '';
  const location = useLocation();

  const isRoster = location.pathname.endsWith('/roster') || location.pathname.endsWith('/resources');
  const isAllocation = location.pathname.endsWith('/allocation');

  const tabClass = (active: boolean) =>
    [
      'px-4 py-1.5 text-sm font-medium rounded-full transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
      active
        ? 'bg-brand-primary/10 text-brand-primary'
        : 'text-neutral-text-secondary hover:text-neutral-text-primary',
    ].join(' ');

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Sub-navigation */}
      <nav
        aria-label="Team sub-view"
        className="flex items-center gap-1 px-4 py-2 border-b border-neutral-border bg-neutral-surface shrink-0"
      >
        <NavLink
          to={`/projects/${projectId}/resources/roster`}
          replace
          className={tabClass(isRoster)}
          aria-current={isRoster ? 'page' : undefined}
        >
          Roster
        </NavLink>
        <NavLink
          to={`/projects/${projectId}/resources/allocation`}
          replace
          className={tabClass(isAllocation)}
          aria-current={isAllocation ? 'page' : undefined}
        >
          Allocation
        </NavLink>
      </nav>

      {/* Child route content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
