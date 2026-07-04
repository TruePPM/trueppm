import { useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { MoreHorizontalIcon } from '@/components/Icons';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { groupedVisibleViewsForUser, surfaceHiddenViews } from '@/features/shell/methodologyTabs';
import { VIEW_TAB_META } from '@/features/shell/viewMeta';
import { ANCHOR_VIEWS, selectMobileNav } from '@/features/shell/bottomNavItems';
import { MoreSheet } from '@/features/shell/MoreSheet';
import { ROLE_SCHEDULER } from '@/lib/roles';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useShellStore } from '@/stores/shellStore';

// Bottom navigation rail — shown at < md (768px) in place of the top-bar view
// tabs (ADR-0134 rule 3: mobile carries view nav here, never the desktop
// overflow scroller). The rail caps at 5 slots (ADR-0196): up to 4 primary tabs
// plus a "More" button in slot 5 when the reachable set exceeds 5; the overflow
// opens in a reused BottomSheet (MoreSheet). This makes Backlog, Risks, and
// Reports reachable on mobile (issue 1464) — previously the rail hardcoded 9
// items and omitted all three.
//
// The *set* of reachable views is composed exactly like the desktop bar
// (methodology filter ∩ per-project surface visibility ∩ per-user hidden_views ∩
// role gate) so the two surfaces stay consistent; only the *order* is mobile-
// specific (see bottomNavItems.ts). Overview always leads (always-on landing)
// and Today is always primary (the headline view — issue 1324). Settings stays
// reachable (issue 539) via the More sheet; the More button reflects an active
// state whenever the current surface lives in the overflow.

