import { useEffect, useMemo, useRef, useState } from 'react';
import { useMatch } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useUpdateHiddenViews } from '@/hooks/useUpdateHiddenViews';
import {
  groupedVisibleViews,
  surfaceHiddenViews,
  STANDALONE_LEADING,
} from '@/features/shell/methodologyTabs';
import { VIEW_TAB_META } from '@/features/shell/viewMeta';
import { ROLE_SCHEDULER } from '@/lib/roles';
import { modifierKeyLabel } from '@/lib/platform';
import type { Methodology } from '@/types';

type IconProps = { className?: string; 'aria-hidden'?: 'true' };

const METHOD_LABEL: Record<Methodology, string> = {
  AGILE: 'Agile',
  WATERFALL: 'Waterfall',
  HYBRID: 'Hybrid',
};

// --- Local glyphs (no Eye/EyeOff/Pin in the shared Icons set) ---------------

function EyeIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

function EyeOffIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M6.3 3.8A6.4 6.4 0 0 1 8 3.5c4.5 0 7 4.5 7 4.5a12 12 0 0 1-2 2.6M3.4 4.8A12 12 0 0 0 1 8s2.5 4.5 7 4.5a6.4 6.4 0 0 0 2.6-.5" />
      <path d="M6.6 6.6a2 2 0 0 0 2.8 2.8" />
      <line x1="2" y1="2" x2="14" y2="14" />
    </svg>
  );
}

function PinIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M8 10v4M5 2h6l-1 4 2 2H4l2-2-1-4Z" />
    </svg>
  );
}

function ResetIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
      <path d="M3.5 2v3h3" />
    </svg>
  );
}

function ChevronIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

const GROUP_HEADER =
  'px-4 pt-2 pb-1 text-xs font-semibold tracking-widest uppercase text-chrome-text-secondary select-none';

/**
 * "Customize views" menu (ADR-0139, issue 220) — a per-user control to hide/show
 * which project view tabs appear in the bar. Self-suppresses off-project and on
 * settings routes, exactly like `ViewTabs` / `MethodWorkspaceLabel`. Desktop only.
 *
 * Only methodology-visible views are toggleable (a view the methodology preset
 * already hides never appears here). Overview is shown as an always-on row with
 * no toggle — the structural guarantee the nav can never be emptied. The hidden
 * set is the per-user global `UserProfile.hidden_views`; toggling PATCHes it with
 * optimistic local state and the bar recomposes on `['current-user']` invalidation.
 */
