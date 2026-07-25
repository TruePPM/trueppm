import type { Task } from '@/types';
import { ClockIcon, WarningIcon } from '@/components/Icons';
import { formatShortDate } from '@/features/schedule/scheduleUtils';
import { fmtCurrency } from './cardFormat';
import type { BoardCardView } from './useBoardCardView';

const CHIP = 'inline-flex items-center gap-0.5 text-xs px-1 py-px rounded-chip border';
const TONE_RED = 'bg-semantic-critical-bg border-semantic-critical/30 text-semantic-critical';
const TONE_AMBER = 'bg-brand-accent/10 border-brand-accent/30 text-brand-accent-dark';
const TONE_GREEN = 'bg-semantic-on-track-bg border-semantic-on-track/30 text-semantic-on-track';

/** Float chip tone: 0 or negative is critical, <3d is at-risk, otherwise healthy. */
function floatToneClass(floatDays: number): string {
  if (floatDays <= 0) return TONE_RED;
  if (floatDays < 3) return TONE_AMBER;
  return TONE_GREEN;
}

/** SPI band → chip tone. The band itself is server-owned (issue 990). */
function spiToneClass(band: BoardCardView['spiBand']): string {
  if (band === 'on_track') return TONE_GREEN;
  if (band === 'at_risk') return TONE_AMBER;
  return TONE_RED;
}

function spiBandLabel(band: BoardCardView['spiBand']): string {
  if (band === 'on_track') return 'on track';
  if (band === 'at_risk') return 'at risk';
  return 'behind schedule';
}

/** CPI ≥ 0.95 is on budget, ≥ 0.85 is over, below that is significantly over. */
function cpiToneClass(cpi: number): string {
  if (cpi >= 0.95) return TONE_GREEN;
  if (cpi >= 0.85) return TONE_AMBER;
  return TONE_RED;
}

function cpiLabel(cpi: number): string {
  if (cpi >= 0.95) return 'on budget';
  if (cpi >= 0.85) return 'over budget';
  return 'significantly over budget';
}

/** Variance text tone: >5d late is critical, any lateness at-risk, else on track. */
function varianceToneClass(days: number): string {
  if (days > 5) return 'text-semantic-critical';
  if (days > 0) return 'text-semantic-at-risk';
  return 'text-semantic-on-track';
}

/** Aging / dwell-time indicator (issue 192): shown when dwell > column SLA. */
function AgingChip({ view }: { view: BoardCardView }) {
  if (!view.isAging) return null;
  return (
    <div
      className={['mt-1', CHIP, view.isPastTwiceSla ? TONE_RED : TONE_AMBER].join(' ')}
      title={`${view.daysAgo}d in column — SLA: ${view.slaDays}d`}
      aria-label={`${view.daysAgo} days in this column, exceeds ${view.slaDays}-day SLA`}
    >
      <ClockIcon aria-hidden="true" className="w-3.5 h-3.5" />
      <span className="tppm-mono">{view.daysAgo}d</span>
    </div>
  );
}

/**
 * Float chip — comfortable + detailed, when CPM data is present (issue 183).
 * CP tasks always show "0d float" (red); non-CP shows totalFloat when defined.
 */
function FloatChip({ view }: { view: BoardCardView }) {
  if (view.isCompact || !view.hasFloatData) return null;
  return (
    <div className="mt-1">
      <span className={[CHIP, floatToneClass(view.floatDays)].join(' ')}>
        {view.floatDays < 0 && (
          <WarningIcon className="inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />
        )}
        <span className="tppm-mono">{view.floatDays}d float</span>
      </span>
    </div>
  );
}

/**
 * SPI chip — comfortable + detailed, when showEvm includes 'spi' (issue 185 /
 * issue 990). SPI value + band are server-owned.
 */
function SpiChip({ view }: { view: BoardCardView }) {
  if (!view.showSpiChip || view.spi === null) return null;
  return (
    <div className="mt-1">
      <span
        className={[CHIP, spiToneClass(view.spiBand)].join(' ')}
        title={`Schedule Performance Index: ${view.spi.toFixed(2)}`}
        aria-label={`SPI ${view.spi.toFixed(2)} — ${spiBandLabel(view.spiBand)}`}
      >
        <span className="tppm-mono">SPI {view.spi.toFixed(2)}</span>
      </span>
    </div>
  );
}

