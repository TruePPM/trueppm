/**
 * Create/edit modal for a webhook (#638 / #600).
 *
 * Left: the form (endpoint URL, format picker, signing secret, event picker).
 * Right: an example of the Slack render when format=slack, plus the recent
 * delivery log when editing an existing webhook.
 *
 * Only `slack` and `generic` formats are selectable — the others are shown
 * disabled (Enterprise). The event picker lists every event the backend can fire
 * (see `events.ts`, which a pytest gate binds to `WebhookEventType`).
 *
 * Two invariants this file exists to hold (#2883 / #2885):
 *
 * 1. **A save never drops a subscription the picker did not render.** The modal
 *    used to narrow `webhook.events` to its own catalog on load and PATCH the
 *    narrowed list, so an admin who opened an API-created webhook to fix a URL
 *    typo silently deleted eight real subscriptions — with a success toast and no
 *    diff. Unrendered ids are now carried through the save and shown in their own
 *    section, so a future catalog gap degrades to "not selectable here", never to
 *    "deleted on save".
 * 2. **The strongest secret is the default one.** Requiring a hand-typed secret
 *    steered every admin toward the weakest value they could invent; the API's
 *    auto-generate path was unreachable from the UI and its one-time echo was
 *    discarded. Generate is now the default and the returned value is shown once.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isAxiosError } from 'axios';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import {
  useCreateWebhook,
  useUpdateWebhook,
  useWebhookDeliveries,
  type ApiWebhook,
  type IntegrationScope,
} from '@/hooks/useWebhooks';
import { WEBHOOK_EVENT_CATALOG, WEBHOOK_FORMATS, ALL_WEBHOOK_EVENT_IDS } from './events';
// The one-time-reveal primitives shipped for the API-token flow (#2205). Reused
// rather than re-derived: a hand-rolled Copy loses the announced accessible name,
// the timed reset, and — the real defect — any signal at all when the clipboard is
// denied or the context is insecure, on the one value that has no second chance.
import { CopyButton, DoneButton } from './McpConnectPanel';
import { CloseIcon } from '@/components/Icons';

/**
 * Server-side floor from `MIN_WEBHOOK_SECRET_LENGTH` (#893). Checked client-side
 * so a plausible human value ("whsec_hunter2") is rejected with a sentence the
 * admin can act on, instead of round-tripping to a raw DRF error string.
 */
const MIN_SECRET_LENGTH = 32;

export interface WebhookEditorModalProps {
  scope: IntegrationScope;
  /** When set, the modal edits this webhook; otherwise it creates a new one. */
  webhook?: ApiWebhook;
  onClose: () => void;
  onSaved: () => void;
}

