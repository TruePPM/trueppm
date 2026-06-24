/**
 * Connected Accounts page — User → Settings → Connected Accounts (#587).
 *
 * Read-only listing of /api/v1/me/credentials/ rows with one section per
 * provider (GitLab, GitHub, generic) registered against ADR-0049's
 * TASK_LINK_PROVIDERS registry. Per-provider Connect / Rotate / Revoke
 * calls live inline; the secret PAT is never returned from the server,
 * so the page renders only metadata (state, base URL, expiration, last
 * used) and writes the new PAT through the upsert mutation.
 *
 * Anchor scroll: `/me/settings/connected-accounts#github` jumps to the
 * GitHub section (#569's Project Integrations page deep-links here).
 */

import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import {
  type IntegrationCredentialSummary,
  useIntegrationCredentials,
  useRevokeIntegrationCredential,
  useUpsertIntegrationCredential,
} from '@/hooks/useIntegrationCredentials';
import { registry } from '@/lib/widget-registry';
import { docsUrl } from '@/lib/docsUrl';

type DialogMode = 'connect' | 'rotate' | 'revoke';

interface DialogState {
  provider: IntegrationCredentialSummary;
  mode: DialogMode;
}

export function ConnectedAccountsPage() {
  const { credentials, isLoading, error, refetch } = useIntegrationCredentials();
  const [dialog, setDialog] = useState<DialogState | null>(null);

  // Anchor-scroll on initial load so deep links from the Project →
  // Settings → Integrations page (#569) land at the right section.
  useEffect(() => {
    if (isLoading) return;
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    const el = document.getElementById(`provider-${hash}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [isLoading]);

  if (isLoading) {
    return (
      <main
        aria-busy="true"
        aria-label="Loading connected accounts"
        className="p-6 max-w-3xl mx-auto"
      >
        <div className="h-8 w-64 rounded-card bg-neutral-surface-raised animate-pulse mb-4" />
        <div className="space-y-3">
          <div className="h-24 rounded-card border border-neutral-border bg-neutral-surface-raised animate-pulse" />
          <div className="h-24 rounded-card border border-neutral-border bg-neutral-surface-raised animate-pulse" />
          <div className="h-24 rounded-card border border-neutral-border bg-neutral-surface-raised animate-pulse" />
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main role="alert" className="p-6 max-w-3xl mx-auto">
        <p className="text-sm text-semantic-critical">
          Couldn&apos;t load connected accounts.{' '}
          <button
            type="button"
            onClick={() => { void refetch(); }}
            className="text-brand-primary underline-offset-2 hover:underline"
          >
            Retry
          </button>
        </p>
      </main>
    );
  }

  const allEmpty = credentials.every((c) => !c.exists);

  return (
    <main
      aria-label="Connected accounts"
      className="flex flex-col gap-6 p-6 max-w-3xl mx-auto"
    >
      <header>
        <h1 className="text-lg font-semibold text-neutral-text-primary">
          Connected accounts
        </h1>
        <p className="mt-1 text-sm text-neutral-text-secondary">
          Connect GitLab or GitHub to unlock on-demand previews of task links.
          Credentials are stored encrypted and never returned to your browser.{' '}
          <a
            href={docsUrl('features/connected-accounts')}
            className="text-brand-primary underline-offset-2 hover:underline"
          >
            Learn more
          </a>
          .
        </p>
      </header>

      {allEmpty && <EmptyStateHint />}

      <ul className="flex flex-col gap-3" aria-label="Integration providers">
        {credentials.map((cred) => (
          <ProviderCard
            key={cred.provider}
            credential={cred}
            onConnect={() => setDialog({ provider: cred, mode: 'connect' })}
            onRotate={() => setDialog({ provider: cred, mode: 'rotate' })}
            onRevoke={() => setDialog({ provider: cred, mode: 'revoke' })}
          />
        ))}
      </ul>

      <EnterpriseProviderSlots />

      <p className="text-xs text-neutral-text-secondary">
        Credentials power task-link previews (#637). Other integration types
        (project webhooks, API tokens) live under{' '}
        <a
          href="/settings/integrations"
          className="text-brand-primary underline-offset-2 hover:underline"
        >
          Project → Settings → Integrations
        </a>
        .
      </p>

      {dialog?.mode === 'connect' || dialog?.mode === 'rotate' ? (
        <ConnectCredentialDialog
          provider={dialog.provider}
          mode={dialog.mode}
          onDismiss={() => setDialog(null)}
        />
      ) : null}
      {dialog?.mode === 'revoke' ? (
        <RevokeCredentialDialog
          provider={dialog.provider}
          onDismiss={() => setDialog(null)}
        />
      ) : null}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Per-provider card
// ---------------------------------------------------------------------------

interface ProviderCardProps {
  credential: IntegrationCredentialSummary;
  onConnect: () => void;
  onRotate: () => void;
  onRevoke: () => void;
}

function ProviderCard({ credential, onConnect, onRotate, onRevoke }: ProviderCardProps) {
  const expiresLabel = formatExpiresLabel(credential.expires_at);
  return (
    <li
      id={`provider-${credential.provider}`}
      className="border border-neutral-border rounded-card bg-neutral-surface-raised p-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-neutral-text-primary">
            {credential.name}
          </h2>
          <ConnectionPill exists={credential.exists} />
        </div>
        <dl className="mt-2 text-xs text-neutral-text-secondary space-y-0.5">
          {credential.exists && credential.base_url ? (
            <div className="flex gap-1">
              <dt className="font-medium">Host:</dt>
              <dd className="truncate">{credential.base_url}</dd>
            </div>
          ) : null}
          {credential.exists && expiresLabel ? (
            <div className="flex gap-1">
              <dt className="font-medium">Expires:</dt>
              <dd>{expiresLabel}</dd>
            </div>
          ) : null}
          {credential.exists && credential.last_used_at ? (
            <div className="flex gap-1">
              <dt className="font-medium">Last used:</dt>
              <dd>{formatRelativeDate(credential.last_used_at)}</dd>
            </div>
          ) : null}
          {credential.exists && credential.created_at ? (
            <div className="flex gap-1">
              <dt className="font-medium">Connected:</dt>
              <dd>{formatRelativeDate(credential.created_at)}</dd>
            </div>
          ) : null}
          {!credential.exists && !credential.requires_credential ? (
            <div className="italic">
              No credential needed — paste any URL on a task and it will render
              as a generic link.
            </div>
          ) : null}
        </dl>
      </div>
      <div className="flex flex-wrap gap-2 sm:shrink-0">
        {!credential.exists && credential.requires_credential ? (
          <button
            type="button"
            onClick={onConnect}
            className="h-8 px-3 rounded-control bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary focus-visible:outline-none"
          >
            Connect
          </button>
        ) : null}
        {credential.exists ? (
          <>
            <button
              type="button"
              onClick={onRotate}
              className="h-8 px-3 rounded-control border border-neutral-border bg-transparent text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
            >
              Rotate
            </button>
            <button
              type="button"
              onClick={onRevoke}
              className="h-8 px-3 rounded-control border border-semantic-critical/50 bg-transparent text-[13px] font-medium text-semantic-critical hover:bg-semantic-critical/10 focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1 focus-visible:outline-none"
            >
              Revoke
            </button>
          </>
        ) : null}
      </div>
    </li>
  );
}

function ConnectionPill({ exists }: { exists: boolean }) {
  if (exists) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-semantic-on-track">
        <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-semantic-on-track" />
        Connected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-neutral-text-secondary">
      <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-neutral-border" />
      Not connected
    </span>
  );
}

// ---------------------------------------------------------------------------
// Connect / rotate dialog
// ---------------------------------------------------------------------------

interface ConnectDialogProps {
  provider: IntegrationCredentialSummary;
  mode: 'connect' | 'rotate';
  onDismiss: () => void;
}

function ConnectCredentialDialog({ provider, mode, onDismiss }: ConnectDialogProps) {
  const titleId = useId();
  const descId = useId();
  const formId = useId();
  const upsert = useUpsertIntegrationCredential();
  const secretRef = useRef<HTMLInputElement>(null);
  const [secret, setSecret] = useState('');
  const [baseUrl, setBaseUrl] = useState(provider.base_url || '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { secretRef.current?.focus(); }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onDismiss();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    upsert.mutate(
      {
        provider: provider.provider,
        secret,
        base_url: baseUrl || undefined,
      },
      {
        onSuccess: () => onDismiss(),
        onError: (err) => {
          setError(err instanceof Error ? err.message : 'Could not save credential.');
        },
      },
    );
  }

  const verb = mode === 'connect' ? 'Connect' : 'Rotate';
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div className="bg-neutral-surface border border-neutral-border rounded-card w-full max-w-md mx-4 p-5 motion-safe:animate-modal-scale-in">
        <h2 id={titleId} className="text-sm font-semibold text-neutral-text-primary mb-2">
          {verb} {provider.name}
        </h2>
        <p id={descId} className="text-xs text-neutral-text-secondary mb-4">
          Paste a personal access token. Tokens are encrypted at rest and never
          shown again — record yours somewhere safe before submitting.
        </p>
        <form id={formId} onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-neutral-text-primary">
              Personal access token
            </span>
            <input
              ref={secretRef}
              type="password"
              required
              autoComplete="new-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className="h-9 px-3 text-[13px] border border-neutral-border rounded-control bg-neutral-surface-raised focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-neutral-text-primary">
              Host URL <span className="text-neutral-text-secondary">(optional)</span>
            </span>
            <input
              type="url"
              placeholder="Leave blank for the default cloud host"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="h-9 px-3 text-[13px] border border-neutral-border rounded-control bg-neutral-surface-raised focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
            />
          </label>
          {error && (
            <p className="text-[12px] text-semantic-critical" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 mt-1">
            <button
              type="button"
              onClick={onDismiss}
              className="h-8 px-3 rounded-control border border-neutral-border bg-transparent text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={upsert.isPending || secret.trim() === ''}
              className="h-8 px-3 rounded-control bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary focus-visible:outline-none"
            >
              {upsert.isPending ? 'Saving…' : verb}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Revoke dialog
// ---------------------------------------------------------------------------

function RevokeCredentialDialog({
  provider,
  onDismiss,
}: {
  provider: IntegrationCredentialSummary;
  onDismiss: () => void;
}) {
  const titleId = useId();
  const descId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const revoke = useRevokeIntegrationCredential();

  useEffect(() => { cancelRef.current?.focus(); }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onDismiss();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div className="bg-neutral-surface border border-neutral-border rounded-card w-full max-w-sm mx-4 p-5 motion-safe:animate-modal-scale-in">
        <h2 id={titleId} className="text-sm font-semibold text-neutral-text-primary mb-2">
          Revoke {provider.name} credential?
        </h2>
        <p id={descId} className="text-xs text-neutral-text-secondary mb-4">
          Task link previews that rely on this credential will stop refreshing.
          You can reconnect at any time.
        </p>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onDismiss}
            className="h-8 px-3 rounded-control bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary focus-visible:outline-none"
          >
            Keep credential
          </button>
          <button
            type="button"
            disabled={revoke.isPending}
            onClick={() => {
              revoke.mutate(
                { provider: provider.provider },
                { onSuccess: () => onDismiss() },
              );
            }}
            className="h-8 px-3 rounded-control border border-semantic-critical/50 bg-transparent text-[13px] font-medium text-semantic-critical hover:bg-semantic-critical/10 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1 focus-visible:outline-none"
          >
            {revoke.isPending ? 'Revoking…' : 'Revoke'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Enterprise extension slot — Jira / ServiceNow / Bitbucket / Azure DevOps
// register here at AppConfig.ready() in the enterprise overlay. Empty in OSS.
// ---------------------------------------------------------------------------

function EnterpriseProviderSlots() {
  const slots = registry.get('user_settings.connected_accounts');
  if (slots.length === 0) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="enterprise-connected-accounts-slot">
      {slots.map((reg) => {
        const Comp = reg.component;
        return <Comp key={reg.id} />;
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state hint (shown when no providers are connected)
// ---------------------------------------------------------------------------

function EmptyStateHint() {
  return (
    <div
      role="note"
      className="border border-dashed border-neutral-border rounded-card bg-neutral-surface-sunken px-4 py-3 text-xs text-neutral-text-secondary"
    >
      <p className="font-medium text-neutral-text-primary mb-1">
        Why connect an account?
      </p>
      <p>
        With a GitLab or GitHub credential, task links render an inline preview
        of issue / MR / PR status — open vs. merged, draft vs. ready — without
        ever leaving the board. Credentials are per-user and stored encrypted.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeDate(value: string): string {
  // Lightweight relative-date formatter — keeps the bundle small and
  // matches the elsewhere-in-app convention from NotificationListPage.
  try {
    const date = new Date(value);
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return value;
  }
}

function formatExpiresLabel(value: string | null): string | null {
  if (!value) return null;
  try {
    const date = new Date(value);
    const now = new Date();
    const days = Math.round((date.getTime() - now.getTime()) / 86_400_000);
    const formatted = date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    if (days < 0) return `${formatted} (expired)`;
    if (days <= 14) return `${formatted} (in ${days} days)`;
    return formatted;
  } catch {
    return value;
  }
}
