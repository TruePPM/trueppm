import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useProgramId } from '@/hooks/useProgramId';
import { useProject } from '@/hooks/useProject';
import { useProgram } from '@/hooks/useProgram';
import { useProjectUnavailable } from '@/hooks/useProjectUnavailable';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useShellStats } from '@/hooks/useShellStats';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { useGroupedProjectViews } from '@/features/shell/useGroupedProjectViews';
import { useAnchoredPopover } from '@/hooks/useAnchoredPopover';
import { ROLE_ADMIN } from '@/lib/roles';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { formatRelative } from '@/lib/formatRelative';
import { programPath, projectPath, segmentAfterRef } from '@/lib/refPath';
import { ChevronDownIcon } from '@/components/Icons';
import { HealthBandChip } from '@/components/page2/StatusChip';
import { DefinitionTip } from '@/components/page2/DefinitionTip';
import { QueryErrorState } from '@/components/QueryErrorState';
import { useProjectViews } from '@/hooks/useProjectViews';
import { resolveContextTabs, type ContextTabsModel } from './contextTabs';
import { ViewsRow3, lensLabel } from './ViewsRow3';
import { CustomizeViewsDialog } from './CustomizeViewsDialog';

const PROGRAM_VIEW_LABEL: Record<string, string> = {
  overview: 'Overview',
  backlog: 'Backlog',
  projects: 'Projects',
  schedule: 'Schedule',
  resources: 'People',
  members: 'Members',
  assets: 'Assets',
  settings: 'Settings',
  labels: 'Labels',
  agents: 'Agents',
  decisions: 'Decisions',
};
const PROGRAM_VIEWS = Object.keys(PROGRAM_VIEW_LABEL);

/** The server band, an error you can retry, or nothing while it loads — never an empty chip that hides a failed read (rule 246). */
function HealthSlot() {
  const { data: stats, error, refetch } = useShellStats();
  if (error) {
    return (
      <QueryErrorState
        variant="inline"
        message="Health unavailable"
        onRetry={refetch}
        className="text-xs"
      />
    );
  }
  if (!stats?.healthBand) return null;
  // The band word is the SERVER's band (rules 397, 442) with a non-color glyph (rule 120).
  return <HealthBandChip band={stats.healthBand} data-testid="shell2-health" />;
}

/** The P80 stamp: the server's value, the server's definition on hover/focus, and its `as_of` (`last_run_at`). */
export function ForecastStamp({ projectId }: { projectId: string }) {
  const { data: mc, error, refetch } = useMonteCarloResult(projectId);
  if (error) {
    return (
      <QueryErrorState
        variant="inline"
        message="Forecast unavailable"
        onRetry={refetch}
        className="hidden text-xs md:flex"
      />
    );
  }
  // No saved forecast yet → no stamp. A dash here would be the "P80 —" placeholder
  // tile the Pass 1 audit filed as gap #2; the stamp states a date or nothing.
  if (!mc?.p80) return null;
  const definition = mc.definitions?.p80;
  return (
    <span className="hidden items-center gap-1.5 text-xs text-p1-text-2 md:flex">
      {/* The definition is the SERVER's sentence (ADR-1314) — a client-written one
          described the number in words the server never used. Without one (a payload
          from before it shipped) the label is plain text, not an empty tooltip. */}
      <DefinitionTip term="P80" definition={definition} />
      <span className="font-mono font-semibold tabular-nums text-p1-text-1">
        {fmtUtcShort(mc.p80)}
      </span>
      {mc.lastRunAt && (
        <span className="text-p1-text-3">· as of {formatRelative(new Date(mc.lastRunAt))}</span>
      )}
    </span>
  );
}

/**
 * Tab recipe. 44px tall outright (rule 5): the row scrolls horizontally, and an
 * overflow container clips a `before:` hit area, so the box itself has to be the
 * target. `focus:` not `focus-visible:` — on a phone this row is the lens switcher
 * (rule 214).
 */
const TAB =
  'relative flex h-11 shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 text-sm font-medium text-p1-text-2 no-underline ' +
  'border-b-2 border-transparent -mb-px hover:text-p1-text-1 focus:outline-none focus:ring-2 focus:ring-p1-focus focus:ring-inset ' +
  'aria-[current=page]:border-p1-brand aria-[current=page]:text-p1-text-1 data-[active=true]:border-p1-brand data-[active=true]:text-p1-text-1';

/**
 * The project/program header's "More" menu button: overflow views, views hidden from
 * the tabs, workspace-off views (focusable, announced disabled) and "Customize views…",
 * in one arrow-key order.
 */
