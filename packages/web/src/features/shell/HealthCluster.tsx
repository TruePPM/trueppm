import { useState, useRef, useEffect, useCallback, useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useMatch, useLocation } from 'react-router';
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
import { addedTimeChipContext } from './addedTimeChip';
import { addedTimeChipForm, RIGHT_CLUSTER_MAX_SIBLINGS } from './addedTimeChipFit';
import {
  ADDED_TIME_LABEL,
  addedTimePresentation,
  addedTimeShortForm,
  addedTimeSpokenHeadline,
  formatEndpoint,
  type AddedTimePresentation,
  type AddedTimeShortForm,
} from '@/features/project/addedTime';
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

// Popover positioning constants (web-rule 253). The panel is portaled to
// document.body and positioned `fixed` from the chip's rect: an in-flow
// `absolute right-0` panel grows leftward from the trigger, which clips off the
// left viewport edge on a phone where the chip sits mid-bar (#1969).
const POPOVER_MIN_WIDTH = 260;
const POPOVER_GAP = 4;
const VIEWPORT_MARGIN = 8;

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

/** Forecast band — a P50 row + a P80 row (the P50·P80 band, ADR-0144/0175), never
 *  a single percentile. Always neutral (rule 172), even inside a red chip. */
function ForecastRows({
  segment,
  canOpenForecast,
  onOpenForecast,
}: {
  segment: Extract<HealthSegment, { kind: 'forecast' }>;
  canOpenForecast: boolean;
  onOpenForecast: () => void;
}): ReactNode {
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
          className={p50Text ? 'tppm-mono text-neutral-text-primary' : 'text-neutral-text-disabled'}
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

/** The active-sprint jump row (folded-in CurrentSprintButton, #1680) plus other
 *  teams' sprint rows. Falls back to the sprints list until the board path
 *  resolves so the primary row is never dead. */
function SprintRows({
  segment,
  iterationLower,
  inContextBoardPath,
  crossTeamTargets,
  onGoToSprints,
  onJumpToBoard,
}: {
  segment: Extract<HealthSegment, { kind: 'sprint' }>;
  iterationLower: string;
  inContextBoardPath: string | null;
  crossTeamTargets: SprintJumpTarget[];
  onGoToSprints: () => void;
  onJumpToBoard: (path: string) => void;
}): ReactNode {
  return (
    <>
      <button
        type="button"
        onClick={() => (inContextBoardPath ? onJumpToBoard(inContextBoardPath) : onGoToSprints())}
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
}

/** The no-active-sprint row: routes to the sprints list, with other teams' active
 *  sprints still reachable as jump rows below. */
function SprintEmptyRows({
  iterationSingular,
  iterationLower,
  crossTeamTargets,
  onGoToSprints,
  onJumpToBoard,
}: {
  iterationSingular: string;
  iterationLower: string;
  crossTeamTargets: SprintJumpTarget[];
  onGoToSprints: () => void;
  onJumpToBoard: (path: string) => void;
}): ReactNode {
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
}

/** Committed-vs-completed points/items row for the active sprint. */
function PointsRow({ segment }: { segment: Extract<HealthSegment, { kind: 'points' }> }): ReactNode {
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
}

/** ADR-0104 / rule 168: content-free velocity privacy wall — no number ever rendered. */
function VelocityGatedRow({ iterationLower }: { iterationLower: string }): ReactNode {
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
}

/** In-audience velocity figure with its ADR-0104 audience-boundary padlock. Renders
 *  a calm em-dash read until there is enough closed-sprint history. */
function VelocityRow({
  segment,
  iterationLower,
  onGoToSprints,
}: {
  segment: Extract<HealthSegment, { kind: 'velocity' }>;
  iterationLower: string;
  onGoToSprints: () => void;
}): ReactNode {
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

/**
 * The added-time clause appended to the chip's `aria-label`.
 *
 * Two templates rather than one, because `addedTimeSpokenHeadline` returns two shapes:
 * `"11 days added"` needs its baseline named, while `"4 days earlier than the computed
 * finish"` is already a complete sentence and would read broken with one appended. A
 * generic `", added time ${spoken}"` prefix was the other option and yields "added time
 * 11 days added".
 *
 * `notRun` contributes nothing — the forecast clause immediately before it already
 * says "forecast not run", and a second one is noise.
 */
function addedTimeAriaClause(presentation: AddedTimePresentation | null): string {
  if (presentation === null || presentation.state === 'notRun') return '';
  if (presentation.state === 'unmeasurable') return ', added time needs estimates';

  const { headline } = presentation;
  const spoken = addedTimeSpokenHeadline(headline);
  // "11 days added" needs the baseline named; "4 days earlier than the computed
  // finish" already names it; "No added time" is a complete read on its own.
  const core =
    spoken === headline
      ? spoken.toLowerCase()
      : headline.startsWith('+')
        ? `${spoken} versus the computed finish`
        : spoken;
  const asOf =
    presentation.state === 'stale' && presentation.asOf
      ? `, from a forecast as of ${formatEndpoint(presentation.asOf, presentation.asOf)}`
      : '';
  return `, ${core}${asOf}`;
}

/**
 * "Added time" — the gap between the computed finish and the P80 commit (#2531).
 *
 * A static row, not a button. Every other actionable row in this popover closes it
 * and navigates; added time is an advisory the reader glanced at on their way
 * somewhere else, and yanking them off Board to satisfy it would cost more than it
 * gives. The Forecast P80 row directly above already offers `Details ›` into the
 * distribution, and Overview carries the full card.
 *
 * The delta always names its baseline here (`+11d vs Oct 24`). The popover renders
 * `Forecast P80` but nothing anywhere carries the *computed* finish, so a bare `+11d`
 * inside this dialog would be a delta with no visible reference — the #2426 defect.
 *
 * No band, no proportion track, and no as-of stamp except in the one state where the
 * stamp is the point (A3): a stale premium without its date is an old verdict wearing
 * a current one's clothes.
 */
function AddedTimeRows({ presentation }: { presentation: AddedTimePresentation }): ReactNode {
  const label = <span className="text-neutral-text-secondary">{ADDED_TIME_LABEL}</span>;

  if (presentation.state === 'notRun') {
    return (
      <div className={ROW}>
        {label}
        {/* Words, not a dash: the two forecast rows above already render "—", and a
            third would read as one more missing number rather than a state. */}
        <span className="text-neutral-text-secondary">Not run yet</span>
      </div>
    );
  }

  if (presentation.state === 'unmeasurable') {
    return (
      <div className={ROW}>
        {label}
        {/* A4, verbatim and lowercase — the same literal the chip fragment and the
            mobile card render, so the three cannot drift and one assertion covers all
            of them. Never "0d", never an em dash. */}
        <span className="text-neutral-text-secondary">needs estimates</span>
      </div>
    );
  }

  const { headline, endpoints, asOf, state } = presentation;
  const cpmShort = formatEndpoint(endpoints.cpmFinish, endpoints.cpmFinish);
  const spoken = addedTimeSpokenHeadline(headline);

  if (spoken === headline) {
    // A worded headline ("No added time") reads correctly as-is, so it renders once —
    // an sr-only twin would announce it twice for no gain.
    return (
      <div className={ROW}>
        {label}
        <span className="text-neutral-text-primary">{headline}</span>
      </div>
    );
  }

  const value = (
    <>
      <span aria-hidden="true">{`${headline} vs ${cpmShort}`}</span>
      {/* Some screen readers drop the "−" from "−4d", which inverts the finding from
          "finishing early" to "finishing late" (rule 6). */}
      <span className="sr-only">{`${spoken}, versus the computed finish ${cpmShort}`}</span>
    </>
  );

  if (state === 'stale') {
    const asOfShort = asOf ? formatEndpoint(asOf, asOf) : null;
    return (
      // Two-line, so `ROW`'s `items-center` cannot be reused. The stamp sits under the
      // label rather than beside the value: a single line would run ~300px and the
      // popover clamps to 100vw−1rem, which is 304px on the narrowest phone — the one
      // width at which this row is the *only* carrier of the value.
      <div className="flex items-start justify-between gap-3 px-2 py-1.5 text-xs whitespace-nowrap">
        <span className="flex flex-col items-start">
          {label}
          {asOfShort && (
            <span className="text-neutral-text-secondary">as of {asOfShort}</span>
          )}
        </span>
        <span className="tppm-mono text-neutral-text-secondary underline decoration-dotted underline-offset-4">
          <span aria-hidden="true">{`${headline} vs ${cpmShort}`}</span>
          <span className="sr-only">
            {`${spoken}, versus the computed finish ${cpmShort}${
              asOfShort ? `, from a forecast as of ${asOfShort}` : ''
            }`}
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className={ROW}>
      {label}
      <span className="tppm-mono text-neutral-text-primary">{value}</span>
    </div>
  );
}

/** Dispatches a single health segment to its row renderer. Forecast expands to a
 *  P50 + P80 band (ADR-0144/0175); at-risk/critical drill; sprint/points/velocity
 *  render their agile reads with the ADR-0104 velocity privacy wall honored. */
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
    case 'forecast':
      return (
        <ForecastRows
          segment={segment}
          canOpenForecast={canOpenForecast}
          onOpenForecast={onOpenForecast}
        />
      );

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
      return (
        <SprintRows
          segment={segment}
          iterationLower={iterationLower}
          inContextBoardPath={inContextBoardPath}
          crossTeamTargets={crossTeamTargets}
          onGoToSprints={onGoToSprints}
          onJumpToBoard={onJumpToBoard}
        />
      );

    case 'sprintEmpty':
      return (
        <SprintEmptyRows
          iterationSingular={iterationSingular}
          iterationLower={iterationLower}
          crossTeamTargets={crossTeamTargets}
          onGoToSprints={onGoToSprints}
          onJumpToBoard={onJumpToBoard}
        />
      );

    case 'points':
      return <PointsRow segment={segment} />;

    case 'velocityGated':
      return <VelocityGatedRow iterationLower={iterationLower} />;

    case 'velocity':
      return (
        <VelocityRow segment={segment} iterationLower={iterationLower} onGoToSprints={onGoToSprints} />
      );

    case 'addedTime':
      return <AddedTimeRows presentation={segment.presentation} />;

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
  const {
    data: mcResult,
    isLoading: mcLoading,
    error: mcError,
  } = useMonteCarloResult(projectId ?? undefined);
  const navigate = useNavigate();
  const location = useLocation();
  const onSettingsRoute = useMatch('/projects/:projectId/settings/*');

  const [open, setOpen] = useState(false);
  const [showMCPanel, setShowMCPanel] = useState(false);
  // Portaled-panel fixed coords (web-rule 253); null until measured (#1969).
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Focus trap on the popover panel (rule 206): moves focus in on open, wraps
  // Tab, routes Escape to close, and restores focus to the chip trigger on close.
  const dialogRef = useFocusTrap<HTMLDivElement>(open, () => setOpen(false));

  // Position the portaled panel below the chip, right-aligned to it, but clamped
  // so it never leaves the viewport — on a phone the chip sits mid-bar, so a
  // right-anchored panel would clip off the left edge (#1969). Width is read from
  // the already-rendered panel so the clamp accounts for its real (content) width.
  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    // `offsetWidth` is 0 for an element that has not laid out yet (first open,
    // before the portal paints), so a zero here means "no measurement", exactly
    // like an absent ref — both fall back to the min width. Written as an explicit
    // zero test rather than `||` because `??` would keep the 0 and collapse the
    // panel, and `||` no longer expresses which falsy value is being caught.
    const measured = dialogRef.current?.offsetWidth ?? 0;
    const width = measured === 0 ? POPOVER_MIN_WIDTH : measured;
    setPos({
      top: rect.bottom + POPOVER_GAP,
      left: Math.max(
        VIEWPORT_MARGIN,
        Math.min(rect.right - width, window.innerWidth - width - VIEWPORT_MARGIN),
      ),
    });
  }, [dialogRef]);

  // Measure + place on open (pre-paint, so the panel never flashes at 0,0), clear
  // on close.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    reposition();
  }, [open, reposition]);

  // A fixed popover can't track its anchor, so re-derive coords on scroll/resize.
  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  // Outside pointer-down closes the popover. The panel is portaled out of the
  // chip's wrapper (rule 253), so the check must span BOTH the trigger and the
  // portaled panel; a click on the chip is "inside" and toggles via its own
  // onClick rather than double-firing a close-then-reopen.
  useEffect(() => {
    if (!open) return undefined;
    function onMouseDown(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || dialogRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open, dialogRef]);

  // Project-scoped chrome; suppressed on project settings routes (rule 123 — the
  // SettingsShell carries its own chrome). The `useProjectId()` null path already
  // covers My Work / Notifications / Portfolio / Program / workspace settings.
  if (!projectId || onSettingsRoute) return null;

  // ── Added time (#2531) ────────────────────────────────────────────────────
  // Suppressed on Overview, which mounts `AddedTimeCard` — one value, one render
  // per screen (rule 284) — and while the forecast query is in flight or errored.
  // That second gate matters: an undefined premium maps to `notRun`, so without it
  // a loading project would assert "Not run yet" about a forecast it has, which is
  // worse than saying nothing.
  const addedTimeCtx = addedTimeChipContext(location.pathname);
  const addedTime: AddedTimePresentation | null =
    addedTimeCtx.suppressed || mcLoading || mcError !== null
      ? null
      : addedTimePresentation(mcResult?.riskPremium);

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
    addedTime,
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
  // The chip is a button with an aria-label, so its inner text is suppressed for
  // assistive tech — anything not in this string does not exist to a screen reader.
  // The clause therefore tracks the *popover row*, not the CSS-hidden fragment: the
  // value is available at every width, exactly as the P80 clause already is.
  chipAria += addedTimeAriaClause(addedTime);

  // The inline fragment. Held to the methodologies whose cluster carries a forecast at
  // all — an added-time read is a forecast derivative, so a chip with no forecast must
  // not carry one — then budget-gated. `null` from the budget means *drop*, never
  // "render the shorter form": an unqualified number on a surface with no computed
  // finish on screen is a delta the reader cannot check, which is worse than silence.
  // Dropping costs nothing, because the popover row below still carries the value.
  //
  // `window.innerWidth` is read inline rather than subscribed to: the CSS `xl:` gate
  // owns the only boundary that matters, so a width that is one resize stale can never
  // show a form the layout cannot hold. Element measurement is deliberately avoided
  // (see addedTimeChipFit) so this cannot fight the cluster's container rules.
  const addedTimeForm =
    addedTime && forecastSeg && !addedTimeCtx.suppressed && addedTimeCtx.fragment
      ? addedTimeChipForm({
          viewportWidth: window.innerWidth,
          siblingCount: RIGHT_CLUSTER_MAX_SIBLINGS,
          baselineOnScreen: addedTimeCtx.baselineOnScreen,
          hasP80Fragment: true,
        })
      : null;
  const addedTimeShort: AddedTimeShortForm =
    addedTime && addedTimeForm
      ? addedTimeShortForm(addedTime, { qualified: addedTimeForm === 'qualified' })
      : null;
  const addedTimeIsValue =
    addedTimeShort?.kind === 'number' || addedTimeShort?.kind === 'qualified';

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
    <div className="relative">
      {/* Status chip trigger — all-width (no md:flex / md:hidden split). The
          data-testid stays on the trigger: e2e locates the surface by it. */}
      <button
        ref={triggerRef}
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
            className="hidden md:inline-flex items-center gap-1 text-neutral-text-secondary"
            title="Run the scheduler"
          >
            <span>P80</span>
            <span>—</span>
          </span>
        )}
        {addedTimeShort && (
          // Trailing, immediately before the caret: this is the only element on the
          // chip that disappears by width budget, so at the edge its absence leaves
          // no hole for the rest of the chip to reflow around. It also reads in the
          // right order — verdict, then the commitment, then the gap the commitment
          // buys over the plan, which cannot be understood before the commitment it
          // is measured from.
          //
          // Neutral ink only. The chip's state word may be critical red; the fragment
          // never inherits it, because a fourth colored signal in this bar would turn
          // it into a wall where nothing is loudest (S1, rule 172).
          // `xl` (1280) rather than the P80 fragment's `md`: it is the first band at
          // which `addedTimeChipForm` returns anything, so the CSS gate and the budget
          // agree instead of the CSS revealing a form the budget rejected. `ml-1`
          // separates the two fragments — at 12px the chip's `gap-1.5` is only 2px
          // wider than each fragment's internal `gap-1`, so without it `P80 · Nov 4 ·
          // Added · +11d` reads as one four-part run.
          <span className="hidden xl:inline-flex items-center gap-1 ml-1">
            {/* The label is the boundary marker — the chip carries no separator glyph,
                and `Added` plays the part `P80` plays for the date beside it. Omitted
                for the worded states, where "Added needs estimates" is not English. */}
            {addedTimeIsValue && <span className="text-neutral-text-secondary">Added</span>}
            <span
              className={
                addedTimeIsValue
                  ? 'tppm-mono text-neutral-text-primary'
                  : 'text-neutral-text-secondary'
              }
            >
              {addedTimeShort.text}
            </span>
          </span>
        )}
        <span aria-hidden="true" className="text-neutral-text-secondary">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {/* Health popover — portaled to document.body and positioned `fixed` so it
          clamps to the viewport instead of clipping off the left edge on a phone
          (web-rule 253, #1969). Pop-surface exception to rule 1 (shadow-pop). It
          renders before `pos` is measured (opacity-0) so useLayoutEffect can read
          its width; the measure→place is pre-paint, so it never flashes. */}
      {open &&
        createPortal(
          <div
            ref={dialogRef}
            role="dialog"
            aria-label="Project health"
            tabIndex={-1}
            style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0 }}
            className={`z-50 min-w-[260px] max-w-[calc(100vw-1rem)] max-h-[calc(100vh-4.5rem)] overflow-y-auto rounded-card shadow-pop border border-neutral-border bg-neutral-surface p-1.5 focus:outline-none ${
              pos ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
          >
            {/* Header — worst-state dot + word, same read as the chip. */}
            <div className="flex items-center gap-2 px-2 py-1.5 mb-1 border-b border-neutral-border">
              <span
                aria-hidden="true"
                className={`inline-block w-2 h-2 rounded-full ${chip.dotClass}`}
              />
              <span className={`text-xs font-medium ${chip.wordClass}`}>{chip.word}</span>
            </div>

            {segments.map((segment) => (
              <SegmentRows
                // Keyed on `kind` alone, not on the index: a cluster never carries
                // two segments of the same kind, and the added-time segment is
                // spliced in mid-list once the forecast query resolves — an index
                // key would renumber every row after it and remount them, dropping
                // keyboard focus if the popover happened to be open.
                key={segment.kind}
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
          </div>,
          document.body,
        )}

      {/* MC distribution panel — opened by the Forecast P80 "Details ›" row (issue 196) */}
      {showMCPanel && mcResult && (
        <MCResultPanel result={mcResult} onClose={() => setShowMCPanel(false)} />
      )}
    </div>
  );
}
