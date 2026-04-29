export interface CellColor {
  bg: string;
  fg: string;
  border?: string;
}

/**
 * Compute background and foreground colours for a heatmap cell based on
 * utilization percent.  Matches the design spec from issue #217 / ADR-0042.
 *
 *  0%        → surface-sunken, disabled text
 *  1–100%    → green ramp (brand-primary rgba), white text above 65% alpha
 *  101–110%  → red ramp begins, semantic-critical border, primary text
 *  >110%     → deep red, white text, semantic-critical border
 */
export function cellColor(util: number): CellColor {
  if (util === 0) {
    return { bg: 'var(--neutral-surface-sunken)', fg: 'var(--neutral-text-disabled)' };
  }

  if (util > 100) {
    const t = Math.min(1, (util - 100) / 30);
    return {
      bg: `rgba(185, 28, 28, ${(0.15 + t * 0.55).toFixed(3)})`,
      fg: util > 110 ? '#fff' : 'var(--neutral-text-primary)',
      border: '1px solid var(--semantic-critical)',
    };
  }

  const t = util / 100;
  return {
    bg: `rgba(28, 107, 58, ${(0.1 + t * 0.55).toFixed(3)})`,
    fg: t > 0.65 ? '#fff' : 'var(--neutral-text-primary)',
  };
}
