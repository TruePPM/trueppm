import { useId, useRef, useState, type KeyboardEvent } from 'react';
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
import { HEALTH_BAND_LABEL, type HealthBand } from '@/lib/healthBand';
import { ROLE_ADMIN } from '@/lib/roles';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { formatRelative } from '@/lib/formatRelative';
import { programPath, projectPath, segmentAfterRef } from '@/lib/refPath';
import { ChevronDownIcon } from '@/components/Icons';
import { Tooltip } from '@/components/Tooltip';
import { QueryErrorState } from '@/components/QueryErrorState';
import { resolveContextTabs, type ContextTabsModel } from './contextTabs';

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

/** Health chip: the band word is the SERVER's band (rule 397), with a non-color glyph (rule 120). */
const HEALTH_GLYPH: Record<HealthBand, string> = { critical: '▲', at_risk: '◆', on_track: '✓' };
const HEALTH_CLASS: Record<HealthBand, string> = {
  critical: 'bg-p1-critical-tint text-p1-critical',
  at_risk: 'bg-p1-risk-tint text-p1-risk-text',
  on_track: 'bg-p1-ok-tint text-p1-ok',
};

function HealthChip({ band }: { band: HealthBand }) {
  return (
    <span
      data-testid="shell2-health"
      className={`inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-xs font-medium ${HEALTH_CLASS[band]}`}
    >
      <span aria-hidden="true" className="text-xs leading-none">
        {HEALTH_GLYPH[band]}
      </span>
      {HEALTH_BAND_LABEL[band]}
    </span>
  );
}

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
  return <HealthChip band={stats.healthBand} />;
}

/** A 44px hit area around a control shorter than 44px (rules 5, 330): sized, never inset; only valid where no ancestor clips overflow. */
const HIT_44 =
  "relative before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-full before:min-w-[44px] before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']";

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
      {definition ? (
        <Tooltip content={definition}>
          <button
            type="button"
            className={`${HIT_44} cursor-help rounded border-b border-dotted border-p1-hairline-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus`}
          >
            P80
          </button>
        </Tooltip>
      ) : (
        <span>P80</span>
      )}
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

function MoreMenu({ model }: { model: ContextTabsModel }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const itemsRef = useRef<Array<HTMLAnchorElement | null>>([]);
  const { triggerRef, popoverRef, popoverStyle } = useAnchoredPopover<
    HTMLButtonElement,
    HTMLDivElement
  >({
    open,
    width: 200,
    estimatedHeight: 44 * model.more.length + 16,
    align: 'right',
    onDismiss: () => setOpen(false),
  });
  const anyActive = model.more.some((t) => t.active);

  const focusItem = (i: number) => window.setTimeout(() => itemsRef.current[i]?.focus(), 0);
  // A menu button opens AND seats focus on the first item (APG menu button pattern);
  // Escape closes and returns focus to the button.
  const openMenu = () => {
    setOpen(true);
    focusItem(0);
  };
  const closeMenu = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onMenuKeyDown = (e: KeyboardEvent) => {
    const items = itemsRef.current.filter((el): el is HTMLAnchorElement => el !== null);
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

  if (model.more.length === 0) return null;
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
            if (open) focusItem(e.key === 'ArrowDown' ? 0 : model.more.length - 1);
            else openMenu();
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
                className="flex h-11 items-center rounded-md px-2.5 text-sm text-p1-text-2 no-underline hover:bg-p1-surface-2 hover:text-p1-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus aria-[current=page]:bg-p1-brand-tint aria-[current=page]:text-p1-text-1"
              >
                {t.label}
              </Link>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

function TabRow({ model, layoutLabel }: { model: ContextTabsModel; layoutLabel: string }) {
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
        <MoreMenu model={model} />
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
  const { groups, labelFor } = useGroupedProjectViews(projectId);
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
  });
  return (
    <div className="shrink-0 border-b border-p1-hairline px-3 pt-3 md:px-6 md:pt-4">
      <div className="flex min-h-[32px] items-center gap-3">
        <ContextTitle name={project.name} />
        <HealthSlot />
        <span className="flex-1" />
        <ForecastStamp projectId={projectId} />
      </div>
      <div className="mt-1.5">
        <TabRow
          model={model}
          layoutLabel={`${model.tabs.find((t) => t.active)?.label ?? 'View'} layout`}
        />
      </div>
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
