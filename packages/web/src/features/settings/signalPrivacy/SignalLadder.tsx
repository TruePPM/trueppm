/**
 * One signal's ladder row (ADR-0104 §1.1) — a 4-rung audience control with a
 * team-authorized ceiling.
 *
 * The track is filled (sage) up to the current audience; the ceiling is a 🔒
 * marker and rungs *beyond* it are dimmed/locked. A facilitator clicks any rung in
 * [Team … ceiling] to set the audience; the locked zone is unreachable without the
 * heavier, team-owned "Raise ceiling" act, surfaced as a separate affordance.
 */

import { LockIcon } from '@/components/Icons';
import type { ReactNode } from 'react';
import {
  AUDIENCE_RUNG_LABEL,
  AUDIENCE_RUNG_LABEL_FULL,
  SIGNAL_AUDIENCE_LADDER,
  audienceRank,
  type SignalAudience,
  type SignalPair,
} from './useSignalPrivacy';

interface SignalLadderProps {
  title: string;
  description: string;
  pair: SignalPair;
  canSet: boolean;
  canRaiseCeiling: boolean;
  pending?: boolean;
  /** A raise is already pending team ratification — block opening another. */
  hasOpenProposal?: boolean;
  /** The inline pending-ratification card for this signal, when one is open. */
  proposalSlot?: ReactNode;
  onSetAudience: (audience: SignalAudience) => void;
  onRaiseCeiling: () => void;
  onLowerCeiling: () => void;
}

export function SignalLadder({
  title,
  description,
  pair,
  canSet,
  canRaiseCeiling,
  pending,
  hasOpenProposal,
  proposalSlot,
  onSetAudience,
  onRaiseCeiling,
  onLowerCeiling,
}: SignalLadderProps) {
  const audienceIdx = audienceRank(pair.audience);
  const ceilingIdx = audienceRank(pair.ceiling);
  const ceilingLabel = AUDIENCE_RUNG_LABEL_FULL[pair.ceiling];

  return (
    <li className="px-4 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-semibold text-neutral-text-primary">{title}</h3>
        <span className="tppm-mono text-[11px] text-neutral-text-secondary">
          audience: {AUDIENCE_RUNG_LABEL_FULL[pair.audience]} · ceiling: {ceilingLabel}
        </span>
      </div>
      <p className="mt-0.5 text-[12px] text-neutral-text-secondary">{description}</p>

      {/* Ladder track */}
      <div
        role="radiogroup"
        aria-label={`${title} audience`}
        className="mt-3 flex items-center gap-1"
      >
        {SIGNAL_AUDIENCE_LADDER.map((rung, idx) => {
          const filled = idx <= audienceIdx;
          const locked = idx > ceilingIdx;
          const isCeiling = idx === ceilingIdx;
          const interactive = canSet && !locked && !pending;
          return (
            <button
              key={rung}
              type="button"
              role="radio"
              aria-checked={idx === audienceIdx}
              aria-disabled={!interactive}
              disabled={!interactive}
              // aria-label carries the full rung name regardless of which visible
              // label fits, so screen readers never hear a bare "SM"/"PM" (#975).
              aria-label={AUDIENCE_RUNG_LABEL_FULL[rung]}
              title={
                locked
                  ? `Beyond the team's ceiling — raise the ceiling to allow ${AUDIENCE_RUNG_LABEL_FULL[rung]}`
                  : AUDIENCE_RUNG_LABEL_FULL[rung]
              }
              onClick={() => interactive && onSetAudience(rung)}
              className={[
                'flex h-8 flex-1 items-center justify-center gap-1 rounded text-[11px] font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                filled
                  ? 'bg-sage-500 text-navy-900'
                  : locked
                    ? 'border border-dashed border-neutral-border text-neutral-text-disabled'
                    : 'border border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-sunken',
                interactive ? 'cursor-pointer' : 'cursor-not-allowed',
              ].join(' ')}
            >
              {/* Full label where the row has room; abbreviation as the narrow/mobile
                  fallback. The full name is always in aria-label + title above. */}
              <span className="hidden md:inline">{AUDIENCE_RUNG_LABEL_FULL[rung]}</span>
              <span className="md:hidden">{AUDIENCE_RUNG_LABEL[rung]}</span>
              {isCeiling && <LockIcon className="inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />}
            </button>
          );
        })}
      </div>

      {/* Ceiling controls */}
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[12px] text-neutral-text-secondary">🔒 Ceiling: {ceilingLabel}</span>
        {canRaiseCeiling && (
          <span className="flex gap-3">
            {ceilingIdx < SIGNAL_AUDIENCE_LADDER.length - 1 && (
              <button
                type="button"
                onClick={onRaiseCeiling}
                disabled={pending || hasOpenProposal}
                title={hasOpenProposal ? 'A raise is already pending for this signal' : undefined}
                className="text-[12px] font-medium text-sage-700 hover:underline disabled:opacity-50"
              >
                ↑ Raise ceiling…
              </button>
            )}
            {ceilingIdx > 0 && (
              <button
                type="button"
                onClick={onLowerCeiling}
                disabled={pending}
                className="text-[12px] text-neutral-text-secondary hover:underline disabled:opacity-50"
              >
                ↓ Lower ceiling
              </button>
            )}
          </span>
        )}
      </div>

      {proposalSlot}
    </li>
  );
}
