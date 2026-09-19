import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  useRemoveSampleProgram,
  useShiftSampleDates,
  type ShiftSampleDatesResult,
} from '@/hooks/useProgramSeedIo';

interface SampleDataBannerProps {
  programId: string;
  /** Whether the current user may remove or re-anchor the sample (program owner). */
  canRemove: boolean;
  /**
   * Days since the sample's dates were anchored (`Program.sample_days_stale`).
   * `null` for a sample loaded before #3481, which carries no anchor and cannot
   * be shifted.
   */
  sampleDaysStale?: number | null;
}

/**
 * Below this the demo is current enough to leave alone (#3481, ADR-1175).
 *
 * The shift quantum is a whole week — plan dates are snapped onto working days by
 * the seed resolver, so only a whole-week offset preserves the weekday each date
 * was placed on. Under seven days the server would compute a zero offset, so
 * offering the control would be offering a no-op.
 */
const SHIFT_THRESHOLD_DAYS = 7;

/**
 * Above this the banner stops claiming the demo renders out of the box.
 *
 * Four weeks is where the drift stops being cosmetic: health rollups start
 * reading Critical off staleness alone, the burndown has run off the end of its
 * window, and every project shows overdue tasks that the seed never intended.
 */
const STALE_THRESHOLD_DAYS = 28;

/** The promise sentence, replaced by a drift warning once the demo is stale. */
function SampleIntro({ isStale, days }: { isStale: boolean; days: number }) {
  if (isStale) {
    return (
      <>
        Its dates were set <span className="font-semibold">{days} days ago</span>, so the active
        sprint, burndown, and overdue counts have drifted from today. Shift them forward to demo
        from a live-looking program.
      </>
    );
  }
  return (
    <>
      It includes 60 days of history — forecast trend, sprint velocity, and baseline variance render
      out of the box. Explore freely — remove it when you&rsquo;re ready to start your own work.
    </>
  );
}

function ShiftResultNote({ result }: { result: ShiftSampleDatesResult }) {
  return (
    <p className="w-full text-xs text-neutral-text-secondary">
      {result.shifted ? (
        <>
          <span className="font-semibold text-neutral-text-primary">Dates updated.</span> Moved the
          demo forward {result.days} days — {result.rows_shifted.toLocaleString()} records across{' '}
          {result.projects} {result.projects === 1 ? 'project' : 'projects'}. Schedules are
          recalculating.
        </>
      ) : (
        <>
          <span className="font-semibold text-neutral-text-primary">Already current.</span> The
          demo&rsquo;s dates did not need moving.
        </>
      )}
    </p>
  );
}

/**
 * "This is sample data" banner shown on a sample program (#375, #3481).
 *
 * Two owner actions: re-anchor the demo's dates to today, and tear it down. They
 * are deliberately **not** peers — the shift is constructive and reversible in
 * effect, the teardown destroys the program — so the shift takes the filled
 * treatment when it is the recommended action and the teardown never does.
 *
 * The promise sentence is **replaced**, not supplemented, once the demo is stale.
 * It asserts a present-tense fact about what renders ("60 days of history …
 * render out of the box"), and at seven weeks that is simply false — which is the
 * defect #3481 exists to fix. Leaving it in place and adding a warning beside it
 * would keep the false claim on screen.
 */
