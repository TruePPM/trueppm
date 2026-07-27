/**
 * The "Agents" sub-view of the project Activity tab (#2481, ADR-0677).
 *
 * The team-facing half of the agent-oversight surface: a project-scoped read of
 * the hash-chained `AgentAction` log (ADR-0112/0421), rendered with the same
 * components as the program panel (#2020) so the two never drift. The API was
 * already team-readable and `?project=`-filterable — this is a placement change,
 * not a new capability, and it stays strictly read-only.
 *
 * Sibling of the ADR-0201 changelog ("what changed") on the same tab. The two are
 * deliberately separate queries and separate components: an agent *read* changed
 * nothing, and interleaving it into the changelog would render it as if it had.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { AgentAction } from '@/api/types';
import { AgentIcon } from '@/components/Icons';
import { EmptyState } from '@/components/EmptyState';
import { QueryErrorState } from '@/components/QueryErrorState';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { AgentActivityTable } from '@/features/programs/agents/AgentActivityTable';
import { AgentActionDrawer } from '@/features/programs/agents/AgentActionDrawer';
import { RefusalLog } from '@/features/programs/agents/RefusalLog';
import { useProjectAgentActions } from './useProjectAgentActions';
import type { AgentRange } from './agentActivityUrl';
import { AGENT_RANGES } from './agentActivityUrl';

// A navigating anchor keeps `focus-visible:` — a clicked link does not retain
// focus, so the rule-214 `focus:` carve-out (standalone buttons/tabs) does not apply.
const LINK_FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1';

export interface ProjectAgentActivityProps {
  projectId: string | undefined;
  /** Show only `verdict=refused` rows — the host tab's filter band owns this state. */
  refusalsOnly: boolean;
  /** Time window — also owned by the host tab's filter band. */
  range: AgentRange;
}

export function ProjectAgentActivity({
  projectId,
  refusalsOnly,
  range,
}: ProjectAgentActivityProps) {
  const [selected, setSelected] = useState<AgentAction | null>(null);
  const { user } = useCurrentUser();

  // Recomputed only when the range changes, so the query key stays stable across
  // renders (an inline `Date.now()` would churn the key every render and refetch
  // in a loop).
  const since = useMemo(() => {
    const ms = AGENT_RANGES.find((r) => r.key === range)?.ms ?? null;
    return ms === null ? undefined : new Date(Date.now() - ms).toISOString();
  }, [range]);

  const q = useProjectAgentActions(projectId, {
    since,
    verdict: refusalsOnly ? 'refused' : undefined,
  });

  // A token's own actions are the only principal we can name from the client;
  // everyone else stays an opaque id, exactly as the program panel does.
  const resolvePrincipal = (id: string | null) => (id && user?.id === id ? 'You' : null);

  return (
    <div className="px-4 py-4">
      {q.isLoading && <TableSkeleton />}

      {/* A failed fetch must never render as "no agent has ever acted here" — on an
          oversight surface that is the one misreading that matters (web-rule 246). */}
      {!q.isLoading && q.isError && (
        <QueryErrorState
          variant="inline"
          message="Couldn't load agent activity."
          onRetry={q.refetch}
        />
      )}

      {!q.isLoading && !q.isError && refusalsOnly && (
        // RefusalLog carries its own honest zero state — an empty refusal log is a
        // good outcome, not a cold start, so it must not read as an empty surface.
        <RefusalLog
          refusals={q.actions}
          resolvePrincipal={resolvePrincipal}
          onSelect={setSelected}
          hasNextPage={q.hasNextPage}
          fetchNextPage={q.fetchNextPage}
          isFetchingNextPage={q.isFetchingNextPage}
        />
      )}

      {!q.isLoading && !q.isError && !refusalsOnly && q.actions.length === 0 && (
        <EmptyState
          icon={AgentIcon}
          title="No agent activity yet"
          description="When an MCP client or agent reads this project, every action it takes is recorded here — tamper-evident and verifiable by your team, not just an admin."
          action={
            <Link
              to="/me/settings/api-tokens"
              className={`rounded-control bg-brand-primary px-3 py-2 text-sm font-medium text-neutral-text-inverse hover:opacity-90 ${LINK_FOCUS_RING}`}
            >
              Connect an agent →
            </Link>
          }
        />
      )}

      {!q.isLoading && !q.isError && !refusalsOnly && q.actions.length > 0 && (
        <AgentActivityTable
          actions={q.actions}
          resolvePrincipal={resolvePrincipal}
          onSelect={setSelected}
          hasNextPage={q.hasNextPage}
          fetchNextPage={q.fetchNextPage}
          isFetchingNextPage={q.isFetchingNextPage}
          showReadOnlyStrip={q.actions.every((a) => a.method === 'GET')}
        />
      )}

      {/* The project is the surface, so re-stating its name inside the drawer
          would be a second copy of a value the shell already carries (rule 284). */}
      <AgentActionDrawer
        action={selected}
        projectName={null}
        principalName={selected ? resolvePrincipal(selected.principal) : null}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-2" role="status" aria-label="Loading agent activity">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="h-12 rounded-card border border-neutral-border bg-neutral-surface-sunken motion-safe:animate-pulse"
        />
      ))}
    </div>
  );
}
