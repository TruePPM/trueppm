/**
 * Webhooks list + CRUD entry points for the Integrations page (#638 / #600).
 *
 * Renders one row per webhook (status dot, URL, format, event count, last
 * activity) with Test / Edit / Delete actions, a "New webhook" button, and the
 * WebhookEditorModal. Works at both project and program scope via the `scope`
 * prop. Replaces the read-only "Manage via API" card.
 */

import { useState, type ReactNode } from 'react';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { SettingsCard } from '../../SettingsShell';
import {
  useWebhooks,
  useDeleteWebhook,
  useTestWebhook,
  useWebhookTestResult,
  type ApiWebhook,
  type IntegrationScope,
} from '@/hooks/useWebhooks';
import { WebhookEditorModal } from './WebhookEditorModal';
import { Tooltip } from '@/components/Tooltip';
import { CheckIcon } from '@/components/Icons';

export interface WebhooksManagerProps {
  scope: IntegrationScope;
}


export function WebhooksManager({ scope }: WebhooksManagerProps) {
  const { data: webhooks, isLoading, isError, refetch } = useWebhooks(scope);
  const del = useDeleteWebhook(scope);

  const [editing, setEditing] = useState<ApiWebhook | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ApiWebhook | null>(null);

  return (
    <SettingsCard>
      <div className="px-4 pt-3.5 pb-2 flex items-center justify-between border-b border-neutral-border/55">
        <div className="flex items-center gap-2">
          <h2 className="text-[14px] font-semibold text-neutral-text-primary">
            {scope.kind === 'program' ? 'Program webhooks' : 'Outbound webhooks'}
          </h2>
          {webhooks && (
            <span
              className="text-[12px] text-neutral-text-secondary tppm-mono"
              aria-label={`${webhooks.length} webhooks`}
            >
              {webhooks.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="h-7 px-3 text-[12px] font-medium rounded bg-brand-primary text-neutral-text-inverse hover:bg-brand-primary-dark focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          New webhook
        </button>
      </div>

      <p className="px-4 pt-3 text-[12px] text-neutral-text-secondary">
        {scope.kind === 'program'
          ? 'Program webhooks let external systems receive real-time events (task created, status changed, milestone reached) from every project in this program.'
          : 'Webhooks let external systems receive real-time events (task created, status changed, milestone reached) from this project.'}
      </p>

      <div className="px-4 py-3">
        {isLoading ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading webhooks">
            <div className="h-4 w-3/4 bg-neutral-surface-sunken rounded motion-safe:animate-pulse" />
            <div className="h-4 w-1/2 bg-neutral-surface-sunken rounded motion-safe:animate-pulse" />
          </div>
        ) : isError ? (
          <div className="flex items-center gap-3">
            <p className="text-[13px] text-neutral-text-secondary flex-1">
              Couldn&apos;t load webhooks.
            </p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="h-7 px-3 text-[12px] font-medium border border-neutral-border rounded text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Retry
            </button>
          </div>
        ) : !webhooks || webhooks.length === 0 ? (
          <p className="text-[13px] text-neutral-text-secondary">
            No webhooks yet. Add one to push events to Slack, Discord, or any HTTPS endpoint.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {webhooks.map((wh) => (
              <li
                key={wh.id}
                className="flex items-center gap-2 min-w-0 py-1.5 border-b border-neutral-border/40 last:border-0"
              >
                <StatusDot active={wh.is_active} />
                <span className="flex flex-col min-w-0 flex-1">
                  <span
                    className="tppm-mono text-[12px] text-neutral-text-primary truncate"
                    title={wh.url}
                  >
                    {wh.url}
                  </span>
                  <span className="text-[11px] text-neutral-text-secondary">
                    {wh.events.length} event{wh.events.length === 1 ? '' : 's'}
                    {wh.consecutive_failures > 0 && (
                      <>
                        {' · '}
                        <span className="text-semantic-critical">
                          {wh.disabled_at
                            ? `paused after ${wh.consecutive_failures} failures`
                            : `${wh.consecutive_failures} recent failure${wh.consecutive_failures === 1 ? '' : 's'}`}
                        </span>
                      </>
                    )}
                  </span>
                </span>
                <FormatPill format={wh.format} />
                <div className="flex items-center gap-1 shrink-0">
                  <TestButton scope={scope} webhook={wh} />
                  <RowButton onClick={() => setEditing(wh)}>Edit</RowButton>
                  <RowButton onClick={() => setConfirmDelete(wh)} variant="danger">
                    Delete
                  </RowButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {(creating || editing) && (
        <WebhookEditorModal
          scope={scope}
          webhook={editing ?? undefined}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete webhook?"
          body={`This stops deliveries to ${confirmDelete.url}. This can't be undone.`}
          confirmLabel="Delete webhook"
          pending={del.isPending}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            del.mutate(confirmDelete.id, { onSuccess: () => setConfirmDelete(null) });
          }}
        />
      )}
    </SettingsCard>
  );
}

/**
 * "Test" button that reports the receiver's real answer, not the enqueue ack.
 *
 * The old implementation flipped to "Sent ✓" in the POST's `onSuccess` with no
 * `onError` and no read-back. Since the ping also skipped the format renderer, a
 * Slack-format webhook — the modal's default — was guaranteed to fail with 400
 * `invalid_payload` while the UI reported success (#2884). Both halves are fixed:
 * the ping now renders through the subscription's provider server-side, and this
 * button polls the delivery row until it reaches a terminal status.
 *
 * A component per row (rather than state lifted into the manager) so each row owns
 * its own poll — hooks cannot be called in a loop.
 *
 * Two accessibility constraints shape the markup, and both are easy to get wrong:
 *
 * - **`aria-disabled`, never `disabled`, for the in-flight state.** A focused
 *   element that becomes `disabled` is removed from the focusability tree, so every
 *   browser blurs it and focus falls to `<body>` — throwing the keyboard user off
 *   the row for the whole poll. `aria-disabled` plus an early return keeps the tab
 *   stop and the focus.
 * - **The result needs a live region.** The outcome is otherwise rendered *only*
 *   into this button's accessible name, which is read on focus — and the user is no
 *   longer focused there. There is no second channel: the test mutation invalidates
 *   a longer query key than the webhook list, so the row's own failure counter is
 *   not refetched either. The region is mounted unconditionally, because one created
 *   in the same tick as its content does not reliably announce.
 */
function TestButton({ scope, webhook }: { scope: IntegrationScope; webhook: ApiWebhook }) {
  const test = useTestWebhook(scope);
  const [deliveryId, setDeliveryId] = useState<string | null>(null);
  const result = useWebhookTestResult(scope, webhook.id, deliveryId);

  // Every read of the result is gated on THIS click having produced a delivery id.
  // The hook is already scoped by `deliveryId`, but re-gating here is what keeps a
  // cached row from an earlier test out of the label: without it the button reads
  // "Delivered" before the user has clicked anything.
  const delivery = deliveryId ? result.delivery : null;
  const settled = !!deliveryId && result.settled;
  const timedOut = !!deliveryId && result.timedOut;

  const failed = settled && delivery?.status === 'failed';
  const polling = !!deliveryId && !settled && !timedOut;
  const busy = test.isPending || polling;

  let label: ReactNode = 'Test';
  let announcement = '';
  let explanation: string | undefined;

  if (test.isPending) {
    label = 'Sending…';
  } else if (test.isError) {
    label = 'Failed';
    announcement = 'The test could not be sent.';
    explanation = "TruePPM couldn't send the test. Check your permissions and try again.";
  } else if (polling) {
    label = 'Waiting…';
  } else if (timedOut) {
    label = 'Pending';
    announcement = 'The test is still pending.';
    explanation =
      'The receiver has not answered yet. TruePPM is still retrying — open Edit to see the delivery log.';
  } else if (failed) {
    const status = delivery?.response_status;
    label = status ? `Failed ${status}` : 'Failed';
    announcement = status
      ? `Test failed. The receiver answered HTTP ${status}.`
      : 'Test failed.';
    explanation = status
      ? `Your endpoint rejected the test with HTTP ${status}. ${httpHint(status)}`
      : 'Your endpoint did not accept the test delivery.';
  } else if (settled) {
    label = (
      <>
        Delivered
        <CheckIcon className="inline-block h-3 w-3 align-[-0.125em] ml-1" aria-hidden="true" />
      </>
    );
    announcement = 'Test delivered successfully.';
  }

  return (
    <>
      <Tooltip content={explanation ?? 'Send a test delivery to this endpoint.'}>
        <RowButton
          onClick={() => {
            if (busy) return;
            setDeliveryId(null);
            test.reset();
            test.mutate(webhook.id, {
              onSuccess: (data) => setDeliveryId(data.delivery_id),
            });
          }}
          ariaDisabled={busy}
          variant={failed || test.isError ? 'danger' : 'default'}
        >
          {label}
        </RowButton>
      </Tooltip>
      {/* Mounted unconditionally — see the note above. */}
      <span className="sr-only" role="status">
        {announcement}
      </span>
    </>
  );
}

/** Plain-English gloss for the HTTP statuses a webhook receiver actually returns. */
function httpHint(status: number): string {
  if (status === 401 || status === 403) return 'The endpoint rejected our credentials.';
  if (status === 404 || status === 410) return 'The endpoint no longer exists at that URL.';
  if (status === 429) return 'The endpoint is rate-limiting us; TruePPM will retry.';
  if (status >= 500) return 'The endpoint hit an internal error; TruePPM will retry.';
  return 'The endpoint could not process the payload we sent.';
}

function StatusDot({ active }: { active: boolean }) {
  return (
    <span
      aria-label={active ? 'Active' : 'Inactive'}
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${
        active ? 'bg-semantic-on-track' : 'bg-neutral-text-disabled'
      }`}
    />
  );
}

function FormatPill({ format }: { format: string }) {
  const isSlack = format === 'slack';
  return (
    <span
      className={[
        'text-[11px] font-medium rounded px-1.5 py-0.5 shrink-0',
        isSlack
          ? 'bg-brand-primary/10 text-brand-primary'
          : 'bg-neutral-surface-sunken text-neutral-text-secondary',
      ].join(' ')}
    >
      {isSlack ? 'Slack' : 'JSON'}
    </span>
  );
}

function RowButton({
  children,
  onClick,
  disabled,
  ariaDisabled,
  variant = 'default',
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /**
   * Soft-disable for a *transient busy* state. Keeps the tab stop and the focus,
   * which `disabled` destroys — the caller must early-return in `onClick`.
   */
  ariaDisabled?: boolean;
  variant?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={ariaDisabled || undefined}
      className={[
        'h-6 px-2 text-[11px] font-medium rounded border border-neutral-border hover:bg-neutral-surface-sunken disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed',
        // Same visual treatment as :disabled for the soft-disabled state (rule 122
        // recipe, opacity 1), without leaving the focusability tree.
        ariaDisabled
          ? 'aria-disabled:bg-neutral-surface-sunken aria-disabled:text-neutral-text-secondary aria-disabled:border-neutral-border/55 aria-disabled:cursor-not-allowed'
          : '',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
        variant === 'danger' ? 'text-semantic-critical' : 'text-neutral-text-secondary',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  pending,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Escape/close routes to the safe (Cancel) action; guarded while the mutation
  // is in-flight to mirror the backdrop-dismiss guard. Cancel is first in DOM so
  // the trap seats initial focus there — a destructive confirm must never
  // autofocus the destructive button.
  const trapRef = useFocusTrap<HTMLDivElement>(true, () => {
    if (!pending) onCancel();
  });

  return (
    <div
      ref={trapRef}
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-neutral-overlay p-4 focus:outline-none"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !pending) onCancel();
      }}
    >
      <div className="bg-neutral-surface border border-neutral-border rounded-card w-full max-w-sm p-5">
        <h2 className="text-sm font-semibold text-neutral-text-primary mb-2">{title}</h2>
        <p className="text-xs text-neutral-text-secondary mb-4">{body}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="h-8 px-3 rounded border border-neutral-border bg-transparent text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="h-8 px-3 rounded bg-semantic-critical text-white text-[13px] font-medium hover:opacity-90 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1"
          >
            {pending ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
