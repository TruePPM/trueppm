/**
 * Workspace → Settings → Email & SMTP — writable transport config (#712, ADR-0213).
 *
 * Upgrades the #639 read-only status page to the writable admin surface: pick a
 * provider (TruePPM cloud / Gmail / Microsoft 365 / Fastmail / SendGrid / SES /
 * custom SMTP), enter credentials (password write-only), From identity, DKIM,
 * delivery limits, and a bounce webhook. Guided provider setup (#2115) adds
 * first-class presets on top of the ADR-0213 backend contract: a preset is a
 * *client-side projection* of `(transport_mode, host)` — Gmail/M365/Fastmail all
 * persist as `transport_mode='smtp'` with a known host — so no new server field
 * is introduced. The form fields save through the shell save-bar (validate-
 * before-persist — a failed transport keeps the entered values and shows the
 * error inline). "Send test email" and the deliverability health check act on
 * the *saved* singleton and are button-triggered, not part of the form save.
 */

import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
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
import { FieldHelp, type FieldHelpOption } from '@/components/FieldHelp';
import { ChevronDownIcon, ChevronRightIcon } from '@/components/Icons';

const INPUT_CLASS =
  'w-full max-w-[420px] h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed';
const SELECT_CLASS =
  'h-8 pl-2.5 pr-7 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none bg-no-repeat bg-[right_0.45rem_center] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary disabled:cursor-not-allowed';
const SELECT_STYLE = {
  backgroundImage:
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 16 16'><path d='M4 6l4 4 4-4' stroke='%23667085' stroke-width='2' stroke-linecap='round' fill='none' /></svg>\")",
};

/**
 * Client-side provider registry (#2115).
 *
 * "Provider" is a lens over the ADR-0213 singleton, not a persisted field: the
 * server stores only `transport_mode` + `host` + `port` + `security`, so
 * Gmail/M365/Fastmail all map to `transport_mode='smtp'` with a known host. The
 * registry drives (a) the `<select>` options, (b) the defaults a preset pre-
 * fills, (c) whether host/port/security collapse behind the Advanced reveal, and
 * (d) whether the Gmail App-Password help shows.
 */
type ProviderId = 'cloud' | 'gmail' | 'm365' | 'fastmail' | 'sendgrid' | 'ses' | 'custom';

interface ProviderDef {
  id: ProviderId;
  label: string;
  transportMode: EmailTransportMode;
  /** Pre-filled on select; still editable. Empty for cloud/ses/custom. */
  defaultHost: string;
  defaultPort: number;
  defaultSecurity: EmailSecurity;
  /** Preset (Gmail/M365/Fastmail): host/port/security live behind an Advanced reveal. */
  showAdvanced: boolean;
  /** Gmail: show the guided App-Password FieldHelp next to the credential. */
  gmailHelp: boolean;
  credentialLabel: string;
}

const PROVIDERS: ProviderDef[] = [
  {
    id: 'cloud',
    label: 'TruePPM cloud',
    transportMode: 'cloud',
    defaultHost: '',
    defaultPort: 587,
    defaultSecurity: 'tls',
    showAdvanced: false,
    gmailHelp: false,
    credentialLabel: 'Password',
  },
  {
    id: 'gmail',
    label: 'Gmail',
    transportMode: 'smtp',
    defaultHost: 'smtp.gmail.com',
    defaultPort: 587,
    defaultSecurity: 'tls',
    showAdvanced: true,
    gmailHelp: true,
    credentialLabel: 'App password',
  },
  {
    id: 'm365',
    label: 'Microsoft 365 / Outlook',
    transportMode: 'smtp',
    defaultHost: 'smtp.office365.com',
    defaultPort: 587,
    defaultSecurity: 'tls',
    showAdvanced: true,
    gmailHelp: false,
    credentialLabel: 'Password',
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    transportMode: 'smtp',
    defaultHost: 'smtp.fastmail.com',
    defaultPort: 465,
    defaultSecurity: 'ssl',
    showAdvanced: true,
    gmailHelp: false,
    credentialLabel: 'App password',
  },
  {
    id: 'sendgrid',
    label: 'SendGrid',
    transportMode: 'sendgrid',
    defaultHost: 'smtp.sendgrid.net',
    defaultPort: 587,
    defaultSecurity: 'tls',
    showAdvanced: false,
    gmailHelp: false,
    credentialLabel: 'API key / SMTP password',
  },
  {
    id: 'ses',
    label: 'Amazon SES',
    transportMode: 'ses',
    defaultHost: '',
    defaultPort: 587,
    defaultSecurity: 'tls',
    showAdvanced: false,
    gmailHelp: false,
    credentialLabel: 'API key / SMTP password',
  },
  {
    id: 'custom',
    label: 'Custom (generic) SMTP',
    transportMode: 'smtp',
    defaultHost: '',
    defaultPort: 587,
    defaultSecurity: 'tls',
    showAdvanced: false,
    gmailHelp: false,
    credentialLabel: 'Password',
  },
];

