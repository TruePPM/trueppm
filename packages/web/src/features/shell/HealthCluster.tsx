import { useState, useRef, useEffect, type ReactNode } from 'react';
import { useNavigate, useMatch } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useShellStats } from '@/hooks/useShellStats';
import { useActiveSprint, useProjectVelocity } from '@/hooks/useSprints';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useCurrentSprintTargets, type SprintJumpTarget } from '@/hooks/useCurrentSprintTargets';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { WarningIcon, CriticalDotIcon } from '@/components/Icons';
import { MCResultPanel } from './MCResultPanel';
import { healthClusterModel, type HealthSegment } from './healthClusterModel';
import { fmtUtcShort } from '@/lib/formatUtcDate';

interface Props {
  /** Selects + scrolls to a task and routes to the schedule (owned by TopBar). */
  onTaskNavigate: (id: string) => void;
}

// Forecast dates are formatted in UTC (the server emits MC percentile dates as
// UTC ISO strings). Local-zone formatting drifts a calendar day west of UTC,
// which is what made the shell header disagree with the schedule bar (ADR-0144).
const formatForecastDate = fmtUtcShort;

// The velocity number is audience-scoped (ADR-0104). Even when the viewer is in
// audience, the row surfaces this boundary so teams trust the figure isn't piped
// up to portfolio/PMO surfaces (issue 1197 — Morgan's trust ask).
const VELOCITY_PRIVACY_NOTE = 'Visible to project members only — not on portfolio dashboards';

// At-risk / critical drill lists cap at five items with a "+N more" tail so the
// popover never grows unbounded (mirrors the previous SegmentPopover behaviour).
const MAX_VISIBLE = 5;

// Inline padlock glyph for the ADR-0104 velocity privacy wall (rule 168). No
// LockIcon exists in the icon set; this is decorative (aria-hidden) — the gate is
// named in the row's aria-label.
function LockGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="w-3 h-3" fill="currentColor" aria-hidden="true">
      <path d="M8 1a3 3 0 0 0-3 3v2H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1V4a3 3 0 0 0-3-3Zm-1.5 5V4a1.5 1.5 0 0 1 3 0v2h-3Z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Chip state word — derived from the project-wide at-risk / critical counts on
// `useShellStats`, NOT from the methodology segment set. `status-summary`
// carries `at_risk_count` / `critical_count` for every methodology, so an Agile
// project whose cluster shows Sprint/Points/Velocity still reads "At risk" on the
// chip when it has a real critical task (rule 6 — the WORD is the non-color
// signal; the dot only reinforces it).
// ---------------------------------------------------------------------------

type ChipStateKey = 'critical' | 'atRisk' | 'onTrack';

interface ChipState {
  key: ChipStateKey;
  word: string;
  /** Word color: semantic for at-risk/critical; neutral for on-track (the dot
   *  carries the on-track color so the word stays a calm non-color signal, rule 6). */
  wordClass: string;
  dotClass: string;
}

function deriveChipState(criticalCount: number, atRiskCount: number): ChipState {
  // One critical ⇒ "At risk"; ≥1 at-risk & 0 critical ⇒ "On watch"; else "On
  // track". No other math — the chip is a single worst-state read.
  if (criticalCount > 0) {
    return {
      key: 'critical',
      word: 'At risk',
      wordClass: 'text-semantic-critical',
      dotClass: 'bg-semantic-critical',
    };
  }
  if (atRiskCount > 0) {
    return {
      key: 'atRisk',
      word: 'On watch',
      wordClass: 'text-semantic-at-risk',
      dotClass: 'bg-semantic-at-risk',
    };
  }
  return {
    key: 'onTrack',
    word: 'On track',
    wordClass: 'text-neutral-text-secondary',
    dotClass: 'bg-semantic-on-track',
  };
}

