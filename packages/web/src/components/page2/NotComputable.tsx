import type { ReactNode } from 'react';

export interface NotComputableProps {
  /** The metric that cannot be shown, e.g. "Schedule variance". */
  label: string;
  /** The missing input, as a short clause: "no baseline is set". */
  missing: string;
  /** The ONE thing that fixes it — a link or button. Exactly one, never a list. */
  fix: ReactNode;
}

/**
 * A configured-but-not-computable metric, as ONE line (rule 439, narrowing rule
 * 119): a dashed top rule, the metric's name, the input it is missing, and the
 * single fix.
 *
 * Rule 119 already forbids hiding the metric. Pass 2 narrows the muted card it
 * allowed to a line, because a full-size tile with a dash in it reads as a
 * value of zero at a glance — the Pass 1 audit's "P80 —" finding. A line is
 * visibly not a tile, and naming the missing input tells the person what to do
 * instead of only that something is wrong.
 */
export function NotComputable({ label, missing, fix }: NotComputableProps) {
  return (
    <p
      data-testid="not-computable"
      className="flex flex-wrap items-center gap-x-1.5 border-t border-dashed border-p1-hairline-strong pt-2 text-xs text-p1-text-2"
    >
      {/* Explicit spaces: the flex gap is visual only, and without them the line
          reads as "Schedule variancecan't…" to anything that takes its text. */}
      <span className="font-medium text-p1-text-1">{label}</span>{' '}
      <span>can’t be computed: {missing}.</span> {fix}
    </p>
  );
}
