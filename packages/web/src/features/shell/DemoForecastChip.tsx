import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router';
import { useAnchoredPopover } from '@/hooks/useAnchoredPopover';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { useProjectId } from '@/hooks/useProjectId';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { ScheduleForecastBar } from '@/features/schedule/ScheduleForecastBar';

/**
 * The demo's forecast surface: one chip, and the real forecast bar behind it
 * (#4050 A1).
 *
 * **ADR-0144 / web rule 189 is the whole design here.** There is exactly one
 * forecast surface, and this does not add a second one — it *relocates* the
 * only one. In the demo `ScheduleView` does not mount the docked
 * `ScheduleForecastBar` at all; this chip mounts it, unchanged, inside a
 * popover. So the percentiles are still rendered once, by the same component,
 * from the same `useForecastPresentation` derivation. The chip itself shows
 * **only P80** — never P50/P80/P95 alongside the popover's copies of them —
 * because a chip that repeated the row it opens would be the two-surface split
 * ADR-0144 exists to have removed.
 *
 * **Why a chip at all.** The docked bar is a 60–120px strip pinned to the
 * bottom of the schedule column. On a working session that is right: the
 * forecast is what a PM checks constantly. On a *first visit* it was one of
 * five strips squeezing the Gantt into a third of the viewport, and the number
 * it shows means nothing to someone who has not yet understood the plan. The
 * chip keeps the headline — the date, and the date it is measured against —
 * and defers the histogram and the run history to a click.
 *
 * **Schedule route only.** The forecast is a statement about this project's
 * finish; on the Board or a settings page it is a number with no context, and
 * the hooks it needs would fetch a task list nothing on screen is showing.
 */
export function DemoForecastChip() {
  const { pathname } = useLocation();
  const projectId = useProjectId();
  // Gate BEFORE the data hooks, not after: `useScheduleTasks` polls, and a chip
  // that returns null at the end of its render still paid for the fetch.
  if (!projectId || !pathname.includes('/schedule')) return null;
  return <DemoForecastChipInner projectId={projectId} />;
}

function DemoForecastChipInner({ projectId }: { projectId: string }) {
  const { data: result } = useMonteCarloResult(projectId);
  const { tasks } = useScheduleTasks(projectId);
  const [open, setOpen] = useState(false);

  const popover = useAnchoredPopover<HTMLButtonElement, HTMLDivElement>({
    open,
    width: 520,
    estimatedHeight: 420,
    align: 'right',
    onDismiss: () => setOpen(false),
  });

  // Escape closes and returns focus to the chip. `useAnchoredPopover` documents
  // that it deliberately does NOT own Escape (a duplicate document listener is
  // the rule-204 double-fire), so the site owns it — here, plainly, because this
  // panel has no search box to clear first.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      popover.triggerRef.current?.focus();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, popover.triggerRef]);

  // No run yet → no chip. A "Forecast —" placeholder would be a control that
  // opens a panel to say nothing, on the one screen where every pixel is being
  // argued over. The docked bar's own empty state still exists for every other
  // deployment (rule 379: a withdrawal, not an error).
  if (!result?.p80) return null;

  const target = result.cpmFinish;

  return (
    <>
      <button
        type="button"
        ref={popover.triggerRef}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="demo-forecast-chip"
        className="flex h-7 flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-chip
          border border-brand-primary/40 px-2 font-medium
          hover:bg-brand-primary/10 focus:outline-none focus:ring-2
          focus:ring-brand-primary focus:ring-offset-1"
      >
        <span className="font-semibold">Forecast</span>
        <span>P80 {fmtUtcShort(result.p80)}</span>
        {target ? (
          <>
            <span aria-hidden="true" className="text-brand-primary/50">
              ·
            </span>
            <span>target {fmtUtcShort(target)}</span>
          </>
        ) : null}
      </button>

      {open && popover.popoverStyle
        ? createPortal(
            <div
              ref={popover.popoverRef}
              role="dialog"
              aria-label="Schedule forecast"
              data-testid="demo-forecast-popover"
              style={popover.popoverStyle}
              className="z-50 overflow-y-auto rounded-card border border-neutral-border
                bg-neutral-surface shadow-pop"
            >
              {/* The docked bar itself — not a re-implementation of it. `variant`
                  only swaps the outer section's dock classes (border-t,
                  `hidden md:flex`, the 40vh cap) for popover ones; every child,
                  every derivation and every string is the shipped component's. */}
              <ScheduleForecastBar
                projectId={projectId}
                cpmFinish={target}
                tasks={tasks ?? []}
                variant="popover"
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
