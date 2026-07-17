/**
 * Workspace → Settings → Email & SMTP — writable transport config (#712, ADR-0213).
 *
 * Upgrades the #639 read-only status page to the writable admin surface: pick a
 * transport (TruePPM cloud / custom SMTP / SendGrid / SES), enter credentials
 * (password write-only), From identity, DKIM, delivery limits, and a bounce
 * webhook. The form fields save through the shell save-bar (validate-before-
 * persist — a failed transport keeps the entered values and shows the error
 * inline). "Send test email" and the deliverability health check act on the
 * *saved* singleton and are button-triggered, not part of the form save.
 */

import { useCallback, useEffect, useId, useState } from 'react';
import {
  useEmailSettings,
  useUpdateEmailSettings,
  useSendTestEmail,
  useEmailHealth,
  type EmailSecurity,
  type EmailSettings,
  type EmailTransportMode,
  type HealthStatus,
} from '@/hooks/useEmailSettings';
import { SettingsPageTitle, FieldRow, SettingsCard } from '../SettingsShell';
import { useDirtyForm } from '../hooks/useDirtyForm';

const INPUT_CLASS =
  'w-full max-w-[420px] h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed';
const SELECT_CLASS =
  'h-8 pl-2.5 pr-7 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none bg-no-repeat bg-[right_0.45rem_center] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary disabled:cursor-not-allowed';
const SELECT_STYLE = {
  backgroundImage:
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 16 16'><path d='M4 6l4 4 4-4' stroke='%23667085' stroke-width='2' stroke-linecap='round' fill='none' /></svg>\")",
};

const TRANSPORTS: { value: EmailTransportMode; title: string; desc: string }[] = [
  { value: 'cloud', title: 'TruePPM cloud', desc: 'Built-in relay (server settings).' },
  { value: 'smtp', title: 'Custom SMTP', desc: 'Your own mail host.' },
  { value: 'sendgrid', title: 'SendGrid', desc: 'SendGrid SMTP relay.' },
  { value: 'ses', title: 'Amazon SES', desc: 'SES SMTP relay.' },
];

const SES_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-2',
  'eu-west-1',
  'eu-central-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
];

/** Compose / parse the region-specific SES relay host from a region code. */
function sesHostFor(region: string): string {
  return `email-smtp.${region}.amazonaws.com`;
}
function regionFromHost(host: string): string {
  const m = /^email-smtp\.([a-z0-9-]+)\.amazonaws\.com$/.exec(host);
  return m ? m[1] : SES_REGIONS[0];
}

/** Copy-to-clipboard button for a read-only value (mirrors WorkspaceSsoPage). */
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="h-8 px-2.5 text-[12px] font-medium border border-neutral-border rounded-control text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 shrink-0"
    >
      {copied ? 'Copied ✓' : 'Copy'}
    </button>
  );
}

interface FormState {
  transportMode: EmailTransportMode;
  host: string;
  port: number;
  security: EmailSecurity;
  username: string;
  password: string;
  sesRegion: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  dkimSelector: string;
  maxRecipients: number;
  throttlePerMin: number;
  bounceWebhookUrl: string;
}

function snapshotFrom(data: EmailSettings): FormState {
  return {
    transportMode: data.transport_mode,
    host: data.transport_mode === 'ses' ? '' : data.host,
    port: data.port,
    security: data.security,
    username: data.username,
    // Password always starts blank — a set secret shows as a placeholder and an
    // untouched blank field structurally equals its snapshot (never dirty).
    password: '',
    sesRegion: data.transport_mode === 'ses' ? regionFromHost(data.host) : SES_REGIONS[0],
    fromName: data.from_name,
    fromEmail: data.from_email,
    replyTo: data.reply_to,
    dkimSelector: data.dkim_selector,
    maxRecipients: data.max_recipients,
    throttlePerMin: data.throttle_per_min,
    bounceWebhookUrl: data.bounce_webhook_url,
  };
}

/** Best-effort extraction of a DRF 400 error into one human-readable line. */
function parseSaveError(err: unknown): string {
  const generic = 'Could not save the email settings. Check the highlighted fields.';
  if (typeof err !== 'object' || err === null || !('response' in err)) return generic;
  const response = (err as { response?: { data?: unknown } }).response;
  const data = response?.data;
  if (typeof data !== 'object' || data === null) return generic;
  const record = data as Record<string, unknown>;
  const order = ['non_field_errors', 'host', 'password', 'from_email', 'bounce_webhook_url'];
  for (const key of [...order, ...Object.keys(record)]) {
    const val = record[key];
    if (Array.isArray(val) && typeof val[0] === 'string') return val[0];
    if (typeof val === 'string') return val;
  }
  return generic;
}

