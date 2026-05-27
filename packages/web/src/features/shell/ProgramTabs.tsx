import { NavLink, useLocation } from 'react-router';
import { OverviewIcon, ListIcon, WbsIcon, ResourcesIcon, SettingsIcon } from '@/components/Icons';
import { useProgramId } from '@/hooks/useProgramId';
import type { ComponentType } from 'react';

interface Tab {
  view: string;
  label: string;
  Icon: ComponentType<{ className?: string; 'aria-hidden'?: 'true' }>;
}

// Settings is last, mirroring the project ViewTabs (ADR-0091). The program tab
// set is shorter and fixed — no methodology/role gating (writes are gated inside
// each page, like the project Settings tab).
const TABS: Tab[] = [
  { view: 'overview', label: 'Overview', Icon: OverviewIcon },
  { view: 'backlog', label: 'Backlog', Icon: ListIcon },
  { view: 'projects', label: 'Projects', Icon: WbsIcon },
  { view: 'members', label: 'Members', Icon: ResourcesIcon },
  { view: 'settings', label: 'Settings', Icon: SettingsIcon },
];

/**
 * Top-bar tab strip for switching between program views (ADR-0091).
 *
 * The program analog of `ViewTabs`: rendered inside the global `TopBar`,
 * `h-full` so it adds no height, and hidden when no program is active (no
 * `:programId`). `ViewTabs` and `ProgramTabs` are mutually exclusive — a URL is
 * either `/projects/:id/*` or `/programs/:id/*`, never both — so exactly one
 * renders. Settings stays active across every `/settings/*` sub-route.
 */
export function ProgramTabs() {
  const location = useLocation();
  const programId = useProgramId();

  if (!programId) return null;

  // Active view = the path segment immediately after the programId.
  //   /programs/abc/backlog          → 'backlog'
  //   /programs/abc/settings/cadence → 'settings'  (Settings tab stays active)
  const pathSegments = location.pathname.split('/');
  const programIdIndex = pathSegments.indexOf(programId);
  const currentView =
    (programIdIndex >= 0 ? pathSegments[programIdIndex + 1] : undefined) ?? 'overview';

  return (
    <nav aria-label="Program" className="hidden md:flex items-stretch h-full gap-0.5">
      {TABS.map(({ view, label, Icon }) => {
        const isActive = currentView === view;
        return (
          <NavLink
            key={view}
            to={`/programs/${programId}/${view}`}
            replace
            className={[
              'flex items-center gap-1.5 px-3 text-sm font-medium border-b-2 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
              isActive
                ? 'border-brand-primary text-brand-primary'
                : 'border-transparent text-neutral-text-secondary hover:text-neutral-text-primary',
            ].join(' ')}
            aria-current={isActive ? 'page' : undefined}
          >
            <Icon
              className={isActive ? 'text-brand-primary' : 'text-neutral-text-disabled'}
              aria-hidden="true"
            />
            {label}
          </NavLink>
        );
      })}
    </nav>
  );
}
