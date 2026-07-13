/**
 * Legend strip for the program schedule view (ADR-0182, issue 1118).
 *
 * Always visible (not a popover) because this view is the GA-launch demo
 * centerpiece — a first-time viewer must be able to read the cross-project
 * critical path and the dashed cross-project edges without hunting for a key.
 * The swatches mirror the canvas treatments: red bar = critical path, dashed
 * line = cross-project dependency, solid line = within-project, hatched gray =
 * a limited-view (redacted) task, diamond = milestone.
 */

import type { CSSProperties, ReactNode } from 'react';

interface LegendItemProps {
  swatch: ReactNode;
  label: string;
}

/**
 * Diagonal-hatch fill for the "Limited-view task" swatch. Mode-aware via the
 * `--hatch-limited-view` custom property (issue #1914) — a hardcoded
 * `rgba(0,0,0,…)` stripe was illegible against the dark-mode neutral surface.
 * Exported so it can be asserted directly in tests without rendering the
 * full component tree.
 */
export const LIMITED_VIEW_HATCH_STYLE: CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(45deg, var(--hatch-limited-view) 0 1px, transparent 1px 4px)',
};

function LegendItem({ swatch, label }: LegendItemProps) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-[12px] text-neutral-text-secondary">
      <span className="flex h-3 w-6 items-center justify-center" aria-hidden="true">
        {swatch}
      </span>
      {label}
    </span>
  );
}

export interface ProgramScheduleLegendProps {
  /** Show the limited-view (external) item only when redacted tasks are present. */
  hasExternalTasks: boolean;
}

export function ProgramScheduleLegend({ hasExternalTasks }: ProgramScheduleLegendProps) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1"
      role="list"
      aria-label="Schedule legend"
    >
      <div role="listitem">
        <LegendItem
          swatch={<span className="h-2.5 w-5 rounded-[2px] bg-semantic-critical" />}
          label="Critical path"
        />
      </div>
      <div role="listitem">
        <LegendItem
          swatch={
            <svg
              viewBox="0 0 24 8"
              className="h-2 w-6 text-neutral-text-primary"
              fill="none"
              aria-hidden="true"
            >
              <line
                x1="0"
                y1="4"
                x2="24"
                y2="4"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray="6 4"
              />
            </svg>
          }
          label="Cross-project link"
        />
      </div>
      <div role="listitem">
        <LegendItem
          swatch={
            <svg
              viewBox="0 0 24 8"
              className="h-2 w-6 text-neutral-text-secondary"
              fill="none"
              aria-hidden="true"
            >
              <line x1="0" y1="4" x2="24" y2="4" stroke="currentColor" strokeWidth="2" />
            </svg>
          }
          label="Within-project link"
        />
      </div>
      {hasExternalTasks && (
        <div role="listitem">
          <LegendItem
            swatch={
              <span
                className="h-2.5 w-5 rounded-[2px] bg-neutral-text-disabled"
                style={LIMITED_VIEW_HATCH_STYLE}
              />
            }
            label="Limited-view task"
          />
        </div>
      )}
      <div role="listitem">
        <LegendItem
          swatch={<span className="h-2.5 w-2.5 rotate-45 bg-brand-accent" />}
          label="Milestone"
        />
      </div>
    </div>
  );
}
