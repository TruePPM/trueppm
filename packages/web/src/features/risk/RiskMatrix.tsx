import type { Risk } from '@/api/types';
import { RiskMatrixCell } from './RiskMatrixCell';
import { isUnmitigated } from './riskFilters';

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

// 5 cells (60px each) + 4 × 1px gaps = 304px total grid width.
const GRID_WIDTH = 'w-[304px]';

export function RiskMatrix({ risks, selectedCell, onCellSelect }: RiskMatrixProps) {
  // "N unmitigated need action" callout (issue 1230): the count of active,
  // undecided threats (OPEN / MITIGATING) across the whole register — the ones
  // the matrix is warning about. Suppressed when the register is fully handled.
  const needActionCount = risks.filter(isUnmitigated).length;

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

                  return (
                    <RiskMatrixCell
                      key={imp}
                      probability={prob}
                      impact={imp}
                      risksInCell={risksInCell}
                      isSelected={isSelected}
                      isInteractive={!!onCellSelect}
                      onSelect={handleCellClick}
                    />
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
                  className={['w-3 h-3 rounded-chip shrink-0', swatchClass].join(' ')}
                  aria-hidden="true"
                />
                <dt className="text-xs font-medium text-neutral-text-primary">{label}</dt>
                <dd className="text-xs text-neutral-text-secondary">{range}</dd>
              </div>
            ))}
          </dl>

          {/* "N unmitigated need action" callout (issue 1230) — a plain-language
              summary of the live threat load beneath the matrix. */}
          {needActionCount > 0 && (
            <p
              className="mt-4 ml-6 inline-flex items-center gap-1.5 text-xs font-medium
                text-semantic-at-risk"
              role="status"
            >
              <span
                aria-hidden="true"
                className="inline-block w-1.5 h-1.5 rounded-full bg-semantic-at-risk shrink-0"
              />
              {needActionCount} unmitigated need action
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