/** CPI chip — when showEvm includes 'cpi' and task.cpi is set (issue 185). */
function CpiChip({ view }: { view: BoardCardView }) {
  if (!view.showCpiChip || view.cpi === null) return null;
  return (
    <div className="mt-1">
      <span
        className={[CHIP, cpiToneClass(view.cpi)].join(' ')}
        title={`Cost Performance Index: ${view.cpi.toFixed(2)}`}
        aria-label={`CPI ${view.cpi.toFixed(2)} — ${cpiLabel(view.cpi)}`}
      >
        <span className="tppm-mono">CPI {view.cpi.toFixed(2)}</span>
      </span>
    </div>
  );
}

/** Cost chip — when the showCost toggle is on and the task has cost data (issue 189). */
function CostChip({ task, view }: { task: Task; view: BoardCardView }) {
  const bac = task.budgetAtCompletion;
  if (!view.showCostChip || bac == null) return null;
  const actual = task.actualCost != null ? fmtCurrency(task.actualCost) : null;
  return (
    <div className="mt-1">
      <span
        className={[
          CHIP,
          task.actualCost != null && task.actualCost > bac
            ? TONE_RED
            : 'bg-neutral-surface-sunken border-neutral-border text-neutral-text-secondary',
        ].join(' ')}
        title={`Actual cost ${actual ?? '—'} of ${fmtCurrency(bac)}`}
        aria-label={`Cost: ${actual ?? 'no actuals'} of ${fmtCurrency(bac)} budget`}
      >
        <span className="tppm-mono">
          {actual ?? '—'}
          {' / '}
          {fmtCurrency(bac)}
        </span>
      </span>
    </div>
  );
}

/**
 * Baseline vs. forecast date variance (issue 186), folded into the issue 1305
 * peek so the badge's aria-controls covers everything it reveals; the panel
 * inherits the peek's collapsed/revealed visibility.
 */
function BaselineVariance({ task, varianceDays }: { task: Task; varianceDays: number | null }) {
  if (varianceDays === null) return null;
  const sign = varianceDays > 0 ? '+' : '';
  return (
    <div
      className="mt-1.5 pt-1 border-t border-neutral-border/30"
      aria-label={`Baseline variance: ${sign}${varianceDays}d`}
    >
      <div className="flex items-center gap-1.5 flex-wrap text-xs">
        <span className="text-neutral-text-disabled">
          BL <span className="tppm-mono">{formatShortDate(task.baselineFinish!)}</span>
        </span>
        <span className="text-neutral-text-disabled" aria-hidden="true">
          →
        </span>
        <span className="text-neutral-text-secondary">
          FC <span className="tppm-mono">{formatShortDate(task.finish)}</span>
        </span>
        <span className={['font-medium tppm-mono', varianceToneClass(varianceDays)].join(' ')}>
          {sign}
          {varianceDays}d
        </span>
      </div>
    </div>
  );
}

interface CardHealthPeekProps {
  task: Task;
  view: BoardCardView;
  /** Calendar days between forecast finish and baseline; null when unbaselined. */
  baselineVarianceDays: number | null;
  peekOpen: boolean;
}

/**
 * Health-chip peek (issue 1305). Detailed density shows the full chip set
 * inline (no badge). Comfortable density collapses it behind the
 * worst-offender badge. `group-hover:block` is a pointer-only convenience;
 * keyboard and touch reveal flow through `peekOpen` so `aria-expanded` always
 * matches what is visible and the collapse is never inert (no
 * `group-focus-within` — that would desync the announced state). Keyboard + SR
 * reachable, never lossy.
 */
export function CardHealthPeek({
  task,
  view,
  baselineVarianceDays,
  peekOpen,
}: CardHealthPeekProps) {
  let visibilityClass = '';
  if (!view.isDetailed) visibilityClass = peekOpen ? 'block' : 'hidden group-hover:block';
  return (
    <div
      id={view.peekId}
      role={view.isDetailed ? undefined : 'group'}
      aria-label={view.isDetailed ? undefined : 'Card health details'}
      className={visibilityClass}
    >
      <AgingChip view={view} />
      <FloatChip view={view} />
      <SpiChip view={view} />
      <CpiChip view={view} />
      <CostChip task={task} view={view} />
      <BaselineVariance task={task} varianceDays={baselineVarianceDays} />
    </div>
  );
}