const PROVIDER_BY_ID = Object.fromEntries(PROVIDERS.map((p) => [p.id, p])) as Record<
  ProviderId,
  ProviderDef
>;

/** Reverse lookup: a known SMTP host → its preset id (else Custom). */
const KNOWN_SMTP_HOSTS: Record<string, ProviderId> = {
  'smtp.gmail.com': 'gmail',
  'smtp.office365.com': 'm365',
  'smtp.fastmail.com': 'fastmail',
};

/**
 * Project the saved `(transport_mode, host)` back onto a provider option. Runs
 * once on load (and on reset) against the *raw* host, before the SES host-blank
 * in `snapshotFrom` — an unrecognized SMTP host derives to Custom.
 */
function deriveProviderId(mode: EmailTransportMode, host: string): ProviderId {
  if (mode === 'cloud') return 'cloud';
  if (mode === 'sendgrid') return 'sendgrid';
  if (mode === 'ses') return 'ses';
  return KNOWN_SMTP_HOSTS[host.trim().toLowerCase()] ?? 'custom';
}

/**
 * Whether a preset's Advanced reveal should start expanded: only when the saved
 * host/port/security diverge from the preset defaults, so an operator's prior
 * customization is visible rather than hidden.
 */
function shouldAutoExpandAdvanced(
  id: ProviderId,
  cfg: { host: string; port: number; security: EmailSecurity },
): boolean {
  const def = PROVIDER_BY_ID[id];
  if (!def.showAdvanced) return false;
  return (
    cfg.host.trim().toLowerCase() !== def.defaultHost ||
    cfg.port !== def.defaultPort ||
    cfg.security !== def.defaultSecurity
  );
}

const SECURITY_LABEL: Record<EmailSecurity, string> = {
  none: 'None',
  tls: 'STARTTLS',
  ssl: 'SSL/TLS',
};

const SECURITY_INLINE_HINT: Record<EmailSecurity, string> = {
  tls: 'Upgrades to an encrypted connection after connecting. Recommended (port 587).',
  ssl: 'Encrypted from the first byte (port 465).',
  none: 'No encryption — credentials and mail travel in plaintext (port 25).',
};

/** FieldHelp option copy for the Security select (web-rule 263). */
function securityHelpOptions(current: EmailSecurity): FieldHelpOption[] {
  return [
    {
      label: 'STARTTLS (recommended)',
      desc: 'Port 587. Connects in the clear, then upgrades to TLS before login. The right choice for almost every provider.',
      selected: current === 'tls',
    },
    {
      label: 'SSL/TLS',
      desc: 'Port 465. TLS from the first byte (implicit). Use it when your provider only offers 465.',
      selected: current === 'ssl',
    },
    {
      label: 'None',
      desc: 'Port 25, plaintext. No encryption — only for a trusted relay on a private network.',
      selected: current === 'none',
    },
  ];
}

