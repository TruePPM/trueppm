/**
 * Git-event board automation config UI (issue 1257) for the project Integrations page.
 *
 * Drives the issue 329 backend (ADR-0158): an off-by-default toggle, the per-project
 * webhook URL (copyable), and a "generate / rotate secret" action that reveals
 * the plaintext exactly once — mirroring the ApiTokensManager one-time-reveal
 * contract. The GET never returns the secret, so the UI tracks only whether one
 * is set ("secret set on …") and warns when automation is on but unsecured.
 *
 * Project-admin only (Owner/Admin). The whole section is hidden below ADMIN so a
 * Member never sees — nor fires the 403-guarded GET for — admin-only config.
 */

import { useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { SettingsCard } from '../../SettingsShell';
import { ROLE_ADMIN } from '@/lib/roles';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import {
  useGitAutomationConfig,
  useUpdateGitAutomation,
  useRotateGitAutomationSecret,
  type GitAutomationConfig,
} from '@/hooks/useGitAutomation';
import { Toggle } from '../Toggle';

export interface GitAutomationManagerProps {
  projectId: string;
}

/**
 * Role gate. Splitting the admin check into a wrapper means the config GET (and
 * its 403 for non-admins) only fires once the viewer is confirmed Owner/Admin —
 * the inner section never mounts otherwise.
 */
export function GitAutomationManager({ projectId }: GitAutomationManagerProps) {
  const { role, isLoading } = useCurrentUserRole(projectId);
  if (isLoading || role == null || role < ROLE_ADMIN) return null;
  return <GitAutomationSection projectId={projectId} />;
}

function GitAutomationSection({ projectId }: GitAutomationManagerProps) {
  const { data, isLoading, isError, refetch } = useGitAutomationConfig(projectId);
  const update = useUpdateGitAutomation(projectId);
  const [rotating, setRotating] = useState(false);

  return (
    <div data-testid="git-automation-manager">
    <SettingsCard>
      <div className="px-4 pt-3.5 pb-2 flex items-center justify-between border-b border-neutral-border/55">
        <div className="flex items-center gap-2">
          <h2 className="text-[14px] font-semibold text-neutral-text-primary">
            Git-event automation
          </h2>
          {data && (
            <span
              className={[
                'text-[11px] px-1.5 py-0.5 rounded font-medium',
                data.enabled
                  ? 'bg-brand-primary/12 text-brand-primary'
                  : 'bg-neutral-surface-sunken text-neutral-text-secondary',
              ].join(' ')}
            >
              {data.enabled ? 'On' : 'Off'}
            </span>
          )}
        </div>
      </div>

      <p className="px-4 pt-3 text-[12px] text-neutral-text-secondary">
        Move a task&apos;s card automatically when its linked pull/merge request opens
        (→ Review) or merges (→ Complete). Point your provider&apos;s webhook at the URL
        below and paste in the secret.
      </p>

      <div className="px-4 py-3">
        {isLoading ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading Git-event automation">
            <div className="h-4 w-3/4 bg-neutral-surface-sunken rounded motion-safe:animate-pulse" />
            <div className="h-4 w-1/2 bg-neutral-surface-sunken rounded motion-safe:animate-pulse" />
          </div>
        ) : isError || !data ? (
          <div className="flex items-center gap-3">
            <p className="text-[13px] text-neutral-text-secondary flex-1">
              Couldn&apos;t load Git-event automation.
            </p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="h-7 px-3 text-[12px] font-medium border border-neutral-border rounded text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <Toggle
                on={data.enabled}
                onChange={(on) => update.mutate({ enabled: on })}
                ariaLabel="Enable Git-event automation"
                hint="Off by default. Cards only move while this is on."
              />
              {update.isError && (
                <span className="text-[12px] text-semantic-critical" role="alert">
                  Couldn&apos;t save — try again.
                </span>
              )}
            </div>

            {data.enabled && !data.secret_set && (
              <p
                className="text-[12px] text-semantic-warning bg-semantic-warning-bg rounded px-3 py-2"
                role="status"
              >
                Automation is on but no secret is set — the receiver rejects every
                webhook until you generate one.
              </p>
            )}

            <WebhookUrlField url={data.webhook_url} />

            <SecretRow config={data} onRotate={() => setRotating(true)} />

            <ProviderHints />
          </div>
        )}
      </div>

      {rotating && (
        <RotateSecretModal projectId={projectId} hasSecret={!!data?.secret_set} onClose={() => setRotating(false)} />
      )}
    </SettingsCard>
    </div>
  );
}

