/**
 * Read-only "who sees what" matrix lens (ADR-0104 §1.1) — the same posture data as
 * the ladder, shown as a compact table. Cells are filled (●) up to the audience; a
 * 🔒 marks the ceiling column; columns beyond the ceiling are dimmed. No controls —
 * the natural default view for non-editors answering "who can see our velocity?".
 */

import {
  AUDIENCE_RUNG_LABEL,
  AUDIENCE_RUNG_LABEL_FULL,
  SIGNAL_AUDIENCE_LADDER,
  SIGNALS,
  audienceRank,
  type SignalKey,
  type SignalPair,
} from './useSignalPrivacy';

interface SignalMatrixLensProps {
  signals: Record<SignalKey, SignalPair>;
}

export function SignalMatrixLens({ signals }: SignalMatrixLensProps) {
  return (
    <div className="overflow-x-auto rounded-card border border-neutral-border">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-neutral-border bg-neutral-surface-sunken text-neutral-text-secondary">
            <th className="px-3 py-2 text-left font-semibold">Signal</th>
            {SIGNAL_AUDIENCE_LADDER.map((rung) => (
              // Full column name where the table has room, abbreviation as the
              // narrow fallback; the spelled-out name is always the header's
              // accessible name + hover title so "SM"/"PM" are never ambiguous (#975).
              <th
                key={rung}
                scope="col"
                aria-label={AUDIENCE_RUNG_LABEL_FULL[rung]}
                title={AUDIENCE_RUNG_LABEL_FULL[rung]}
                className="px-3 py-2 text-center font-semibold"
              >
                <span className="hidden md:inline">{AUDIENCE_RUNG_LABEL_FULL[rung]}</span>
                <span className="md:hidden">{AUDIENCE_RUNG_LABEL[rung]}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SIGNALS.map(({ key, title }) => {
            const pair = signals[key];
            const audienceIdx = audienceRank(pair.audience);
            const ceilingIdx = audienceRank(pair.ceiling);
            return (
              <tr key={key} className="border-b border-neutral-border last:border-0">
                <td className="px-3 py-2 text-neutral-text-primary">{title}</td>
                {SIGNAL_AUDIENCE_LADDER.map((rung, idx) => {
                  const filled = idx <= audienceIdx;
                  const isCeiling = idx === ceilingIdx;
                  const beyond = idx > ceilingIdx;
                  return (
                    <td
                      key={rung}
                      className={[
                        'px-3 py-2 text-center',
                        beyond ? 'text-neutral-text-disabled' : 'text-neutral-text-primary',
                      ].join(' ')}
                    >
                      {filled ? '●' : isCeiling ? '🔒' : '·'}
                      {!filled && isCeiling ? '' : isCeiling && filled ? ' 🔒' : ''}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="px-3 py-2 text-[11px] text-neutral-text-secondary">
        ● visible now · 🔒 ceiling (max the team has authorized)
      </p>
    </div>
  );
}
