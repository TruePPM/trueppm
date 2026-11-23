import type { ReactNode } from 'react';

/**
 * The over-allocation visual language, built once (#1235, rule 120): a ▲ glyph
 * **and** the critical color, never color alone. Every surface that says "this
 * person is over capacity" — the board card's assignee chips, the People capacity
 * view, the Resource Manager home — renders one of these two primitives rather
 * than its own red dot or tinted pill.
 *
 * Neither primitive decides whether someone is over-allocated. The caller passes
 * the server's verdict (`overallocated`, `over_allocated_count`, a peak factor);
 * these only draw it.
 */

const GLYPH = '▲';

export interface OverallocBadgeProps {
  /**
   * `marker` is the glyph alone, pinned to the corner of an avatar (the caller
   * owns the accessible name, on the avatar). `chip` is the glyph plus a value.
   */
  variant?: 'marker' | 'chip';
  /** The value the chip shows, e.g. `1.4×` or `120%`. Ignored by `marker`. */
  value?: ReactNode;
  className?: string;
}

/** A single over-allocation mark: the corner marker or a glyph + value chip. */
export function OverallocBadge({ variant = 'chip', value, className = '' }: OverallocBadgeProps) {
  if (variant === 'marker') {
    return (
      <span
        aria-hidden="true"
        data-testid="overalloc-marker"
        className={`absolute -top-1.5 -right-1.5 text-[0.625rem] leading-none text-semantic-critical ${className}`}
      >
        {GLYPH}
      </span>
    );
  }
  return (
    <span
      data-testid="overalloc-chip"
      className={`inline-flex items-center gap-0.5 rounded-chip border border-semantic-critical/30 bg-semantic-critical-bg px-1 py-px text-xs text-semantic-critical tppm-mono ${className}`}
    >
      <span aria-hidden="true">{GLYPH}</span>
      <span>{value}</span>
    </span>
  );
}

export interface OverallocBannerProps {
  /** How many people are over capacity — the server's count, never recounted here. */
  count: number;
  /** Optional trailing action, e.g. a link to the capacity view. */
  action?: ReactNode;
}

/**
 * A one-line over-capacity summary ("▲ 3 people over capacity"). Renders nothing
 * at zero: a banner announcing that nobody is over is noise, and the heat map
 * beside it already shows the idle weeks.
 */
export function OverallocBanner({ count, action }: OverallocBannerProps) {
  if (count <= 0) return null;
  const noun = count === 1 ? 'person' : 'people';
  return (
    <p
      role="status"
      data-testid="overalloc-banner"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-semantic-critical/30 bg-semantic-critical-bg px-3 py-2 text-sm text-semantic-critical"
    >
      <span aria-hidden="true">{GLYPH}</span>
      <span>
        {count} {noun} over capacity
      </span>
      {action}
    </p>
  );
}
