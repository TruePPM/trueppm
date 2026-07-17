import type { ReactNode } from 'react';
import type { AgentAction } from '@/api/types';
import { formatRelative } from '@/lib/formatRelative';
import { VERDICT_DISPLAY } from './agentDisplay';

export interface AgentActivityTableProps {
  actions: AgentAction[];
  resolvePrincipal: (id: string | null) => string | null;
  onSelect: (action: AgentAction) => void;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  isFetchingNextPage: boolean;
  /** Show the "today agents can only read" strip (auto-removed once a non-GET row appears). */
  showReadOnlyStrip: boolean;
}

/**
 * The team's chronological read of what its agents did across the program
 * (#2020, design §4.2). Columns map 1:1 to real AgentAction serializer fields —
 * no invented data. Each row opens the detail drawer; keyboard users focus the
 * per-row button whose accessible name summarizes the action.
 */
export function AgentActivityTable({
  actions,
  resolvePrincipal,
  onSelect,
  hasNextPage,
  fetchNextPage,
  isFetchingNextPage,
  showReadOnlyStrip,
}: AgentActivityTableProps) {
  return (
    <div>
      {showReadOnlyStrip && (
        <p
          role="note"
          className="mb-3 rounded-card border border-neutral-border bg-neutral-surface-sunken px-3 py-2 text-xs text-neutral-text-secondary"
        >
          Today agents can only read. Write actions — and the refusals that guard your plan — arrive
          with the 0.6 write surface.
        </p>
      )}

      {/* Desktop / tablet table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-max border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-border text-xs uppercase tracking-wide text-neutral-text-secondary">
              <Th>When</Th>
              <Th>Seq</Th>
              <Th>Action</Th>
              <Th>Actor</Th>
              <Th>On behalf</Th>
              <Th>Capability</Th>
              <Th>Verdict</Th>
            </tr>
          </thead>
          <tbody>
            {actions.map((action) => {
              const verdict = VERDICT_DISPLAY[action.verdict];
              const principal = resolvePrincipal(action.principal);
              return (
                <tr
                  key={action.id}
                  onClick={() => onSelect(action)}
                  className="cursor-pointer border-b border-neutral-border/60 hover:bg-neutral-surface-raised"
                >
                  <Td className="whitespace-nowrap text-neutral-text-secondary">
                    {formatRelative(new Date(action.occurred_at))}
                  </Td>
                  <Td>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(action);
                      }}
                      aria-label={`Action #${action.sequence}, ${action.action}, ${verdict.label}`}
                      className="tppm-mono rounded-chip px-1 text-xs text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                    >
                      #{action.sequence}
                    </button>
                  </Td>
                  <Td className="tppm-mono text-xs">
                    {action.action}{' '}
                    <span className="text-neutral-text-disabled">{action.method}</span>
                  </Td>
                  <Td className="tppm-mono text-xs text-neutral-text-secondary">
                    {action.actor_token_prefix || '—'}
                  </Td>
                  <Td className="text-neutral-text-secondary">{principal ?? '—'}</Td>
                  <Td className="tppm-mono text-xs text-neutral-text-secondary">
                    {action.capability_used || '—'}
                  </Td>
                  <Td className={`whitespace-nowrap font-medium ${verdict.textClass}`}>
                    <span aria-hidden="true">{verdict.symbol}</span> {verdict.label}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <ul className="flex list-none flex-col gap-2 p-0 md:hidden">
        {actions.map((action) => {
          const verdict = VERDICT_DISPLAY[action.verdict];
          const principal = resolvePrincipal(action.principal);
          return (
            <li key={action.id}>
              <button
                type="button"
                onClick={() => onSelect(action)}
                aria-label={`Action #${action.sequence}, ${action.action}, ${verdict.label}`}
                className="flex w-full flex-col gap-1 rounded-card border border-neutral-border bg-neutral-surface p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              >
                <div className="flex items-center justify-between gap-2 text-xs text-neutral-text-secondary">
                  <span className="tppm-mono">#{action.sequence}</span>
                  <span>{formatRelative(new Date(action.occurred_at))}</span>
                </div>
                <div className="tppm-mono text-sm text-neutral-text-primary">
                  {action.action}{' '}
                  <span className="text-neutral-text-disabled">{action.method}</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="tppm-mono text-neutral-text-secondary">
                    {action.actor_token_prefix || '—'}
                    {principal ? ` → ${principal}` : ''}
                  </span>
                  <span className={`font-medium ${verdict.textClass}`}>
                    <span aria-hidden="true">{verdict.symbol}</span> {verdict.label}
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>

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
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th scope="col" className="px-3 py-2 text-left font-medium">
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-3 py-2 align-middle ${className}`}>{children}</td>;
}
