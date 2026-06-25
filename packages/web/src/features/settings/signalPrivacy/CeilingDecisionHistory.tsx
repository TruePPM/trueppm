/**
 * Team-readable audit tail of resolved ceiling-raise proposals (ADR-0104
 * Amendment A.6 / issue 930, issue 1260).
 *
 * Collapsed by default and fetched lazily — open proposals are already shown inline on
 * their ladder row, so this section filters to terminal outcomes (ratified / rejected /
 * expired) and exists purely as the "what did the team decide, and when" record.
 */

import { useState } from 'react';
import { formatRelative } from '@/lib/formatRelative';
import {
  AUDIENCE_RUNG_LABEL_FULL,
  SIGNALS,
  useCeilingProposals,
  type CeilingProposal,
  type CeilingRaiseStatus,
} from './useSignalPrivacy';

const SIGNAL_TITLE: Record<string, string> = Object.fromEntries(
  SIGNALS.map((s) => [s.key, s.title]),
);

const OUTCOME: Record<Exclude<CeilingRaiseStatus, 'open'>, { glyph: string; label: string; cls: string }> = {
  ratified: { glyph: '✓', label: 'Ratified', cls: 'text-semantic-on-track' },
  rejected: { glyph: '✗', label: 'Rejected', cls: 'text-semantic-critical' },
  expired: { glyph: '⋯', label: 'Expired', cls: 'text-neutral-text-disabled' },
};

interface CeilingDecisionHistoryProps {
  projectId: string | undefined;
}

export function CeilingDecisionHistory({ projectId }: CeilingDecisionHistoryProps) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useCeilingProposals(projectId, open);

  // Open proposals live inline on their ladder row; the audit tail is the resolved set.
  const resolved: CeilingProposal[] = (data ?? []).filter((p) => p.status !== 'open');

  return (
    <section className="mt-4 rounded-card border border-neutral-border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded px-3 py-2 text-[12px] font-medium text-neutral-text-secondary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        Decision history
      </button>

      {open && (
        <div className="border-t border-neutral-border px-3 py-2">
          {isLoading && (
            <div className="h-5 animate-pulse rounded bg-neutral-surface-raised" aria-hidden="true" />
          )}
          {!isLoading && resolved.length === 0 && (
            <p className="text-[12px] text-neutral-text-secondary">No ceiling decisions yet.</p>
          )}
          {!isLoading && resolved.length > 0 && (
            <ul className="space-y-1.5">
              {resolved.map((p) => {
                const outcome = OUTCOME[p.status as Exclude<CeilingRaiseStatus, 'open'>];
                const when = p.resolved_at ? formatRelative(new Date(p.resolved_at)) : '';
                return (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]"
                  >
                    <span className={`font-medium ${outcome.cls}`}>
                      <span aria-hidden="true">{outcome.glyph}</span> {outcome.label}
                    </span>
                    <span className="text-neutral-text-primary">
                      {SIGNAL_TITLE[p.signal] ?? p.signal}
                    </span>
                    <span className="tppm-mono text-[11px] text-neutral-text-secondary">
                      {AUDIENCE_RUNG_LABEL_FULL[p.from_ceiling]} →{' '}
                      {AUDIENCE_RUNG_LABEL_FULL[p.to_ceiling]}
                    </span>
                    <span className="text-neutral-text-secondary">
                      · {p.approve_count}/{p.threshold} approved{when ? ` · ${when}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
