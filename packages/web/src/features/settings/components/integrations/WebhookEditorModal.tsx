/**
 * Create/edit modal for a webhook (#638 / #600).
 *
 * Left: the form (endpoint URL, format picker, signing secret, event picker).
 * Right: a live Slack-renderer preview when format=slack, plus the recent
 * delivery log when editing an existing webhook.
 *
 * Only `slack` and `generic` formats are selectable — the others are shown
 * disabled (Enterprise). The event picker lists exactly the 11 real OSS events;
 * the four added in 0.2 carry a "new" badge.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isAxiosError } from 'axios';
import {
  useCreateWebhook,
  useUpdateWebhook,
  useWebhookDeliveries,
  type ApiWebhook,
  type IntegrationScope,
} from '@/hooks/useWebhooks';
import {
  WEBHOOK_EVENT_CATALOG,
  WEBHOOK_FORMATS,
  ALL_WEBHOOK_EVENT_IDS,
} from './events';

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
  const [events, setEvents] = useState<Set<string>>(
    () => new Set(webhook?.events.filter((e) => ALL_WEBHOOK_EVENT_IDS.includes(e)) ?? []),
  );
  const [formError, setFormError] = useState<string | null>(null);

  const create = useCreateWebhook(scope);
  const update = useUpdateWebhook(scope);
  const saving = create.isPending || update.isPending;
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !saving) {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

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
    if (!isEdit && secret.trim().length === 0) return 'A signing secret is required.';
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
        { url: url.trim(), events: eventList, format, secret: secret.trim() },
        { onSuccess: onSaved, onError: (e) => setFormError(extractError(e)) },
      );
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="webhook-editor-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="bg-neutral-surface border border-neutral-border rounded-lg w-full max-w-3xl max-h-[90vh] overflow-auto">
        <div className="px-5 pt-4 pb-3 border-b border-neutral-border flex items-start justify-between">
          <div>
            <h2
              id="webhook-editor-title"
              ref={headingRef}
              tabIndex={-1}
              className="text-[15px] font-semibold text-neutral-text-primary outline-none"
            >
              {isEdit ? 'Edit webhook' : 'New webhook'}
            </h2>
            <p className="text-[12px] text-neutral-text-secondary mt-0.5">
              Fires whenever a subscribed event happens in this {scope.kind}.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            className="text-neutral-text-secondary hover:text-neutral-text-primary text-lg leading-none px-1 disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        <div className="grid md:grid-cols-[1.2fr_1fr] gap-5 p-5">
          {/* Left: form */}
          <div className="space-y-4">
            <Field label="Endpoint URL" hint="HTTPS only.">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://hooks.slack.com/services/…"
                className="tppm-mono w-full h-8 px-2 text-[13px] border border-neutral-border rounded bg-neutral-surface focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
              />
            </Field>

            <Field label="Format" hint="Slack renders a Block-Kit message; Generic sends the raw JSON envelope.">
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
                        active
                          ? 'bg-brand-primary text-white border-brand-primary'
                          : 'border-neutral-border text-neutral-text-secondary hover:text-neutral-text-primary',
                        !f.available ? 'opacity-40 cursor-not-allowed' : '',
                      ].join(' ')}
                    >
                      {f.label}
                      {!f.available && <span className="ml-1 text-[10px]">Enterprise</span>}
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field
              label={isEdit ? 'Signing secret (leave blank to keep current)' : 'Signing secret'}
              hint="HMAC-SHA256 of the body. Verify before trusting payloads."
            >
              <input
                type="text"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={isEdit ? '••••••••  (unchanged)' : 'whsec_…'}
                className="tppm-mono w-full h-8 px-2 text-[13px] border border-neutral-border rounded bg-neutral-surface focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
              />
            </Field>

            <div>
              <div className="text-[13px] font-medium text-neutral-text-primary mb-1">
                Events
              </div>
              <div className="text-[12px] text-neutral-text-secondary mb-2">
                {events.size} selected
              </div>
              <div className="space-y-3">
                {WEBHOOK_EVENT_CATALOG.map((group) => (
                  <fieldset key={group.category}>
                    <legend className="text-[10px] uppercase tracking-wide font-semibold text-neutral-text-secondary mb-1">
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
                            className="accent-brand-primary"
                          />
                          <span className="tppm-mono text-[11px] text-neutral-text-secondary">
                            {ev.id}
                          </span>
                          <span className="text-neutral-text-primary">· {ev.label}</span>
                          {ev.isNew && (
                            <span className="ml-auto text-[10px] font-semibold text-white bg-brand-primary rounded px-1.5 py-0.5">
                              new
                            </span>
                          )}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ))}
              </div>
            </div>
          </div>

          {/* Right: preview + deliveries */}
          <div className="space-y-4">
            {format === 'slack' && <SlackPreview />}
            {isEdit && webhook && <RecentDeliveries scope={scope} webhookId={webhook.id} />}
          </div>
        </div>

        {formError && (
          <div className="px-5 pb-2 text-[12px] text-semantic-critical" role="alert">
            {formError}
          </div>
        )}

        <div className="px-5 py-3 border-t border-neutral-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="h-8 px-3 rounded border border-neutral-border bg-transparent text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving}
            className="h-8 px-3 rounded bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark disabled:opacity-50"
          >
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create webhook'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[13px] font-medium text-neutral-text-primary mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-neutral-text-secondary mt-1">{hint}</span>}
    </label>
  );
}

/** Representative Slack render of a task.assigned event (static preview). */
function SlackPreview() {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide font-semibold text-neutral-text-secondary mb-2">
        Slack renderer preview
      </div>
      <div className="bg-white border border-[#E4E4E0] rounded-lg p-3.5 text-[13px] text-[#1d1c1d] leading-snug">
        <div className="flex gap-2.5 mb-2">
          <span className="w-8 h-8 rounded bg-brand-primary text-white inline-flex items-center justify-center font-bold text-[13px] shrink-0">
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
    </div>
  );
}

function RecentDeliveries({
  scope,
  webhookId,
}: {
  scope: IntegrationScope;
  webhookId: string;
}) {
  const { data: deliveries, isLoading } = useWebhookDeliveries(scope, webhookId);
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide font-semibold text-neutral-text-secondary mb-2">
        Recent deliveries
      </div>
      {isLoading ? (
        <div className="h-16 bg-neutral-surface-sunken rounded animate-pulse" aria-busy="true" />
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