export function BottomNav() {
  const location = useLocation();
  const projectId = useProjectId();
  const { role } = useCurrentUserRole(projectId ?? undefined);
  const project = useProject(projectId);
  const { user } = useCurrentUser();
  const pinnedMobileViews = useShellStore((s) => s.pinnedMobileViews);
  const toggleMobileViewPin = useShellStore((s) => s.toggleMobileViewPin);
  const [sheetOpen, setSheetOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  // Derive the active view from the segment immediately after the projectId —
  // identical to ViewTabs (ADR-0030). The last segment would misfire on nested
  // routes (e.g. /board/<cardId>), leaving no tab active.
  const pathSegments = location.pathname.split('/');
  const projectIdIndex = pathSegments.indexOf(projectId ?? '');
  const currentView =
    (projectIdIndex >= 0 ? pathSegments[projectIdIndex + 1] : undefined) ?? 'overview';
  const isSettingsActive =
    projectId !== null && location.pathname.includes(`/projects/${projectId}/settings`);

  // Default to HYBRID (all tabs visible) until the project loads; read the
  // server-resolved methodology (ADR-0107) so the rail mirrors ViewTabs.
  const methodology = project.data?.effective_methodology ?? 'HYBRID';
  // Resolve the iteration label through the shared chokepoint (ADR-0116) so the
  // rail matches ViewTabs even when the label is inherited from the program or
  // workspace (effective_iteration_label set, project override null).
  const sprintsLabel = useIterationLabel(projectId).plural;

  // Compose the reachable set the same way the desktop bar does: methodology
  // filter → per-project surface visibility (ADR-0193) → per-user hidden_views
  // (ADR-0139 — now applied on mobile too). `groupedVisibleViewsForUser` handles
  // the first and third; surfaceHiddenViews contributes `reports` when reporting
  // is off. `overview`/`settings` are standalone (never grouped/hideable), so
  // they are added explicitly. `resources` (Team) additionally needs Scheduler+.
  const surfaceHidden = surfaceHiddenViews(
    project.data?.effective_surface_visibility ?? { reporting: true },
  );
  const hidden = new Set([...(user?.hidden_views ?? []), ...surfaceHidden]);
  const grouped = groupedVisibleViewsForUser(methodology, hidden).flatMap((g) => g.visibleViews);
  const canSeeTeam = role !== null && role >= ROLE_SCHEDULER;
  const reachable = [
    'overview',
    ...grouped.filter((v) => v !== 'resources' || canSeeTeam),
    'settings',
  ];

  // Promote the user's pinned views (issue 1591) into the primary slots ahead
  // of the methodology defaults; Overview/Today stay anchored (see ANCHOR_VIEWS).
  const { primary, overflow } = selectMobileNav(reachable, methodology, pinnedMobileViews);
  const hasOverflow = overflow.length > 0;
  // Non-anchor primary views the user can unpin from the More sheet's "On the
  // bar" section — Overview/Today are anchored and never customizable.
  const customizablePrimary = primary.filter((v) => !ANCHOR_VIEWS.includes(v));
  // Which overflow-parked surface (if any) is currently active. Match `settings`
  // by its path prefix so any settings sub-page counts, and resolve the label
  // off the view *key* (not `currentView`) so a settings sub-page still reads as
  // "Settings" rather than the sub-segment (issue 539).
  const activeOverflowView = overflow.find((v) =>
    v === 'settings' ? isSettingsActive : v === currentView,
  );
  const moreActive = activeOverflowView !== undefined;
  const activeOverflowLabel =
    activeOverflowView === 'sprints'
      ? sprintsLabel
      : ((activeOverflowView ? VIEW_TAB_META[activeOverflowView]?.label : undefined) ?? 'view');

  if (!projectId) return null;

  return (
    <>
      <nav
        aria-label="View"
        className="md:hidden flex items-stretch h-14 border-t border-chrome-border bg-chrome-surface"
      >
        {primary.map((view) => {
          const meta = VIEW_TAB_META[view];
          if (!meta) return null;
          // Settings targets the consolidated settings base (rule 125); its
          // active match uses the pathname so aria-current holds across sections.
          const isSettings = view === 'settings';
          const to = isSettings
            ? `/projects/${projectId}/settings`
            : `/projects/${projectId}/${view}`;
          const isActive = isSettings ? isSettingsActive : currentView === view;
          const { Icon } = meta;
          const label = view === 'sprints' ? sprintsLabel : meta.label;
          return (
            <NavLink
              key={view}
              to={to}
              replace
              className={[
                'flex flex-1 flex-col items-center justify-center gap-1 text-xs min-h-[44px]',
                'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset',
                isActive ? 'text-brand-primary font-medium' : 'text-neutral-text-secondary',
              ].join(' ')}
              aria-current={isActive ? 'page' : undefined}
            >
              <Icon
                className={isActive ? 'text-brand-primary' : 'text-neutral-text-disabled'}
                aria-hidden="true"
              />
              <span>{label}</span>
            </NavLink>
          );
        })}

        {hasOverflow && (
          <button
            ref={moreButtonRef}
            type="button"
            onClick={() => setSheetOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
            // When a surface parked in the overflow is active, announce it so SR
            // users know More holds the current view (issue 539: Settings lives
            // in More but must still read as the active surface).
            aria-label={moreActive ? `More, ${activeOverflowLabel} selected` : 'More'}
            className={[
              'flex flex-1 flex-col items-center justify-center gap-1 text-xs min-h-[44px]',
              'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset',
              moreActive ? 'text-brand-primary font-medium' : 'text-neutral-text-secondary',
            ].join(' ')}
          >
            <MoreHorizontalIcon
              className={moreActive ? 'text-brand-primary' : 'text-neutral-text-disabled'}
              aria-hidden="true"
            />
            <span>More</span>
          </button>
        )}
      </nav>

      {hasOverflow && (
        <MoreSheet
          isOpen={sheetOpen}
          onClose={() => {
            setSheetOpen(false);
            // BottomSheet traps focus but does not restore it — return focus to
            // the trigger so keyboard users land back on the More button.
            moreButtonRef.current?.focus();
          }}
          projectId={projectId}
          views={overflow}
          barViews={customizablePrimary}
          pinnedViews={pinnedMobileViews}
          onTogglePin={toggleMobileViewPin}
          currentView={currentView}
          isSettingsActive={isSettingsActive}
          sprintsLabel={sprintsLabel}
        />
      )}
    </>
  );
}