export function MoreMenu({
  model,
  onCustomize,
}: {
  model: ContextTabsModel;
  /** Opens "Views in {project}"; absent until the server's view set has answered. */
  onCustomize?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const itemsRef = useRef<Array<HTMLElement | null>>([]);
  const { triggerRef, popoverRef, popoverStyle } = useAnchoredPopover<
    HTMLButtonElement,
    HTMLDivElement
  >({
    open,
    width: 200,
    estimatedHeight:
      44 * (model.more.length + model.hidden.length + model.off.length + (onCustomize ? 1 : 0)) +
      72,
    align: 'right',
    onDismiss: () => setOpen(false),
  });
  const anyActive = model.more.some((t) => t.active);

  const liveItems = () => itemsRef.current.filter((el): el is HTMLElement => el !== null);
  // A menu button opens AND seats focus on the first item (APG menu button pattern);
  // Escape closes and returns focus to the button.
  //
  // Focus is seated in a layout effect on the commit that mounts the menu, not in a
  // `setTimeout(0)`: a deferred focus leaves the trigger focused for one task, so a key
  // typed straight after Enter (End, an arrow) lands on the trigger and is dropped, and
  // focus then jumps to the first item regardless (#3715's soak failure). A discrete
  // event's state update commits synchronously, so the layout effect runs before the
  // browser dispatches the next keydown.
  const pendingFocus = useRef<number | null>(null);
  const openMenu = () => {
    pendingFocus.current = 0;
    setOpen(true);
  };
  useLayoutEffect(() => {
    if (!open || pendingFocus.current === null) return;
    // preventScroll: the panel is still at the offscreen placeholder until the anchor
    // hook's reposition renders, so focusing it must not scroll the page there.
    liveItems()[pendingFocus.current]?.focus({ preventScroll: true });
    pendingFocus.current = null;
  }, [open]);
  const closeMenu = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onMenuKeyDown = (e: KeyboardEvent) => {
    const items = liveItems();
    const i = items.findIndex((el) => el === document.activeElement);
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      closeMenu();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  if (model.more.length + model.hidden.length + model.off.length === 0 && !onCustomize) return null;
  const offBase = model.more.length + model.hidden.length;
  const item =
    'flex min-h-11 flex-col justify-center rounded-md px-2.5 text-sm text-p1-text-2 no-underline hover:bg-p1-surface-2 hover:text-p1-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus aria-[current=page]:bg-p1-brand-tint aria-[current=page]:text-p1-text-1';
  const heading = 'px-2.5 pb-0.5 pt-2 text-xs font-semibold text-p1-text-3';
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-active={anyActive ? 'true' : undefined}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.preventDefault();
            setOpen(false);
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (open) {
              // The items are already mounted while open, so focus moves now.
              const items = liveItems();
              items[e.key === 'ArrowDown' ? 0 : items.length - 1]?.focus();
            } else openMenu();
          }
        }}
        className={TAB}
      >
        More
        <ChevronDownIcon className="h-4 w-4" aria-hidden="true" />
      </button>
      {open &&
        popoverStyle &&
        createPortal(
          <div
            ref={popoverRef}
            id={menuId}
            role="menu"
            aria-label="More views"
            tabIndex={-1}
            style={popoverStyle}
            onKeyDown={onMenuKeyDown}
            className="z-50 max-h-[60vh] overflow-y-auto rounded-lg border border-p1-hairline-strong bg-p1-surface-1 p-1 shadow-pop"
          >
            {model.more.map((t, idx) => (
              <Link
                key={t.view}
                ref={(el) => {
                  itemsRef.current[idx] = el;
                }}
                to={t.to}
                role="menuitem"
                tabIndex={-1}
                aria-current={t.active ? 'page' : undefined}
                onClick={() => setOpen(false)}
                className={item}
              >
                {t.label}
              </Link>
            ))}
            {/* ADR-1478: advisory hides still open from here; only `enforced` ones cannot. */}
            {model.hidden.length > 0 && (
              <div role="group" aria-labelledby={`${menuId}-hidden`}>
                <div id={`${menuId}-hidden`} className={heading}>
                  Hidden from your tabs
                </div>
                {model.hidden.map((t, i) => (
                  <Link
                    key={t.view}
                    ref={(el) => {
                      itemsRef.current[model.more.length + i] = el;
                    }}
                    to={t.to}
                    role="menuitem"
                    tabIndex={-1}
                    aria-current={t.active ? 'page' : undefined}
                    onClick={() => setOpen(false)}
                    className={item}
                  >
                    <span>{t.label}</span>
                    <span className="text-xs text-p1-text-3">
                      <span aria-hidden="true">{t.source === 'seed' ? '◌ ' : '⊖ '}</span>
                      {t.source === 'seed'
                        ? `Suggested for ${lensLabel(t.lens ?? '')}`
                        : 'Hidden by you'}
                    </span>
                  </Link>
                ))}
              </div>
            )}
            {model.off.length > 0 && (
              <div role="group" aria-labelledby={`${menuId}-off`}>
                <div id={`${menuId}-off`} className={heading}>
                  Off in this workspace
                </div>
                {/* Off items stay in the arrow-key order and announce as disabled
                    (packages/web/CLAUDE.md: never drop an explained-unavailable control
                    out of keyboard reach), so a keyboard user hears why. */}
                {model.off.map((t, i) => (
                  <div
                    key={t.view}
                    ref={(el) => {
                      itemsRef.current[offBase + i] = el;
                    }}
                    role="menuitem"
                    aria-disabled="true"
                    tabIndex={-1}
                    className="flex min-h-11 items-center rounded-md px-2.5 text-sm text-p1-text-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus"
                  >
                    <span aria-hidden="true">⊘&nbsp;</span>
                    {/* TODO(#4888): frame 1B's "· Why" explainer; no view is off until capability toggles ship. */}
                    {t.label} is off
                  </div>
                ))}
              </div>
            )}
            {onCustomize && (
              <button
                type="button"
                ref={(el) => {
                  itemsRef.current[offBase + model.off.length] = el;
                }}
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  setOpen(false);
                  // The dialog returns focus to whatever held it when it opened.
                  triggerRef.current?.focus();
                  onCustomize();
                }}
                className={`${item} mt-1 w-full border-t border-p1-hairline text-left`}
              >
                Customize views…
              </button>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

function TabRow({
  model,
  layoutLabel,
  onCustomize,
}: {
  model: ContextTabsModel;
  layoutLabel: string;
  onCustomize?: () => void;
}) {
  const activeTab = model.tabs.find((t) => t.active);
  const toggles = activeTab && activeTab.toggles.length > 1 ? activeTab.toggles : [];
  return (
    <div className="flex items-end gap-2">
      {/* The row can grow (a long iteration noun, a phone); it scrolls, it never pushes its neighbours (rule 290). */}
      <nav
        aria-label="Views"
        className="-mb-px flex min-w-0 flex-1 gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
      >
        {model.tabs.map((t) => (
          <Link key={t.key} to={t.to} aria-current={t.active ? 'page' : undefined} className={TAB}>
            {t.label}
          </Link>
        ))}
        <MoreMenu model={model} onCustomize={onCustomize} />
      </nav>
      {toggles.length > 0 && (
        // Shown at every width: on a phone these are the only route to Grid,
        // Calendar, Sprints and the backlog besides ⌘K. The link is the pill,
        // so no clipped pseudo-element is doing the hit-area work.
        <nav
          aria-label={layoutLabel}
          className="mb-1 flex shrink-0 gap-0.5 overflow-x-auto rounded-md bg-p1-surface-2 p-0.5 [scrollbar-width:none]"
        >
          {toggles.map((t) => (
            <Link
              key={t.view}
              to={t.to}
              aria-current={t.active ? 'page' : undefined}
              className="flex h-10 items-center rounded px-2.5 text-xs font-medium text-p1-text-2 no-underline hover:text-p1-text-1 focus:outline-none focus:ring-2 focus:ring-p1-focus focus:ring-inset aria-[current=page]:bg-p1-surface-1 aria-[current=page]:text-p1-text-1"
            >
              {t.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}

function ContextTitle({ name }: { name: string }) {
  // Not an <h1>: every page already owns its (often sr-only) h1 naming the VIEW,
  // and two h1s per document put the project name ahead of the page's own name.
  return (
    <>
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-p1-surface-3 text-xs font-semibold text-p1-text-2"
        aria-hidden="true"
      >
        {name.charAt(0)}
      </span>
      <span
        className="truncate text-xl font-semibold tracking-[-0.01em]"
        title={name}
        data-testid="shell2-context-title"
      >
        {name}
      </span>
    </>
  );
}

function ProjectContextHeader({ projectId }: { projectId: string }) {
  const { pathname } = useLocation();
  const { data: project } = useProject(projectId);
  const unavailable = useProjectUnavailable(projectId);
  const { user } = useCurrentUser();
  const { groups, labelFor, allows } = useGroupedProjectViews(projectId);
  // ADR-1478: the server resolves which views show, seeding on the first open. Until it
  // answers, the tab row is a skeleton (never a full row that is pruned a moment later).
  // On error it fails open to the unseeded composition below, and nothing is saved.
  const viewSet = useProjectViews(projectId);
  const [customizing, setCustomizing] = useState(false);
  if (unavailable || !project) return null;
  const basePath = projectPath(project);
  const activeView = segmentAfterRef(pathname, 'project') ?? 'overview';
  const visibleViews = groups.flatMap((g) => g.visibleViews);
  const model = resolveContextTabs({
    scope: 'project',
    basePath,
    activeView,
    visibleViews,
    userHiddenViews: user?.hidden_views ?? [],
    labelFor,
    resolved: viewSet.data?.views,
    allows,
  });
  return (
    <div className="shrink-0 border-b border-p1-hairline px-3 pt-3 md:px-6 md:pt-4">
      <div className="flex min-h-[32px] items-center gap-3">
        <ContextTitle name={project.name} />
        <HealthSlot />
        <span className="flex-1" />
        <ForecastStamp projectId={projectId} />
        <Link
          to={`${basePath}/forecast`}
          className="relative hidden h-8 items-center text-xs text-p1-brand underline before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-[''] focus:outline-none focus:ring-2 focus:ring-p1-focus md:inline-flex"
        >
          Forecast
        </Link>
      </div>
      <div className="mt-1.5">
        {viewSet.isPending ? (
          <div
            data-testid="shell2-tabs-skeleton"
            role="status"
            aria-busy="true"
            aria-label="Loading views"
            className="flex h-11 items-end gap-2 pb-1"
          >
            {[56, 40, 56, 44, 52].map((w) => (
              <span
                key={w}
                className="h-6 animate-pulse rounded bg-p1-surface-2 motion-reduce:animate-none"
                style={{ width: w }}
              />
            ))}
          </div>
        ) : (
          <TabRow
            model={model}
            layoutLabel={`${model.tabs.find((t) => t.active)?.label ?? 'View'} layout`}
            onCustomize={viewSet.data ? () => setCustomizing(true) : undefined}
          />
        )}
      </div>
      {viewSet.data && (
        <ViewsRow3
          projectId={projectId}
          viewSet={viewSet.data}
          labelFor={labelFor}
          openHiddenView={model.hidden.find((t) => t.active)?.view ?? null}
          onCustomize={() => setCustomizing(true)}
        />
      )}
      {customizing && viewSet.data && (
        <CustomizeViewsDialog
          projectId={projectId}
          projectName={project.name}
          viewSet={viewSet.data}
          labelFor={labelFor}
          onClose={() => setCustomizing(false)}
        />
      )}
    </div>
  );
}

function ProgramContextHeader({ programId }: { programId: string }) {
  const { pathname } = useLocation();
  const { data: program } = useProgram(programId);
  if (!program) return null;
  const basePath = programPath(program);
  const activeView = segmentAfterRef(pathname, 'program') ?? 'overview';
  const isAdmin = (program.my_role ?? 0) >= ROLE_ADMIN;
  const visibleViews = PROGRAM_VIEWS.filter((v) => v !== 'settings' || isAdmin);
  const model = resolveContextTabs({
    scope: 'program',
    basePath,
    activeView,
    visibleViews,
    userHiddenViews: [],
    labelFor: (v) => PROGRAM_VIEW_LABEL[v] ?? v,
  });
  return (
    <div className="shrink-0 border-b border-p1-hairline px-3 pt-3 md:px-6 md:pt-4">
      <div className="flex min-h-[32px] items-center gap-3">
        <ContextTitle name={program.name} />
      </div>
      <div className="mt-1.5">
        <TabRow model={model} layoutLabel="Layout" />
      </div>
    </div>
  );
}

/**
 * Title + health (shown ONCE in the chrome) + P80 stamp, and the ≤5-tab row that
 * answers "how am I looking at it". Renders nothing off a project or program
 * route, and nothing for a project the person cannot see (404/403) — Home,
 * Inbox, Work and People pages own their own headings.
 */
export function ContextHeader2() {
  const projectId = useProjectId();
  const programId = useProgramId();
  if (projectId) return <ProjectContextHeader projectId={projectId} />;
  if (programId) return <ProgramContextHeader programId={programId} />;
  return null;
}
