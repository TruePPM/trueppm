import { useId, type ReactNode } from 'react';
import { useScheduleLegendCollapsed } from '@/hooks/useScheduleLegendCollapsed';
import { RadioDotIcon } from '@/components/Icons';
import { gutterBackground } from './deliveryModePresentation';

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
                 bg-neutral-surface-raised border border-neutral-border rounded-card
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
                   focus-visible:rounded-control
                  "
      >
        <span
          aria-hidden="true"
          className={[
            'inline-block w-2 text-xs transition-transform duration-150 ease-out',
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
          {/* Row 3 — delivery mode (#2727 pt.7, WCAG 1.4.1): gutter + texture,
              never color alone. Waterfall (the default) draws neither, so it
              has no swatch here — the same "omission is the baseline" reading
              GanttRenderer.ts's drawDeliveryModeMark uses. Milestone-mode-on-
              a-bar is a rare edge case, deliberately left out of the legend to
              keep this list to the two methodologies a user actually chooses. */}
          <LegendRow label="Scrum">
            <ScrumSwatch />
          </LegendRow>
          <LegendRow label="Kanban">
            <KanbanSwatch />
          </LegendRow>
          {/* MIXED (#2737): a phase whose subtree holds more than one delivery
              mode. Outline-only — the canvas draws no summary-bar mark, so this
              names what the split gutter beside a phase row means rather than
              a texture on the chart. */}
          <LegendRow label="Mixed subtree">
            <MixedSwatch />
          </LegendRow>
          {/* Sprint window (#2738): the band drawn behind the bars of a
              sprint-driven subtree. It belongs in THIS list, beside Scrum and
              Kanban, rather than in a legend of its own — the band and the
              hatched bars inside it are one statement about one plan, and a
              second legend would re-introduce the "two views" the band exists
              to deny. The swatch is the region, not a bar: hatched wash between
              two edge rules. */}
          <LegendRow label="Sprint window">
            <SprintBandSwatch />
          </LegendRow>
          {/* Row 4 — lines &amp; arrows.
              No "Planned baseline" entry: ADR-0376 defers the baseline ghost-bar
              overlay to 0.5, so the canvas draws nothing from baseline dates. A
              legend names marks that are drawn — reinstate this row with the
              overlay, not before. */}
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
        {/* Drag-to-link discoverability (#1666). The link affordance is the
            crosshair dot at a bar's right edge; name it here so the gesture is
            discoverable without a coachmark. */}
        <p className="mt-1 text-xs text-neutral-text-secondary">
          Drag the{' '}
          <RadioDotIcon
            aria-hidden="true"
            filled={false}
            className="inline-block h-2.5 w-2.5 align-[-0.125em]"
          />{' '}
          handle at a bar’s right edge onto another task to link them
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
  // The normal in-progress bar is the brand `info` blue on the canvas
  // (barNormal = --info; #1700 / #1740 reconciliation — the swatch previously
  // showed sage, which never matched the blue bars it described). Mode-aware:
  // --info flips light/dark in globals.css, matching COLOR/COLOR_DARK. Applied via
  // the CSS var in `style` (rule 10 — CSS custom property) since there is no
  // `bg-info` Tailwind token.
  return (
    <span className="relative block w-full h-2 border border-neutral-border bg-neutral-surface rounded-[2px] overflow-hidden">
      <span
        className="absolute inset-y-0 left-0 w-3/5"
        style={{ backgroundColor: 'var(--info)' }}
      />
    </span>
  );
}

function CompleteSwatch() {
  return <span className="block w-full h-2 bg-semantic-on-track rounded-[2px]" />;
}

function CriticalSwatch() {
  // Critical path now reads as a red BORDER frame around a state-colored bar, not a
  // red fill (#1699, ADR-0277): a completed critical task stays visible as a green
  // bar in a red frame instead of losing its criticality to completion. The swatch
  // mirrors that — a 2px red frame over a neutral bar body.
  return (
    <span className="block w-full h-2 border-2 border-semantic-critical bg-neutral-surface rounded-[2px]" />
  );
}

function TodaySwatch() {
  // Vertical sage line — matches the canvas today-line (sage-600 light /
  // sage-400 dark) in GanttRenderer.ts. brand-primary reverses itself by mode.
  return <span className="block h-full w-[2px] mx-auto bg-brand-primary" />;
}

function ScrumSwatch() {
  // Matches GanttRenderer.ts's drawDeliveryModeMark: a left-edge gutter (here,
  // the left third of the swatch) plus a diagonal-stripe texture across the
  // body — the redundant non-color cue, not just the violet hue. Uses the
  // existing --violet/--agile token (globals.css) — already this codebase's
  // agile-methodology accent (BurnChart's "Completed" line).
  return (
    <span className="relative block w-full h-2 border border-neutral-border bg-neutral-surface rounded-[2px] overflow-hidden">
      <span
        className="absolute inset-y-0 left-0 w-1/3"
        style={{ backgroundColor: 'var(--violet)' }}
      />
      <svg className="absolute inset-0 w-full h-full" aria-hidden="true">
        <pattern id="scrum-swatch-stripes" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="4" stroke="currentColor" strokeWidth="1" className="text-neutral-text-secondary" />
        </pattern>
        <rect width="100%" height="100%" fill="url(#scrum-swatch-stripes)" opacity="0.4" />
      </svg>
    </span>
  );
}

function KanbanSwatch() {
  // Same gutter+texture composition as ScrumSwatch. Uses the new --teal/
  // --kanban token (globals.css) — added alongside this branch specifically
  // so this swatch and GanttRenderer.ts's COLOR.deliveryKanban share one
  // source of truth instead of "kept in sync by eye".
  return (
    <span className="relative block w-full h-2 border border-neutral-border bg-neutral-surface rounded-[2px] overflow-hidden">
      <span
        className="absolute inset-y-0 left-0 w-1/3"
        style={{ backgroundColor: 'var(--kanban)' }}
      />
      <svg className="absolute inset-0 w-full h-full" aria-hidden="true">
        <pattern id="kanban-swatch-dots" width="4" height="4" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="0.75" fill="currentColor" className="text-neutral-text-secondary" />
        </pattern>
        <rect width="100%" height="100%" fill="url(#kanban-swatch-dots)" opacity="0.4" />
      </svg>
    </span>
  );
}

function MixedSwatch() {
  // The outline gutter as it renders on a phase whose descendants disagree: a
  // vertical 3px strip split evenly between the modes present, beside a muted
  // row standing in for the task line. Drawn from the same `gutterBackground`
  // recipe RowModeIndicators uses, so the legend and the row cannot diverge — a
  // two-part gated+scrum split is the canonical example. Graphical only: the
  // `MIXED` token is the row's own label, and repeating it here at a size below
  // the rule-50 floor would be both redundant and a WCAG 1.4.3 failure.
  return (
    <span className="relative block w-full h-3">
      <span
        className="absolute left-0 top-0 bottom-0 w-[3px]"
        style={{ background: gutterBackground(['var(--ink-2)', 'var(--agile)']) }}
      />
      <span className="absolute left-[6px] right-0 top-1/2 -translate-y-1/2 h-[3px] bg-neutral-border" />
    </span>
  );
}

function SprintBandSwatch() {
  // Mirrors drawSprintBands in GanttRenderer.ts: a low-alpha violet wash, the
  // same 45° diagonal hatch the scrum bar texture uses (at the band's wider
  // pitch), bounded left and right by the full-strength violet window rules.
  // Uses the --agile token so the swatch, the canvas band, the scrum bar gutter
  // and the outline chip all resolve to one hue in both light and dark.
  return (
    <span className="relative block w-full h-3.5 overflow-hidden">
      <span
        className="absolute inset-0"
        style={{ backgroundColor: 'color-mix(in srgb, var(--agile) 8%, transparent)' }}
      />
      <svg className="absolute inset-0 w-full h-full" aria-hidden="true">
        <pattern
          id="sprint-band-swatch-stripes"
          width="5"
          height="5"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="5" stroke="var(--agile)" strokeWidth="1" />
        </pattern>
        <rect width="100%" height="100%" fill="url(#sprint-band-swatch-stripes)" opacity="0.3" />
      </svg>
      <span
        className="absolute left-0 top-0 bottom-0 w-[2px]"
        style={{ backgroundColor: 'var(--agile)' }}
      />
      <span
        className="absolute right-0 top-0 bottom-0 w-[2px]"
        style={{ backgroundColor: 'var(--agile)' }}
      />
    </span>
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
