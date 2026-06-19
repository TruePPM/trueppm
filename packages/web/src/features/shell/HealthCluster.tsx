import { useState, useRef, useEffect, type ReactNode } from 'react';
import { useNavigate, useMatch } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useShellStats } from '@/hooks/useShellStats';
import { useActiveSprint, useProjectVelocity } from '@/hooks/useSprints';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { WarningIcon, CriticalDotIcon } from '@/components/Icons';
import { MCResultPanel } from './MCResultPanel';
import { healthClusterModel, type HealthSegment } from './healthClusterModel';
import { fmtUtcShort } from '@/lib/formatUtcDate';

interface Props {
  /** Selects + scrolls to a task and routes to the schedule (owned by TopBar). */
  onTaskNavigate: (id: string) => void;
}

interface BadgeTaskItem {
  id: string;
  wbs: string;
  name: string;
}

// Forecast dates are formatted in UTC (the server emits MC percentile dates as
// UTC ISO strings). Local-zone formatting drifts a calendar day west of UTC,
// which is what made the shell header disagree with the schedule bar (ADR-0144).
const formatForecastDate = fmtUtcShort;

// The velocity number is audience-scoped (ADR-0104). Even when the viewer is in
// audience, the slot surfaces this boundary so teams trust the figure isn't piped
// up to portfolio/PMO surfaces (issue 1197 — Morgan's trust ask).
const VELOCITY_PRIVACY_NOTE = 'Visible to project members only — not on portfolio dashboards';

// Inline padlock glyph for the ADR-0104 velocity privacy wall (rule 168). No
// LockIcon exists in the icon set; this is decorative (aria-hidden) — the gate is
// named in the segment's aria-label.
function LockGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="w-3 h-3" fill="currentColor" aria-hidden="true">
      <path d="M8 1a3 3 0 0 0-3 3v2H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1V4a3 3 0 0 0-3-3Zm-1.5 5V4a1.5 1.5 0 0 1 3 0v2h-3Z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Task-list popover — the at-risk / critical segments open a role="menu" list of
// the offending tasks. Mirrors BadgePopover's a11y (used by the sidebar); kept
// local so the cluster reads as one bordered unit, not nested bordered pills.
// ---------------------------------------------------------------------------

interface SegmentPopoverProps {
  triggerLabel: string;
  ariaLabel: string;
  variant: 'at-risk' | 'critical';
  icon: ReactNode;
  count: number;
  items: BadgeTaskItem[];
  onItemClick: (id: string) => void;
}

const MAX_VISIBLE = 5;

