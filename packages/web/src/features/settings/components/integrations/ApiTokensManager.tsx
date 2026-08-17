/**
 * API tokens list + create (one-time reveal) + revoke for the Integrations page
 * (#600). Works at project and program scope via the `scope` prop.
 *
 * The one-time-reveal contract: the raw token is shown exactly once, in the
 * create modal's success state, with a copy button and an explicit "you won't
 * see this again" warning. After the modal closes it is unrecoverable.
 *
 * A token is minted with a capability scope (issue 601, ADR-0186 §F). At project
 * and program scope the only scope on offer is `legacy:full` (read + write, for CI
 * / inbound sync).
 *
 * `mcp:read` is deliberately NOT offered here (#2890). A token minted at project
 * or program scope has a null `owner`, and the MCP read surface admits owner-scoped
 * (personal) tokens only (`TokenIsOwnerScoped`, #1712) — so the config this page
 * used to generate 401'd the MCP server at `verify_auth()` on its very first boot,
 * with no message pointing at the cause. The server now rejects the scope on this
 * endpoint too; the connect affordance lives on the Personal Access Tokens page,
 * which mints the credential the read surface actually accepts.
 */

import { useState } from 'react';
import { Link } from 'react-router';
import { isAxiosError } from 'axios';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { SettingsCard } from '../../SettingsShell';
import {
  useApiTokens,
  useCreateApiToken,
  useRevokeApiToken,
  type ApiToken,
  type ApiTokenScope,
  type CreatedApiToken,
} from '@/hooks/useApiTokens';
import type { IntegrationScope } from '@/hooks/useWebhooks';
import { ConfirmDialog } from './WebhooksManager';
import { CopyButton, DoneButton, buildClaudeDesktopConfig } from './McpConnectPanel';

// Re-exported for the existing unit test and any other consumers that imported
// the helper from this module before it was extracted into McpConnectPanel.tsx.
export { buildClaudeDesktopConfig };

export interface ApiTokensManagerProps {
  scope: IntegrationScope;
}

/** Whether a created/listed token carries the read-only MCP scope. */
function isMcpRead(scopes: ApiTokenScope[] | undefined): boolean {
  return Array.isArray(scopes) && scopes.includes('mcp:read');
}