export function WebhookEditorModal({ scope, webhook, onClose, onSaved }: WebhookEditorModalProps) {
  const isEdit = !!webhook;
  const [url, setUrl] = useState(webhook?.url ?? '');
  const [format, setFormat] = useState(webhook?.format ?? 'slack');
  const [secret, setSecret] = useState('');
  // Generate-on-create is the default: omitting `secret` makes the server mint a
  // 256-bit value, which is strictly stronger than anything typed into a form.
  const [generateSecret, setGenerateSecret] = useState(!isEdit);
  // Every id the saved webhook is subscribed to, INCLUDING ids this build has no
  // catalog entry for. Deliberately unfiltered — see invariant 1 in the file
  // docstring.
  const [events, setEvents] = useState<Set<string>>(() => new Set(webhook?.events ?? []));
  const [formError, setFormError] = useState<string | null>(null);
  /** The one-time secret echo from a 201, shown once and never retrievable again. */
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  const create = useCreateWebhook(scope);
  const update = useUpdateWebhook(scope);
  const saving = create.isPending || update.isPending;

  // Subscriptions this build cannot render a checkbox for. Rendered in their own
  // section so they are visible and can be removed deliberately — the point is
  // that removal must be a decision, not a side effect of pressing Save.
  const unknownEvents = (webhook?.events ?? []).filter(
    (id) => !ALL_WEBHOOK_EVENT_IDS.includes(id),
  );

  // Trap focus and route Escape to close (guarded while saving, matching the
  // backdrop-dismiss guard). The hook seats initial focus on the first focusable
  // and restores focus to the trigger on close. `focusKey` re-seats focus when the
  // modal swaps to the created-secret panel, whose controls replace the form's
  // (#1776 — without it focus drops to <body> and Tab escapes the modal).
  //
  // Both dismissal paths are gated on the reveal phase, not just on `saving`: once
  // the generated secret is on screen it is unrecoverable, so a stray backdrop click
  // or a reflexive Escape would be permanent data loss with no undo and no diff. Only
  // the explicit Done/Close controls may leave that phase.
  const trapRef = useFocusTrap<HTMLDivElement>(
    true,
    () => {
      if (!saving && createdSecret === null) onClose();
    },
    createdSecret === null ? 'form' : 'created',
  );

  function toggleEvent(id: string) {
    setEvents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function validate(): string | null {
    if (!/^https:\/\//i.test(url.trim())) return 'Endpoint URL must start with https://';
    if (events.size === 0) return 'Select at least one event to subscribe to.';
    const typed = secret.trim();
    if (!isEdit && !generateSecret && typed.length === 0) return 'A signing secret is required.';
    if (typed.length > 0 && typed.length < MIN_SECRET_LENGTH) {
      return `A signing secret must be at least ${MIN_SECRET_LENGTH} characters. Leave it blank and use "Generate a secret for me" to get a strong one.`;
    }
    return null;
  }

  function handleSubmit() {
    const err = validate();
    if (err) {
      setFormError(err);
      return;
    }
    setFormError(null);
    const eventList = [...events];

    if (isEdit && webhook) {
      const body: Record<string, unknown> = { url: url.trim(), events: eventList, format };
      if (secret.trim()) body.secret = secret.trim();
      update.mutate(
        { id: webhook.id, body },
        { onSuccess: onSaved, onError: (e) => setFormError(extractError(e)) },
      );
    } else {
      create.mutate(
        {
          url: url.trim(),
          events: eventList,
          format,
          // Omitted entirely when generating: the server only auto-generates when
          // the field is absent or blank.
          ...(generateSecret ? {} : { secret: secret.trim() }),
        },
        {
          onSuccess: (created) => {
            // The 201 echoes the secret exactly once (#893). Show it rather than
            // discard it — there is no read path to it afterwards.
            if (created.secret) setCreatedSecret(created.secret);
            else onSaved();
          },
          onError: (e) => setFormError(extractError(e)),
        },
      );
    }
  }

  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="webhook-editor-title"
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-neutral-overlay p-4 focus:outline-none motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !saving && createdSecret === null) onClose();
      }}
    >
      <div className="bg-neutral-surface border border-neutral-border rounded-card w-full max-w-3xl max-h-[90vh] overflow-auto motion-safe:animate-modal-scale-in flex flex-col">
        <div className="px-5 pt-4 pb-3 border-b border-neutral-border flex items-start justify-between">
          <div>
            <h2
              id="webhook-editor-title"
              className="text-[15px] font-semibold text-neutral-text-primary outline-none"
            >
              {createdSecret !== null ? 'Webhook created' : isEdit ? 'Edit webhook' : 'New webhook'}
            </h2>
            <p className="text-[12px] text-neutral-text-secondary mt-0.5">
              {createdSecret !== null
                ? 'Copy the signing secret now — it is shown once.'
                : `Fires whenever a subscribed event happens in this ${scope.kind}.`}
            </p>
          </div>
          <button
            type="button"
            onClick={createdSecret !== null ? onSaved : onClose}
            disabled={saving}
            aria-label="Close"
            className="text-neutral-text-secondary hover:text-neutral-text-primary text-lg leading-none px-1 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
          >
            <CloseIcon className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        {createdSecret !== null ? (
          <CreatedSecretPanel secret={createdSecret} onDone={onSaved} />
        ) : (
          <>
            <div className="grid md:grid-cols-[1.2fr_1fr] gap-5 p-5">
              {/* Left: form */}
              <div className="space-y-4">
                <Field label="Endpoint URL" hint="HTTPS only.">
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://hooks.slack.com/services/…"
                    className="tppm-mono w-full h-8 px-2 text-[13px] border border-neutral-border rounded bg-neutral-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                  />
                </Field>

                <Field
                  label="Format"
                  hint="Slack sends a message with an attachment (also works with Discord and Mattermost); Generic sends the raw JSON envelope."
                >
                  <div className="flex flex-wrap gap-1.5">
                    {WEBHOOK_FORMATS.map((f) => {
                      const active = format === f.value;
                      return (
                        <button
                          key={f.value}
                          type="button"
                          disabled={!f.available}
                          aria-pressed={active}
                          onClick={() => f.available && setFormat(f.value)}
                          title={f.hint}
                          className={[
                            'h-7 px-3 rounded text-[12px] font-medium border',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                            active
                              ? 'bg-sage-500 text-navy-900 border-sage-600'
                              : 'border-neutral-border text-neutral-text-secondary hover:text-neutral-text-primary',
                            !f.available ? 'opacity-40 cursor-not-allowed' : '',
                          ].join(' ')}
                        >
                          {f.label}
                          {!f.available && <span className="ml-1 text-[11px]">Enterprise</span>}
                        </button>
                      );
                    })}
                  </div>
                </Field>

                <div>
                  <div className="text-[13px] font-medium text-neutral-text-primary mb-1">
                    {isEdit ? 'Signing secret (leave blank to keep current)' : 'Signing secret'}
                  </div>
                  {!isEdit && (
                    <label className="flex items-center gap-2 text-[12px] text-neutral-text-primary mb-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={generateSecret}
                        onChange={(e) => setGenerateSecret(e.target.checked)}
                        className="accent-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                      />
                      Generate a secret for me (recommended — 256 bits, shown once)
                    </label>
                  )}
                  {!(generateSecret && !isEdit) && (
                    <input
                      type="text"
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      placeholder={isEdit ? '••••••••  (unchanged)' : 'whsec_…'}
                      aria-label="Signing secret"
                      className="tppm-mono w-full h-8 px-2 text-[13px] border border-neutral-border rounded bg-neutral-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                    />
                  )}
                  <span className="block text-[11px] text-neutral-text-secondary mt-1">
                    HMAC-SHA256 of the timestamp and body. Minimum {MIN_SECRET_LENGTH} characters.
                    Verify before trusting payloads.
                  </span>
                </div>

                <div>
                  <div className="text-[13px] font-medium text-neutral-text-primary mb-1">
                    Events
                  </div>
                  <div className="text-[12px] text-neutral-text-secondary mb-2">
                    {events.size} selected
                  </div>
                  {/* Bounded scroller: 19 events over 8 groups is ~815px, which
                      pushed the "{n} selected" counter and the footer off-screen on a
                      laptop. Nothing inside portals or opens an in-flow absolute
                      panel, so a nested scroller introduces no clipping (rule 253). */}
                  <div className="space-y-3 max-h-[320px] overflow-y-auto pr-1">
                    {WEBHOOK_EVENT_CATALOG.map((group) => (
                      <fieldset key={group.category}>
                        <legend className="text-[11px] uppercase tracking-wide font-semibold text-neutral-text-secondary mb-1">
                          {group.category}
                        </legend>
                        <div className="border border-neutral-border rounded overflow-hidden">
                          {group.events.map((ev, i) => (
                            <label
                              key={ev.id}
                              className={[
                                'flex items-center gap-2 px-3 py-1.5 text-[13px] cursor-pointer hover:bg-neutral-surface-sunken',
                                i ? 'border-t border-neutral-border/55' : '',
                              ].join(' ')}
                            >
                              <input
                                type="checkbox"
                                checked={events.has(ev.id)}
                                onChange={() => toggleEvent(ev.id)}
                                className="accent-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                              />
                              <span className="tppm-mono text-[11px] text-neutral-text-secondary">
                                {ev.id}
                              </span>
                              <span className="text-neutral-text-primary">· {ev.label}</span>
                              {ev.isNew && (
                                <span className="ml-auto text-[11px] font-semibold text-navy-900 bg-sage-500 rounded px-1.5 py-0.5">
                                  new
                                </span>
                              )}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    ))}

                    {unknownEvents.length > 0 && (
                      <fieldset>
                        <legend className="text-[11px] uppercase tracking-wide font-semibold text-neutral-text-secondary mb-1">
                          Other subscriptions
                        </legend>
                        <p className="text-[11px] text-neutral-text-secondary mb-1">
                          Registered through the API and not listed above. They stay subscribed
                          unless you clear them here.
                        </p>
                        <div className="border border-neutral-border rounded overflow-hidden">
                          {unknownEvents.map((id, i) => (
                            <label
                              key={id}
                              className={[
                                'flex items-center gap-2 px-3 py-1.5 text-[13px] cursor-pointer hover:bg-neutral-surface-sunken',
                                i ? 'border-t border-neutral-border/55' : '',
                              ].join(' ')}
                            >
                              <input
                                type="checkbox"
                                checked={events.has(id)}
                                onChange={() => toggleEvent(id)}
                                className="accent-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                              />
                              <span className="tppm-mono text-[11px] text-neutral-text-secondary">
                                {id}
                              </span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    )}
                  </div>
                </div>
              </div>

              {/* Right: example render + deliveries */}
              <div className="space-y-4">
                {format === 'slack' && <SlackExample />}
                {isEdit && webhook && (
                  <>
                    {webhook.disabled_at && (
                      <DisabledNotice
                        reason={webhook.disabled_reason}
                        failures={webhook.consecutive_failures}
                        resuming={update.isPending}
                        onResume={() => {
                          // The serializer treats a false→true is_active transition as
                          // the reactivation path and clears the failure record in the
                          // same write, so nothing else needs sending.
                          update.mutate(
                            { id: webhook.id, body: { is_active: true } },
                            {
                              onSuccess: onSaved,
                              onError: (e) => setFormError(extractError(e)),
                            },
                          );
                        }}
                      />
                    )}
                    <RecentDeliveries scope={scope} webhookId={webhook.id} />
                  </>
                )}
              </div>
            </div>

            {formError && (
              <div className="px-5 pb-2 text-[12px] text-semantic-critical" role="alert">
                {formError}
              </div>
            )}

            <div className="px-5 py-3 border-t border-neutral-border flex justify-end gap-2 sticky bottom-0 bg-neutral-surface">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="h-8 px-3 rounded border border-neutral-border bg-transparent text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={saving}
                className="h-8 px-3 rounded bg-brand-primary text-neutral-text-inverse text-[13px] font-medium hover:bg-brand-primary-dark disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create webhook'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[13px] font-medium text-neutral-text-primary mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-neutral-text-secondary mt-1">{hint}</span>}
    </label>
  );
}

/**
 * The one-time secret echo (#2885), built on the primitives shipped for the
 * API-token reveal (#2205).
 *
 * The API returns the generated secret in the 201 body and never again — discarding
 * it, as this modal used to, left the admin with a webhook whose signatures they
 * could not verify. Everything here follows from that unrecoverability: focus seats
 * on Copy (never on a dismiss control), the field selects itself on focus so a
 * blocked clipboard still has a keyboard path, and the heading announces the phase
 * swap because that swap is the only signal a non-sighted user gets.
 */
function CreatedSecretPanel({ secret, onDone }: { secret: string; onDone: () => void }) {
  const copyRef = useRef<HTMLDivElement>(null);

  // The focus trap re-seats on the phase swap, but it takes the FIRST focusable —
  // which on a header-first modal is the ✕, one keystroke from discarding the secret.
  // Re-seat onto Copy after the trap has run (effect order = call order).
  useEffect(() => {
    copyRef.current?.querySelector('button')?.focus();
  }, []);

  return (
    <div className="p-5 space-y-4">
      <h3
        className="text-[13px] font-semibold text-neutral-text-primary"
        aria-live="polite"
      >
        Signing secret created — copy it now
      </h3>
      <div className="border border-semantic-at-risk/80 bg-semantic-at-risk-bg rounded p-3 text-[12px] text-neutral-text-primary">
        This is the only time the signing secret is shown. Store it in your
        receiver&apos;s configuration now — it cannot be retrieved later, only rotated.
      </div>
      <div ref={copyRef} className="flex items-center gap-2">
        <input
          readOnly
          value={secret}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Generated signing secret"
          className="tppm-mono flex-1 min-w-0 h-8 px-2 text-[13px] border border-neutral-border rounded bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        />
        <CopyButton value={secret} label="Copy" accessibleName="Copy signing secret" />
      </div>
      <div className="flex justify-end">
        <DoneButton onClose={onDone} />
      </div>
    </div>
  );
}


/**
 * Surfaces the automatic failure guard (#2884), with the control that clears it.
 *
 * No live region: this renders from a static prop that cannot change while the modal
 * is open, and a region whose content exists in the same commit as the region is not
 * reliably announced anyway. The bold heading, border, and text carry the meaning
 * without relying on color.
 *
 * The "Resume deliveries" button is not decoration — an earlier revision told the
 * admin to "re-enable this webhook" while the web app had no way to write
 * `is_active` at all, so the only in-app recovery was delete-and-recreate, which
 * loses the signing secret.
 */
function DisabledNotice({
  reason,
  failures,
  onResume,
  resuming,
}: {
  reason: string;
  failures: number;
  onResume: () => void;
  resuming: boolean;
}) {
  return (
    <div className="border border-semantic-critical/80 bg-semantic-critical-bg rounded p-3 text-[12px] text-neutral-text-primary">
      <span className="block font-semibold mb-0.5">Deliveries paused automatically</span>
      {reason || `Deactivated after ${failures} consecutive failed deliveries.`} Fix the
      receiver, then resume deliveries.
      <button
        type="button"
        onClick={onResume}
        disabled={resuming}
        className="mt-2 h-7 px-3 rounded border border-neutral-border bg-transparent text-[12px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        {resuming ? 'Resuming…' : 'Resume deliveries'}
      </button>
    </div>
  );
}


/**
 * A representative Slack render of a `task.assigned` event.
 *
 * Static by design and labelled as an example, not a live preview: rendering
 * faithfully would mean reimplementing the server-side renderer in TypeScript,
 * and a second implementation that drifts is worse than an honest sample (#2885).
 */
function SlackExample() {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide font-semibold text-neutral-text-secondary mb-2">
        Slack render example
      </div>
      {/* The hex colors below are deliberate Slack-message fidelity (Slack's own
          palette), not TruePPM chrome — intentionally exempt from web CLAUDE.md
          rule 8. The avatar/accent use TruePPM brand tokens. */}
      <div className="bg-white border border-[#E4E4E0] rounded-card p-3.5 text-[13px] text-[#1d1c1d] leading-snug">
        <div className="flex gap-2.5 mb-2">
          <span className="w-8 h-8 rounded bg-sage-500 text-navy-900 inline-flex items-center justify-center font-bold text-[13px] shrink-0">
            tP
          </span>
          <span className="flex flex-col">
            <span className="flex items-baseline gap-1.5">
              <b>TruePPM</b>
              <span className="text-[10px] text-[#616061] bg-[#F8F8F8] px-1 rounded">APP</span>
            </span>
            <span className="font-bold mt-0.5">Task assigned — Foundation pour</span>
          </span>
        </div>
        <div className="border-l-4 border-brand-primary pl-3 ml-1 flex flex-col gap-1.5">
          <div className="font-semibold">Foundation pour — final approval</div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
            <span className="text-[#616061]">Status</span>
            <span>in_progress</span>
            <span className="text-[#616061]">Assignee</span>
            <span>Jordan Mehta</span>
          </div>
        </div>
      </div>
      <p className="text-[11px] text-neutral-text-secondary mt-1.5">
        Example only — the fields shown depend on the event type.
      </p>
    </div>
  );
}

function RecentDeliveries({ scope, webhookId }: { scope: IntegrationScope; webhookId: string }) {
  const { data: deliveries, isLoading } = useWebhookDeliveries(scope, webhookId);
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide font-semibold text-neutral-text-secondary mb-2">
        Recent deliveries
      </div>
      {isLoading ? (
        <div
          className="h-16 bg-neutral-surface-sunken rounded motion-safe:animate-pulse"
          aria-busy="true"
        />
      ) : !deliveries || deliveries.length === 0 ? (
        <p className="text-[12px] text-neutral-text-secondary">No deliveries yet.</p>
      ) : (
        <div className="border border-neutral-border rounded overflow-hidden text-[12px]">
          {deliveries.slice(0, 6).map((d, i) => (
            <div
              key={d.id}
              className={[
                'grid grid-cols-[1fr_auto_auto] gap-2 px-3 py-1.5 items-center',
                i ? 'border-t border-neutral-border/55' : '',
              ].join(' ')}
            >
              <span className="tppm-mono truncate">{d.event_type}</span>
              <span
                className={`tppm-mono ${
                  d.status === 'success'
                    ? 'text-semantic-on-track'
                    : d.status === 'failed'
                      ? 'text-semantic-critical'
                      : 'text-semantic-at-risk'
                }`}
              >
                {d.response_status ?? d.status}
              </span>
              <span className="tppm-mono text-neutral-text-secondary">#{d.sequence_number}</span>
            </div>
          ))}
        </div>
      )}
    </div>
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
