import { useId } from 'react';
import { NavLink } from 'react-router';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { PinIcon } from '@/components/Icons';
import { VIEW_TAB_META } from '@/features/shell/viewMeta';

/**
 * The "More" overflow sheet for the mobile bottom rail (ADR-0196). Lists the
 * views that don't fit the ≤5-slot rail as full-width ≥44px navigation rows, and
 * lets the user pin/unpin which views occupy the primary rail slots (issue 1591).
 *
 * Reuses the shared {@link BottomSheet} (scrim, slide-up, focus trap, Escape,
 * `aria-modal`) so this component owns only its content. Navigation rows are real
 * `NavLink`s — they route, so a link (not a `menuitem` button) is the honest
 * semantic; the sheet closes as navigation happens (`onClick={onClose}`). Each
 * customizable row carries a pin toggle whose accessible name — "Pin …" vs
 * "Unpin …" — conveys pinned state to screen readers without relying on color.
 */
export interface MoreSheetProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  /** Overflow view keys, already ordered (settings last). */
  views: string[];
  /**
   * Non-anchor views currently on the primary rail (issue 1591). Rendered in the
   * "On the bar" section so the user can unpin/pin them; Overview and Today are
   * anchored and excluded by the caller.
   */
  barViews: string[];
  /** View keys the user has pinned — drives each toggle's pinned state. */
  pinnedViews: string[];
  /** Pin or unpin a view from the primary rail. */
  onTogglePin: (view: string) => void;
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
  barViews,
  pinnedViews,
  onTogglePin,
  currentView,
  isSettingsActive,
  sprintsLabel,
}: MoreSheetProps) {
  const headingId = useId();
  const pinned = new Set(pinnedViews);

  // Settings is not pinnable (it is always reachable via this sheet, issue 539).
  const canPin = (view: string) => view !== 'settings';
  const labelFor = (view: string) =>
    view === 'sprints' ? sprintsLabel : (VIEW_TAB_META[view]?.label ?? view);

  const pinToggle = (view: string) => {
    if (!canPin(view)) return null;
    const isPinned = pinned.has(view);
    const label = labelFor(view);
    return (
      <button
        type="button"
        onClick={() => onTogglePin(view)}
        aria-pressed={isPinned}
        aria-label={
          isPinned ? `Unpin ${label} from navigation bar` : `Pin ${label} to navigation bar`
        }
        className={[
          'flex min-h-[44px] min-w-[44px] items-center justify-center rounded-control',
          'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset',
          isPinned ? 'text-brand-primary' : 'text-neutral-text-disabled',
        ].join(' ')}
      >
        <PinIcon aria-hidden="true" />
      </button>
    );
  };

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} titleId={headingId} size="auto">
      <div className="flex flex-col px-4 pb-[env(safe-area-inset-bottom)]">
        {barViews.length > 0 && (
          <>
            <h2 className="px-1 py-2 text-sm font-semibold text-neutral-text-primary">
              On the navigation bar
            </h2>
            <ul>
              {barViews.map((view) => {
                const meta = VIEW_TAB_META[view];
                if (!meta) return null;
                const { Icon } = meta;
                return (
                  <li key={view} className="flex items-center gap-2">
                    <span className="flex min-h-[44px] flex-1 items-center gap-3 px-1 text-sm text-neutral-text-primary">
                      <Icon className="text-neutral-text-disabled" aria-hidden="true" />
                      <span>{labelFor(view)}</span>
                    </span>
                    {pinToggle(view)}
                  </li>
                );
              })}
            </ul>
          </>
        )}

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
            return (
              <li key={view} className="flex items-center gap-2">
                <NavLink
                  to={to}
                  replace
                  onClick={onClose}
                  aria-current={isActive ? 'page' : undefined}
                  className={[
                    'flex min-h-[44px] flex-1 items-center gap-3 rounded-control px-1 text-left text-sm',
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
                  <span>{labelFor(view)}</span>
                </NavLink>
                {pinToggle(view)}
              </li>
            );
          })}
        </ul>
      </div>
    </BottomSheet>
  );
}
