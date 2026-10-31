import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useProgramId } from '@/hooks/useProgramId';
import { useProject } from '@/hooks/useProject';
import { useProgram } from '@/hooks/useProgram';
import { useShellStats } from '@/hooks/useShellStats';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { useGroupedProjectViews } from '@/features/shell/useGroupedProjectViews';
import { useAnchoredPopover } from '@/hooks/useAnchoredPopover';
import { HEALTH_BAND_LABEL, type HealthBand } from '@/lib/healthBand';
import { ROLE_ADMIN } from '@/lib/roles';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { programPath, projectPath, segmentAfterRef } from '@/lib/refPath';
import { ChevronDownIcon } from '@/components/Icons';
import { Tooltip } from '@/components/Tooltip';
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

const P80_DEFINITION =
  'P80 finish — the date 80% of the simulated schedules finish on or before. Recomputed from the latest saved forecast.';

/** The P80 stamp: value, definition on hover/focus, and when it was computed. */
function ForecastStamp({ projectId }: { projectId: string }) {
  const { data: mc } = useMonteCarloResult(projectId);
  // No saved forecast yet → no stamp. A dash here would be the 'P80 —' placeholder
  // tile the Pass 1 audit filed as gap #2; the stamp states a date or nothing.
  if (!mc?.p80) return null;
  return (
    <span className="hidden items-center gap-1.5 text-xs text-p1-text-2 md:flex">
      <Tooltip content={P80_DEFINITION}>
        <button
          type="button"
          className="cursor-help rounded border-b border-dotted border-p1-hairline-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus"
        >
          P80
        </button>
      </Tooltip>
      <span className="font-mono font-semibold tabular-nums text-p1-text-1">
        {fmtUtcShort(mc.p80)}
      </span>
      {mc.lastRunAt && <span className="text-p1-text-3">· as of {fmtUtcShort(mc.lastRunAt)}</span>}
    </span>
  );
}

const TAB =
  'relative flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 text-sm font-medium text-p1-text-2 no-underline ' +
  'border-b-2 border-transparent -mb-px hover:text-p1-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus focus-visible:ring-inset ' +
  'aria-[current=page]:border-p1-brand aria-[current=page]:text-p1-text-1 ' +
  // 44px hit area on a 36px tab (rules 5, 330): sized, not inset.
  "before:absolute before:left-0 before:top-1/2 before:h-11 before:w-full before:-translate-y-1/2 before:content-['']";

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

  const onKeyDown = (e: KeyboardEvent) => {
    const items = itemsRef.current.filter((el): el is HTMLAnchorElement => el !== null);
    const i = items.findIndex((el) => el === document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
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
        aria-current={anyActive ? 'page' : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.preventDefault();
            setOpen(false);
          } else if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
            window.setTimeout(() => itemsRef.current[0]?.focus(), 0);
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
            onKeyDown={onKeyDown}
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
        <nav
          aria-label={layoutLabel}
          className="mb-1.5 hidden shrink-0 gap-0.5 rounded-md bg-p1-surface-2 p-0.5 md:flex"
        >
          {toggles.map((t) => (
            <Link
              key={t.view}
              to={t.to}
              aria-current={t.active ? 'page' : undefined}
              className="relative flex h-7 items-center rounded px-2.5 text-xs font-medium text-p1-text-2 no-underline hover:text-p1-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus aria-[current=page]:bg-p1-surface-1 aria-[current=page]:text-p1-text-1 before:absolute before:left-0 before:top-1/2 before:h-11 before:w-full before:-translate-y-1/2 before:content-['']"
            >
              {t.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}

function ProjectContextHeader({ projectId }: { projectId: string }) {
  const { pathname } = useLocation();
  const { data: project } = useProject(projectId);
  const { data: stats } = useShellStats();
  const { groups, labelFor } = useGroupedProjectViews(projectId);
  if (!project) return null;
  const basePath = projectPath(project);
  const activeView = segmentAfterRef(pathname, 'project') ?? 'overview';
  const visibleViews = groups.flatMap((g) => g.visibleViews);
  const model = resolveContextTabs({
    scope: 'project',
    basePath,
    activeView,
    visibleViews,
    labelFor,
  });
  return (
    <div className="shrink-0 border-b border-p1-hairline px-3 pt-3 md:px-6 md:pt-4">
      <div className="flex min-h-[32px] items-center gap-3">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-p1-surface-3 text-xs font-semibold text-p1-text-2"
          aria-hidden="true"
        >
          {project.name.charAt(0)}
        </span>
        <h1 className="truncate text-xl font-semibold tracking-[-0.01em]" title={project.name}>
          {project.name}
        </h1>
        {stats?.healthBand && <HealthChip band={stats.healthBand} />}
        <span className="flex-1" />
        <ForecastStamp projectId={projectId} />
      </div>
      <div className="mt-2.5">
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
    labelFor: (v) => PROGRAM_VIEW_LABEL[v] ?? v,
  });
  return (
    <div className="shrink-0 border-b border-p1-hairline px-3 pt-3 md:px-6 md:pt-4">
      <div className="flex min-h-[32px] items-center gap-3">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-p1-surface-3 text-xs font-semibold text-p1-text-2"
          aria-hidden="true"
        >
          {program.name.charAt(0)}
        </span>
        <h1 className="truncate text-xl font-semibold tracking-[-0.01em]" title={program.name}>
          {program.name}
        </h1>
      </div>
      <div className="mt-2.5">
        <TabRow model={model} layoutLabel="Layout" />
      </div>
    </div>
  );
}

/**
 * Title + health (shown ONCE per context, here and nowhere else) + P80 stamp,
 * and the ≤5-tab row that answers "how am I looking at it". Renders nothing
 * off a project or program route — Home, Inbox, Work and People pages own
 * their own headings.
 */
export function ContextHeader2() {
  const projectId = useProjectId();
  const programId = useProgramId();
  if (projectId) return <ProjectContextHeader projectId={projectId} />;
  if (programId) return <ProgramContextHeader programId={programId} />;
  return null;
}
