import { cellColor } from './cellColor';

interface Props {
  util: number;
  resourceName: string;
  weekLabel: string; // e.g. "2026-W18"
  onClick: () => void;
}

/**
 * A single utilization cell in the team heatmap grid.
 *
 * Color is computed from the utilization percent using the design-spec
 * cellColor() function (issue #217).  Cells with util > 100 also render
 * a semantic-critical border.
 *
 * Accessible: aria-label includes resource + week + percent so color is
 * never the sole signal (WCAG 1.4.1).
 */
export function HeatmapCell({ util, resourceName, weekLabel, onClick }: Props) {
  const weekNum = weekLabel.includes('-W') ? `W${weekLabel.split('-W')[1]}` : weekLabel;
  const { bg, fg, border } = cellColor(util);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${resourceName}, ${weekNum}, ${util}% utilized`}
      className={[
        'flex items-center justify-center rounded h-9 text-xs font-medium tppm-mono',
        'mx-0.5 my-[3px] w-full',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
        'transition-opacity hover:opacity-80 cursor-pointer',
      ].join(' ')}
      style={{ backgroundColor: bg, color: fg, border: border ?? 'none' }}
    >
      {util > 0 ? `${util}%` : ''}
    </button>
  );
}