// ---------------------------------------------------------------------------
// Popover rows — one row (or nested drill group) per methodology segment. Rows
// reuse the exact segment set from `healthClusterModel` so the popover never
// re-derives the methodology cluster.
// ---------------------------------------------------------------------------

const ROW = 'flex items-center justify-between gap-3 px-2 py-1.5 text-xs whitespace-nowrap';
const ROW_BTN =
  'w-full ' +
  ROW +
  ' rounded-control hover:bg-neutral-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset';
const TASK_BTN =
  'w-full text-left px-2 py-1.5 rounded-control text-xs hover:bg-neutral-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset';

interface SegmentRowsProps {
  segment: HealthSegment;
  iterationSingular: string;
  iterationLower: string;
  canOpenForecast: boolean;
  onOpenForecast: () => void;
  onGoToSprints: () => void;
  onTaskNavigate: (id: string) => void;
  /** The in-context project's active-sprint board deep-link, or null when it has
   *  no active sprint / the targets haven't resolved. The `sprint` row jumps here
   *  (the folded-in CurrentSprintButton behaviour, #1680), falling back to the
   *  sprints list so the row is never dead. */
  inContextBoardPath: string | null;
  /** Other teams' active sprints (multi-team) — rendered as per-team jump rows
   *  under the primary sprint row (#1680). */
  crossTeamTargets: SprintJumpTarget[];
  onJumpToBoard: (path: string) => void;
}

/** Per-team jump rows for the multi-team case (#1680) — each opens that team's
 *  active-sprint board. Grouped so a screen reader announces the set. */
