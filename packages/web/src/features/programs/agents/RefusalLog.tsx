import { useMemo } from 'react';
import type { AgentAction } from '@/api/types';
import { formatRelative } from '@/lib/formatRelative';
import { GROUP_LABEL, refusalGroup, refusalWhy } from './agentDisplay';

export interface RefusalLogProps {
  refusals: AgentAction[];
  resolvePrincipal: (id: string | null) => string | null;
  onSelect: (action: AgentAction) => void;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  isFetchingNextPage: boolean;
}

/**
 * The concentrated view of what the engine *stopped* (#2020, design §4.3) —
 * ADR-0362's "refusal is the demo". Identity/policy read-refusals are real today;
 * the commitment refusal (a write rejected as schedule-infeasible) is the
 * forward-looking 0.6 row, designed and future-labelled here so it renders the
 * moment the gated-write surface lands.
 */
export function RefusalLog({
  refusals,
  resolvePrincipal,
  onSelect,
  hasNextPage,
  fetchNextPage,
  isFetchingNextPage,
}: RefusalLogProps) {
  const counts = useMemo(() => {
    let identity = 0;
    let policy = 0;
    for (const r of refusals) {
      if (refusalGroup(r) === 'identity') identity += 1;
      else policy += 1;
    }
    // commitment is the 0.6 forward-looking bucket — no producer emits it yet.
    return { identity, policy, commitment: 0 };
  }, [refusals]);

  const total = counts.identity + counts.policy + counts.commitment;

  return (
    <div>
      <ReasonDistribution counts={counts} total={total} />

      {refusals.length === 0 ? (
        <p role="status" className="mt-4 text-sm text-neutral-text-secondary">
          No refusals in this range. When the engine refuses an agent action — an expired token, a
          missing capability, or (with 0.6 writes) a change that would break your plan — it shows
          here with the reason.
        </p>
      ) : (
        <ul className="mt-4 flex list-none flex-col gap-2 p-0">
          {refusals.map((r) => {
            const group = refusalGroup(r);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onSelect(r)}
                  aria-label={`Refused action #${r.sequence}, ${r.action}, ${GROUP_LABEL[group]}`}
                  className="flex w-full flex-col gap-1 rounded-card border border-neutral-border bg-neutral-surface p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-text-secondary">
                    <span className="tppm-mono">
                      #{r.sequence} · {r.action} {r.method}
                    </span>
                    <span>{formatRelative(new Date(r.occurred_at))}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-semantic-critical">
                      <span aria-hidden="true">⛔</span> {GROUP_LABEL[group]}
                    </span>
                    <span className="text-neutral-text-secondary">{refusalWhy(r)}</span>
                    <span className="tppm-mono text-xs text-neutral-text-disabled">
                      {r.actor_token_prefix || '—'}
                      {resolvePrincipal(r.principal) ? ` → ${resolvePrincipal(r.principal)}` : ''}
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {hasNextPage && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            className="min-h-[44px] rounded-control border border-neutral-border px-4 text-sm font-medium text-neutral-text-secondary hover:text-neutral-text-primary disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary md:min-h-[36px]"
          >
            {isFetchingNextPage ? 'Loading…' : 'Load older'}
          </button>
        </div>
      )}

      <CommitmentForwardSection />
    </div>
  );
}

function ReasonDistribution({
  counts,
  total,
}: {
  counts: { identity: number; policy: number; commitment: number };
  total: number;
}) {
  const pct = (n: number) => (total > 0 ? `${(n / total) * 100}%` : '0%');
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-text-secondary">
        <span>
          Identity <span className="tppm-mono text-neutral-text-primary">{counts.identity}</span>
        </span>
        <span>
          Policy <span className="tppm-mono text-neutral-text-primary">{counts.policy}</span>
        </span>
        <span>
          Commitment{' '}
          <span className="tppm-mono text-neutral-text-primary">{counts.commitment}</span>
        </span>
      </div>
      <div
        className="mt-2 flex h-2 w-full max-w-md overflow-hidden rounded-full bg-neutral-surface-sunken"
        role="img"
        aria-label={`Refusal reasons: ${counts.identity} identity, ${counts.policy} policy, ${counts.commitment} commitment`}
      >
        {counts.identity > 0 && (
          <span
            className="block bg-neutral-text-disabled"
            style={{ width: pct(counts.identity) }}
          />
        )}
        {counts.policy > 0 && (
          <span
            className="block bg-neutral-text-secondary"
            style={{ width: pct(counts.policy), marginLeft: counts.identity > 0 ? 2 : 0 }}
          />
        )}
        {counts.commitment > 0 && (
          <span className="block bg-semantic-critical" style={{ width: pct(counts.commitment) }} />
        )}
      </div>
    </div>
  );
}

function CommitmentForwardSection() {
  return (
    <section className="mt-6 border-t border-dashed border-neutral-border pt-4">
      <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary">
        Commitment refusals · arrives with 0.6 writes
      </h3>
      <p className="mt-1 text-sm text-neutral-text-disabled">
        When agents can make changes, a write the engine refuses as schedule-infeasible will appear
        here with the binding constraint that fired and the projected impact on your plan — the same
        &ldquo;why this date?&rdquo; derivation the schedule view uses. No such refusal exists yet.
      </p>
    </section>
  );
}
