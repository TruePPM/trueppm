import type { Risk } from '@/api/types';

// Zone background token per severity band (rule 88). No hex literals — tokens defined in tailwind.config.ts.
function cellBgClass(probability: number, impact: number): string {
  const severity = probability * impact;
  if (severity >= 20) return 'bg-risk-zone-critical';
  if (severity >= 12) return 'bg-risk-zone-high';
  if (severity >= 6)  return 'bg-risk-zone-medium';
  if (severity >= 2)  return 'bg-risk-zone-low';
  return 'bg-risk-zone-minimal';
}

// Badge background matches the design ring formula (mockups-pages.jsx ringFor).
function badgeBgClass(severity: number): string {
  if (severity >= 20) return 'bg-semantic-critical text-white';
  if (severity >= 12) return 'bg-brand-accent-dark text-white';
  if (severity >= 6)  return 'bg-brand-accent text-white';
  if (severity >= 2)  return 'bg-semantic-on-track text-white';
  return 'bg-neutral-border text-neutral-text-secondary';
}

// Compact badge label for a matrix cell: the server's display id without the
// "R-" prefix ("R-007" → "007"). Pure presentation — the identifier itself is
// server-owned, so the badge no longer re-parses the raw short_id.
function badgeLabel(displayId: string): string {
  if (!displayId) return '?';
  return displayId.replace(/^R-/, '');
}

// Cell: 60px to match design (mockups-pages.jsx gridTemplateRows: "repeat(5, 60px)").
const CELL_SIZE = 'w-[60px] h-[60px]';

interface RiskMatrixCellProps {
  probability: number;
  impact: number;
  risksInCell: Risk[];
  isSelected: boolean;
  isInteractive: boolean;
  onSelect: (probability: number, impact: number) => void;
}

/**
 * A single probability × impact cell of the risk matrix.
 *
 * Renders the zone-tinted clickable button (rule 88 tokens, no hex literals) with
 * one compact severity badge per risk that falls in the cell. Behavior, zone tokens,
 * and accessible names are owned here so `RiskMatrix` only maps over the grid.
 */
export function RiskMatrixCell({
  probability,
  impact,
  risksInCell,
  isSelected,
  isInteractive,
  onSelect,
}: RiskMatrixCellProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(probability, impact)}
      disabled={!isInteractive}
      aria-pressed={isSelected}
      aria-label={`P${probability} × I${impact} = ${probability * impact}, ${risksInCell.length} risk${risksInCell.length !== 1 ? 's' : ''}`}
      className={[
        CELL_SIZE,
        'flex flex-wrap items-center justify-center gap-0.5 p-0.5 overflow-hidden',
        cellBgClass(probability, impact),
        isInteractive ? 'cursor-pointer' : 'cursor-default',
        isSelected
          ? 'border-2 border-brand-primary z-10 relative'
          : 'border border-neutral-border/60',
        isInteractive
          ? 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1'
          : 'focus-visible:outline-none',
      ].join(' ')}
    >
      {risksInCell.map((r) => (
        <span
          key={r.id}
          className={[
            'inline-flex items-center justify-center',
            // Design spec is 22px; bumped to 26px to keep label at the
            // text-xs (12px) accessibility floor (rule 50). Still reads
            // as a compact badge and fits 4 per cell with wrap.
            'w-[26px] h-[26px] rounded-full shrink-0 text-xs font-semibold tppm-mono',
            badgeBgClass(r.severity),
          ].join(' ')}
          title={r.title}
          aria-hidden="true"
        >
          {badgeLabel(r.short_id_display)}
        </span>
      ))}
    </button>
  );
}