function CrossTeamSprintRows({
  targets,
  iterationLower,
  onJumpToBoard,
}: {
  targets: SprintJumpTarget[];
  iterationLower: string;
  onJumpToBoard: (path: string) => void;
}): ReactNode {
  if (targets.length === 0) return null;
  return (
    <div role="group" aria-label={`Other teams' active ${iterationLower}s`}>
      {targets.map((t) => (
        <button
          key={t.sprintId}
          type="button"
          onClick={() => onJumpToBoard(t.path)}
          aria-label={`Go to ${t.projectName} ${iterationLower}: ${t.sprintName}.`}
          className="w-full flex flex-col items-start gap-0 px-2 py-1.5 text-xs rounded-control hover:bg-neutral-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset"
        >
          <span className="w-full truncate text-neutral-text-primary">{t.sprintName}</span>
          <span className="tppm-mono w-full truncate text-neutral-text-secondary">
            {t.projectName}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Renders the one-or-two popover rows for a single health segment. Forecast
 *  expands to a P50 row + a P80 row (the P50·P80 band, ADR-0144/0175) — never a
 *  single percentile. Forecast rows are always neutral (rule 172). */
function SegmentRows({
  segment,
  iterationSingular,
  iterationLower,
  canOpenForecast,
  onOpenForecast,
  onGoToSprints,
  onTaskNavigate,
  inContextBoardPath,
  crossTeamTargets,
  onJumpToBoard,
}: SegmentRowsProps): ReactNode {
  switch (segment.kind) {
    case 'forecast': {
      const p50Text = segment.p50 != null ? formatForecastDate(segment.p50) : null;
      const p80Text = segment.p80 != null ? formatForecastDate(segment.p80) : null;
      // aria-label MUST start with "Monte Carlo forecast" when the band is
      // present (schedule-monte-carlo.spec locates the drill by this prefix).
      const detailAria =
        p50Text != null
          ? `Monte Carlo forecast: P50 ${p50Text}, P80 ${p80Text ?? 'not run'}. View distribution.`
          : `Monte Carlo P80 completion ${p80Text ?? 'not run'}. View distribution.`;
      return (
        <>
          {/* P50 row — neutral, static (rule 172: forecast is informational,
              never amber, even when the chip itself is red). */}
          <div className={ROW}>
            <span className="text-neutral-text-secondary">Forecast P50</span>
            <span
              className={
                p50Text ? 'tppm-mono text-neutral-text-primary' : 'text-neutral-text-disabled'
              }
            >
              {p50Text ?? '—'}
            </span>
          </div>
          {/* P80 row — neutral, with the Details › drill into the MC distribution. */}
          <div className={ROW}>
            <span className="text-neutral-text-secondary">Forecast P80</span>
            <span className="flex items-center gap-2">
              <span
                className={
                  p80Text ? 'tppm-mono text-neutral-text-primary' : 'text-neutral-text-disabled'
                }
                title={p80Text ? undefined : 'Run the scheduler'}
              >
                {p80Text ?? '—'}
              </span>
              {canOpenForecast && (
                <button
                  type="button"
                  onClick={onOpenForecast}
                  aria-haspopup="dialog"
                  aria-label={detailAria}
                  className="text-brand-primary rounded-control px-1 hover:underline focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset"
                >
                  Details ›
                </button>
              )}
            </span>
          </div>
        </>
      );
    }

    case 'atRisk':
      return (
        <DrillRows
          label="At risk"
          variant="at-risk"
          icon={<WarningIcon aria-hidden="true" />}
          count={segment.count}
          items={segment.items}
          ariaGroup={`${segment.count} at-risk task${segment.count === 1 ? '' : 's'}`}
          onTaskNavigate={onTaskNavigate}
        />
      );

    case 'critical':
      return (
        <DrillRows
          label="Critical path"
          variant="critical"
          icon={<CriticalDotIcon aria-hidden="true" />}
          count={segment.count}
          items={segment.items}
          ariaGroup={`${segment.count} critical task${segment.count === 1 ? '' : 's'}`}
          onTaskNavigate={onTaskNavigate}
        />
      );

    case 'sprint':
      // Primary row jumps to the in-context board (the folded-in CurrentSprintButton,
      // #1680); falls back to the sprints list until the board path resolves so it is
      // never dead. Other teams' sprints follow as per-team jump rows.
      return (
        <>
          <button
            type="button"
            onClick={() =>
              inContextBoardPath ? onJumpToBoard(inContextBoardPath) : onGoToSprints()
            }
            // The announced destination must match where the click lands: only
            // promise the board once its path has resolved, else the fallback
            // (sprints list) would mismatch the name for a load tick.
            aria-label={
              inContextBoardPath
                ? `${segment.name}, day ${segment.dayN} of ${segment.dayM}. Go to ${iterationLower} board.`
                : `${segment.name}, day ${segment.dayN} of ${segment.dayM}. View ${iterationLower}s.`
            }
            className={ROW_BTN}
          >
            <span className="text-neutral-text-primary font-medium">{segment.name}</span>
            <span className="tppm-mono text-neutral-text-secondary">
              Day {segment.dayN}/{segment.dayM}
            </span>
          </button>
          <CrossTeamSprintRows
            targets={crossTeamTargets}
            iterationLower={iterationLower}
            onJumpToBoard={onJumpToBoard}
          />
        </>
      );

    case 'sprintEmpty':
      // No in-context board to jump to; the primary row still routes to the sprints
      // list. Other teams' active sprints remain reachable as jump rows.
      return (
        <>
          <button
            type="button"
            onClick={onGoToSprints}
            aria-label={`No active ${iterationLower}. View ${iterationLower}s.`}
            className={ROW_BTN}
          >
            <span className="text-neutral-text-secondary">No active {iterationSingular}</span>
            <span aria-hidden="true" className="text-neutral-text-disabled">
              ›
            </span>
          </button>
          <CrossTeamSprintRows
            targets={crossTeamTargets}
            iterationLower={iterationLower}
            onJumpToBoard={onJumpToBoard}
          />
        </>
      );

    case 'points':
      return (
        <div
          className={ROW}
          aria-label={`${segment.completed} of ${segment.committed} ${
            segment.unit === 'pts' ? 'points' : 'items'
          } completed`}
        >
          <span className="text-neutral-text-secondary">Points</span>
          <span className="flex items-center gap-1">
            <span className="tppm-mono text-neutral-text-primary">
              {segment.completed}/{segment.committed}
            </span>
            <span className="text-neutral-text-secondary">{segment.unit}</span>
          </span>
        </div>
      );

    case 'velocityGated':
      // ADR-0104 / rule 168: content-free wall, no number ever rendered.
      return (
        <div
          className={ROW + ' text-neutral-text-secondary'}
          aria-label={`Team ${iterationLower} velocity is kept private to the team`}
        >
          <span className="flex items-center gap-1.5">
            <LockGlyph />
            Velocity
          </span>
          <span>Kept to the team</span>
        </div>
      );

    case 'velocity': {
      if (segment.avg == null) {
        return (
          <div className={ROW} title="Not enough closed-sprint history yet">
            <span className="text-neutral-text-secondary">Velocity</span>
            <span className="text-neutral-text-disabled">—</span>
          </div>
        );
      }
      const range =
        segment.low != null && segment.high != null ? `, range ${segment.low}–${segment.high}` : '';
      const excluded = segment.excluded > 0 ? `, ${segment.excluded} excluded` : '';
      return (
        <button
          type="button"
          onClick={onGoToSprints}
          title={VELOCITY_PRIVACY_NOTE}
          aria-label={`Velocity ${segment.avg} points per ${iterationLower}${range}${excluded}. ${VELOCITY_PRIVACY_NOTE}. View ${iterationLower}s.`}
          className={ROW_BTN}
        >
          {/* Lock = the audience boundary on the in-audience figure (issue 1197).
              Decorative; the boundary text lives in the aria-label + title. */}
          <span className="flex items-center gap-1.5 text-neutral-text-secondary">
            <LockGlyph />
            Velocity
          </span>
          <span className="tppm-mono text-neutral-text-primary">
            {segment.avg} pts/{iterationLower}
          </span>
        </button>
      );
    }

    default:
      return null;
  }
}

interface DrillRowsProps {
  label: string;
  variant: 'at-risk' | 'critical';
  icon: ReactNode;
  count: number;
  items: { id: string; wbs: string; name: string }[];
  ariaGroup: string;
  onTaskNavigate: (id: string) => void;
}

/** At-risk / critical row. Zero is a calm static "0 tasks" read (no drill);
 *  count > 0 renders a labelled header plus the offending tasks nested as drill
 *  buttons (MAX_VISIBLE + "+N more"). Selecting a task closes the popover. */
function DrillRows({
  label,
  variant,
  icon,
  count,
  items,
  ariaGroup,
  onTaskNavigate,
}: DrillRowsProps) {
  if (count === 0) {
    return (
      <div className={ROW}>
        <span className="text-neutral-text-secondary">{label}</span>
        <span className="text-neutral-text-secondary">0 tasks</span>
      </div>
    );
  }
  const colorClass = variant === 'critical' ? 'text-semantic-critical' : 'text-semantic-at-risk';
  const visible = items.slice(0, MAX_VISIBLE);
  const overflow = count - visible.length;
  return (
    <div role="group" aria-label={ariaGroup}>
      <div className={ROW + ' ' + colorClass}>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true">{icon}</span>
          {label}
        </span>
        <span className="tppm-mono">{count}</span>
      </div>
      {visible.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onTaskNavigate(item.id)}
          className={TASK_BTN + ' ' + colorClass}
        >
          <span className="text-neutral-text-secondary mr-1">{item.wbs}</span>
          {item.name}
        </button>
      ))}
      {overflow > 0 && (
        <div className="px-2 py-1 text-xs text-neutral-text-secondary">+{overflow} more</div>
      )}
    </div>
  );
}

/**
 * v2 methodology-adaptive project health surface (ADR-0128 §B, progressive
 * disclosure — issue 1644). A single all-width **status chip** shows the
 * worst-state word (On track / On watch / At risk), a health dot, and an
 * optional P80 forecast fragment. Clicking it opens a **health popover** whose
 * rows are exactly the methodology's `healthClusterModel` segments — forecast
 * band, at-risk/critical drills, sprint/points/velocity — with the ADR-0104
 * velocity privacy wall honored.
 *
 * The chip replaces both the always-inline `md:flex` segmented cluster and the
 * separate phone-only "Health ▾" dropdown: it is one control at every width.
 *
 * Project-scoped chrome: returns null off a project route and on project settings
 * routes (the SettingsShell carries its own chrome — rule 123 / ADR-0128 §C).
 */
export function HealthCluster({ onTaskNavigate }: Props) {
  const projectId = useProjectId() ?? null;
  const { data: project } = useProject(projectId);
  const { data: stats } = useShellStats();
  const { sprint: activeSprint } = useActiveSprint(projectId);
  const { data: velocity } = useProjectVelocity(projectId);
  const iteration = useIterationLabel(projectId);
  // Sprint-jump targets (issue 1594) folded into the popover's sprint row (#1680) —
  // one source shared with the ⌘K "Current sprint" action (web-rule 214).
  const sprintTargets = useCurrentSprintTargets(projectId);
  const { data: mcResult } = useMonteCarloResult(projectId ?? undefined);
  const navigate = useNavigate();
  const onSettingsRoute = useMatch('/projects/:projectId/settings/*');

  const [open, setOpen] = useState(false);
  const [showMCPanel, setShowMCPanel] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Focus trap on the popover panel (rule 206): moves focus in on open, wraps
  // Tab, routes Escape to close, and restores focus to the chip trigger on close.
  const dialogRef = useFocusTrap<HTMLDivElement>(open, () => setOpen(false));

  // Outside pointer-down closes the popover. The wrapper spans BOTH the chip and
  // the panel, so a click on the chip is "inside" and toggles via its own
  // onClick rather than double-firing a close-then-reopen.
  useEffect(() => {
    if (!open) return undefined;
    function onMouseDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  // Project-scoped chrome; suppressed on project settings routes (rule 123 — the
  // SettingsShell carries its own chrome). The `useProjectId()` null path already
  // covers My Work / Notifications / Portfolio / Program / workspace settings.
  if (!projectId || onSettingsRoute) return null;

  // Default to HYBRID (richest cluster) until the project loads — mirrors ViewTabs.
  const methodology = project?.methodology ?? 'HYBRID';
  const segments = healthClusterModel({
    methodology,
    stats,
    activeSprint,
    velocity,
    // P50 for the forecast band comes from the same MC result the drill-through
    // panel renders (issue 1197); P80 stays sourced from the status-summary.
    mc: mcResult ? { p50: mcResult.p50, p80: mcResult.p80 } : undefined,
    now: new Date(),
  });

  // The chip word is derived from the project-wide counts, independent of which
  // segments this methodology renders (see deriveChipState).
  const chip = deriveChipState(stats?.criticalCount ?? 0, stats?.atRiskCount ?? 0);

  // P80 fragment on the chip: shown only when the methodology cluster has a
  // forecast segment (omitted entirely for pure Agile). The value text stays
  // neutral even inside an amber/red chip (rule 172).
  const forecastSeg = segments.find(
    (s): s is Extract<HealthSegment, { kind: 'forecast' }> => s.kind === 'forecast',
  );

  let chipAria = `Project health: ${chip.word}`;
  if (forecastSeg) {
    chipAria +=
      forecastSeg.p80 != null
        ? `, forecast P80 ${formatForecastDate(forecastSeg.p80)}`
        : ', forecast not run';
  }

  // The in-context project's active-sprint board (the primary jump) and the other
  // teams' sprints (multi-team rows). `sprintTargets` is "here first", so the
  // in-context one — if any — is the entry whose projectId matches.
  const inContextBoardPath = sprintTargets.find((t) => t.projectId === projectId)?.path ?? null;
  const crossTeamTargets = sprintTargets.filter((t) => t.projectId !== projectId);

  function goToSprints() {
    setOpen(false);
    void navigate(`/projects/${projectId}/${'sprints'}`);
  }

  function jumpToBoard(path: string) {
    setOpen(false);
    void navigate(path);
  }

  function drillTask(id: string) {
    setOpen(false);
    onTaskNavigate(id);
  }

  function openForecast() {
    setOpen(false);
    setShowMCPanel(true);
  }

  return (
    <div ref={wrapperRef} className="relative">
      {/* Status chip trigger — all-width (no md:flex / md:hidden split). The
          data-testid stays on the trigger: e2e locates the surface by it. */}
      <button
        type="button"
        data-testid="health-cluster"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={chipAria}
        className="inline-flex items-center gap-1.5 h-[34px] rounded-full border border-neutral-border px-3 text-xs font-medium
          hover:bg-neutral-surface-raised
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        <span aria-hidden="true" className={`inline-block w-2 h-2 rounded-full ${chip.dotClass}`} />
        <span className={chip.wordClass}>{chip.word}</span>
        {forecastSeg && forecastSeg.p80 != null && (
          // P80 value stays neutral even inside an amber/red chip (rule 172).
          // Held to md+ (tablet and up, #1562): on a phone the fixed-width right
          // cluster can't compress (TopBar rule 174), so the extra "P80 {date}"
          // width pushed the sync badge and everything after it off the right edge
          // (#1788). The dot + state word are always visible; the forecast lives in
          // the popover on phones.
          <span className="hidden md:inline-flex items-center gap-1">
            <span className="text-neutral-text-secondary">P80</span>
            <span className="tppm-mono text-neutral-text-primary">
              {formatForecastDate(forecastSeg.p80)}
            </span>
          </span>
        )}
        {forecastSeg && forecastSeg.p80 == null && (
          <span
            className="hidden md:inline-flex items-center gap-1 text-neutral-text-disabled"
            title="Run the scheduler"
          >
            <span>P80</span>
            <span>—</span>
          </span>
        )}
        <span aria-hidden="true" className="text-neutral-text-secondary">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {/* Health popover — pop-surface exception to rule 1 (shadow-pop allowed). */}
      {open && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-label="Project health"
          tabIndex={-1}
          className="absolute top-full right-0 mt-1 z-50 min-w-[260px] rounded-card shadow-pop border border-neutral-border bg-neutral-surface p-1.5 focus:outline-none"
        >
          {/* Header — worst-state dot + word, same read as the chip. */}
          <div className="flex items-center gap-2 px-2 py-1.5 mb-1 border-b border-neutral-border">
            <span
              aria-hidden="true"
              className={`inline-block w-2 h-2 rounded-full ${chip.dotClass}`}
            />
            <span className={`text-xs font-medium ${chip.wordClass}`}>{chip.word}</span>
          </div>

          {segments.map((segment, i) => (
            <SegmentRows
              key={`${segment.kind}-${i}`}
              segment={segment}
              iterationSingular={iteration.singular}
              iterationLower={iteration.lower}
              canOpenForecast={Boolean(mcResult)}
              onOpenForecast={openForecast}
              onGoToSprints={goToSprints}
              onTaskNavigate={drillTask}
              inContextBoardPath={inContextBoardPath}
              crossTeamTargets={crossTeamTargets}
              onJumpToBoard={jumpToBoard}
            />
          ))}
        </div>
      )}

      {/* MC distribution panel — opened by the Forecast P80 "Details ›" row (issue 196) */}
      {showMCPanel && mcResult && (
        <MCResultPanel result={mcResult} onClose={() => setShowMCPanel(false)} />
      )}
    </div>
  );
}
