/**
 * Personal Access Tokens page — User → Settings → Personal Access Tokens
 * (issue 648, ADR-0214).
 *
 * A PAT is a user-scoped API credential (`Authorization: Bearer tppm_…`) that
 * authenticates a script *as you* — it carries exactly your RBAC. This page
 * lists your tokens with prefix, last-used, and expiry state; creates one with a
 * one-time raw-token reveal + copy button and an optional expiry; and revokes one
 * behind a confirm. A live "N of 10" cap indicator disables Create at the cap
 * (the server enforces the same cap; the indicator just avoids a wasted round
 * trip).
 *
 * The raw token is shown exactly once, in the create dialog's success state.
 * After the dialog closes it is unrecoverable — the server only stores its hash.
 */

import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import {
  MAX_PERSONAL_ACCESS_TOKENS,
  isTokenActive,
  useCreateMyApiToken,
  useMyApiTokens,
  useRevokeMyApiToken,
  type ApiTokenScope,
  type CreatedMyApiToken,
  type MyApiToken,
} from '@/hooks/useMyApiTokens';
import { McpConnectPanel } from '@/features/settings/components/integrations/McpConnectPanel';
import { docsUrl } from '@/lib/docsUrl';

/** Whether a created/listed token carries the read-only MCP scope. */
function isMcpRead(scopes: readonly string[] | undefined): boolean {
  return Array.isArray(scopes) && scopes.includes('mcp:read');
}

