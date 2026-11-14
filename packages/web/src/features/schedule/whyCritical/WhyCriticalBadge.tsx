import type { BandKind } from './whyCriticalModel';

interface Props {
  band: BandKind | null;
  /** Total float in working days; `null` renders the badge without a number. */
  float: number | null;
  onActivate: () => void;
}

function days(n: number): string {
  return `${n} working ${n === 1 ? 'day' : 'days'}`;
}

/**
 * Drawer header badge (#4892) that replaces the static `CP` chip in the
 * Schedule drawer. A button: it selects Details and moves focus to the "Why
 * critical" heading. Renders only for the critical and near-critical bands;
 * an ample or unknown band shows nothing, so it disappears when a recompute
 * moves the task out of the band.
 */
export function WhyCriticalBadge({ band, float, onActivate }: Props) {
  if (band !== 'critical' && band !== 'near_critical') return null;
  const critical = band === 'critical';
  const word = critical ? 'Critical' : 'Near-critical';
  const label = float === null ? word : `${word} · ${float} wd float`;
  const aria =
    float === null
      ? `${word}. Show why it's ${critical ? 'critical' : 'near-critical'}.`
      : `${word}, ${days(float)} float. Show why it's ${critical ? 'critical' : 'near-critical'}.`;
  return (
    <button
      type="button"
      onClick={onActivate}
      aria-label={aria}
      className={[
        'min-h-6 text-xs font-semibold px-1.5 py-0.5 rounded-chip',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2',
        critical
          ? 'text-white bg-semantic-critical'
          : 'text-semantic-at-risk bg-semantic-at-risk/10 border border-semantic-at-risk',
      ].join(' ')}
    >
      {label}
    </button>
  );
}
