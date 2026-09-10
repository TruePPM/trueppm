/**
 * Schedule task-ceiling banner (#3388, `administration/sizing.md` "Tested
 * envelope").
 *
 * Whole-project load — every page, what the Schedule fetches before drawing a
 * bar — is measured at 1.85s at 1,000 tasks and breaches at 2,000 (60s): a
 * cliff, not a slope. A project already past that line reads as *broken*
 * rather than *slow* the moment it is opened, with nothing on screen
 * explaining why. This banner is that explanation.
 *
 * Deliberately non-blocking and dismissible (`Wanted` #2 in the issue is
 * explicit: a toast/banner, not a modal) — the ceiling is a measured comfort
 * line, not a correctness limit, so nothing here stops the Schedule from
 * opening or the operator from working in it.
 *
 * `exceedsScheduleTaskCeiling` reads `allTasks.length` — the schedule's own
 * already-fetched task list — rather than issuing a new request. The whole
 * point of the ceiling is that fetching it already cost the slow path; a
 * dedicated count endpoint would only add a second request to a page that is
 * already struggling to load the first one.
 */

export const SCHEDULE_TASK_CEILING_RECOMMENDED = 1_000;

/**
 * Whether a task count sits past the tested-comfortable Schedule size.
 *
 * `ceiling` defaults to {@link SCHEDULE_TASK_CEILING_RECOMMENDED}, which
 * mirrors the server's `settings.SCHEDULE_TASK_CEILING` default (#3388) — kept
 * as a plain constant here rather than fetched, matching this banner's whole
 * point of adding no request to Schedule open.
 */
export function exceedsScheduleTaskCeiling(
  taskCount: number,
  ceiling: number = SCHEDULE_TASK_CEILING_RECOMMENDED,
): boolean {
  return taskCount > ceiling;
}

interface ScheduleTaskCeilingBannerProps {
  taskCount: number;
  ceiling?: number;
  onDismiss: () => void;
}

/**
 * A dismissible banner, not a toast: a toast disappears on its own timer, and
 * an operator who opens the Schedule and immediately starts scrolling would
 * likely never read it. The banner stays until dismissed, matching
 * `SeedBanner`/`ReforecastPanel`'s own non-modal, always-visible-until-acted-on
 * pattern on this same view.
 */
export function ScheduleTaskCeilingBanner({
  taskCount,
  ceiling = SCHEDULE_TASK_CEILING_RECOMMENDED,
  onDismiss,
}: ScheduleTaskCeilingBannerProps) {
  return (
    <section
      data-testid="schedule-task-ceiling-banner"
      aria-label="Schedule size warning"
      className="flex flex-shrink-0 items-start gap-3 border-b border-neutral-border bg-neutral-surface-raised px-4 py-2"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs text-neutral-text-primary">
          <span className="font-medium">
            This project has {taskCount.toLocaleString()} tasks
          </span>
          , past the ~{ceiling.toLocaleString()}-task ceiling the Schedule has been measured
          comfortable to.{' '}
          <span className="text-neutral-text-secondary">
            Nothing is broken — it may just load and respond more slowly than usual.
          </span>
        </p>
        <a
          href="https://docs.trueppm.com/administration/sizing"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-brand-primary underline-offset-2 hover:underline rounded
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Read the deployment sizing guide
        </a>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss Schedule size warning"
        data-testid="schedule-task-ceiling-banner-dismiss"
        className="ml-auto shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-control
          text-neutral-text-secondary hover:bg-neutral-surface-sunken
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        ×
      </button>
    </section>
  );
}