export function ViewsMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const projectId = useProjectId();
  const onSettingsRoute = useMatch('/projects/:projectId/settings/*');
  const { data: project } = useProject(projectId);
  const { role } = useCurrentUserRole(projectId ?? undefined);
  const { user } = useCurrentUser();
  const iteration = useIterationLabel(projectId);
  const update = useUpdateHiddenViews();

  // Optimistic override: while a PATCH is in flight `pending` holds the desired
  // set so the rows flip instantly; it is reconciled to the server value once the
  // invalidated `['current-user']` query catches up, and cleared on error.
  const [pending, setPending] = useState<string[] | null>(null);
  const serverHidden = useMemo(() => user?.hidden_views ?? [], [user?.hidden_views]);
  const effectiveHidden = pending ?? serverHidden;
  const hiddenSet = new Set(effectiveHidden);

  useEffect(() => {
    if (pending !== null && JSON.stringify(pending) === JSON.stringify(serverHidden)) {
      setPending(null);
    }
  }, [pending, serverHidden]);

  // Close on Escape; return focus to the trigger.
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen]);

  // Close on outside pointerdown.
  useEffect(() => {
    if (!isOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [isOpen]);

  if (!projectId || onSettingsRoute) return null;

  // Server-resolved methodology (ADR-0107, issue 955): the effective preset, not
  // the raw per-project override, gates which views appear in the menu.
  const methodology: Methodology = project?.effective_methodology ?? 'HYBRID';
  const methodLabel = METHOD_LABEL[methodology];
  const roleAllows = (view: string) =>
    view !== 'resources' || (role !== null && role >= ROLE_SCHEDULER);

  // Per-project leaf-surface toggles (ADR-0193, issue 956) are a stronger hide
  // than the per-user preference: a surface the project turned off is not a
  // meaningful personal toggle, so drop it from the menu entirely (only
  // `reporting` maps to a view here).
  const surfaceHidden = new Set(
    surfaceHiddenViews(project?.effective_surface_visibility ?? { reporting: true }),
  );

  // The toggleable groups = methodology-visible views, minus the role-gated ones
  // and the project-surface-hidden ones.
  const groups = groupedVisibleViews(methodology)
    .map((g) => ({
      ...g,
      visibleViews: g.visibleViews.filter((v) => roleAllows(v) && !surfaceHidden.has(v)),
    }))
    .filter((g) => g.visibleViews.length > 0);

  const labelFor = (view: string) =>
    view === 'sprints' ? iteration.plural : (VIEW_TAB_META[view]?.label ?? view);

  function commit(next: string[]) {
    setPending(next);
    update.mutate(next, {
      onError: () => setPending(null),
    });
  }

  function toggle(view: string) {
    const next = hiddenSet.has(view)
      ? effectiveHidden.filter((v) => v !== view)
      : [...effectiveHidden, view];
    commit(next);
  }

  // Reset clears only the personally-hidden keys that are visible for THIS
  // methodology, preserving any global hides for views not shown here.
  const resettableHidden = groups.flatMap((g) => g.visibleViews).filter((v) => hiddenSet.has(v));
  const canReset = resettableHidden.length > 0;

  function reset() {
    const resettable = new Set(resettableHidden);
    commit(effectiveHidden.filter((v) => !resettable.has(v)));
  }

  return (
    <div className="hidden md:block relative" ref={menuRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label="Customize views"
        onClick={() => setIsOpen((p) => !p)}
        className="inline-flex shrink-0 items-center gap-1 h-8 px-2 rounded-control text-sm font-medium text-chrome-text-secondary hover:text-chrome-text-primary hover:bg-neutral-text-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface"
      >
        <EyeIcon className="text-current" aria-hidden="true" />
        <span className="hidden lg:inline">Views</span>
        <ChevronIcon className="text-current" aria-hidden="true" />
      </button>

      {isOpen && (
        <div
          role="menu"
          aria-label="Customize views"
          className="absolute top-full right-0 mt-1 z-50 w-72 bg-chrome-surface rounded-card border border-neutral-border flex flex-col py-1"
        >
          <div className="px-4 pt-1 pb-2">
            <h2 className="text-sm font-semibold text-neutral-text-primary leading-tight">
              Customize views
            </h2>
            <p className="text-xs text-neutral-text-secondary leading-tight mt-0.5">
              Hidden views stay here &amp; in {modifierKeyLabel()}K
            </p>
          </div>

          {/* Always-on Overview — no toggle (the nav can never be emptied). */}
          <div className={GROUP_HEADER}>Always on</div>
          <div className="flex items-center gap-2.5 px-4 min-h-[36px] text-sm text-neutral-text-primary">
            <OverviewMetaIcon />
            <span className="flex-1">{VIEW_TAB_META[STANDALONE_LEADING].label}</span>
            <span className="flex items-center text-neutral-text-secondary" title="Always shown">
              <PinIcon aria-hidden="true" />
            </span>
          </div>

          {groups.map((group) => (
            <div key={group.id}>
              <div className={GROUP_HEADER}>{group.id}</div>
              {group.visibleViews.map((view) => {
                const visible = !hiddenSet.has(view);
                const { Icon } = VIEW_TAB_META[view];
                return (
                  <button
                    key={view}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={visible}
                    onClick={() => toggle(view)}
                    className="w-full flex items-center gap-2.5 px-4 min-h-[36px] text-sm text-left hover:bg-chrome-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary"
                  >
                    <Icon
                      className={
                        visible ? 'text-neutral-text-secondary' : 'text-neutral-text-disabled'
                      }
                      aria-hidden="true"
                    />
                    <span
                      className={`flex-1 ${visible ? 'text-neutral-text-primary' : 'text-neutral-text-secondary'}`}
                    >
                      {labelFor(view)}
                    </span>
                    {visible ? (
                      <EyeIcon className="text-brand-primary" aria-hidden="true" />
                    ) : (
                      <EyeOffIcon className="text-neutral-text-secondary" aria-hidden="true" />
                    )}
                  </button>
                );
              })}
            </div>
          ))}

          <div className="mx-4 mt-1 border-t border-neutral-border" aria-hidden="true" />
          <button
            type="button"
            role="menuitem"
            onClick={reset}
            disabled={!canReset}
            title={canReset ? undefined : 'No views hidden'}
            className="w-full flex items-center gap-2.5 px-4 min-h-[36px] text-sm text-left text-neutral-text-primary hover:bg-chrome-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary disabled:text-neutral-text-secondary disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            <ResetIcon className="text-current" aria-hidden="true" />
            Reset to {methodLabel} default
          </button>
        </div>
      )}
    </div>
  );
}

// The Overview tab icon (kept local so the row matches the bar's leading tab).
function OverviewMetaIcon() {
  const { Icon } = VIEW_TAB_META[STANDALONE_LEADING];
  return <Icon className="text-neutral-text-secondary" aria-hidden="true" />;
}
