/**
 * API tokens list + create (one-time reveal) + revoke for the Integrations page
 * (#600). Works at project and program scope via the `scope` prop.
 *
 * The one-time-reveal contract: the raw token is shown exactly once, in the
 * create modal's success state, with a copy button and an explicit "you won't
 * see this again" warning. After the modal closes it is unrecoverable.
 *
 * A token is minted with a capability scope (issue 601, ADR-0186 §F):
 * `legacy:full` (the default — read + write, for CI / inbound sync) or
 * `mcp:read` (read-only, for pointing an MCP client such as Claude Desktop at
 * the instance). Creating an `mcp:read` token additionally reveals a
 * copy-paste `claude_desktop_config.json` snippet so the user can wire up their
 * AI client without touching the shell.
 */

import { useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
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
import {
  CopyButton,
  DoneButton,
  McpConnectPanel,
  buildClaudeDesktopConfig,
} from './McpConnectPanel';

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
            {scope.kind === 'program' ? 'any project in this program' : 'this project'}, or connect
            an AI assistant read-only.
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
  const [tokenScope, setTokenScope] = useState<ApiTokenScope>('legacy:full');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  function handleCreate() {
    if (name.trim().length === 0) {
      setError('Give the token a name.');
      return;
    }
    setError(null);
    create.mutate(
      { name: name.trim(), scopes: [tokenScope] },
      {
        onSuccess: (data) => setCreated(data),
        onError: (e) => setError(extractError(e)),
      },
    );
  }

  const revealMcp = created ? isMcpRead(created.scopes ?? [tokenScope]) : false;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={created ? 'Token created' : 'Create API token'}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-neutral-overlay p-4"
      onPointerDown={(e) => {
        // Once the token is revealed, a stray backdrop click must NOT dismiss it
        // — the plaintext is shown once and is unrecoverable (#2205). Gate on
        // !created so only the pre-creation form closes on an outside click.
        if (e.target === e.currentTarget && !create.isPending && !created) onClose();
      }}
    >
      <div
        className={[
          'bg-neutral-surface border border-neutral-border rounded-card w-full p-5',
          created && revealMcp ? 'max-w-lg' : 'max-w-md',
        ].join(' ')}
      >
        {created ? (
          revealMcp ? (
            <McpConnectPanel token={created.token} onClose={onClose} />
          ) : (
            <PlainTokenReveal token={created.token} onClose={onClose} />
          )
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
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Jira Production"
              className="w-full h-8 px-2 text-[13px] border border-neutral-border rounded bg-neutral-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            />

            <ScopeSelector value={tokenScope} onChange={setTokenScope} />

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

/** Radio group choosing what a new token is for (issue 1481, ADR-0186 §F). */
function ScopeSelector({
  value,
  onChange,
}: {
  value: ApiTokenScope;
  onChange: (v: ApiTokenScope) => void;
}) {
  const options: {
    scope: ApiTokenScope;
    label: string;
    help: string;
    describedBy: string;
  }[] = [
    {
      scope: 'legacy:full',
      label: 'Full access (inbound sync)',
      help: "Read and write this project's data — lets CI or external tools push tasks in.",
      describedBy: 'token-scope-full-help',
    },
    {
      scope: 'mcp:read',
      label: 'Read-only for AI assistants',
      help: "Lets Claude Desktop and other MCP clients read the schedule. It can't make any changes.",
      describedBy: 'token-scope-mcp-help',
    },
  ];

  return (
    <fieldset className="mt-4">
      <legend className="mb-1.5 text-[13px] font-medium text-neutral-text-primary">
        What is this token for?
      </legend>
      <div className="space-y-2">
        {options.map((opt) => {
          const selected = value === opt.scope;
          const inputId = `${opt.describedBy}-radio`;
          return (
            <label
              key={opt.scope}
              htmlFor={inputId}
              className={[
                'flex gap-2.5 p-2.5 rounded border cursor-pointer',
                selected
                  ? 'border-brand-primary ring-1 ring-brand-primary/40 bg-brand-primary/5'
                  : 'border-neutral-border hover:bg-neutral-surface-sunken',
              ].join(' ')}
            >
              <input
                id={inputId}
                type="radio"
                name="token-scope"
                value={opt.scope}
                checked={selected}
                onChange={() => onChange(opt.scope)}
                aria-describedby={opt.describedBy}
                className="mt-0.5 accent-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              />
              <span className="flex flex-col text-[13px] font-medium text-neutral-text-primary">
                {opt.label}
                <span
                  id={opt.describedBy}
                  className="text-[12px] font-normal text-neutral-text-secondary"
                >
                  {opt.help}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
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