export function ApiTokensManager({ scope }: ApiTokensManagerProps) {
  const { data: tokens, isLoading, isError, refetch } = useApiTokens(scope);
  const revoke = useRevokeApiToken(scope);

  const [creating, setCreating] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<ApiToken | null>(null);

  const active = tokens?.filter((t) => !t.is_revoked) ?? [];

  return (
    <SettingsCard>
      <div className="px-4 pt-3.5 pb-2 flex items-center justify-between border-b border-neutral-border/55">
        <div className="flex items-center gap-2">
          <h2 className="text-[14px] font-semibold text-neutral-text-primary">
            {scope.kind === 'program' ? 'Program API tokens' : 'Inbound API tokens'}
          </h2>
          {tokens && (
            <span
              className="text-[12px] text-neutral-text-secondary tppm-mono"
              aria-label={`${active.length} active tokens`}
            >
              {active.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="h-7 px-3 text-[12px] font-medium rounded bg-brand-primary text-neutral-text-inverse hover:bg-brand-primary-dark focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Create token
        </button>
      </div>

      <p className="px-4 pt-3 text-[12px] text-neutral-text-secondary">
        {scope.kind === 'program'
          ? 'Program API tokens authenticate scripts and integrations that read or modify any project in this program via the REST API.'
          : 'API tokens authenticate scripts and integrations that read or modify this project’s data via the REST API.'}
      </p>

      <div className="px-4 py-3">
        {isLoading ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading tokens">
            <div className="h-4 w-3/4 bg-neutral-surface-sunken rounded motion-safe:animate-pulse" />
            <div className="h-4 w-1/2 bg-neutral-surface-sunken rounded motion-safe:animate-pulse" />
          </div>
        ) : isError ? (
          <div className="flex items-center gap-3">
            <p className="text-[13px] text-neutral-text-secondary flex-1">
              Couldn&apos;t load tokens.
            </p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="h-7 px-3 text-[12px] font-medium border border-neutral-border rounded text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Retry
            </button>
          </div>
        ) : !tokens || tokens.length === 0 ? (
          <p className="text-[13px] text-neutral-text-secondary">
            No tokens yet. Generate one to let CI or external tools push tasks into{' '}
            {scope.kind === 'program' ? 'any project in this program' : 'this project'}.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {tokens.map((tok) => (
              <li
                key={tok.id}
                className={[
                  'flex items-center gap-2 min-w-0 py-1.5 border-b border-neutral-border/40 last:border-0',
                  tok.is_revoked ? 'opacity-55' : '',
                ].join(' ')}
              >
                <span className="flex flex-col min-w-0 flex-1">
                  <span className="text-[13px] text-neutral-text-primary truncate">{tok.name}</span>
                  <span className="tppm-mono text-[11px] text-neutral-text-disabled">
                    {tok.token_prefix}…
                  </span>
                </span>
                <ScopeBadge scopes={tok.scopes} />
                <span className="text-[11px] text-neutral-text-secondary shrink-0">
                  {tok.is_revoked ? 'Revoked' : tok.last_used_at ? 'in use' : 'never used'}
                </span>
                {!tok.is_revoked && (
                  <button
                    type="button"
                    onClick={() => setConfirmRevoke(tok)}
                    className="h-6 px-2 text-[11px] font-medium rounded border border-neutral-border text-semantic-critical hover:bg-neutral-surface-sunken shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1"
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ScopesReference />

      {creating && <CreateTokenModal scope={scope} onClose={() => setCreating(false)} />}

      {confirmRevoke && (
        <ConfirmDialog
          title="Revoke token?"
          body={`"${confirmRevoke.name}" will stop working immediately. Integrations using it will fail until re-issued.`}
          confirmLabel="Revoke token"
          pending={revoke.isPending}
          onCancel={() => setConfirmRevoke(null)}
          onConfirm={() => {
            revoke.mutate(confirmRevoke.id, { onSuccess: () => setConfirmRevoke(null) });
          }}
        />
      )}
    </SettingsCard>
  );
}

/**
 * Compact scope pill for a token row. Renders nothing when the token has no
 * scopes yet — this component develops in parallel with the backend (issue
 * 601), and a not-yet-rebased API omits the field entirely.
 */
function ScopeBadge({ scopes }: { scopes: ApiTokenScope[] | undefined }) {
  if (!scopes || scopes.length === 0) return null;
  const readOnly = isMcpRead(scopes);
  return (
    <span
      className={[
        'shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded',
        readOnly
          ? 'bg-brand-primary/10 text-brand-primary'
          : 'bg-neutral-surface-sunken text-neutral-text-secondary',
      ].join(' ')}
    >
      {readOnly ? 'Read-only' : 'Full'}
    </span>
  );
}

function ScopesReference() {
  return (
    <div className="px-4 pb-3 pt-1">
      <p className="text-[11px] text-neutral-text-secondary">
        Tokens authenticate inbound requests as{' '}
        <span className="tppm-mono">Authorization: Bearer tppm_…</span>. A token sees only the data
        its scope allows.
      </p>
    </div>
  );
}

function CreateTokenModal({ scope, onClose }: { scope: IntegrationScope; onClose: () => void }) {
  const create = useCreateApiToken(scope);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);

  // Multi-state dialog (#1776): the trap re-seats focus when the phase flips from
  // the create form to the one-time-reveal panel, so focus never drops to <body>
  // when the form controls unmount. Escape/close is guarded while the create
  // mutation is in-flight to mirror the backdrop-dismiss guard.
  const phase = created ? 'reveal' : 'form';
  const trapRef = useFocusTrap<HTMLDivElement>(
    true,
    () => {
      if (!create.isPending) onClose();
    },
    phase,
  );

  function handleCreate() {
    if (name.trim().length === 0) {
      setError('Give the token a name.');
      return;
    }
    setError(null);
    create.mutate(
      { name: name.trim(), scopes: ['legacy:full'] },
      {
        onSuccess: (data) => setCreated(data),
        onError: (e) => setError(extractError(e)),
      },
    );
  }

  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-label={created ? 'Token created' : 'Create API token'}
      tabIndex={-1}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-neutral-overlay p-4 focus:outline-none"
      onPointerDown={(e) => {
        // Once the token is revealed, a stray backdrop click must NOT dismiss it
        // — the plaintext is shown once and is unrecoverable (#2205). Gate on
        // !created so only the pre-creation form closes on an outside click.
        if (e.target === e.currentTarget && !create.isPending && !created) onClose();
      }}
    >
      <div className="bg-neutral-surface border border-neutral-border rounded-card w-full p-5 max-w-md">
        {created ? (
          <PlainTokenReveal token={created.token} onClose={onClose} />
        ) : (
          <>
            <h2 className="text-sm font-semibold text-neutral-text-primary mb-3">
              Create API token
            </h2>
            <label
              htmlFor="api-token-name"
              className="block mb-1 text-[13px] font-medium text-neutral-text-primary"
            >
              Name
            </label>
            <input
              id="api-token-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Jira Production"
              className="w-full h-8 px-2 text-[13px] border border-neutral-border rounded bg-neutral-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            />

            <TokenPurposeNote />

            {error && (
              <p className="text-[12px] text-semantic-critical mt-2" role="alert">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={onClose}
                disabled={create.isPending}
                className="h-8 px-3 rounded border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={create.isPending}
                className="h-8 px-3 rounded bg-brand-primary text-neutral-text-inverse text-[13px] font-medium hover:bg-brand-primary-dark disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                {create.isPending ? 'Creating…' : 'Create token'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * What this token is for, and where to go if it is the other thing (#2890).
 *
 * This replaced a two-option scope picker whose second option, "Read-only for AI
 * assistants" (`mcp:read`), minted a credential the MCP read surface refuses: a
 * project/program token has a null `owner` and `TokenIsOwnerScoped` (#1712) 401s it
 * at the MCP server's boot-time auth check. So the picker offered a choice with one
 * real answer and one dead end that failed several steps later, outside the app.
 *
 * A single scope needs no radio group — but it does need the signpost, because the
 * page a user lands on looking for "connect an AI assistant" is this one.
 */
function TokenPurposeNote() {
  return (
    <div className="mt-4">
      <p className="text-[13px] font-medium text-neutral-text-primary">
        Full access (inbound sync)
      </p>
      <p className="mt-0.5 text-[12px] text-neutral-text-secondary">
        Reads and writes this project&apos;s data — lets CI or external tools push tasks in.
      </p>
      <p className="mt-2 text-[12px] text-neutral-text-secondary">
        Connecting an AI assistant? Read-only MCP tokens are personal, not project-scoped —
        create one from{' '}
        <Link
          to="/me/settings/api-tokens"
          className="rounded text-brand-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Personal Settings → API tokens
        </Link>
        . It then reads only what your own role can see.
      </p>
    </div>
  );
}

/** The existing plain one-time reveal for a `legacy:full` token, unchanged. */
function PlainTokenReveal({ token, onClose }: { token: string; onClose: () => void }) {
  return (
    <>
      <h2 className="text-sm font-semibold text-neutral-text-primary mb-2" aria-live="polite">
        Token created — copy it now
      </h2>
      <p className="text-xs text-semantic-critical mb-3">
        This is the only time you&apos;ll see this token. Store it somewhere safe; it can&apos;t be
        retrieved again.
      </p>
      <div className="flex items-center gap-2 mb-4">
        <input
          readOnly
          value={token}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="New API token"
          className="tppm-mono flex-1 h-8 px-2 text-[12px] border border-neutral-border rounded bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        />
        <CopyButton value={token} label="Copy" accessibleName="Copy token" />
      </div>
      <div className="flex justify-end">
        <DoneButton onClose={onClose} />
      </div>
    </>
  );
}

function extractError(e: Error): string {
  if (isAxiosError(e) && e.response?.data && typeof e.response.data === 'object') {
    const data = e.response.data as Record<string, unknown>;
    const firstKey = Object.keys(data)[0];
    if (firstKey) {
      const val = data[firstKey];
      const msg: unknown = Array.isArray(val) ? (val as unknown[])[0] : val;
      return `${firstKey}: ${String(msg)}`;
    }
  }
  return 'Something went wrong. Please try again.';
}
