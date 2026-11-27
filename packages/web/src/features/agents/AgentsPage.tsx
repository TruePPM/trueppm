/**
 * Workspace › Agents (#4757, #4814). Every agent the person can see across the
 * programs they belong to, and — for their own agents, or any agent if they are a
 * workspace Admin — the controls: Pause, Edit scope, Revoke token.
 *
 * The page decides nothing. Visibility is filtered by the API, pause and scope are
 * enforced on every agent call by the server, and `write` is refused by the server;
 * the disabled Write column is a description of that rule, not the rule.
 */
import { useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { AgentDetail, AgentRow, AgentScope, AgentScopeLevel } from '@/api/types';
import { EmptyState } from '@/components/EmptyState';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { QueryErrorState } from '@/components/QueryErrorState';
import { PageFrame } from '@/components/page2/PageFrame';
import { formatRelative } from '@/lib/formatRelative';
import { LEVEL_LABEL, VerdictChip, includes, scopeInWords } from './agentWords';
import {
  useAgent,
  useAgentAuditVerify,
  useAgentControl,
  useAgents,
  useEditAgentScope,
} from './useAgents';

const FOCUS =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2';
const BTN = `inline-flex min-h-11 items-center justify-center rounded-control border border-neutral-border px-3 text-sm font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken disabled:opacity-50 ${FOCUS}`;

type Area = { key: string; label: string; covers?: string };

function serverMessage(error: unknown): string {
  const data = (error as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === 'object') {
    const scope = (data as { scope?: unknown }).scope;
    if (Array.isArray(scope) && typeof scope[0] === 'string') return scope[0];
    const detail = (data as { detail?: unknown }).detail;
    if (typeof detail === 'string') return detail;
  }
  return 'The server did not accept that change. Nothing was changed.';
}

function VerifiedLine() {
  const { data, isLoading, isError } = useAgentAuditVerify();
  if (isLoading)
    return <p className="text-sm text-neutral-text-secondary">Verifying action log…</p>;
  if (isError || !data)
    return (
      <p className="text-sm text-neutral-text-secondary">
        Action log not verified: the check could not run.
      </p>
    );
  const asOf = formatRelative(new Date(data.checked_at));
  return data.ok ? (
    <p className="text-sm text-neutral-text-secondary" data-testid="agents-verified">
      <span aria-hidden="true">✓ </span>Action log verified · {data.record_count} records · as of{' '}
      {asOf}
    </p>
  ) : (
    <p
      className="text-sm font-medium text-semantic-critical"
      role="status"
      data-testid="agents-verified"
    >
      <span aria-hidden="true">✕ </span>Action log broken at record {data.break_sequence} · as of{' '}
      {asOf}
    </p>
  );
}

function PausedChip({ row }: { row: AgentRow }) {
  if (!row.paused) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-chip border border-neutral-border px-2 py-0.5 text-xs font-medium text-neutral-text-primary">
      <span aria-hidden="true">❚❚</span> Paused
    </span>
  );
}

function AgentListRow({
  row,
  areas,
  selected,
  onSelect,
}: {
  row: AgentRow;
  areas: Area[];
  selected: boolean;
  onSelect: () => void;
}) {
  const last = row.last_action;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={`flex w-full min-h-11 flex-col gap-1 rounded-card border p-3 text-left ${selected ? 'border-brand-primary' : 'border-neutral-border'} bg-neutral-surface-raised ${FOCUS}`}
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-neutral-text-primary">{row.name}</span>
          <PausedChip row={row} />
          <span className="ml-auto text-xs text-neutral-text-secondary">
            {row.refusals_7d} refused in 7 days
          </span>
        </span>
        <span className="text-sm text-neutral-text-secondary">Acts for {row.principal.name}</span>
        <span className="text-sm text-neutral-text-secondary">
          {scopeInWords(row.effective_scope, areas)}
        </span>
        <span className="text-xs text-neutral-text-secondary">
          {last
            ? `Last action ${formatRelative(new Date(last.occurred_at))}${last.redacted ? ' · in a project you cannot read' : last.summary ? ` · ${last.summary}` : ''}`
            : 'No actions yet'}
        </span>
      </button>
    </li>
  );
}

