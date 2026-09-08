import { useState, useRef, useEffect, useCallback, useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useMatch, useLocation } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useProjectUnavailable } from '@/hooks/useProjectUnavailable';
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
import { QueryErrorState } from '@/components/QueryErrorState';
import { REPORTED_HEALTH_TITLE } from '@/features/project/projectHealth';
import { HEALTH_BAND_LABEL, type HealthBand } from '@/lib/healthBand';
import type { HealthBandSource } from '@/types';

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
// Chip state word — the SERVER's band, read off `status-summary`'s `health_band`
// (`useShellStats`), NOT derived here and NOT taken from the methodology segment
// set. `status-summary` carries the band for every methodology, so an Agile
// project whose cluster shows Sprint/Points/Velocity still reads "Critical" on
// the chip when the project is critical (rule 6 — the WORD is the non-color
// signal; the dot only reinforces it).
//
// The chip must NOT re-derive the band from `at_risk_count` / `critical_count`:
// those counts cannot see the manual `Project.health` override, so a chip that
// computed its own band printed "On track" over a project whose PM had reported
// it Critical, and disagreed with the my-projects triage list about the same
// project (#3501). The server folds the override in; this component prints it.
//
// The word is the SERVER band word (`HEALTH_BAND_LABEL`), never a chip-private
// synonym. The chip used to render "At risk" for the critical band and
// "On watch" for the at-risk band, so the top bar disagreed with the page
// beneath it on the same project and "On watch" existed nowhere else in the
// product (#3470). A task-count nuance belongs in the popover rows below, not
// in the word.
// ---------------------------------------------------------------------------

interface ChipState {
  band: HealthBand;
  word: string;
  /** Word color: semantic for at-risk/critical; neutral for on-track (the dot
   *  carries the on-track color so the word stays a calm non-color signal, rule 6). */
  wordClass: string;
  dotClass: string;
}

const CHIP_WORD_CLASS: Record<HealthBand, string> = {
  critical: 'text-semantic-critical',
  at_risk: 'text-semantic-at-risk',
  on_track: 'text-neutral-text-secondary',
};

const CHIP_DOT_CLASS: Record<HealthBand, string> = {
  critical: 'bg-semantic-critical',
  at_risk: 'bg-semantic-at-risk',
  on_track: 'bg-semantic-on-track',
};