export function WorkspaceEmailPage() {
  const { data, isLoading, isError, refetch } = useEmailSettings();
  const updateSettings = useUpdateEmailSettings();
  const sendTest = useSendTestEmail();
  const health = useEmailHealth();
  const portId = useId();
  const securityId = useId();
  const regionId = useId();

  const [form, setForm] = useState<FormState | null>(null);
  const [initial, setInitial] = useState<FormState | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const snap = snapshotFrom(data);
    setForm(snap);
    setInitial(snap);
  }, [data]);

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSaveError(null); // editing clears the last transport-validation error
  }, []);

  const onSave = useCallback(async () => {
    if (!form) return;
    const host = form.transportMode === 'ses' ? sesHostFor(form.sesRegion) : form.host;
    try {
      await updateSettings.mutateAsync({
        transport_mode: form.transportMode,
        host,
        port: form.port,
        security: form.security,
        username: form.username,
        password: form.password,
        from_name: form.fromName,
        from_email: form.fromEmail,
        reply_to: form.replyTo,
        dkim_selector: form.dkimSelector,
        max_recipients: form.maxRecipients,
        throttle_per_min: form.throttlePerMin,
        bounce_webhook_url: form.bounceWebhookUrl,
      });
      // Success: clear the write-only password field and re-snapshot.
      setInitial({ ...form, password: '' });
      setForm({ ...form, password: '' });
      setSaveError(null);
    } catch (err) {
      // Keep every entered value; surface the transport error inline and
      // re-throw so the shell keeps the section dirty and doesn't stamp "Saved".
      setSaveError(parseSaveError(err));
      throw err;
    }
  }, [form, updateSettings]);

  const onReset = useCallback(() => {
    setForm(initial);
    setSaveError(null);
  }, [initial]);

  const canEdit = data?.can_edit ?? false;
  const dirty = !!form && !!initial && JSON.stringify(form) !== JSON.stringify(initial);

  useDirtyForm({
    values: (form ?? {}) as unknown as Record<string, unknown>,
    initialValues: (initial ?? {}) as unknown as Record<string, unknown>,
    onSave,
    onReset,
    apiReady: canEdit,
  });

  if (isError) {
    return (
      <div className="px-6 pb-8 max-w-[920px]">
        <SettingsCard className="border-semantic-critical/40">
          <div className="px-4 py-4 flex items-center gap-3" role="alert">
            <p className="flex-1 text-[13px] text-neutral-text-secondary">
              Couldn&apos;t load email settings.
            </p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="h-7 px-3 text-[12px] font-medium border border-neutral-border rounded-control text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Retry
            </button>
          </div>
        </SettingsCard>
      </div>
    );
  }

  if (isLoading || !form || !data) {
    return (
      <div className="px-6 py-8 space-y-3" aria-label="Loading email settings" aria-busy="true">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-10 rounded-control bg-neutral-surface-raised motion-safe:animate-pulse"
          />
        ))}
      </div>
    );
  }

  const disabled = !canEdit;
  const isSmtp = form.transportMode === 'smtp';
  const isSes = form.transportMode === 'ses';
  const isSendgrid = form.transportMode === 'sendgrid';
  const isCloud = form.transportMode === 'cloud';
  const credentialLabel = isSendgrid || isSes ? 'API key / SMTP password' : 'Password';

  return (
    <div>
      <SettingsPageTitle
        title="Email & SMTP"
        subtitle="Configure how this workspace sends outbound mail."
      />

      <div className="px-6 pb-8 max-w-[920px]">
        {/* Public URL status (#2015) — the origin used to build emailed invite,
            reset, and notification deep-links. Env-only (TRUEPPM_FRONTEND_BASE_URL);
            shown read-only so an operator can confirm it, and warned about when
            unset because those links then render as origin-less paths and break. */}
        {data.frontend_base_url_configured ? (
          <SettingsCard className="mb-5">
            <div className="px-4 py-3">
              <FieldRow
                label="Public URL"
                hint="Origin used to build invite, reset, and notification links in outbound email."
              >
                <div className="flex items-center gap-2 max-w-[520px]">
                  <input
                    type="text"
                    readOnly
                    value={data.frontend_base_url}
                    aria-label="Public URL (read-only)"
                    className={`${INPUT_CLASS} tppm-mono bg-neutral-surface-sunken`}
                  />
                  <CopyButton value={data.frontend_base_url} />
                </div>
              </FieldRow>
              <p className="mt-1 text-[12px] text-neutral-text-secondary">
                Set at deploy time (<span className="tppm-mono">TRUEPPM_FRONTEND_BASE_URL</span>);
                not editable here.
              </p>
            </div>
          </SettingsCard>
        ) : (
          <div
            role="alert"
            className="mb-5 rounded-card border border-semantic-warning/40 bg-semantic-warning-bg px-4 py-3"
          >
            <p className="text-[13px] font-medium text-semantic-warning">
              Public URL not set — emailed links are broken
            </p>
            <p className="mt-0.5 text-[13px] text-neutral-text-secondary">
              Invite, password-reset, and notification emails build links from this install&apos;s
              public origin. It is unset, so those links render as bare paths with no domain and
              won&apos;t open. Set <span className="tppm-mono">TRUEPPM_FRONTEND_BASE_URL</span> at
              deploy time (Helm <span className="tppm-mono">config.TRUEPPM_FRONTEND_BASE_URL</span>).
            </p>
          </div>
        )}

        {!canEdit && (
          <SettingsCard className="mb-5 bg-neutral-surface-sunken">
            <div className="px-4 py-3" role="note">
              <p className="text-[13px] text-neutral-text-secondary">
                Only a workspace operator can change the mail transport. You can view the
                current configuration below.
              </p>
            </div>
          </SettingsCard>
        )}

        {saveError && (
          <div
            role="alert"
            className="mb-5 rounded-card border border-semantic-critical/40 bg-semantic-critical-bg px-4 py-3"
          >
            <p className="text-[13px] font-medium text-semantic-critical">
              Transport validation failed
            </p>
            <p className="mt-0.5 text-[13px] text-semantic-critical">{saveError}</p>
            <p className="mt-1 text-[12px] text-neutral-text-secondary">
              Your entries are kept — fix the values and save again.
            </p>
          </div>
        )}

        {/* Transport picker */}
        <FieldRow label="Transport" hint="How mail leaves TruePPM.">
          <fieldset
            className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-[520px] border-0 p-0 m-0"
            aria-label="Transport"
          >
            {TRANSPORTS.map((t) => {
              const selected = form.transportMode === t.value;
              return (
                <label
                  key={t.value}
                  className={[
                    'flex flex-col gap-0.5 rounded-card border p-3 cursor-pointer transition-colors',
                    selected
                      ? 'border-brand-primary bg-brand-primary-light/40'
                      : 'border-neutral-border hover:border-neutral-text-disabled',
                    disabled ? 'cursor-not-allowed opacity-70' : '',
                  ].join(' ')}
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="transport-mode"
                      value={t.value}
                      checked={selected}
                      disabled={disabled}
                      onChange={() => set('transportMode', t.value)}
                      className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                    />
                    <span className="text-[13px] font-semibold text-neutral-text-primary">
                      {t.title}
                    </span>
                  </span>
                  <span className="text-[12px] text-neutral-text-secondary pl-6">{t.desc}</span>
                </label>
              );
            })}
          </fieldset>
        </FieldRow>

        {/* Conditional transport fields */}
        {isCloud && (
          <SettingsCard className="my-3 bg-neutral-surface-sunken">
            <div className="px-4 py-3">
              <p className="text-[13px] text-neutral-text-secondary">
                Mail sends through TruePPM&apos;s built-in relay (the server{' '}
                <span className="tppm-mono">EMAIL_*</span> settings). No credentials needed.
                Choose another transport above to use your own provider.
              </p>
            </div>
          </SettingsCard>
        )}

        {isSmtp && (
          <>
            <FieldRow label="Host">
              <input
                type="text"
                value={form.host}
                disabled={disabled}
                onChange={(e) => set('host', e.target.value)}
                className={INPUT_CLASS}
                placeholder="smtp.example.com"
                aria-label="SMTP host"
              />
            </FieldRow>
            <FieldRow label="Port">
              <label htmlFor={portId} className="sr-only">
                SMTP port
              </label>
              <input
                id={portId}
                type="number"
                min={1}
                max={65535}
                value={form.port}
                disabled={disabled}
                onChange={(e) => set('port', e.target.valueAsNumber || 0)}
                className="w-[120px] h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary disabled:bg-neutral-surface-sunken disabled:cursor-not-allowed"
              />
            </FieldRow>
            <FieldRow label="Security">
              <label htmlFor={securityId} className="sr-only">
                Connection security
              </label>
              <select
                id={securityId}
                value={form.security}
                disabled={disabled}
                onChange={(e) => set('security', e.target.value as EmailSecurity)}
                className={`${SELECT_CLASS} w-[180px]`}
                style={SELECT_STYLE}
              >
                <option value="none">None</option>
                <option value="tls">STARTTLS</option>
                <option value="ssl">SSL/TLS</option>
              </select>
            </FieldRow>
            <FieldRow label="Username">
              <input
                type="text"
                value={form.username}
                disabled={disabled}
                onChange={(e) => set('username', e.target.value)}
                className={INPUT_CLASS}
                aria-label="SMTP username"
              />
            </FieldRow>
          </>
        )}

        {isSes && (
          <>
            <FieldRow label="Region" hint="The SES SMTP endpoint is derived from the region.">
              <label htmlFor={regionId} className="sr-only">
                SES region
              </label>
              <select
                id={regionId}
                value={form.sesRegion}
                disabled={disabled}
                onChange={(e) => set('sesRegion', e.target.value)}
                className={`${SELECT_CLASS} w-[200px]`}
                style={SELECT_STYLE}
              >
                {SES_REGIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </FieldRow>
            <FieldRow label="SMTP username">
              <input
                type="text"
                value={form.username}
                disabled={disabled}
                onChange={(e) => set('username', e.target.value)}
                className={INPUT_CLASS}
                aria-label="SES SMTP username"
              />
            </FieldRow>
            <SettingsCard className="my-2 bg-neutral-surface-sunken max-w-[420px]">
              <div className="px-4 py-2.5">
                <p className="text-[12px] text-neutral-text-secondary">
                  Relay{' '}
                  <span className="tppm-mono">{sesHostFor(form.sesRegion)} · 587 · STARTTLS</span>
                </p>
              </div>
            </SettingsCard>
          </>
        )}

        {isSendgrid && (
          <SettingsCard className="my-2 bg-neutral-surface-sunken max-w-[420px]">
            <div className="px-4 py-2.5">
              <p className="text-[12px] text-neutral-text-secondary">
                Relay <span className="tppm-mono">smtp.sendgrid.net · 587 · STARTTLS</span>. Paste
                your API key below.
              </p>
            </div>
          </SettingsCard>
        )}

        {/* Credential (write-only) — shown for every non-cloud transport */}
        {!isCloud && (
          <FieldRow
            label={credentialLabel}
            hint={data.password_is_set ? 'Leave blank to keep the current secret.' : undefined}
          >
            <div className="flex items-center gap-2 max-w-[420px]">
              <input
                type={showPassword ? 'text' : 'password'}
                value={form.password}
                disabled={disabled}
                onChange={(e) => set('password', e.target.value)}
                placeholder={
                  data.password_is_set
                    ? '•••• (set — leave blank to keep)'
                    : isSendgrid || isSes
                      ? 'Paste API key'
                      : 'Enter password'
                }
                className={INPUT_CLASS}
                aria-label={credentialLabel}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="text-[12px] text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-control px-1"
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </FieldRow>
        )}

        {/* From identity — always visible */}
        <h3 className="mt-8 mb-1 text-[13px] font-semibold text-neutral-text-primary">
          From identity
        </h3>
        <FieldRow label="From name">
          <input
            type="text"
            value={form.fromName}
            disabled={disabled}
            onChange={(e) => set('fromName', e.target.value)}
            className={INPUT_CLASS}
            aria-label="From name"
          />
        </FieldRow>
        <FieldRow label="From address">
          <input
            type="email"
            value={form.fromEmail}
            disabled={disabled}
            onChange={(e) => set('fromEmail', e.target.value)}
            className={INPUT_CLASS}
            aria-label="From address"
          />
        </FieldRow>
        <FieldRow label="Reply-to">
          <input
            type="email"
            value={form.replyTo}
            disabled={disabled}
            onChange={(e) => set('replyTo', e.target.value)}
            className={INPUT_CLASS}
            aria-label="Reply-to address"
          />
        </FieldRow>
        <FieldRow label="DKIM selector">
          <input
            type="text"
            value={form.dkimSelector}
            disabled={disabled}
            onChange={(e) => set('dkimSelector', e.target.value)}
            className={`${INPUT_CLASS} tppm-mono max-w-[220px]`}
            aria-label="DKIM selector"
          />
        </FieldRow>

        {/* Delivery & limits */}
        <h3 className="mt-8 mb-1 text-[13px] font-semibold text-neutral-text-primary">
          Delivery &amp; limits
        </h3>
        <FieldRow label="Max recipients" hint="Per single message.">
          <input
            type="number"
            min={1}
            value={form.maxRecipients}
            disabled={disabled}
            onChange={(e) => set('maxRecipients', e.target.valueAsNumber || 0)}
            className="w-[120px] h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary disabled:bg-neutral-surface-sunken disabled:cursor-not-allowed"
            aria-label="Max recipients"
          />
        </FieldRow>
        <FieldRow label="Throttle (per minute)" hint="0 disables throttling.">
          <input
            type="number"
            min={0}
            value={form.throttlePerMin}
            disabled={disabled}
            onChange={(e) => set('throttlePerMin', e.target.valueAsNumber || 0)}
            className="w-[120px] h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary disabled:bg-neutral-surface-sunken disabled:cursor-not-allowed"
            aria-label="Throttle per minute"
          />
        </FieldRow>
        <FieldRow label="Bounce webhook" hint="POSTed when a message bounces.">
          <input
            type="url"
            value={form.bounceWebhookUrl}
            disabled={disabled}
            onChange={(e) => set('bounceWebhookUrl', e.target.value)}
            className={INPUT_CLASS}
            placeholder="https://example.com/hooks/bounce"
            aria-label="Bounce webhook URL"
          />
        </FieldRow>

        {/* Send test email — immediate action, gated on a clean saved form */}
        {canEdit && (
          <SettingsCard className="mt-8">
            <div className="px-4 py-3.5">
              <h3 className="text-[13px] font-semibold text-neutral-text-primary">
                Send test email
              </h3>
              <p className="mt-0.5 text-[12px] text-neutral-text-secondary">
                {dirty
                  ? 'Save your changes first to test the new transport.'
                  : 'Sends a test message to your own address through the saved transport.'}
              </p>
              <div className="mt-2 flex items-center gap-3">
                <button
                  type="button"
                  disabled={dirty || sendTest.isPending}
                  onClick={() => sendTest.mutate()}
                  className="h-8 px-3 text-[13px] font-medium border border-neutral-border rounded-control text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed"
                >
                  {sendTest.isPending ? 'Sending…' : 'Send test email'}
                </button>
                <p className="text-[12px]" aria-live="polite">
                  {sendTest.data?.sent === true && (
                    <span className="text-semantic-on-track">✓ Sent — check your inbox.</span>
                  )}
                  {sendTest.data?.sent === false && (
                    <span className="text-semantic-critical">
                      ✗ {sendTest.data.error ?? 'Send failed.'}
                    </span>
                  )}
                </p>
              </div>
            </div>
          </SettingsCard>
        )}

        {/* Deliverability health — lazy, button-triggered */}
        {canEdit && (
          <SettingsCard className="mt-3">
            <div className="px-4 py-3.5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-[13px] font-semibold text-neutral-text-primary">
                  Deliverability
                </h3>
                <button
                  type="button"
                  disabled={health.isFetching}
                  onClick={() => void health.refetch()}
                  className="h-7 px-3 text-[12px] font-medium border border-neutral-border rounded-control text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:cursor-not-allowed"
                >
                  {health.isFetching ? 'Checking…' : health.data ? 'Re-check' : 'Check now'}
                </button>
              </div>
              <div className="mt-2">
                {health.data && !health.data.available ? (
                  <p className="text-[12px] text-neutral-text-secondary">
                    Deliverability checks are unavailable on this server.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <HealthChip label="SPF" status={health.data?.spf} />
                    <HealthChip label="DKIM" status={health.data?.dkim} />
                    <HealthChip label="DMARC" status={health.data?.dmarc} />
                  </div>
                )}
              </div>
            </div>
          </SettingsCard>
        )}
      </div>
    </div>
  );
}

const CHIP_STYLES: Record<HealthStatus, string> = {
  pass: 'bg-semantic-on-track-bg text-semantic-on-track',
  warn: 'bg-semantic-at-risk-bg text-semantic-at-risk',
  fail: 'bg-semantic-critical-bg text-semantic-critical',
  unknown: 'bg-neutral-surface-sunken text-neutral-text-secondary',
};
const CHIP_GLYPH: Record<HealthStatus, string> = {
  pass: '✓',
  warn: '⚠',
  fail: '✗',
  unknown: '–',
};
const CHIP_WORD: Record<HealthStatus, string> = {
  pass: 'Pass',
  warn: 'Warn',
  fail: 'Fail',
  unknown: 'Not checked',
};

function HealthChip({ label, status }: { label: string; status?: HealthStatus }) {
  const s: HealthStatus = status ?? 'unknown';
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px]">
      <span className="font-medium text-neutral-text-secondary">{label}</span>
      <span
        className={`inline-flex items-center gap-1 rounded-pill px-2 py-0.5 font-medium ${CHIP_STYLES[s]}`}
      >
        <span aria-hidden="true">{CHIP_GLYPH[s]}</span>
        {CHIP_WORD[s]}
      </span>
    </span>
  );
}