export function SampleDataBanner({
  programId,
  canRemove,
  sampleDaysStale = null,
}: SampleDataBannerProps) {
  const navigate = useNavigate();
  const removeSample = useRemoveSampleProgram();
  const shiftDates = useShiftSampleDates();
  const [confirming, setConfirming] = useState<'remove' | 'shift' | null>(null);
  const [shiftResult, setShiftResult] = useState<ShiftSampleDatesResult | null>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const shiftTriggerRef = useRef<HTMLButtonElement>(null);

  // `null` means the anchor is unknown (a sample loaded before #3481), which is a
  // different state from "current" — the server would refuse a shift, so the
  // banner offers a reload instead of a control that cannot work.
  const anchorUnknown = sampleDaysStale === null;
  const days = sampleDaysStale ?? 0;
  const isStale = !anchorUnknown && days >= STALE_THRESHOLD_DAYS;
  const canShift = canRemove && !anchorUnknown && days >= SHIFT_THRESHOLD_DAYS;

  const onRemove = () => {
    removeSample.mutate(programId, {
      onSuccess: () => {
        void navigate('/programs');
      },
    });
  };

  const onShift = () => {
    shiftDates.mutate(programId, {
      onSuccess: (result) => {
        setShiftResult(result);
        setConfirming(null);
        // The trigger is about to unmount (the server has flipped
        // sample_days_stale to its sub-week residual), and a focused element that
        // disappears drops focus to <body> — the screen reader loses its place
        // mid-announcement. Move focus onto the banner, which is where the result
        // sentence renders.
        bannerRef.current?.focus();
      },
    });
  };

  const cancelConfirm = () => {
    setConfirming(null);
    shiftTriggerRef.current?.focus();
  };

  return (
    <div
      ref={bannerRef}
      role="status"
      tabIndex={-1}
      className={`flex flex-wrap items-center justify-between gap-3 rounded-card border px-4 py-3
        focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary ${
          isStale
            ? 'border-semantic-warning/40 bg-semantic-warning-bg'
            : 'border-brand-primary/30 bg-brand-primary-light'
        }`}
    >
      <p className="text-sm text-neutral-text-primary">
        <span className="font-semibold">This is sample data.</span>{' '}
        <SampleIntro isStale={isStale} days={days} />
      </p>

      {confirming === 'shift' ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-text-secondary">
            This moves every date in the demo forward {days} days — including any changes you made.
            Nothing is deleted.
          </span>
          <button
            type="button"
            onClick={onShift}
            disabled={shiftDates.isPending}
            aria-busy={shiftDates.isPending}
            className="h-8 rounded-control bg-brand-primary px-3 text-xs font-medium text-white
              hover:bg-brand-primary/90 disabled:opacity-60 focus:outline-none
              focus:ring-2 focus:ring-white focus:ring-offset-1
              focus:ring-offset-brand-primary"
          >
            {shiftDates.isPending ? 'Shifting dates…' : 'Shift dates'}
          </button>
          {/* Removed while pending: an in-flight bulk write cannot be cancelled,
              and a Cancel that does nothing is a lie. */}
          {!shiftDates.isPending && (
            <button
              type="button"
              onClick={cancelConfirm}
              className="h-8 rounded-control border border-neutral-border px-3 text-xs font-medium
                text-neutral-text-primary hover:bg-neutral-surface-raised
                focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
            >
              Cancel
            </button>
          )}
        </div>
      ) : confirming === 'remove' ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-text-secondary">
            This removes the entire demo program, including any changes you made. Your own projects
            are not affected.
          </span>
          <button
            type="button"
            onClick={onRemove}
            disabled={removeSample.isPending}
            className="h-8 rounded-control bg-semantic-critical px-3 text-xs font-medium text-white hover:bg-semantic-critical/90 disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-1 focus:ring-offset-semantic-critical"
          >
            {removeSample.isPending ? 'Removing…' : 'Remove'}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(null)}
            className="h-8 rounded-control border border-neutral-border px-3 text-xs font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {canShift && (
            <button
              ref={shiftTriggerRef}
              type="button"
              onClick={() => setConfirming('shift')}
              className={`h-8 rounded-control px-3 text-xs font-medium focus:outline-none
                focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 ${
                  isStale
                    ? 'bg-brand-primary text-white hover:bg-brand-primary/90'
                    : 'border border-neutral-border text-neutral-text-primary hover:bg-neutral-surface-raised'
                }`}
            >
              Shift dates to today
            </button>
          )}
          {canRemove && (
            <button
              type="button"
              onClick={() => setConfirming('remove')}
              className="h-8 rounded-control border border-neutral-border px-3 text-xs font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
            >
              Remove sample data
            </button>
          )}
        </div>
      )}

      {shiftResult !== null && <ShiftResultNote result={shiftResult} />}

      {anchorUnknown && canRemove && (
        <p className="w-full text-xs text-neutral-text-secondary">
          Dates can&rsquo;t be refreshed for a demo loaded before this version. Remove and reload it
          to get current dates.
        </p>
      )}

      {removeSample.isError && (
        <p role="alert" className="w-full text-xs text-semantic-critical">
          Could not remove the sample — please try again.
        </p>
      )}
      {shiftDates.isError && (
        <p role="alert" className="w-full text-xs text-semantic-critical">
          Could not shift the demo dates — please try again.
        </p>
      )}
    </div>
  );
}
