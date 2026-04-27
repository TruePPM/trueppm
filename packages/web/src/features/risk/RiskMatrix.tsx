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

// Badge background matches the severity band (rule 86).
function badgeBgClass(severity: number): string {
  if (severity >= 20) return 'bg-semantic-critical text-white';
  if (severity >= 12) return 'bg-brand-accent text-neutral-text-primary';
  if (severity >= 6)  return 'bg-semantic-warning text-white';
  if (severity >= 2)  return 'bg-semantic-on-track/80 text-white';
  return 'bg-neutral-border text-neutral-text-secondary';
}

interface RiskMatrixProps {
  risks: Risk[];
}

const LEGEND = [
  { label: 'Critical', range: '≥ 20', dotClass: 'bg-semantic-critical' },
  { label: 'High',     range: '12–19', dotClass: 'bg-brand-accent' },
  { label: 'Medium',   range: '6–11',  dotClass: 'bg-semantic-warning' },
  { label: 'Low',      range: '2–5',   dotClass: 'bg-semantic-on-track/80' },
] as const;

// Cell width: w-12 = 48px. 5 cells + 4 gaps (gap-px = 1px each) = 244px.
const CELL_CLASS = 'w-12 h-12';
const AXIS_LABEL_WIDTH = 'w-[244px]';

export function RiskMatrix({ risks }: RiskMatrixProps) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-neutral-text-primary mb-3">Risk Matrix</h3>

      <div className="flex gap-2">
        {/* Probability axis label — rotated, reads bottom-to-top */}
        <div className="flex flex-col items-center justify-center w-5 shrink-0">
          <span
            className="text-xs text-neutral-text-secondary whitespace-nowrap"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
          >
            ↑ Probability
          </span>
        </div>

        <div className="flex flex-col gap-1">
          {/* Probability row labels + grid */}
          {[5, 4, 3, 2, 1].map((prob) => (
            <div key={prob} className="flex items-center gap-1">
              {/* Row label */}
              <span className="text-xs text-neutral-text-secondary w-4 text-right shrink-0">
                {prob}
              </span>

              {/* 5 cells for impact 1–5 */}
              <div className="flex gap-px">
                {[1, 2, 3, 4, 5].map((imp) => {
                  const risksInCell = risks.filter(
                    (r) => r.probability === prob && r.impact === imp,
                  );
                  return (
                    <div
                      key={imp}
                      className={[
                        CELL_CLASS,
                        'border border-neutral-border flex flex-wrap items-center justify-center gap-0.5 p-1 overflow-hidden',
                        cellBgClass(prob, imp),
                      ].join(' ')}
                      title={`P${prob} × I${imp} = ${prob * imp}`}
                    >
                      {risksInCell.map((r) => (
                        <span
                          key={r.id}
                          className={[
                            'inline-flex items-center justify-center',
                            'w-9 h-9 rounded-full shrink-0 text-xs font-semibold',
                            badgeBgClass(r.severity),
                          ].join(' ')}
                          title={r.title}
                          aria-label={r.title}
                        >
                          {r.short_id.slice(0, 4)}
                        </span>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Impact column labels */}
          <div className="flex items-center gap-1 mt-1">
            <span className="w-4 shrink-0" aria-hidden="true" />
            <div className="flex gap-px">
              {[1, 2, 3, 4, 5].map((imp) => (
                <div
                  key={imp}
                  className="w-12 text-center text-xs text-neutral-text-secondary"
                >
                  {imp}
                </div>
              ))}
            </div>
          </div>

          {/* Impact axis label */}
          <div className="flex items-center gap-1">
            <span className="w-4 shrink-0" aria-hidden="true" />
            <div className={`${AXIS_LABEL_WIDTH} text-center text-xs text-neutral-text-secondary`}>
              ← Impact →
            </div>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-1 mt-3">
            <span className="w-4 shrink-0" aria-hidden="true" />
            <dl className="flex flex-col gap-1.5">
              {LEGEND.map(({ label, range, dotClass }) => (
                <div key={label} className="flex items-center gap-2">
                  <span
                    className={['w-2.5 h-2.5 rounded-full shrink-0', dotClass].join(' ')}
                    aria-hidden="true"
                  />
                  <dt className="text-xs font-medium text-neutral-text-primary w-14 shrink-0">
                    {label}
                  </dt>
                  <dd className="text-xs text-neutral-text-secondary">{range}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
