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

import { useState } from 'react';
import { isAxiosError } from 'axios';
import { useFocusTrap } from '@/hooks/useFocusTrap';
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
import { CheckIcon } from '@/components/Icons';

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

            <LastDeliveryRow config={data} />

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
          {copied ? (
            <>
              Copied
              <CheckIcon className="inline-block h-3 w-3 align-[-0.125em] ml-1" aria-hidden="true" />
            </>
          ) : (
            'Copy'
          )}
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

/**
 * How each delivery outcome reads to an operator (#2882).
 *
 * `tone` drives the styling, and the split is the point: a delivery that the
 * provider reported as a green check can still be a `problem` here. Before this
 * row existed, every one of these was invisible — the receiver logged nothing, all
 * non-auth outcomes were HTTP 200, and this card had no error surface at all, so
 * "I followed every documented step and no card ever moves" had no answer anywhere
 * in the product.
 *
 * `hint` exists only where the operator can actually do something next. `no_link`
 * gets the longest one because it is the most common failure and the least
 * guessable: matching is exact-URL against a link on the task, and nothing in the
 * setup flow tells you to create one.
 */
const DELIVERY_OUTCOMES: Record<string, { label: string; tone: 'ok' | 'problem' | 'idle'; hint?: string }> = {
  opened_review: { label: 'Card moved to Review', tone: 'ok' },
  merged_complete: { label: 'Card moved to Complete', tone: 'ok' },
  noop_forward_only: {
    label: 'Card already at or past the target',
    tone: 'ok',
    hint: 'Automation only moves cards forward, so nothing changed.',
  },
  duplicate: { label: 'Duplicate delivery ignored', tone: 'ok' },
  draft: {
    label: 'Draft pull/merge request ignored',
    tone: 'idle',
    hint: 'A draft does not move the card. Mark it ready for review and the card moves to Review.',
  },
  ignored: { label: 'Event not one automation acts on', tone: 'idle' },
  no_link: {
    label: 'No task is linked to that pull/merge request',
    tone: 'problem',
    hint: 'Automation matches on a link, so add the pull/merge request URL to the task first: open the task, go to Files → External links, and paste it there. The URL must match exactly.',
  },
  no_url: {
    label: 'Payload carried no pull/merge request URL',
    tone: 'problem',
    hint: 'Check the webhook is configured for pull-request / merge-request events.',
  },
  bad_signature: {
    label: 'Signature rejected',
    tone: 'problem',
    // Hedged deliberately. This endpoint is public, so an unauthenticated request
    // with a junk signature lands here too — an unconditional "rotate your secret"
    // would let a stranger talk an admin into breaking a working integration.
    hint: 'If this lines up with a delivery from your provider, the secret there does not match this project — rotate it and paste the new one into the webhook. If it does not, this was unauthenticated traffic and nothing is wrong.',
  },
  no_secret: {
    label: 'Delivery arrived with no secret set',
    tone: 'problem',
    hint: 'Generate a secret and paste it into your provider.',
  },
  automation_disabled: {
    label: 'Delivery arrived while automation was off',
    tone: 'problem',
    hint: 'Turn the toggle on for cards to move.',
  },
  unknown_provider: {
    label: 'Unrecognized provider',
    tone: 'problem',
    hint: 'Only GitHub and GitLab webhooks are recognized.',
  },
  secret_unreadable: {
    label: 'Stored secret could not be read',
    tone: 'problem',
    hint: 'Rotate the secret to re-encrypt it, then update your provider.',
  },
  malformed_payload: { label: 'Payload was not valid JSON', tone: 'problem' },
  // No `no_automation` entry: that refusal is raised with no automation row to
  // record against, so the server can never persist it. A mapping for a value that
  // cannot arrive is a control with no producer.
};

/** `github` / `gitlab` are raw server tokens; the rest of this card writes them properly. */
const PROVIDER_LABEL: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab' };

/** Turn an unmapped server token into something a human can read (rule 301c). */
function humanizeOutcome(token: string): string {
  return token.replace(/_/g, ' ');
}

const TONE_CLASS: Record<'ok' | 'problem' | 'idle', string> = {
  // `on-track` is the design system's AA-checked "good" text tone in both themes
  // (there is no `semantic-success` token — rule 145 keeps the state colors
  // distinct, and inventing a fourth would break the DS-v2 hex ratchet).
  ok: 'text-semantic-on-track',
  problem: 'text-semantic-critical',
  idle: 'text-neutral-text-secondary',
};

/**
 * One outcome block: label, tone-coloured summary, optional remediation hint.
 *
 * No `role="status"` anywhere in here. This content mounts together with its own
 * container when the config query resolves, and nothing subsequently updates it —
 * a live region created with its content does not reliably announce (rule 297), and
 * on the reading where it did, it would announce the coloured summary *without* the
 * "Last delivery" label or the hint: the problem stripped of its context and its
 * fix. A labelled group gives a screen-reader user the same structure a sighted user
 * gets, on demand rather than unprompted.
 */