/** Guided Gmail App-Password walkthrough, rendered inside a FieldHelp popover. */
const GMAIL_HELP_BODY: ReactNode = (
  <div className="space-y-2">
    <p>
      Gmail no longer accepts your normal account password over SMTP — &ldquo;less secure app
      access&rdquo; was retired. An App Password is the only way in.
    </p>
    <ol className="list-decimal space-y-1 pl-4">
      <li>Turn on 2-Step Verification for the Google account.</li>
      <li>
        Create a 16-character App Password at{' '}
        <a
          href="https://myaccount.google.com/apppasswords"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-brand-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Google App passwords
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        .
      </li>
      <li>
        Paste that 16-character password into the App password field — not your account password.
      </li>
      <li>Keep Security on STARTTLS (587).</li>
    </ol>
  </div>
);

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
  const providerSelectId = useId();
  const portId = useId();
  const securityId = useId();
  const securityHintId = useId();
  const advancedPanelId = useId();
  const regionId = useId();

  const [form, setForm] = useState<FormState | null>(null);
  const [initial, setInitial] = useState<FormState | null>(null);
  // `providerId` is derived UI state, NOT a snapshot field — the server has no
  // such column, so adding it to the dirty-tracked form would desync. It is
  // seeded on load and only changes on an explicit dropdown pick or a reset.
  const [providerId, setProviderId] = useState<ProviderId>('cloud');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const snap = snapshotFrom(data);
    setForm(snap);
    setInitial(snap);
    // Derive against the RAW host (before snapshotFrom blanks the SES host).
    const pid = deriveProviderId(data.transport_mode, data.host);
    setProviderId(pid);
    setShowAdvanced(shouldAutoExpandAdvanced(pid, data));
  }, [data]);

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSaveError(null); // editing clears the last transport-validation error
  }, []);

  /**
   * Switch provider: pre-fill the underlying (dirty-tracked) transport fields in
   * one batched merge so it registers as a single dirty transition. Because the
   * provider identity itself isn't persisted, a flip whose field values are
   * identical to the saved ones (e.g. Gmail→Custom on `smtp.gmail.com`) leaves
   * the form clean — correct, there is nothing to save.
   */
  const selectProvider = useCallback((id: ProviderId) => {
    const def = PROVIDER_BY_ID[id];
    setProviderId(id);
    setShowAdvanced(false);
    setSaveError(null);
    setForm((prev) => {
      if (!prev) return prev;
      switch (id) {
        case 'cloud':
          // Leave host/port/security untouched — the backend ignores them in cloud mode.
          return { ...prev, transportMode: 'cloud' };
        case 'gmail':
        case 'm365':
        case 'fastmail':
          return {
            ...prev,
            transportMode: 'smtp',
            host: def.defaultHost,
            port: def.defaultPort,
            security: def.defaultSecurity,
          };
        case 'sendgrid':
          return {
            ...prev,
            transportMode: 'sendgrid',
            host: 'smtp.sendgrid.net',
            port: 587,
            security: 'tls',
          };
        case 'ses':
          return { ...prev, transportMode: 'ses', sesRegion: prev.sesRegion || SES_REGIONS[0] };
        case 'custom':
          // Keep whatever host is there so refining an unknown host doesn't lose it.
          return { ...prev, transportMode: 'smtp' };
        default:
          return prev;
      }
    });
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
    if (initial) {
      // Re-derive the provider lens against the reverted values, else it would
      // show the last-picked provider against restored fields (initial keeps the
      // real host for smtp; ses/cloud/sendgrid derive by mode).
      const pid = deriveProviderId(initial.transportMode, initial.host);
      setProviderId(pid);
      setShowAdvanced(shouldAutoExpandAdvanced(pid, initial));
    }
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
  const provider = PROVIDER_BY_ID[providerId];
  const isCloud = providerId === 'cloud';
  const isSes = providerId === 'ses';
  const isSendgrid = providerId === 'sendgrid';
  const isCustom = providerId === 'custom';
  const isPreset = provider.showAdvanced; // gmail / m365 / fastmail
  const credentialLabel = provider.credentialLabel;

  let credentialHint: string | undefined;
  if (data.password_is_set) {
    credentialHint = 'Leave blank to keep the current secret.';
  } else if (providerId === 'gmail' || providerId === 'fastmail') {
    credentialHint = 'Use an App Password, not your account password.';
  }

  const credentialPlaceholder = data.password_is_set
    ? '•••• (set — leave blank to keep)'
    : providerId === 'gmail'
      ? 'Paste the 16-character App Password'
      : isSendgrid || isSes
        ? 'Paste API key'
        : providerId === 'fastmail'
          ? 'Paste your app password'
          : 'Enter password';

  // Host / Port / Security block, shared by the Custom path (shown flat) and the
  // preset path (wrapped in the Advanced reveal). Username renders separately so
  // presets keep it visible while collapsing only the server plumbing.
  const transportFields = (
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
      {/* Security row is hand-rolled (not FieldRow) so the FieldHelp ⓘ sits next
          to the label, per web-rule 263. */}
      <div className="grid grid-cols-1 gap-2 md:gap-6 md:grid-cols-[240px_1fr] py-3.5 border-b border-neutral-border/55 items-start">
        <div>
          <div className="flex items-center gap-1">
            <label
              htmlFor={securityId}
              className="text-[13px] font-medium text-neutral-text-primary"
            >
              Security
            </label>
            <FieldHelp
              label="Connection security"
              intro="How TruePPM secures the SMTP connection."
              options={securityHelpOptions(form.security)}
              docHref="administration/email/#smtp-security"
              docLabel="SMTP security guide"
            />
          </div>
        </div>
        <div className="min-w-0">
          <select
            id={securityId}
            value={form.security}
            disabled={disabled}
            aria-describedby={securityHintId}
            onChange={(e) => set('security', e.target.value as EmailSecurity)}
            className={`${SELECT_CLASS} w-[180px]`}
            style={SELECT_STYLE}
          >
            <option value="tls">STARTTLS</option>
            <option value="ssl">SSL/TLS</option>
            <option value="none">None</option>
          </select>
          <p id={securityHintId} className="mt-1 text-[12px] text-neutral-text-secondary">
            {SECURITY_INLINE_HINT[form.security]}
          </p>
          {form.security === 'none' && (
            <div
              role="alert"
              className="mt-2 max-w-[420px] rounded-card border border-semantic-warning/40 bg-semantic-warning-bg px-3 py-2.5"
            >
              <p className="text-[13px] font-medium text-semantic-warning">
                Unencrypted connection
              </p>
              <p className="mt-0.5 text-[13px] text-neutral-text-primary">
                None sends your credentials and every message in plaintext on port 25. Only use this
                for a trusted internal relay on a private network — never over the public internet.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );

  const usernameField = (
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
  );

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
              deploy time (Helm <span className="tppm-mono">config.TRUEPPM_FRONTEND_BASE_URL</span>
              ).
            </p>
          </div>
        )}

        {!canEdit && (
          <SettingsCard className="mb-5 bg-neutral-surface-sunken">
            <div className="px-4 py-3" role="note">
              <p className="text-[13px] text-neutral-text-secondary">
                Only a workspace operator can change the mail transport. You can view the current
                configuration below.
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

        {/* Provider picker (#2115) — a native <select> over the client-side
            registry; the form below renders conditionally on the choice. */}
        <FieldRow label="Provider" hint="The service that delivers this workspace's mail.">
          <label htmlFor={providerSelectId} className="sr-only">
            Provider
          </label>
          <select
            id={providerSelectId}
            value={providerId}
            disabled={disabled}
            onChange={(e) => selectProvider(e.target.value as ProviderId)}
            className={`${SELECT_CLASS} w-full max-w-[420px]`}
            style={SELECT_STYLE}
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </FieldRow>

        {/* Conditional transport fields */}
        {isCloud && (
          <SettingsCard className="my-3 bg-neutral-surface-sunken">
            <div className="px-4 py-3">
              <p className="text-[13px] text-neutral-text-secondary">
                Mail sends through TruePPM&apos;s built-in relay (the server{' '}
                <span className="tppm-mono">EMAIL_*</span> settings). No credentials needed. Choose
                another provider above to use your own.
              </p>
            </div>
          </SettingsCard>
        )}

        {/* Known preset (Gmail / M365 / Fastmail): host/port/security are pre-filled
            and collapsed behind an Advanced reveal; Username stays visible. */}
        {isPreset && (
          <>
            <div className="my-3">
              <button
                type="button"
                aria-expanded={showAdvanced}
                aria-controls={advancedPanelId}
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex min-h-11 items-center gap-1 rounded-control px-1 -ml-1 text-[13px] font-medium text-neutral-text-primary hover:text-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 md:min-h-0"
              >
                {showAdvanced ? (
                  <ChevronDownIcon className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <ChevronRightIcon className="h-4 w-4" aria-hidden="true" />
                )}
                Advanced — server settings
              </button>
              <p className="mt-0.5 ml-5 text-[12px] text-neutral-text-secondary tppm-mono">
                {form.host} · {form.port} · {SECURITY_LABEL[form.security]}
              </p>
              <div id={advancedPanelId} hidden={!showAdvanced} className="mt-1">
                {transportFields}
              </div>
            </div>
            {usernameField}
          </>
        )}

        {/* Custom generic SMTP: all fields flat. */}
        {isCustom && (
          <>
            {transportFields}
            {usernameField}
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

        {/* Credential (write-only) — shown for every non-cloud provider. Hand-
            rolled (not FieldRow) so the Gmail App-Password FieldHelp ⓘ can sit
            next to the label, per web-rule 263. */}
        {!isCloud && (
          <div className="grid grid-cols-1 gap-2 md:gap-6 md:grid-cols-[240px_1fr] py-3.5 border-b border-neutral-border/55 items-start">
            <div>
              <div className="flex items-center gap-1">
                <span className="text-[13px] font-medium text-neutral-text-primary">
                  {credentialLabel}
                </span>
                {provider.gmailHelp && (
                  <FieldHelp
                    label="Gmail App password"
                    body={GMAIL_HELP_BODY}
                    docHref="administration/email/#gmail-app-password"
                    docLabel="Gmail setup guide"
                  />
                )}
              </div>
              {credentialHint && (
                <div className="text-[12px] text-neutral-text-secondary mt-0.5 leading-snug">
                  {credentialHint}
                </div>
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 max-w-[420px]">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  disabled={disabled}
                  onChange={(e) => set('password', e.target.value)}
                  placeholder={credentialPlaceholder}
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
            </div>
          </div>
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
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${CHIP_STYLES[s]}`}
      >
        <span aria-hidden="true">{CHIP_GLYPH[s]}</span>
        {CHIP_WORD[s]}
      </span>
    </span>
  );
}