export function PersonalAccessTokensPage() {
  const { data: tokens, isLoading, isError, refetch } = useMyApiTokens();
  const revoke = useRevokeMyApiToken();

  const [creating, setCreating] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<MyApiToken | null>(null);

  const activeCount = tokens?.filter(isTokenActive).length ?? 0;
  const atCap = activeCount >= MAX_PERSONAL_ACCESS_TOKENS;

  return (
    <main aria-label="Personal access tokens" className="flex flex-col gap-6 p-6 max-w-3xl mx-auto">
      <header>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-neutral-text-primary">
              Personal access tokens
            </h1>
            <p className="mt-1 text-sm text-neutral-text-secondary">
              A personal access token lets a script or tool call the API{' '}
              <strong>as you</strong> — it can see and do exactly what your account can, nothing
              more. Send it as{' '}
              <span className="tppm-mono text-[13px]">Authorization: Bearer tppm_…</span>.{' '}
              <a
                href={docsUrl('features/personal-access-tokens')}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Learn more
              </a>
              .
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreating(true)}
            disabled={atCap}
            title={atCap ? 'Revoke a token to free up a slot' : undefined}
            className="h-8 px-3 shrink-0 rounded-control bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            Create token
          </button>
        </div>
        <p
          className="mt-2 text-[12px] text-neutral-text-secondary"
          aria-label={`${activeCount} of ${MAX_PERSONAL_ACCESS_TOKENS} active tokens`}
        >
          <span className="tppm-mono">{activeCount}</span> of {MAX_PERSONAL_ACCESS_TOKENS} active
          tokens
          {atCap && (
            <span className="text-semantic-critical">
              {' '}
              — revoke one to create another.
            </span>
          )}
        </p>
      </header>

      {isLoading ? (
        <div aria-busy="true" aria-label="Loading tokens" className="space-y-2">
          <div className="h-14 rounded-card border border-neutral-border bg-neutral-surface-raised motion-safe:animate-pulse" />
          <div className="h-14 rounded-card border border-neutral-border bg-neutral-surface-raised motion-safe:animate-pulse" />
        </div>
      ) : isError ? (
        <div role="alert" className="flex items-center gap-3">
          <p className="text-sm text-semantic-critical flex-1">Couldn&apos;t load your tokens.</p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="h-8 px-3 rounded-control border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            Retry
          </button>
        </div>
      ) : !tokens || tokens.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Your tokens">
          {tokens.map((tok) => (
            <TokenRow key={tok.id} token={tok} onRevoke={() => setConfirmRevoke(tok)} />
          ))}
        </ul>
      )}

      {creating && <CreateTokenDialog onClose={() => setCreating(false)} />}

      {confirmRevoke && (
        <RevokeDialog
          token={confirmRevoke}
          pending={revoke.isPending}
          onCancel={() => setConfirmRevoke(null)}
          onConfirm={() =>
            revoke.mutate(confirmRevoke.id, { onSuccess: () => setConfirmRevoke(null) })
          }
        />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Token row
// ---------------------------------------------------------------------------

function TokenRow({ token, onRevoke }: { token: MyApiToken; onRevoke: () => void }) {
  const active = isTokenActive(token);
  return (
    <li
      className={[
        'flex items-center gap-3 min-w-0 border border-neutral-border rounded-card bg-neutral-surface-raised px-4 py-3',
        active ? '' : 'opacity-60',
      ].join(' ')}
    >
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-sm font-medium text-neutral-text-primary truncate">{token.name}</span>
        <span className="tppm-mono text-[11px] text-neutral-text-disabled">
          {token.token_prefix}…
        </span>
      </div>
      <div className="flex flex-col items-end text-right shrink-0">
        <StatusChip token={token} />
        <span className="text-[11px] text-neutral-text-secondary">
          {token.last_used_at ? `Last used ${formatDate(token.last_used_at)}` : 'Never used'}
        </span>
        {token.expires_at && (
          <span className="text-[11px] text-neutral-text-secondary">
            {expiryLabel(token.expires_at)}
          </span>
        )}
      </div>
      {active && (
        <button
          type="button"
          onClick={onRevoke}
          className="h-7 px-2.5 shrink-0 text-[12px] font-medium rounded-control border border-semantic-critical/50 text-semantic-critical hover:bg-semantic-critical/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1"
        >
          Revoke
        </button>
      )}
    </li>
  );
}

function StatusChip({ token }: { token: MyApiToken }) {
  let label = 'Active';
  let tone = 'text-semantic-on-track';
  if (token.is_revoked) {
    label = 'Revoked';
    tone = 'text-neutral-text-secondary';
  } else if (token.is_expired) {
    label = 'Expired';
    tone = 'text-semantic-critical';
  }
  return (
    <span className={`text-[11px] font-medium uppercase tracking-wide ${tone}`}>{label}</span>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div
      role="note"
      className="border border-dashed border-neutral-border rounded-card bg-neutral-surface-sunken px-4 py-6 text-center"
    >
      <p className="text-sm font-medium text-neutral-text-primary">No personal access tokens yet</p>
      <p className="mt-1 text-[13px] text-neutral-text-secondary">
        Create one to script against your projects — a weekly portfolio export, a roadmap dump, or
        CI tooling that acts as you.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create dialog — name + optional expiry, then one-time reveal
// ---------------------------------------------------------------------------

function CreateTokenDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const create = useCreateMyApiToken();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [tokenScope, setTokenScope] = useState<ApiTokenScope>('legacy:full');
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedMyApiToken | null>(null);

  // An mcp:read token must carry an expiry (server rule #1713: a leaked read
  // credential must be self-limiting), so surface the requirement in the UI and
  // block submit rather than round-trip for a 400.
  const mcpRead = tokenScope === 'mcp:read';

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Once the token is revealed, Escape must not silently discard it before
      // the user has copied it — they explicitly click Done instead.
      if (e.key === 'Escape' && !create.isPending && !created) {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, create.isPending, created]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length === 0) {
      setError('Give the token a name.');
      return;
    }
    if (mcpRead && !expiresAt) {
      setError('Set an expiration date — a read-only AI token must expire.');
      return;
    }
    setError(null);
    // A bare date input yields YYYY-MM-DD; send it as an end-of-day ISO instant so
    // the token stays valid through the whole chosen day.
    const expires = expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : undefined;
    create.mutate(
      { name: name.trim(), expires_at: expires, scopes: [tokenScope] },
      {
        onSuccess: (data) => setCreated(data),
        onError: (err) => setError(extractError(err)),
      },
    );
  }

  // Prefer the server's authoritative scope on the created token; fall back to
  // the chosen scope for a not-yet-rebased API that omits the field.
  const revealMcp = created ? isMcpRead(created.scopes ?? [tokenScope]) : false;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !create.isPending && !created) onClose();
      }}
    >
      <div
        className={[
          'bg-neutral-surface border border-neutral-border rounded-card w-full p-5 motion-safe:animate-modal-scale-in',
          created && revealMcp ? 'max-w-lg' : 'max-w-md',
        ].join(' ')}
      >
        {created ? (
          revealMcp ? (
            <McpConnectPanel token={created.token} onClose={onClose} />
          ) : (
            <TokenReveal token={created.token} onClose={onClose} />
          )
        ) : (
          <>
            <h2 id={titleId} className="text-sm font-semibold text-neutral-text-primary mb-3">
              Create personal access token
            </h2>
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[13px] font-medium text-neutral-text-primary">Name</span>
                <input
                  ref={nameRef}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Power BI export"
                  className="h-9 px-3 text-[13px] border border-neutral-border rounded-control bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                />
              </label>

              <ScopeSelector value={tokenScope} onChange={setTokenScope} />

              <label className="flex flex-col gap-1">
                <span className="text-[13px] font-medium text-neutral-text-primary">
                  Expiration{' '}
                  {mcpRead ? (
                    <span className="text-semantic-critical">(required)</span>
                  ) : (
                    <span className="text-neutral-text-secondary">(optional)</span>
                  )}
                </span>
                <input
                  type="date"
                  value={expiresAt}
                  min={tomorrowISODate()}
                  required={mcpRead}
                  aria-required={mcpRead}
                  onChange={(e) => setExpiresAt(e.target.value)}
                  className="h-9 px-3 text-[13px] border border-neutral-border rounded-control bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                />
                <span className="text-[12px] text-neutral-text-secondary">
                  {mcpRead
                    ? 'A read-only AI token must expire so a leaked credential is self-limiting.'
                    : 'Leave blank for a token that never expires.'}
                </span>
              </label>
              {error && (
                <p className="text-[12px] text-semantic-critical" role="alert">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2 mt-1">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={create.isPending}
                  className="h-8 px-3 rounded-control border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={create.isPending}
                  className="h-8 px-3 rounded-control bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                >
                  {create.isPending ? 'Creating…' : 'Create token'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Radio group choosing what a new personal token is for (#1846). Mirrors the
 * project/program token scope picker but with personal-token copy: a `mcp:read`
 * personal token is the one the MCP read surface actually accepts (it admits
 * only owner-scoped tokens), so this is the canonical mint path for connecting
 * an AI assistant.
 */
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
      label: 'Full access (acts as you)',
      help: 'Read and write everything your account can — for scripts, CI, or a portfolio export.',
      describedBy: 'pat-scope-full-help',
    },
    {
      scope: 'mcp:read',
      label: 'Read-only for AI assistants',
      help: "Lets Claude Desktop and other MCP clients read your data. It can't make any changes.",
      describedBy: 'pat-scope-mcp-help',
    },
  ];

  return (
    <fieldset>
      <legend className="mb-1.5 text-[13px] font-medium text-neutral-text-primary">
        What is this token for?
      </legend>
      <div className="flex flex-col gap-2">
        {options.map((opt) => {
          const selected = value === opt.scope;
          const inputId = `${opt.describedBy}-radio`;
          return (
            <label
              key={opt.scope}
              htmlFor={inputId}
              className={[
                'flex gap-2.5 p-2.5 rounded-control border cursor-pointer',
                selected
                  ? 'border-brand-primary ring-1 ring-brand-primary/40 bg-brand-primary/5'
                  : 'border-neutral-border hover:bg-neutral-surface-sunken',
              ].join(' ')}
            >
              <input
                id={inputId}
                type="radio"
                name="pat-token-scope"
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

function TokenReveal({ token, onClose }: { token: string; onClose: () => void }) {
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
          aria-label="New personal access token"
          className="tppm-mono flex-1 h-9 px-2 text-[12px] border border-neutral-border rounded-control bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        />
        <CopyButton value={token} />
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="h-8 px-3 rounded-control border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Done
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Revoke dialog
// ---------------------------------------------------------------------------

function RevokeDialog({
  token,
  pending,
  onCancel,
  onConfirm,
}: {
  token: MyApiToken;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const descId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-neutral-surface border border-neutral-border rounded-card w-full max-w-sm p-5 motion-safe:animate-modal-scale-in">
        <h2 id={titleId} className="text-sm font-semibold text-neutral-text-primary mb-2">
          Revoke this token?
        </h2>
        <p id={descId} className="text-xs text-neutral-text-secondary mb-4">
          &quot;{token.name}&quot; will stop working immediately. Any script or tool using it will
          fail until you issue a new one.
        </p>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="h-8 px-3 rounded-control bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            Keep token
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={onConfirm}
            className="h-8 px-3 rounded-control border border-semantic-critical/50 text-[13px] font-medium text-semantic-critical hover:bg-semantic-critical/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1"
          >
            {pending ? 'Revoking…' : 'Revoke token'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copy-to-clipboard button
// ---------------------------------------------------------------------------

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the value is selectable in its field */
    }
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label="Copy token"
      className="h-9 px-3 shrink-0 rounded-control bg-brand-primary text-white text-[12px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
    >
      {copied ? 'Copied ✓' : 'Copy'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return value;
  }
}

function expiryLabel(value: string): string {
  try {
    const date = new Date(value);
    const days = Math.round((date.getTime() - Date.now()) / 86_400_000);
    const formatted = formatDate(value);
    if (days < 0) return `Expired ${formatted}`;
    if (days <= 14) return `Expires ${formatted} (in ${days} days)`;
    return `Expires ${formatted}`;
  } catch {
    return value;
  }
}

/** The earliest selectable expiry — tomorrow, so a token can't expire same-day. */
function tomorrowISODate(): string {
  const d = new Date(Date.now() + 86_400_000);
  return d.toISOString().slice(0, 10);
}

function extractError(e: Error): string {
  const maybe = e as { response?: { data?: unknown } };
  const data = maybe.response?.data;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const key = Object.keys(record)[0];
    if (key) {
      const val = record[key];
      const msg: unknown = Array.isArray(val) ? (val as unknown[])[0] : val;
      return String(msg);
    }
  }
  return 'Something went wrong. Please try again.';
}