function OutcomeBlock({
  label,
  outcome,
  provider,
  at,
  testId,
  caveat,
}: {
  label: string;
  outcome: string | undefined;
  provider: string | undefined;
  at: string;
  testId: string;
  caveat?: string;
}) {
  const known = outcome ? DELIVERY_OUTCOMES[outcome] : undefined;
  // Unmapped token → the CAUTIOUS tone, never the neutral one (rule 301b). The
  // server owns this vocabulary and grows it, so this map is a mirror that will
  // drift; the drift must not render the next new FAILURE token in the same grey as
  // "nothing to report" on the one surface whose job is saying something is wrong.
  const tone = known?.tone ?? 'problem';
  return (
    <div role="group" aria-label={label} data-testid={testId}>
      <span className="block text-[12px] font-medium text-neutral-text-primary">{label}</span>
      <span className={`block text-[12px] font-medium ${TONE_CLASS[tone]}`}>
        {known?.label ?? (outcome ? humanizeOutcome(outcome) : 'Unknown outcome')}
        {provider ? ` · ${PROVIDER_LABEL[provider] ?? provider}` : ''}
        {` · ${formatDateTime(at)}`}
      </span>
      {known?.hint && (
        <span className="block max-w-[460px] text-[12px] text-neutral-text-secondary mt-0.5">
          {known.hint}
        </span>
      )}
      {caveat && (
        <span className="block max-w-[460px] text-[12px] text-neutral-text-secondary mt-0.5">
          {caveat}
        </span>
      )}
    </div>
  );
}

/**
 * Delivery diagnostics — the consumer a failed webhook never had.
 *
 * Two independent slots, mirroring the server's own split. "Last delivery" is a
 * delivery whose signature verified, so it is trustworthy. "Last refused delivery"
 * was rejected before verification, and because the receiver is public anyone
 * holding the project ID can produce one — so it is shown separately, and labelled
 * as possibly not being the operator's provider at all. Collapsing the two would let
 * a stranger overwrite a real diagnosis with a fabricated cause.
 *
 * Neither renders until something has actually arrived: a row reading "no problems"
 * would be a claim the server has not made, and the honest empty state is the
 * prerequisite hint instead.
 */
function LastDeliveryRow({ config }: { config: GitAutomationConfig }) {
  const deliveredAt = config.last_delivery_at;
  const refusedAt = config.last_refusal_at;
  if (!deliveredAt && !refusedAt) {
    return (
      <p
        className="max-w-[460px] text-[12px] text-neutral-text-secondary"
        data-testid="git-last-delivery-empty"
      >
        No webhook delivery received yet. Cards move only when a task has the pull/merge
        request URL saved as a link (task → Files → External links).
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {deliveredAt && (
        <OutcomeBlock
          label="Last delivery"
          outcome={config.last_delivery_outcome}
          provider={config.last_delivery_provider}
          at={deliveredAt}
          testId="git-last-delivery"
        />
      )}
      {refusedAt && (
        <OutcomeBlock
          label="Last refused delivery"
          outcome={config.last_refusal_outcome}
          provider={config.last_refusal_provider}
          at={refusedAt}
          testId="git-last-refusal"
          caveat="This endpoint is public, so a refusal can also come from a request that is not your provider."
        />
      )}
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

  // Multi-state dialog (#1776): re-seat focus when the phase flips from the
  // rotate/generate confirm to the one-time-reveal panel. Escape/close routes to
  // the safe action and is guarded while the mutation is in-flight (mirrors the
  // backdrop-dismiss guard). Cancel is first in DOM so the trap seats initial
  // focus there — rotating invalidates the current secret, a destructive act.
  const trapRef = useFocusTrap<HTMLDivElement>(
    true,
    () => {
      if (!rotate.isPending) onClose();
    },
    revealed ? 'revealed' : 'confirm',
  );

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
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-label={revealed ? 'Secret generated' : 'Generate webhook secret'}
      tabIndex={-1}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-neutral-overlay p-4 focus:outline-none"
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
                {copied ? (
                  <>
                    Copied
                    <CheckIcon
                      className="inline-block h-3 w-3 align-[-0.125em] ml-1"
                      aria-hidden="true"
                    />
                  </>
                ) : (
                  'Copy'
                )}
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

/** Date + time — a delivery is diagnosed by the minute, not by the day. */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        // The point of this row is cross-referencing the provider's own delivery log,
        // which stamps in its own zone — without a zone the operator cannot be sure
        // the two lines describe the same delivery.
        timeZoneName: 'short',
      });
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