function ScopeMatrix({
  agent,
  areas,
  onDone,
}: {
  agent: AgentDetail;
  areas: Area[];
  onDone?: () => void;
}) {
  const editing = onDone !== undefined;
  const [draft, setDraft] = useState<AgentScope>(agent.scope);
  const edit = useEditAgentScope(agent.id);
  const writeNote = useId();
  const capped = areas.some((a) => agent.scope[a.key] !== agent.effective_scope[a.key]);

  const set = (key: string, column: 'read' | 'propose', on: boolean) => {
    let level: AgentScopeLevel;
    if (column === 'read')
      level = on ? (includes(draft[key], 'propose') ? 'propose' : 'read') : 'none';
    else level = on ? 'propose' : includes(draft[key], 'read') ? 'read' : 'none';
    setDraft({ ...draft, [key]: level });
  };

  const cell = (key: string, column: 'read' | 'propose', label: string) => {
    const level = editing ? draft[key] : agent.scope[key];
    const on = includes(level, column);
    if (!editing) {
      return (
        <td className="px-2 py-2 text-sm">
          {on ? (
            <>
              <span aria-hidden="true">✓ </span>Yes
            </>
          ) : (
            <>
              <span aria-hidden="true">– </span>No
            </>
          )}
        </td>
      );
    }
    return (
      <td className="px-2 py-1">
        <label className="inline-flex min-h-11 min-w-11 items-center justify-center">
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => set(key, column, e.target.checked)}
            aria-label={`${label}: ${LEVEL_LABEL[column]}`}
            className={`h-4 w-4 ${FOCUS}`}
          />
        </label>
      </td>
    );
  };

  return (
    <div>
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">Capability scope for {agent.name}</caption>
        <thead>
          <tr className="text-xs text-neutral-text-secondary">
            <th scope="col" className="px-2 py-2 font-medium">
              Area
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              Read
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              Dry run
            </th>
            <th scope="col" className="px-2 py-2 font-medium" id={writeNote}>
              Write · <span aria-hidden="true">◌</span> Ships in 0.6
            </th>
          </tr>
        </thead>
        <tbody>
          {areas.map((a) => (
            <tr key={a.key} className="border-t border-neutral-border">
              <th scope="row" className="px-2 py-2 text-sm font-normal text-neutral-text-primary">
                {a.label}
                {a.covers && (
                  <span className="mt-0.5 block text-xs text-neutral-text-secondary">
                    {a.covers}
                  </span>
                )}
              </th>
              {cell(a.key, 'read', a.label)}
              {cell(a.key, 'propose', a.label)}
              <td className="px-2 py-1">
                <label className="inline-flex min-h-11 min-w-11 items-center justify-center">
                  <input
                    type="checkbox"
                    checked={false}
                    disabled
                    aria-label={`${a.label}: Write`}
                    aria-describedby={writeNote}
                    className="h-4 w-4"
                  />
                </label>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-neutral-text-secondary">
        Dry run is saved now and takes effect when plan mode ships: the agent will be able to ask
        what a change would do without changing anything. Write ships in 0.6.
      </p>
      <p className="mt-1 text-xs text-neutral-text-secondary" data-testid="agents-export-note">
        Project and program exports carry every area, so they need Read on all four.
      </p>
      {capped && (
        <p className="mt-1 text-xs text-neutral-text-secondary">
          Capped at what {agent.principal.name} can do now: an agent never has more access than the
          person it acts for.
        </p>
      )}
      {editing && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className={BTN}
            disabled={edit.isPending}
            onClick={() => edit.mutate({ scope: draft }, { onSuccess: onDone })}
          >
            Save scope
          </button>
          <button type="button" className={BTN} onClick={onDone}>
            Cancel
          </button>
          {edit.isError && (
            <p role="alert" className="w-full text-sm text-neutral-text-primary">
              {serverMessage(edit.error)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function AgentPanel({ id, areas }: { id: string; areas: Area[] }) {
  const { data: agent, isLoading, isError, refetch } = useAgent(id);
  const control = useAgentControl(id);
  const [editing, setEditing] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const headingId = useId();

  if (isLoading) return <LoadingSkeleton label="Loading agent" variant="rows" />;
  if (isError || !agent)
    return (
      <QueryErrorState message="This agent could not be loaded." onRetry={() => void refetch()} />
    );

  const revoked = agent.revoked_at !== null;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4 rounded-card border border-neutral-border bg-neutral-surface-raised p-4"
    >
      <header className="flex flex-col gap-1">
        <h2 id={headingId} className="text-lg font-semibold text-neutral-text-primary">
          {agent.name}
        </h2>
        <p className="text-sm text-neutral-text-secondary">
          Acts for {agent.principal.name} · token{' '}
          <span className="tppm-mono">tppm_{agent.token_prefix}…</span>
        </p>
        {agent.paused && (
          <p className="text-sm text-neutral-text-primary">
            <span aria-hidden="true">❚❚ </span>Paused by{' '}
            {agent.paused.paused_by?.name ?? 'a deleted account'}{' '}
            {formatRelative(new Date(agent.paused.paused_at))}. Every call it makes is refused.
          </p>
        )}
        {revoked && (
          <p className="text-sm text-neutral-text-primary">
            <span aria-hidden="true">⊘ </span>Token revoked. This agent can no longer connect.
          </p>
        )}
        {agent.programs.length > 0 && (
          <p className="text-sm text-neutral-text-secondary">
            Active in{' '}
            {agent.programs.map((p, i) => (
              <span key={p.id}>
                {i > 0 && ', '}
                <Link to={`/programs/${p.id}/agents`} className={`underline ${FOCUS}`}>
                  {p.name}
                </Link>
              </span>
            ))}
          </p>
        )}
      </header>

      {agent.can_manage && !revoked && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={BTN}
            disabled={control.isPending}
            onClick={() => control.mutate({ action: agent.paused ? 'resume' : 'pause' })}
          >
            {agent.paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className={BTN} onClick={() => setEditing(true)} disabled={editing}>
            Edit scope
          </button>
          {confirmRevoke ? (
            <span
              role="group"
              aria-label="Confirm revoke"
              className="flex flex-wrap items-center gap-2"
            >
              <span className="text-sm text-neutral-text-primary">
                Revoking is immediate and cannot be undone.
              </span>
              <button
                type="button"
                className={BTN}
                onClick={() =>
                  control.mutate({ action: 'revoke' }, { onSettled: () => setConfirmRevoke(false) })
                }
              >
                Revoke now
              </button>
              <button type="button" className={BTN} onClick={() => setConfirmRevoke(false)}>
                Keep token
              </button>
            </span>
          ) : (
            <button type="button" className={BTN} onClick={() => setConfirmRevoke(true)}>
              Revoke token
            </button>
          )}
          {control.isError && (
            <p role="alert" className="w-full text-sm text-neutral-text-primary">
              {serverMessage(control.error)}
            </p>
          )}
        </div>
      )}

      <div>
        <h3 className="mb-1 text-sm font-semibold text-neutral-text-primary">Capability scope</h3>
        <ScopeMatrix
          key={`${agent.id}-${editing ? 'edit' : 'view'}`}
          agent={agent}
          areas={areas}
          onDone={editing ? () => setEditing(false) : undefined}
        />
      </div>

      <div>
        <h3 className="mb-1 text-sm font-semibold text-neutral-text-primary">Recent actions</h3>
        {agent.recent_actions.length === 0 ? (
          <p className="text-sm text-neutral-text-secondary">No actions recorded yet.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Recent actions">
            {agent.recent_actions.map((a) => (
              <li key={a.id} className="flex flex-col gap-1 border-t border-neutral-border pt-2">
                <span className="flex flex-wrap items-center gap-2">
                  {a.actor_kind === 'person' ? (
                    <span className="text-xs font-medium text-neutral-text-secondary">
                      Control change
                    </span>
                  ) : (
                    <VerdictChip verdict={a.verdict} constraint={a.constraint} />
                  )}
                  <span className="text-xs text-neutral-text-secondary">
                    {formatRelative(new Date(a.occurred_at))}
                  </span>
                </span>
                <span className="text-sm text-neutral-text-primary">
                  {a.redacted ? 'In a project you cannot read' : a.summary || a.action}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** The workspace Agents page. */
export function AgentsPage() {
  const { data, isLoading, isError, error, refetch } = useAgents();
  const [selected, setSelected] = useState<string | null>(null);
  const agents = data?.agents ?? [];
  const areas = data?.areas ?? [];
  // `?agent=<id>` is how a refused-agent Inbox item opens this page on its agent
  // (#5110). A row the person picks wins over it. An id not on the list (the agent
  // was revoked since, or is no longer visible to this person) shows a notice and
  // falls back to the first agent, rather than silently opening a different one.
  // A truncated list cannot tell "gone" from "past the cap", so it says only that
  // the list is partial.
  const [searchParams] = useSearchParams();
  const requested = searchParams.get('agent');
  const requestedListed = requested !== null && agents.some((row) => row.id === requested);
  const current = selected ?? (requestedListed ? requested : null) ?? agents[0]?.id ?? null;
  const requestedMissing =
    requested !== null &&
    !requestedListed &&
    selected === null &&
    !isLoading &&
    !isError &&
    agents.length > 0;
  const requestedNotice = !requestedMissing
    ? ''
    : data?.truncated
      ? `The agent from your Inbox item is not among the first ${agents.length} agents this list shows. The list is partial.`
      : 'The agent from your Inbox item is no longer on this list. Its token may have been revoked.';

  return (
    <PageFrame
      width="contained"
      header={
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-neutral-text-primary">Agents</h1>
          {data?.can_verify_log && <VerifiedLine />}
        </div>
      }
    >
      {/* Mounted empty before the list loads and filled afterwards: a live region
          that mounts already holding its text is not reliably announced. */}
      <p
        role="status"
        data-testid="agents-requested-notice"
        className={requestedNotice ? 'mb-2 text-sm text-neutral-text-secondary' : undefined}
      >
        {requestedNotice}
      </p>
      {isLoading ? (
        <LoadingSkeleton label="Loading agents" variant="rows" />
      ) : isError ? (
        <QueryErrorState
          message="Agents could not be loaded."
          error={error}
          onRetry={() => void refetch()}
        />
      ) : agents.length === 0 ? (
        <EmptyState
          variant="page"
          title="No agents configured"
          description="An agent is a personal access token with the read-only MCP scope. Create one under Settings › API tokens and connect your MCP client; it appears here once it exists."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-2">
            <p className="text-xs text-neutral-text-secondary">
              Refused: calls the server refused in the last 7 days, counting only actions you can
              see.
            </p>
            <ul className="flex flex-col gap-2" aria-label="Agents">
              {agents.map((row) => (
                <AgentListRow
                  key={row.id}
                  row={row}
                  areas={areas}
                  selected={row.id === current}
                  onSelect={() => setSelected(row.id)}
                />
              ))}
            </ul>
            {data?.truncated && (
              <p className="text-xs text-neutral-text-secondary">
                Showing the first {agents.length} agents. More exist than this list carries.
              </p>
            )}
          </div>
          {current && <AgentPanel key={current} id={current} areas={areas} />}
        </div>
      )}
    </PageFrame>
  );
}
