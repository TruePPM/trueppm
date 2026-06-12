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
// server-owned (#929), so the badge no longer re-parses the raw short_id.
function badgeLabel(displayId: string): string {
  if (!displayId) return '?';
  return displayId.replace(/^R-/, '');
}

export interface SelectedCell {
  probability: number;
  impact: number;
}

interface RiskMatrixProps {
  risks: Risk[];
  selectedCell?: SelectedCell | null;
  onCellSelect?: (cell: SelectedCell | null) => void;
}

// Legend swatches mirror badge bg colors (which now follow the design ring formula).
const LEGEND = [
  { label: 'Critical', range: '(P×I ≥ 20)', swatchClass: 'bg-semantic-critical' },
  { label: 'High',     range: '(12–19)',     swatchClass: 'bg-brand-accent-dark' },
  { label: 'Medium',   range: '(6–11)',      swatchClass: 'bg-brand-accent' },
  { label: 'Low',      range: '(1–5)',       swatchClass: 'bg-semantic-on-track' },
] as const;

// Cell: 60px to match design (mockups-pages.jsx gridTemplateRows: "repeat(5, 60px)").
// 5 cells + 4 × 1px gaps = 304px total grid width.
const CELL_SIZE = 'w-[60px] h-[60px]';
const GRID_WIDTH = 'w-[304px]';

export function RiskMatrix({ risks, selectedCell, onCellSelect }: RiskMatrixProps) {
  function handleCellClick(probability: number, impact: number) {
    if (!onCellSelect) return;
    const isActive = selectedCell?.probability === probability && selectedCell?.impact === impact;
    onCellSelect(isActive ? null : { probability, impact });
  }

  return (
    <div>
      <p className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-4">
        Probability × Impact
      </p>

      <div className="flex gap-2">
        {/* "PROBABILITY →" — rotated, reads bottom-to-top */}
        <div className="flex items-center justify-center w-5 shrink-0">
          <span
            className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary whitespace-nowrap"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
            aria-hidden="true"
          >
            Probability →
          </span>
        </div>

        <div
          role="grid"
          aria-label="Risk matrix"
          tabIndex={-1}
          className="flex flex-col gap-px"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && selectedCell) {
              // Stop propagation so the drawer Escape handler doesn't also fire
              e.stopPropagation();
              onCellSelect?.(null);
            }
          }}
        >
          {/* Rows: probability 5 → 1 (top to bottom) */}
          {[5, 4, 3, 2, 1].map((prob) => (
            <div key={prob} className="flex items-center gap-1">
              {/* Row label */}
              <span className="text-xs text-neutral-text-secondary w-5 text-right shrink-0 tppm-mono">
                {prob}
              </span>

              {/* 5 impact cells */}
              <div className="flex gap-px">
                {[1, 2, 3, 4, 5].map((imp) => {
                  const risksInCell = risks.filter(
                    (r) => r.probability === prob && r.impact === imp,
                  );
                  const isSelected = selectedCell?.probability === prob && selectedCell?.impact === imp;
                  const isInteractive = !!onCellSelect;

                  return (
                    <button
                      key={imp}
                      type="button"
                      onClick={() => handleCellClick(prob, imp)}
                      disabled={!isInteractive}
                      aria-pressed={isSelected}
                      aria-label={`P${prob} × I${imp} = ${prob * imp}, ${risksInCell.length} risk${risksInCell.length !== 1 ? 's' : ''}`}
                      className={[
                        CELL_SIZE,
                        'flex flex-wrap items-center justify-center gap-0.5 p-0.5 overflow-hidden',
                        cellBgClass(prob, imp),
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
                })}
              </div>
            </div>
          ))}

          {/* Impact column numbers */}
          <div className="flex items-center gap-1 mt-1">
            <span className="w-5 shrink-0" aria-hidden="true" />
            <div className="flex gap-px">
              {[1, 2, 3, 4, 5].map((imp) => (
                <div
                  key={imp}
                  className="w-[60px] text-center text-xs text-neutral-text-secondary tppm-mono"
                >
                  {imp}
                </div>
              ))}
            </div>
          </div>

          {/* "IMPACT →" axis label */}
          <div className="flex items-center gap-1 mt-0.5">
            <span className="w-5 shrink-0" aria-hidden="true" />
            <p className={`${GRID_WIDTH} text-center text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary`}>
              Impact →
            </p>
          </div>

          {/* Legend — square swatches */}
          <dl className="mt-4 flex flex-col gap-2 ml-6">
            {LEGEND.map(({ label, range, swatchClass }) => (
              <div key={label} className="flex items-center gap-2.5">
                <span
                  className={['w-3 h-3 rounded-sm shrink-0', swatchClass].join(' ')}
                  aria-hidden="true"
                />
                <dt className="text-xs font-medium text-neutral-text-primary">{label}</dt>
                <dd className="text-xs text-neutral-text-secondary">{range}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