function SegmentPopover({
  triggerLabel,
  ariaLabel,
  variant,
  icon,
  count,
  items,
  onItemClick,
}: SegmentPopoverProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const colorClass = variant === 'critical' ? 'text-semantic-critical' : 'text-semantic-at-risk';
  const visible = items.slice(0, MAX_VISIBLE);
  const overflow = count - visible.length;

  // Zero is a calm static read (no drill-down target) — not a dead button.
  if (count === 0) {
    return (
      <span className={CELL + ' text-neutral-text-secondary'} aria-label={ariaLabel}>
        <span aria-hidden="true">{icon}</span>
        {triggerLabel}
      </span>
    );
  }

  return (
    <div ref={wrapperRef} className="relative flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={[
          'flex items-center gap-1.5 px-2.5 h-full text-xs font-medium',
          count > 0 ? colorClass : 'text-neutral-text-secondary',
          'hover:bg-neutral-surface-raised',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset',
        ].join(' ')}
    >
        <span aria-hidden="true">{icon}</span>
        {triggerLabel}
      </button>

      {open && count > 0 && (
        <div
          role="menu"
          aria-label={ariaLabel}
          className="absolute top-full right-0 mt-1 z-50 min-w-[200px] bg-neutral-surface border border-neutral-border rounded-card p-1"
        >
          {visible.map((item) => (
            <button
              key={item.id}
              role="menuitem"
              type="button"
              onClick={() => {
                onItemClick(item.id);
                setOpen(false);
              }}
              className={[
                'w-full text-left px-2 py-1.5 rounded-control text-xs',
                colorClass,
                'hover:bg-neutral-surface-raised',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset',
              ].join(' ')}
            >
              <span className="text-neutral-text-secondary mr-1">{item.wbs}</span>
              {item.name}
            </button>
          ))}
          {overflow > 0 && (
            <div role="presentation" className="px-2 py-1.5 text-xs text-neutral-text-secondary">
              +{overflow} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Segment renderers — one bordered cell each. Buttons carry the rule-4 ring
// (inset, since they sit inside the bordered container). Static cells are plain.
// ---------------------------------------------------------------------------

const CELL = 'flex items-center gap-1.5 px-2.5 h-full text-xs whitespace-nowrap';
const CELL_BTN =
  CELL +
  ' hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset';

function Divider() {
  return <span aria-hidden="true" className="self-center h-4 w-px bg-neutral-border" />;
}

interface SegmentProps {
  segment: HealthSegment;
  iterationSingular: string;
  iterationLower: string;
  onOpenForecast: () => void;
  onGoToSprints: () => void;
  onTaskNavigate: (id: string) => void;
}

function Segment({
  segment,
  iterationSingular,
  iterationLower,
  onOpenForecast,
  onGoToSprints,
  onTaskNavigate,
}: SegmentProps) {
  switch (segment.kind) {
    case 'forecast': {
      if (segment.p80 == null) {
        return (
          <span className={CELL} title="Forecast unavailable — run the scheduler">
            <span className="text-neutral-text-secondary">P80</span>
            <span className="text-neutral-text-disabled">—</span>
          </span>
        );
      }
      // Surface the P50·P80 band (issue 1197) — Janet's "binary forecast" is a hard-NO; the
      // MC engine already computes both percentiles. P50 is null only when no MC
      // distribution is cached, in which case the slot degrades to P80 alone.
      const p50 = segment.p50;
      const ariaLabel =
        p50 != null
          ? `Monte Carlo forecast: P50 ${formatForecastDate(p50)}, P80 ${formatForecastDate(segment.p80)}. View distribution.`
          : `Monte Carlo P80 completion ${formatForecastDate(segment.p80)}. View distribution.`;
      return (
        <button
          type="button"
          onClick={onOpenForecast}
          aria-haspopup="dialog"
          aria-label={ariaLabel}
          className={CELL_BTN}
        >
          {p50 != null && (
            <>
              <span className="text-neutral-text-secondary">P50</span>
              <span className="tppm-mono text-neutral-text-primary">{formatForecastDate(p50)}</span>
              <span aria-hidden="true" className="text-neutral-text-disabled">·</span>
            </>
          )}
          <span className="text-neutral-text-secondary">P80</span>
          <span className="tppm-mono text-neutral-text-primary">{formatForecastDate(segment.p80)}</span>
        </button>
      );
    }

    case 'atRisk':
      return (
        <SegmentPopover
          variant="at-risk"
          icon={<WarningIcon aria-hidden="true" />}
          triggerLabel={`${segment.count} at risk`}
          ariaLabel={`${segment.count} at-risk task${segment.count === 1 ? '' : 's'}`}
          count={segment.count}
          items={segment.items}
          onItemClick={onTaskNavigate}
        />
      );

    case 'critical':
      return (
        <SegmentPopover
          variant="critical"
          icon={<CriticalDotIcon aria-hidden="true" />}
          triggerLabel={`${segment.count} critical`}
          ariaLabel={`${segment.count} critical task${segment.count === 1 ? '' : 's'}`}
          count={segment.count}
          items={segment.items}
          onItemClick={onTaskNavigate}
        />
      );

    case 'sprint':
      return (
        <button
          type="button"
          onClick={onGoToSprints}
          aria-label={`${segment.name}, day ${segment.dayN} of ${segment.dayM}. View ${iterationLower}s.`}
          className={CELL_BTN}
        >
          <span className="text-neutral-text-primary font-medium">{segment.name}</span>
          <span className="tppm-mono text-neutral-text-secondary">
            Day {segment.dayN}/{segment.dayM}
          </span>
        </button>
      );

    case 'sprintEmpty':
      return (
        <button
          type="button"
          onClick={onGoToSprints}
          aria-label={`No active ${iterationLower}. View ${iterationLower}s.`}
          className={CELL_BTN}
        >
          <span className="text-neutral-text-secondary">No active {iterationSingular}</span>
        </button>
      );

    case 'points':
      return (
        <span
          className={CELL}
          aria-label={`${segment.completed} of ${segment.committed} ${
            segment.unit === 'pts' ? 'points' : 'items'
          } completed`}
        >
          <span className="tppm-mono text-neutral-text-primary">
            {segment.completed}/{segment.committed}
          </span>
          <span className="text-neutral-text-secondary">{segment.unit}</span>
        </span>
      );

    case 'velocityGated':
      return (
        <span
          className={CELL + ' text-neutral-text-secondary'}
          aria-label={`Team ${iterationLower} velocity is kept private to the team`}
        >
          <LockGlyph />
          Kept to the team
        </span>
      );

    case 'velocity': {
      if (segment.avg == null) {
        return (
          <span className={CELL} title="Not enough closed-sprint history yet">
            <span className="text-neutral-text-secondary">Velocity</span>
            <span className="text-neutral-text-disabled">—</span>
          </span>
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
          className={CELL_BTN}
        >
          {/* Lock = the audience boundary on the in-audience figure (issue 1197). Decorative;
              the boundary text lives in the button's aria-label + title. */}
          <span className="text-neutral-text-secondary">
            <LockGlyph />
          </span>
          <span className="text-neutral-text-secondary">Velocity</span>
          <span className="tppm-mono text-neutral-text-primary">
            {segment.avg} pts/{iterationLower}
          </span>
          {segment.excluded > 0 && (
            <span className="text-neutral-text-secondary">· {segment.excluded} excl</span>
          )}
        </button>
      );
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Collapsed (< lg) menu — rule 109. One "Health ▾" button expanding the same
// segments as read rows; at-risk / critical rows expose their tasks as menuitems.
// ---------------------------------------------------------------------------

interface CollapsedProps {
  segments: HealthSegment[];
  iterationSingular: string;
  iterationLower: string;
  onTaskNavigate: (id: string) => void;
}

function segmentSummary(
  segment: HealthSegment,
  iterationSingular: string,
  iterationLower: string,
): string {
  switch (segment.kind) {
    case 'forecast':
      if (segment.p80 == null) return 'P80: — (run the scheduler)';
      return segment.p50 != null
        ? `P50 ${formatForecastDate(segment.p50)} · P80 ${formatForecastDate(segment.p80)}`
        : `P80: ${formatForecastDate(segment.p80)}`;
    case 'atRisk':
      return `${segment.count} at-risk task${segment.count === 1 ? '' : 's'}`;
    case 'critical':
      return `${segment.count} critical task${segment.count === 1 ? '' : 's'}`;
    case 'sprint':
      return `${segment.name} · Day ${segment.dayN}/${segment.dayM}`;
    case 'sprintEmpty':
      return `No active ${iterationSingular}`;
    case 'points':
      return `${segment.completed}/${segment.committed} ${segment.unit}`;
    case 'velocityGated':
      return `Velocity kept to the team`;
    case 'velocity':
      return segment.avg == null
        ? 'Velocity: —'
        : `Velocity ${segment.avg} pts/${iterationLower} · members only`;
    default:
      return '';
  }
}

function CollapsedHealth({
  segments,
  iterationSingular,
  iterationLower,
  onTaskNavigate,
}: CollapsedProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  return (
    <div ref={wrapperRef} className="lg:hidden relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Project health summary"
        className="flex items-center gap-1 h-6 px-2 rounded-control border border-neutral-border text-[12px] font-medium text-neutral-text-secondary
          hover:bg-neutral-surface-raised
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        Health <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Project health summary"
          className="absolute top-full right-0 mt-1 z-50 min-w-[220px] bg-neutral-surface border border-neutral-border rounded-card p-1"
        >
          {segments.map((segment, i) => {
            const summary = segmentSummary(segment, iterationSingular, iterationLower);
            const tasks =
              segment.kind === 'atRisk' || segment.kind === 'critical' ? segment.items : [];
            const color =
              segment.kind === 'critical'
                ? 'text-semantic-critical'
                : segment.kind === 'atRisk'
                  ? 'text-semantic-at-risk'
                  : 'text-neutral-text-primary';
            return (
              <div role="presentation" key={`${segment.kind}-${i}`}>
                <div role="presentation" className={`px-2 py-1.5 text-xs ${color}`}>
                  {summary}
                </div>
                {tasks.slice(0, MAX_VISIBLE).map((item) => (
                  <button
                    key={item.id}
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      onTaskNavigate(item.id);
                      setOpen(false);
                    }}
                    className={`w-full text-left px-2 py-1.5 rounded-control text-xs ${color}
                      hover:bg-neutral-surface-raised
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset`}
                  >
                    <span className="text-neutral-text-secondary mr-1">{item.wbs}</span>
                    {item.name}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * v2 methodology-adaptive health cluster (ADR-0128 §B). One bordered,
 * segmented cluster that replaces the three free-floating TopBar badges. The
 * three segments adapt to the project methodology; the velocity/points segments
 * respect the ADR-0104 privacy gate and never render a number when suppressed.
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
  const { data: mcResult } = useMonteCarloResult(projectId ?? undefined);
  const navigate = useNavigate();
  const onSettingsRoute = useMatch('/projects/:projectId/settings/*');
  const [showMCPanel, setShowMCPanel] = useState(false);

  // Project-scoped chrome; suppressed on project settings routes (rule 123 — the
  // SettingsShell carries its own chrome). The `useProjectId()` null path already
  // covers My Work / Inbox / Portfolio / Program / workspace settings.
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

  function goToSprints() {
    void navigate(`/projects/${projectId}/${'sprints'}`);
  }

  return (
    <>
      {/* Full cluster — lg+ */}
      <div
        role="group"
        aria-label="Project health"
        data-testid="health-cluster"
        className="hidden lg:flex items-stretch h-7 rounded-control border border-neutral-border overflow-hidden"
      >
        {segments.map((segment, i) => (
          <div key={`${segment.kind}-${i}`} className="flex items-stretch">
            {i > 0 && <Divider />}
            <Segment
              segment={segment}
              iterationSingular={iteration.singular}
              iterationLower={iteration.lower}
              onOpenForecast={() => setShowMCPanel(true)}
              onGoToSprints={goToSprints}
              onTaskNavigate={onTaskNavigate}
            />
          </div>
        ))}
      </div>

      {/* Collapsed dropdown — below lg (rule 109) */}
      <CollapsedHealth
        segments={segments}
        iterationSingular={iteration.singular}
        iterationLower={iteration.lower}
        onTaskNavigate={onTaskNavigate}
      />

      {/* MC distribution panel — opened by the Forecast segment (issue 196) */}
      {showMCPanel && mcResult && (
        <MCResultPanel result={mcResult} onClose={() => setShowMCPanel(false)} />
      )}
    </>
  );
}
