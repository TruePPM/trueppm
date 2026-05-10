import { NavLink, Outlet } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';

interface SettingsTab {
  path: string;
  label: string;
}

const SETTINGS_TABS: SettingsTab[] = [
  { path: 'members', label: 'Members' },
];

/**
 * Settings page shell with a secondary tab nav for settings sub-sections.
 *
 * Currently has one sub-section (Members); future sub-sections (General,
 * Integrations) add entries to SETTINGS_TABS without changing this component.
 */
export function ProjectSettingsPage() {
  const projectId = useProjectId();
  if (!projectId) return null;

  return (
    <div className="flex flex-col h-full bg-neutral-surface">
      {/* Settings sub-nav */}
      <nav
        aria-label="Settings"
        className="flex items-center gap-1 border-b border-neutral-border px-4 pt-4"
      >
        {SETTINGS_TABS.map((tab) => (
          <NavLink
            key={tab.path}
            to={`/projects/${projectId}/settings/${tab.path}`}
            replace
            className={({ isActive }) =>
              [
                'px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                isActive
                  ? 'border-brand-primary text-brand-primary'
                  : 'border-transparent text-neutral-text-secondary hover:text-neutral-text-primary',
              ].join(' ')
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      {/* Sub-page content */}
      <div className="flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
