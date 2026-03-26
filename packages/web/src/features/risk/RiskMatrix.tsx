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

// Dot color matches the RiskChip text token for the severity band (rule 86).
function dotColorClass(severity: number): string {
  if (severity >= 20) return 'bg-semantic-critical';
  if (severity >= 12) return 'bg-brand-accent-dark';
  if (severity >= 6)  return 'bg-neutral-text-primary';
  return 'bg-neutral-text-secondary';
}

interface RiskMatrixProps {
  risks: Risk[];
}

export function RiskMatrix({ risks }: RiskMatrixProps) {
  return (
    <div className="mt-6">
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
                        'w-10 h-10 border border-neutral-border flex flex-wrap items-center justify-center gap-0.5 p-1',
                        cellBgClass(prob, imp),
                      ].join(' ')}
                      title={`P${prob} × I${imp} = ${prob * imp}`}
                    >
                      {risksInCell.map((r) => (
                        <span
                          key={r.id}
                          className={[
                            'w-2 h-2 rounded-full shrink-0',
                            dotColorClass(r.severity),
                          ].join(' ')}
                          title={r.title}
                          aria-label={r.title}
                        />
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
                  className="w-10 text-center text-xs text-neutral-text-secondary"
                >
                  {imp}
                </div>
              ))}
            </div>
          </div>

          {/* Impact axis label */}
          <div className="flex items-center gap-1">
            <span className="w-4 shrink-0" aria-hidden="true" />
            <div className="w-[212px] text-center text-xs text-neutral-text-secondary">
              ← Impact →
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
