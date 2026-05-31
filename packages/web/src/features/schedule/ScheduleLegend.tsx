import { useId, type ReactNode } from 'react';
import { useScheduleLegendCollapsed } from '@/hooks/useScheduleLegendCollapsed';

interface ScheduleLegendProps {
  /**
   * Width of the task list panel in pixels. Used to offset the legend horizontally
   * so it floats over the bottom-left of the *canvas* viewport rather than the
   * task list. Comes from useColumnWidths().totalWidth in ScheduleView.
   */
  taskListWidth: number;
}

/**
 * Floating legend overlay for the Schedule (Gantt) view (#474, ADR-0064).
 *
 * Mounted as a sibling of the canvas scroll container with `position: absolute`,
 * inside the timeline wrapper. Suppressed below the `lg` breakpoint (1024px) —
 * narrow viewports risk obscuring the first task row. Collapsed state persists
 * across sessions and tabs via `useScheduleLegendCollapsed`.
 *
 * The PDF-export question (VoC: Sarah blocks if it appears on client PDFs) is
 * resolved structurally: the legend is a DOM sibling of the canvas, not inside
 * it, so any future canvas export pipeline starts from "explicitly include"
 * rather than "explicitly exclude".
 */
export function ScheduleLegend({ taskListWidth }: ScheduleLegendProps) {
  const { collapsed, toggle } = useScheduleLegendCollapsed();
  const headerId = useId();
  const bodyId = `${headerId}-body`;

  return (
    <div
      data-testid="schedule-legend"
      style={{ left: taskListWidth + 16 }}
      className="absolute bottom-4 z-20 hidden lg:block
                 bg-neutral-surface-raised border border-neutral-border rounded-md
                 text-xs text-neutral-text-primary"
    >
      <button
        type="button"
        id={headerId}
        data-testid="schedule-legend-chip"
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onClick={toggle}
        className="flex items-center gap-2 px-3 min-h-[44px] w-full text-left
                   font-semibold tracking-widest uppercase
                   text-neutral-text-secondary
                   hover:bg-neutral-surface
                   focus-visible:outline-none focus-visible:ring-2
                   focus-visible:ring-brand-primary focus-visible:ring-offset-1
                   focus-visible:rounded-sm
                   dark:focus-visible:ring-semantic-on-track"
      >
        <span
          aria-hidden="true"
          className={[
            'inline-block w-2 text-[11px] transition-transform duration-150 ease-out',
            'motion-reduce:transition-none',
            collapsed ? 'rotate-0' : 'rotate-90',
          ].join(' ')}
        >
          ▶
        </span>
        <span>Legend</span>
      </button>

      <div
        id={bodyId}
        data-testid="schedule-legend-body"
        role="region"
        aria-labelledby={headerId}
        hidden={collapsed}
        className="px-3 pb-3 pt-1 border-t border-neutral-border"
      >
        <ul
          className="grid grid-cols-3 gap-x-4 gap-y-2 list-none m-0 p-0
                     text-neutral-text-secondary"
        >
          {/* Row 1 — bar variants */}
          <LegendRow label="Summary rollup">
            <SummarySwatch />
          </LegendRow>
          <LegendRow label="Task (progress)">
            <TaskSwatch />
          </LegendRow>
          <LegendRow label="Complete">
            <CompleteSwatch />
          </LegendRow>
          {/* Row 2 — state markers */}
          <LegendRow label="Critical path">
            <CriticalSwatch />
          </LegendRow>
          <LegendRow label="Milestone">
            <MilestoneSwatch />
          </LegendRow>
          <LegendRow label="Today">
            <TodaySwatch />
          </LegendRow>
          {/* Row 3 — lines &amp; arrows */}
          <LegendRow label="Planned baseline">
            <BaselineSwatch />
          </LegendRow>
          <LegendRow label="Finish-to-start">
            <ArrowFsSwatch />
          </LegendRow>
          <LegendRow label="Merged trunk">
            <MergedTrunkSwatch />
          </LegendRow>
        </ul>
        {/* Pan discoverability (#491, rule 131). One quiet line — the legend is
            the established "what do these affordances mean" surface, so the pan
            hint lives here rather than as a transient toast/coachmark. */}
        <p className="mt-2 pt-2 border-t border-neutral-border text-xs text-neutral-text-secondary">
          Hold Space + drag, or middle-drag, to pan
        </p>
        <p className="mt-1 text-xs text-neutral-text-secondary">
          Double-click a task to open its details
        </p>
      </div>
    </div>
  );
}

function LegendRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <li className="flex items-center gap-2 min-h-5">
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center w-8 h-4 shrink-0"
      >
        {children}
      </span>
      <span className="leading-tight">{label}</span>
    </li>
  );
}

function SummarySwatch() {
  // Summary rollup renders as a thin bar with diamond endcaps matching the
  // milestone-diamond geometry — see drawSummaryBar() in GanttRenderer.ts.
  return (
    <span className="relative block w-full h-full">
      <span className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[3px] bg-neutral-text-secondary" />
      <span className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 bg-neutral-text-secondary rotate-45" />
      <span className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-2 h-2 bg-neutral-text-secondary rotate-45" />
    </span>
  );
}

function MilestoneSwatch() {
  return <span className="block w-2 h-2 bg-brand-accent rotate-45" />;
}

function TaskSwatch() {
  // brand-primary is sage (sage-600 light / sage-400 dark, ADR-0103) and is AA in
  // both modes, so no dark escape hatch is needed — the token reverses itself.
  return (
    <span className="relative block w-full h-2 border border-neutral-border bg-neutral-surface rounded-[2px] overflow-hidden">
      <span className="absolute inset-y-0 left-0 w-3/5 bg-brand-primary" />
    </span>
  );
}

function CompleteSwatch() {
  return <span className="block w-full h-2 bg-semantic-on-track rounded-[2px]" />;
}

function CriticalSwatch() {
  return <span className="block w-full h-2 bg-semantic-critical rounded-[2px]" />;
}

function TodaySwatch() {
  // Vertical sage line — matches the canvas today-line (sage-600 light /
  // sage-400 dark) in GanttRenderer.ts. brand-primary reverses itself by mode.
  return <span className="block h-full w-[2px] mx-auto bg-brand-primary" />;
}

function BaselineSwatch() {
  // Dashed border falls back to neutral-text-secondary in dark mode because
  // neutral-text-disabled is below WCAG 1.4.11 3:1 against the dark surface.
  return (
    <span className="block w-full border-t-2 border-dashed border-neutral-text-disabled dark:border-neutral-text-secondary" />
  );
}

function ArrowFsSwatch() {
  return (
    <svg viewBox="0 0 28 8" className="w-full h-2 text-neutral-text-secondary" aria-hidden="true">
      <line x1="0" y1="4" x2="22" y2="4" stroke="currentColor" strokeWidth="1.25" />
      <polygon points="22,1 28,4 22,7" fill="currentColor" />
    </svg>
  );
}

function MergedTrunkSwatch() {
  return (
    <svg viewBox="0 0 28 8" className="w-full h-2 text-neutral-text-secondary" aria-hidden="true">
      <line
        x1="0"
        y1="4"
        x2="22"
        y2="4"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeDasharray="2 2"
      />
      <circle cx="14" cy="4" r="1.5" fill="currentColor" />
      <polygon points="22,1 28,4 22,7" fill="currentColor" />
    </svg>
  );
}