function deriveChipState(band: HealthBand): ChipState {
  return {
    band,
    word: HEALTH_BAND_LABEL[band],
    wordClass: CHIP_WORD_CLASS[band],
    dotClass: CHIP_DOT_CLASS[band],
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
// Two-line row button — the shape `CrossTeamSprintRows` already uses inline,
// named so the provenance row and it cannot drift apart. `ROW`'s single-line
// label/value grid cannot hold the provenance copy: at the popover's 260px floor
// "Reported by the project manager  Update on Overview ›" runs ~290px against a
// `max-w-[calc(100vw-1rem)]` clamp that is 304px on the narrowest phone. It is
// the same width argument `AddedTimeRows`' stale branch makes, and it is why
// there is no `whitespace-nowrap` here — a longer locale must wrap, not clip.
// `focus:` and not `focus-visible:`: every row in this popover is reachable by
// the dialog's scripted focus trap, which browsers may decline to treat as
// visible (rule 288(c)).
const STACKED_BTN =
  'w-full flex flex-col items-start gap-0 px-2 py-1.5 text-xs rounded-control ' +
  'hover:bg-neutral-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset';

// The provenance line's copy. `Reported` leads because that is the word the
// project Dashboard's own chip already uses ("Reported: Critical"), so the two
// surfaces state one verdict in one vocabulary. The explanatory sentence is
// IMPORTED from that chip rather than retyped: a comment claiming two literals
// "cannot drift" holds nothing, where a shared constant makes a divergence a
// missing import (rule 395(a)).
const PROVENANCE_LABEL = 'Reported by the project manager';
// "View", not "Update": editing the report is Admin+, and a Member or Viewer
// offered "Update" follows it to a page whose dialog says "View only". The
// aria-label already said "see or change"; the visible line now agrees with it.
//
// "Dashboard", not "Overview" — the route segment is `/overview` (rule 108) but
// the project rail labels that view **Dashboard** (ADR-0942 §7), and "Overview"
// names only the PROGRAM rail's first view. Sending a reader to look for an
// "Overview" item they will not find is the dead end rule 403(b) exists to close.
const PROVENANCE_ACTION = 'View on Dashboard ›';

const PROVENANCE_ARIA =
  'This health is reported by the project manager, not computed from the rows ' +
  'below. Go to the project Dashboard to see or change the report.';

// The chip's no-value read. Not new copy — it is this file's own idiom, already
// used three times ("Forecast P50 —", "Velocity —", the chip's own "P80 —"), so
// it needs no learning.
//
// Widths measured in Chromium against the bundled Inter at `text-xs
// font-medium`, single-threaded on a private preview port (rule 397(c) — a
// sibling worktree's server on 4173 would silently measure another branch's
// bundle). The run reproduced 397(c)'s own three figures to the pixel, which is
// what makes the fourth trustworthy:
//
//   "On track"  48.73px   (the widest BAND word — not the worst severity)
//   "Critical"  40.55px
//   "At risk"   36.47px
//   "Health —"  53.44px   = 37.44 + 4 (`gap-1`) + 12.00
//
// So the shipped read is 4.70px wider than the widest band, inside the ~10px of
// compressible slack a 375px screen leaves. The rejected alternatives are not:
// "Health unavailable" (~96px) and "Unavailable" (~67px) both overflow it.
// "Unknown" would fit, but it is the word Overview prints for the REAL
// `schedule_health: unknown` server value, so on the chip it would read as a
// fourth band word (rule 397(a) / ADR-0126).
const HEALTH_UNAVAILABLE_WORD = 'Health';
const HEALTH_UNAVAILABLE_ARIA =
  "Project health unavailable — couldn't load the health summary. Open for details and retry.";
// `aria-describedby` target on the unavailable popover: the failure is then read
// WITH the dialog focus lands in, which works whether or not the live region
// fires (rule 335(a)).
const HEALTH_ERROR_MSG_ID = 'health-error-msg';

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
function PointsRow({
  segment,
}: {
  segment: Extract<HealthSegment, { kind: 'points' }>;
}): ReactNode {
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
          {asOfShort && <span className="text-neutral-text-secondary">as of {asOfShort}</span>}
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
        <VelocityRow
          segment={segment}
          iterationLower={iterationLower}
          onGoToSprints={onGoToSprints}
        />
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
 * The band-change announcer (WCAG 2.1 AA 4.1.3).
 *
 * The chip's word can now change because a person changed their mind — a PM
 * files a report and the top bar's verdict flips — with no focus move and no
 * navigation event to carry the news. So it needs a status message.
 *
 * Mounted UNCONDITIONALLY in every state (loading, unavailable, loaded) with
 * only its TEXT swapped: a `role="status"` node that mounts together with its own
 * content is announced inconsistently across assistive tech (rule 335), so a
 * region that appears only when there is something to say frequently says
 * nothing.
 *
 * Silent on first render — a band is news only when it CHANGES, and announcing
 * the initial value would fire on every project navigation — and silent in the
 * loading and unavailable states, which are not bands.
 */
function BandAnnouncer({ text }: { text: string }): ReactNode {
  return (
    <span role="status" aria-live="polite" className="sr-only" data-testid="health-announcer">
      {text}
    </span>
  );
}

/**
 * Chip-shaped skeleton for the first load of a project.
 *
 * `useShellStats` returns `data: undefined` for an in-flight query AND for a
 * failed one, and this component used to read neither flag — so a 5xx on
 * `status-summary` printed a calm "On track" over a project that might be
 * Critical, which is rule 301(d)'s reassuring-failure defect on the one surface
 * that is the only health reading on Schedule and Board (#3525). An absent value
 * renders NO value; it never falls back to the most reassuring word, and not to
 * `at_risk` either — there is no band here to be cautious *about*, and inventing
 * one is rule 397(b) re-derivation wearing a different hat.
 *
 * Width is DERIVED rather than pinned: the widest band label renders `invisible`
 * beneath the pulse, so the skeleton is exactly as wide as the widest band chip.
 * Measured in Chromium at `text-xs font-medium` (rule 397(c)): "On track"
 * 48.73px > "Critical" 40.55px > "At risk" 36.47px — the widest word is the calm
 * one, not the worst severity, which is the inversion 397(c) opens by warning
 * about.
 *
 * Be precise about what that buys, because the obvious stronger claim is false.
 * At PHONE width, where the P80 and added-time fragments are CSS-hidden, the
 * loading→loaded-with-a-band swap can only ever narrow the cluster, and
 * narrowing is free where widening is what pushes the account chip off a 375px
 * screen. It does NOT hold at `md:` (the chip gains "P80 {date}"), at `xl:` (it
 * gains "Added +11d"), or into the unavailable state at any width ("Health —" is
 * 53.44px, the widest of the four reads). Those three still need their own clip
 * check; this shim is not one.
 *
 * Decoration, not a control. A `<button disabled>` stays in the accessibility
 * tree and announces "Project health, button, dimmed", offering an affordance
 * that does not exist; there is nothing to explain yet, so this is `aria-hidden`
 * with no name, no role and no tab stop, and the popover cannot open.
 *
 * It deliberately does NOT carry `data-testid="health-cluster"`: two dozen specs
 * locate the surface by that id, and one of them measures its `boundingBox()` for
 * a phone-clip guard — a placeholder answering to it would report a clip-safe
 * width for a chip that never rendered, a green gate measuring the wrong element.
 * Playwright's auto-waiting then does the right thing for free.
 *
 * `motion-safe:` on the pulse, unlike the rail's `PinsPlaceholder`: that one is
 * transient, this is persistent top-bar chrome, and a permanent pulse is exactly
 * what a reduced-motion reader turns off.
 */
function LoadingChip(): ReactNode {
  return (
    <div
      aria-hidden="true"
      data-testid="health-cluster-loading"
      className="inline-flex items-center gap-1.5 h-[34px] rounded-full border border-neutral-border px-3 text-xs font-medium"
    >
      <span className="inline-block w-2 h-2 rounded-full bg-chrome-surface-raised motion-safe:animate-pulse" />
      <span className="relative inline-block">
        <span className="invisible">{HEALTH_BAND_LABEL.on_track}</span>
        <span className="absolute inset-x-0 inset-y-[3px] rounded bg-chrome-surface-raised motion-safe:animate-pulse" />
      </span>
      <span className="invisible">▾</span>
    </div>
  );
}

/**
 * The provenance line — rule 403(b), "name the source and route to it".
 *
 * Rendered only when the SERVER says the band came from a person
 * (`health_band_source === 'reported'`). Nothing here compares the band against
 * the at-risk / critical counts and nothing re-derives a band: rule 397(b)
 * deleted the client's ability to compute one, and a comparison would be that
 * rule broken by the back door — and wrong besides, since a report that agrees
 * with the counts is indistinguishable from no report at all.
 *
 * It never repeats the band word. The header one line above already prints it,
 * and a "Reported: Critical" form would state the same fact twice in adjacent
 * lines — and invite rendering the *other* value for contrast, which is exactly
 * the comparison this must not make. The row's only job is origin.
 *
 * Neutral ink, never the band color. Semantic hue belongs to the state itself,
 * not to metadata about the state (ADR-0126's one status vocabulary): a red note
 * under a red header reads as a second, independent health signal, and the
 * popover would carry two red things saying one thing.
 *
 * Two lines rather than `ROW_BTN`'s label/value grid — see `STACKED_BTN`.
 *
 * The destination is named "Overview", not "Update": editing the report is
 * Admin+, and Overview gates that itself. A Viewer who follows this row lands on
 * a page that shows the report and offers no editor, which the wording already
 * told them. The shell has no business carrying a second copy of that role rule.
 */
function ProvenanceRow({ onGoToOverview }: { onGoToOverview: () => void }): ReactNode {
  return (
    <button
      type="button"
      data-testid="health-provenance-row"
      onClick={onGoToOverview}
      aria-label={PROVENANCE_ARIA}
      title={REPORTED_HEALTH_TITLE}
      className={STACKED_BTN}
    >
      <span className="w-full text-left text-neutral-text-primary">{PROVENANCE_LABEL}</span>
      <span className="w-full text-left text-brand-primary">{PROVENANCE_ACTION}</span>
    </button>
  );
}

/**
 * The popover body when `status-summary` failed.
 *
 * The error card and NOTHING else — no header block, no provenance row, and
 * deliberately no methodology segment rows. `healthClusterModel` takes `stats` as
 * a whole-cluster input and three of its segment kinds degrade to confident
 * zeros when it is `undefined` (`At risk — 0 tasks`, `Critical path — 0 tasks`,
 * `Forecast P80 —`). Rendering those beneath a chip that has just said it could
 * not read the project's health would reproduce, one level down, the same
 * failure-as-good-news defect this change exists to fix.
 *
 * `QueryErrorState` rather than a hand-rolled banner (rule 246), `inline` rather
 * than `fill`: this is one widget on a still-working page, and `fill`'s assertive
 * alert for a chrome-scoped failure would interrupt the reader over a chip.
 * Retry re-runs just this request.
 */
function HealthErrorBody({ onRetry }: { onRetry: () => void }): ReactNode {
  return (
    <div id={HEALTH_ERROR_MSG_ID} data-testid="health-error">
      <QueryErrorState variant="inline" message="Couldn't load project health." onRetry={onRetry} />
    </div>
  );
}

/**
 * v2 methodology-adaptive project health surface (ADR-0128 §B, progressive
 * disclosure — issue 1644). A single all-width **status chip** shows the
 * project's band word (On track / At risk / Critical — the one health
 * vocabulary, rule 7 / ADR-0126) as the server decided it, a health dot, and an
 * optional P80 forecast fragment. Deliberately not "worst-state": the server's
 * `health_band` puts the PM's manual report ahead of the counts, so the word can
 * be BETTER than the worst signal in the rows below it (#3501). Clicking it opens a **health popover** whose
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
  // Same predicate `ProjectShell` renders `ProjectNotFound` on (#3469). The chip
  // is suppressed entirely here rather than repaired downstream, and that is
  // still right AFTER #3525 gave the component a real unavailable state: a 404 /
  // 403 means the route itself is about to render "This project isn't
  // available", so a "couldn't load project health" chip over it would be a
  // second and wrong explanation of the same fact. The two do not overlap —
  // this is the project read failing; the state below is `status-summary`
  // failing on a project the caller CAN open.
  const projectUnavailable = useProjectUnavailable(projectId);
  // `data` alone is NOT enough: it is `undefined` for an in-flight query and for a
  // failed one alike, so a component that destructures only `data` renders a 5xx
  // as whatever its fallback says — which here was the most reassuring word in the
  // vocabulary (rule 301(d), #3525). Read all three.
  const {
    data: stats,
    isLoading: statsLoading,
    error: statsError,
    refetch: refetchStats,
  } = useShellStats();

  // Derived here, above the hooks that consume it, rather than beside the render
  // branches it drives: `useFocusTrap` below takes `unavailable` as its focusKey,
  // and a hook cannot read a value computed after an early return.
  //
  // A band the client does not have is never printed. `statsError` is the 5xx;
  // the `undefined` band beside it catches a 200 whose body did not carry one
  // (an older server, a proxy, a test mock serving the wrong shape) — the same
  // "no value" outcome reached by a different door, and the failure direction is
  // identical, so it takes the same branch rather than falling through to a word.
  const band = stats?.healthBand;
  const unavailable = statsError !== null || band === undefined;
  const chip = band !== undefined ? deriveChipState(band) : null;
  const healthBandSource: HealthBandSource | undefined = stats?.healthBandSource;
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
  // Band-change announcement (WCAG 4.1.3).
  //
  // The memo carries its SUBJECT, not just the value (rule 407). `HealthCluster` is mounted
  // by the app shell and outlives any one project, so a ref holding only the last
  // band still holds project A's when project B's arrives — and a direct
  // project→project navigation (the rail switcher, ⌘K, My Work's worst-project
  // link, and this popover's own cross-team sprint rows) would announce "Project
  // health changed to Critical, reported by the project manager" about a project
  // the reader has merely arrived at. A `staleTime` hit serves B synchronously, so
  // there is not even a loading tick to mask it. Starting null prevents the
  // announcement once per MOUNT; the mount is what outlives the project.
  const lastBand = useRef<{ projectId: string; band: HealthBand } | null>(null);
  const [bandAnnouncement, setBandAnnouncement] = useState('');
  // Portaled-panel fixed coords (web-rule 253); null until measured (#1969).
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Focus trap on the popover panel (rule 206): moves focus in on open, wraps
  // Tab, routes Escape to close, and restores focus to the chip trigger on close.
  // `unavailable` is the focusKey (rule 245(a)): the popover is now a MULTI-STATE
  // dialog, and its two bodies share no focusable. A successful Retry unmounts the
  // button that currently holds focus and mounts the segment rows in its place
  // while `open` stays true — without a key the re-seat effect never re-runs,
  // focus falls to `<body>`, and Tab escapes to the page behind the dialog.
  const dialogRef = useFocusTrap<HTMLDivElement>(open, () => setOpen(false), unavailable);

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

  // Announce a band CHANGE, never the band itself.
  //
  // Three traps, each of which makes this read correctly while doing the wrong
  // thing. (1) `lastBand` is written AFTER the comparison — write it first and
  // nothing ever differs, so the region is permanently silent and every spec
  // asserting "no announcement on mount" still passes. (2) The absent branch does
  // NOT reset `lastBand`: clearing it would make every recovery from a 5xx
  // announce as a change, because the band coming back is then compared against
  // nothing rather than against the band that was on screen before the failure.
  // (3) …and (2) is exactly what would carry a STALE band across a project
  // switch, because a failure and a navigation are indistinguishable at that
  // check. The projectId in the memo is what separates them; without it the two
  // requirements are in direct conflict and the correct-looking one wins.
  useEffect(() => {
    const band = stats?.healthBand;
    if (band === undefined) {
      // Loading or failed — not a band, so there is nothing to announce and the
      // previously-known one must survive the gap.
      setBandAnnouncement('');
      return;
    }
    if (
      lastBand.current !== null &&
      lastBand.current.projectId === projectId &&
      lastBand.current.band !== band
    ) {
      // The source clause matters most here: a band that changed with no edit to
      // the plan is precisely the case a reader cannot otherwise account for.
      setBandAnnouncement(
        stats?.healthBandSource === 'reported'
          ? `Project health changed to ${HEALTH_BAND_LABEL[band]}, reported by the project manager.`
          : `Project health changed to ${HEALTH_BAND_LABEL[band]}.`,
      );
    }
    lastBand.current = { projectId: projectId ?? '', band };
  }, [projectId, stats?.healthBand, stats?.healthBandSource]);

  // Project-scoped chrome; suppressed on project settings routes (rule 123 — the
  // SettingsShell carries its own chrome). The `useProjectId()` null path already
  // covers My Work / Notifications / Portfolio / Program / workspace settings.
  // …and on a project the caller cannot open (#3469): the cluster's empty form is
  // absence. Stating a health for a project the route itself is about to render as
  // "This project isn't available" is worse than saying nothing.
  if (!projectId || onSettingsRoute || projectUnavailable) return null;

  // ── The three states of the band (#3525) ──────────────────────────────────
  // Suppression above still outranks both of the states below: a project the
  // caller cannot open renders nothing at all, because the route itself is about
  // to say "This project isn't available" and a "couldn't load" chip over it
  // would be a second, wrong explanation. The two do not overlap — 404/403 on
  // `GET /projects/{id}/` is `projectUnavailable`; a 5xx on `status-summary` is
  // the error state here.
  //
  // In flight comes first and renders a skeleton. It is a separate state from the
  // failure on purpose: `staleTime` is 30s with no retry override, so the error
  // state can persist for as long as the server keeps failing, and a skeleton
  // that never resolves is the perpetual-pulse defect rule 246 names.
  if (statsLoading) {
    return (
      <div className="relative">
        <BandAnnouncer text={bandAnnouncement} />
        <LoadingChip />
      </div>
    );
  }

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

  // The chip word is the server's band for the whole project, independent of
  // which segments this methodology renders (see deriveChipState) and never
  // computed from the counts.
  //
  // There is no longer a `?? 'on_track'` fallback here, and the reasoning that
  // justified one was wrong. It argued that "loaded but no band" is unreachable
  // because `health_band` is required and the bundle ships with its own API — but
  // `stats` is `undefined` for a FAILED fetch as much as for an unresolved one,
  // so the fallback was not covering a pre-load tick, it was printing the most
  // reassuring word in the vocabulary over a project whose health nobody could
  // read (#3525). `chip` is now null in that case and nothing prints a band.

  // P80 fragment on the chip: shown only when the methodology cluster has a
  // forecast segment (omitted entirely for pure Agile). The value text stays
  // neutral even inside an amber/red chip (rule 172).
  const forecastSeg = segments.find(
    (s): s is Extract<HealthSegment, { kind: 'forecast' }> => s.kind === 'forecast',
  );

  // The chip is a button with an aria-label, so its inner text is suppressed for
  // assistive tech — anything not in this string does not exist to a screen reader.
  // That is why every clause below lives here rather than only in the popover, and
  // why the unavailable state gets its own sentence instead of inheriting a word
  // the chip no longer prints.
  let chipAria = HEALTH_UNAVAILABLE_ARIA;
  if (chip) {
    chipAria = `Project health: ${chip.word}`;
    // Immediately after the word, before the forecast: it QUALIFIES the word, and
    // on Board and Schedule this label is the only health reading a screen-reader
    // user gets — the provenance row in the popover is not reachable from it
    // (rule 403(b)).
    if (healthBandSource === 'reported') {
      chipAria += ', reported by the project manager';
    }
    if (forecastSeg) {
      chipAria +=
        forecastSeg.p80 != null
          ? `, forecast P80 ${formatForecastDate(forecastSeg.p80)}`
          : ', forecast not run';
    }
    // The clause tracks the *popover row*, not the CSS-hidden fragment: the value
    // is available at every width, exactly as the P80 clause already is.
    chipAria += addedTimeAriaClause(addedTime);
  }

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

  // Rule 403(b): the chip is on Schedule and Board, where the surface owning the
  // report is not, so a reader who meets a reported band there has nowhere to go.
  // A plain navigation, deliberately — mounting `UpdateStatusDialog` from the
  // shell would drag a role-ordinal edit gate into the TopBar, and Overview
  // already gates the editor correctly for every role.
  function goToOverview() {
    setOpen(false);
    void navigate(`/projects/${projectId}/overview`);
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
      <BandAnnouncer text={bandAnnouncement} />
      {/* Status chip trigger — all-width (no md:flex / md:hidden split). The
          data-testid stays on the trigger: e2e locates the surface by it. The
          skeleton above deliberately does NOT take it — see `LoadingChip`. */}
      <button
        ref={triggerRef}
        type="button"
        data-testid="health-cluster"
        // Pinned on the chip so a spec can assert the branch without opening the
        // popover. Both are omitted in the state they do not describe: there is
        // no source when there is no band.
        data-health-source={chip ? healthBandSource : undefined}
        data-state={unavailable ? 'unavailable' : undefined}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={chipAria}
        className="inline-flex items-center gap-1.5 h-[34px] rounded-full border border-neutral-border px-3 text-xs font-medium
          hover:bg-neutral-surface-raised
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        {chip ? (
          <span
            aria-hidden="true"
            className={`inline-block w-2 h-2 rounded-full ${chip.dotClass}`}
          />
        ) : (
          // A hollow ring in the same 8px box, so nothing reflows — and no hue at
          // all, so it cannot be read as green/amber/red under any color-vision
          // profile. `CHIP_DOT_CLASS` is deliberately not consulted: there is no
          // band to reinforce.
          <span
            aria-hidden="true"
            className="inline-block w-2 h-2 rounded-full border border-neutral-text-secondary"
          />
        )}
        {chip ? (
          <span className={chip.wordClass}>{chip.word}</span>
        ) : (
          // "Health —", this file's own no-value idiom (see the constant). Real
          // status text, so `text-neutral-text-secondary` and never
          // `text-neutral-text-disabled`, which fails contrast for anything a
          // reader has to read (#2265).
          <span className="inline-flex items-center gap-1 text-neutral-text-secondary">
            <span>{HEALTH_UNAVAILABLE_WORD}</span>
            <span>—</span>
          </span>
        )}
        {chip && forecastSeg && forecastSeg.p80 != null && (
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
        {chip && forecastSeg && forecastSeg.p80 == null && (
          <span
            className="hidden md:inline-flex items-center gap-1 text-neutral-text-secondary"
            title="Run the scheduler"
          >
            <span>P80</span>
            <span>—</span>
          </span>
        )}
        {chip && addedTimeShort && (
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
            // Bound only in the failure state, where it makes the message read
            // WITH the dialog focus is moved into — which works whether or not
            // the live region fires (rule 335(a)). A dangling reference in the
            // healthy state would be worse than none.
            aria-describedby={unavailable ? HEALTH_ERROR_MSG_ID : undefined}
            tabIndex={-1}
            style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0 }}
            className={`z-50 min-w-[260px] max-w-[calc(100vw-1rem)] max-h-[calc(100vh-4.5rem)] overflow-y-auto rounded-card shadow-pop border border-neutral-border bg-neutral-surface p-1.5 focus:outline-none ${
              pos ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
          >
            {/* Header block — the band dot + word, and (only when the server says
                the word came from a person rather than from the plan) the line
                that explains it.
                
                The two share ONE bordered block on purpose. Provenance is a
                statement about the WORD, not about the evidence rows below it, so
                a separately-fenced row would read as a fourth methodology segment
                — and it sits here, above `segments.map` and unconditional on
                methodology, because `healthClusterModel` emits no at-risk or
                critical segment at all for AGILE. A provenance segment threaded
                through that model would be invisible on exactly the methodology
                where a Critical chip has no drill-through of any kind, which is
                the worst case in #3525 rather than an edge of it.
                
                The header is not necessarily the worst state in the rows beneath
                it: a manual report outranks the counts, so a Critical header can
                sit over "0 tasks" rows. That is now explained rather than left to
                read as a broken tool. */}
            {chip && (
              <div className="mb-1 border-b border-neutral-border">
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <span
                    aria-hidden="true"
                    className={`inline-block w-2 h-2 rounded-full ${chip.dotClass}`}
                  />
                  <span className={`text-xs font-medium ${chip.wordClass}`}>{chip.word}</span>
                </div>
                {healthBandSource === 'reported' && <ProvenanceRow onGoToOverview={goToOverview} />}
              </div>
            )}

            {unavailable && <HealthErrorBody onRetry={refetchStats} />}

            {!unavailable &&
              segments.map((segment) => (
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