/** Read-only webhook URL with copy-to-clipboard. */
function WebhookUrlField({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the value is selectable in the field */
    }
  }
  return (
    <div>
      <label
        htmlFor="git-webhook-url"
        className="block mb-1 text-[12px] font-medium text-neutral-text-primary"
      >
        Webhook URL
      </label>
      <div className="flex items-center gap-2">
        <input
          id="git-webhook-url"
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="tppm-mono flex-1 h-8 px-2 text-[12px] border border-neutral-border rounded bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        />
        <button
          type="button"
          onClick={() => void copy()}
          className="h-8 px-3 rounded border border-neutral-border text-[12px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

/** Secret status + generate/rotate action. The secret value itself is never shown here. */
function SecretRow({ config, onRotate }: { config: GitAutomationConfig; onRotate: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex flex-col min-w-0">
        <span className="text-[12px] font-medium text-neutral-text-primary">Signing secret</span>
        <span className="text-[12px] text-neutral-text-secondary">
          {config.secret_set
            ? config.secret_set_at
              ? `Set on ${formatDate(config.secret_set_at)}. Shown once at generation — rotate to issue a new one.`
              : 'A secret is set. Shown once at generation — rotate to issue a new one.'
            : 'No secret yet. Generate one to paste into your provider.'}
        </span>
      </div>
      <button
        type="button"
        onClick={onRotate}
        className="h-7 px-3 text-[12px] font-medium rounded bg-brand-primary text-neutral-text-inverse hover:bg-brand-primary-dark shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        {config.secret_set ? 'Rotate secret' : 'Generate secret'}
      </button>
    </div>
  );
}

/** Provider-specific setup reference (GitHub / GitLab). */
function ProviderHints() {
  return (
    <div className="bg-neutral-surface-sunken rounded px-3 py-2.5">
      <p className="text-[11px] font-medium text-neutral-text-primary mb-1.5">Provider setup</p>
      <dl className="space-y-1.5 text-[11px] text-neutral-text-secondary">
        <div>
          <dt className="inline font-medium text-neutral-text-primary">GitHub: </dt>
          <dd className="inline">
            paste the URL + secret into the repo&apos;s webhook settings, content-type{' '}
            <span className="tppm-mono">application/json</span>, events ={' '}
            <span className="tppm-mono">Pull requests</span>.
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-neutral-text-primary">GitLab: </dt>
          <dd className="inline">
            paste the URL + Secret token, trigger ={' '}
            <span className="tppm-mono">Merge request events</span>.
          </dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * One-time-reveal modal for the generated secret. Mirrors ApiTokensManager's
 * CreateTokenModal: the plaintext appears only here, with a copy button and an
 * explicit "you won't see this again" warning; closing it makes it unrecoverable.
 */
function RotateSecretModal({
  projectId,
  hasSecret,
  onClose,
}: {
  projectId: string;
  hasSecret: boolean;
  onClose: () => void;
}) {
  const rotate = useRotateGitAutomationSecret(projectId);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);

  // Never first-focus the destructive action (rule 245b): Enter-on-open must not
  // rotate the secret. Focus Cancel on open; on reveal, move focus to the secret
  // field so it is announced and immediately selectable for copy (#2205).
  useEffect(() => {
    if (revealed) secretRef.current?.focus();
    else cancelRef.current?.focus();
  }, [revealed]);

  function handleRotate() {
    setError(null);
    rotate.mutate(undefined, {
      onSuccess: (data) => setRevealed(data.secret),
      onError: (e) => setError(extractError(e)),
    });
  }

  async function copy() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the value is selectable in the field */
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={revealed ? 'Secret generated' : 'Generate webhook secret'}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-neutral-overlay p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !rotate.isPending) onClose();
      }}
    >
      <div className="bg-neutral-surface border border-neutral-border rounded-card w-full max-w-md p-5">
        {revealed ? (
          <>
            <h2 className="text-sm font-semibold text-neutral-text-primary mb-2">
              Secret generated — copy it now
            </h2>
            <p className="text-xs text-semantic-critical mb-3">
              This is the only time you&apos;ll see this secret. Paste it into your
              provider&apos;s webhook settings; it can&apos;t be retrieved again.
            </p>
            <div className="flex items-center gap-2 mb-4">
              <input
                ref={secretRef}
                readOnly
                value={revealed}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="New webhook secret"
                className="tppm-mono flex-1 h-8 px-2 text-[12px] border border-neutral-border rounded bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              />
              <button
                type="button"
                onClick={() => void copy()}
                className="h-8 px-3 rounded bg-brand-primary text-neutral-text-inverse text-[12px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="h-8 px-3 rounded border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-sm font-semibold text-neutral-text-primary mb-2">
              {hasSecret ? 'Rotate webhook secret?' : 'Generate webhook secret?'}
            </h2>
            <p className="text-xs text-neutral-text-secondary mb-3">
              {hasSecret
                ? 'The current secret stops working immediately. Update your provider with the new one or automation will stop.'
                : 'A new signing secret is created. You will see it once — paste it into your provider afterward.'}
            </p>
            {error && (
              <p className="text-[12px] text-semantic-critical mb-2" role="alert">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                ref={cancelRef}
                type="button"
                onClick={onClose}
                disabled={rotate.isPending}
                className="h-8 px-3 rounded border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken disabled:cursor-not-allowed disabled:text-neutral-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRotate}
                disabled={rotate.isPending}
                className="h-8 px-3 rounded bg-brand-primary text-neutral-text-inverse text-[13px] font-medium hover:bg-brand-primary-dark disabled:cursor-not-allowed disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                {rotate.isPending ? 'Working…' : hasSecret ? 'Rotate secret' : 'Generate secret'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
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
