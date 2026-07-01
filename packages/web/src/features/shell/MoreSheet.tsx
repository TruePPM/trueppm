import { useId } from 'react';
import { NavLink } from 'react-router';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { VIEW_TAB_META } from '@/features/shell/viewMeta';

/**
 * The "More" overflow sheet for the mobile bottom rail (ADR-0196). Lists the
 * views that don't fit the ≤5-slot rail as full-width ≥44px navigation rows.
 *
 * Reuses the shared {@link BottomSheet} (scrim, slide-up, focus trap, Escape,
 * `aria-modal`) so this component owns only its content. Rows are real
 * `NavLink`s — they route, so a link (not a `menuitem` button) is the honest
 * semantic; the sheet closes as navigation happens (`onClick={onClose}`).
 */
export interface MoreSheetProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  /** Overflow view keys, already ordered (settings last). */
  views: string[];
  /** The currently active view key, so its row reads as selected. */
  currentView: string;
  /** True when the current path is the settings surface (matches the rail). */
  isSettingsActive: boolean;
  /** Configured iteration label plural (ADR-0111) — overrides the "Sprints" label. */
  sprintsLabel: string;
}

export function MoreSheet({
  isOpen,
  onClose,
  projectId,
  views,
  currentView,
  isSettingsActive,
  sprintsLabel,
}: MoreSheetProps) {
  const headingId = useId();

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} titleId={headingId} size="auto">
      <div className="flex flex-col px-4 pb-[env(safe-area-inset-bottom)]">
        <h2 id={headingId} className="px-1 py-2 text-sm font-semibold text-neutral-text-primary">
          More views
        </h2>
        <ul>
          {views.map((view) => {
            const meta = VIEW_TAB_META[view];
            if (!meta) return null;
            const isSettings = view === 'settings';
            const to = isSettings
              ? `/projects/${projectId}/settings`
              : `/projects/${projectId}/${view}`;
            const isActive = isSettings ? isSettingsActive : currentView === view;
            const { Icon } = meta;
            const label = view === 'sprints' ? sprintsLabel : meta.label;
            return (
              <li key={view}>
                <NavLink
                  to={to}
                  replace
                  onClick={onClose}
                  aria-current={isActive ? 'page' : undefined}
                  className={[
                    'flex min-h-[44px] w-full items-center gap-3 rounded-control px-1 text-left text-sm',
                    'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset',
                    isActive
                      ? 'bg-neutral-surface-sunken font-medium text-brand-primary'
                      : 'text-neutral-text-primary',
                  ].join(' ')}
                >
                  <Icon
                    className={isActive ? 'text-brand-primary' : 'text-neutral-text-disabled'}
                    aria-hidden="true"
                  />
                  <span>{label}</span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      </div>
    </BottomSheet>
  );
}
