/**
 * Workspace → Settings → Single sign-on — admin OIDC provider config (#1392, ADR-0187).
 *
 * The admin surface for basic OIDC/OAuth login against the operator's own IdP.
 * Two states: an **empty** state (no provider connected) with a connect CTA, and
 * the **configured** form. The client secret is write-only (the read shape
 * reports only `secret_set`; entering a value rotates it), the redirect URI is
 * derived and copy-only, and `scopes` is fixed to `openid email profile` in OSS.
 *
 * Form fields save through the shell save-bar (validate-before-persist — enabling
 * a half-configured provider is refused server-side and surfaced inline). "Test
 * connection" probes discovery + JWKS on the entered issuer and "Disable SSO"
 * deletes the config; both act out-of-band from the form save.
 *
 * Boundary (ADR-0187 §4): the "Allow password sign-in: OFF" (enforced-SSO)
 * capability is Enterprise. OSS renders the row informational with an upsell
 * badge — it never ships a functional switch that disables local accounts.
 */

import { useCallback, useEffect, useId, useState } from 'react';
import {
  useOidcProvider,
  useUpdateOidcProvider,
  useDeleteOidcProvider,
  useTestOidcConnection,
  type OidcProviderConfig,
} from '@/hooks/useSso';
import { ROLE_ADMIN, ROLE_MEMBER } from '@/lib/roles';
import { docsUrl } from '@/lib/docsUrl';
import { SettingsPageTitle, FieldRow, SettingsCard } from '../SettingsShell';
import { Toggle } from '../components/Toggle';
import { EnterpriseBadge } from '../components/EnterpriseBadge';
import { useDirtyForm } from '../hooks/useDirtyForm';

const INPUT_CLASS =
  'w-full max-w-[420px] h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed';
const SELECT_CLASS =
  'h-8 pl-2.5 pr-7 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none bg-no-repeat bg-[right_0.45rem_center] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary disabled:cursor-not-allowed';
const SELECT_STYLE = {
  backgroundImage:
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 16 16'><path d='M4 6l4 4 4-4' stroke='%23667085' stroke-width='2' stroke-linecap='round' fill='none' /></svg>\")",
};

interface FormState {
  enabled: boolean;
  displayName: string;
  issuerUrl: string;
  clientId: string;
  /** Write-only — blank keeps the stored secret, a value rotates it. */
  clientSecret: string;
  /** Free text (comma / space / newline separated); parsed to an array on save. */
  allowedDomains: string;
  autoCreateMembers: boolean;
  defaultRole: number;
}

function snapshotFrom(data: OidcProviderConfig): FormState {
  return {
    enabled: data.enabled,
    displayName: data.display_name,
    issuerUrl: data.issuer_url,
    clientId: data.client_id,
    clientSecret: '',
    allowedDomains: data.allowed_email_domains.join(', '),
    autoCreateMembers: data.auto_create_members,
    defaultRole: data.default_role,
  };
}

/** Split the domains free-text into a clean list (lowercased, `@`-stripped). */
function parseDomains(text: string): string[] {
  const seen: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const d = raw.trim().toLowerCase().replace(/^@/, '');
    if (d && !seen.includes(d)) seen.push(d);
  }
  return seen;
}

/** A config with nothing entered yet — drives the empty state. */
function isBlank(data: OidcProviderConfig): boolean {
  return !data.enabled && !data.issuer_url && !data.client_id && !data.secret_set;
}

/** Best-effort extraction of a DRF 400 error into one human-readable line. */
function parseSaveError(err: unknown): string {
  const generic = 'Could not save the SSO configuration. Check the highlighted fields.';
  if (typeof err !== 'object' || err === null || !('response' in err)) return generic;
  const data = (err as { response?: { data?: unknown } }).response?.data;
  if (typeof data !== 'object' || data === null) return generic;
  const record = data as Record<string, unknown>;
  const order = ['non_field_errors', 'enabled', 'issuer_url', 'client_id', 'client_secret'];
  for (const key of [...order, ...Object.keys(record)]) {
    const val = record[key];
    if (Array.isArray(val) && typeof val[0] === 'string') return val[0];
    if (typeof val === 'string') return val;
  }
  return generic;
}

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

export function WorkspaceSsoPage() {
  const { data, isLoading, isError, refetch } = useOidcProvider();
  const update = useUpdateOidcProvider();
  const del = useDeleteOidcProvider();
  const test = useTestOidcConnection();
  const displayNameId = useId();
  const issuerId = useId();
  const clientIdId = useId();
  const secretId = useId();
  const domainsId = useId();
  const roleId = useId();

  const [form, setForm] = useState<FormState | null>(null);
  const [initial, setInitial] = useState<FormState | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Reveal the form from the empty state without saving anything yet.
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (!data) return;
    const snap = snapshotFrom(data);
    setForm(snap);
    setInitial(snap);
  }, [data]);

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSaveError(null);
  }, []);

  const onSave = useCallback(async () => {
    if (!form) return;
    try {
      await update.mutateAsync({
        enabled: form.enabled,
        display_name: form.displayName,
        issuer_url: form.issuerUrl,
        client_id: form.clientId,
        allowed_email_domains: parseDomains(form.allowedDomains),
        auto_create_members: form.autoCreateMembers,
        default_role: form.defaultRole,
        // Only send the secret when the admin typed one — otherwise keep the stored value.
        ...(form.clientSecret ? { client_secret: form.clientSecret } : {}),
      });
      const cleared = { ...form, clientSecret: '' };
      setInitial(cleared);
      setForm(cleared);
      setSaveError(null);
    } catch (err) {
      setSaveError(parseSaveError(err));
      throw err; // keep the section dirty; don't stamp "Saved"
    }
  }, [form, update]);

  const onReset = useCallback(() => {
    setForm(initial);
    setSaveError(null);
  }, [initial]);

  const dirty = !!form && !!initial && JSON.stringify(form) !== JSON.stringify(initial);

  useDirtyForm({
    values: (form ?? {}) as unknown as Record<string, unknown>,
    initialValues: (initial ?? {}) as unknown as Record<string, unknown>,
    onSave,
    onReset,
    apiReady: true,
  });

  if (isError) {
    return (
      <div>
        <SettingsPageTitle title="Single sign-on" />
        <div className="px-6 pb-8 max-w-[920px]">
          <SettingsCard className="border-semantic-critical/40">
            <div className="px-4 py-4 flex items-center gap-3" role="alert">
              <p className="flex-1 text-[13px] text-neutral-text-secondary">
                Couldn&apos;t load the SSO configuration.
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
      </div>
    );
  }

  if (isLoading || !form || !data) {
    return (
      <div className="px-6 py-8 space-y-3" aria-label="Loading SSO settings" aria-busy="true">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-10 rounded-control bg-neutral-surface-raised motion-safe:animate-pulse"
          />
        ))}
      </div>
    );
  }

  // Empty state — nothing configured and the admin hasn't started connecting.
  if (isBlank(data) && !connecting) {
    return (
      <div>
        <SettingsPageTitle
          title="Single sign-on"
          subtitle="Let your team sign in with your own identity provider."
        />
        <div className="px-6 pb-8 max-w-[920px]">
          <SettingsCard>
            <div className="px-6 py-8 flex flex-col items-center text-center gap-3">
              <h3 className="text-[15px] font-semibold text-neutral-text-primary">
                No identity provider connected
              </h3>
              <p className="max-w-md text-[13px] text-neutral-text-secondary leading-relaxed">
                Connect an OIDC provider (Keycloak, Authentik, Authelia, Zitadel, Google, GitHub,
                GitLab, …) so your team can sign in with the accounts they already have. Basic SSO is
                part of the open-source core — no Enterprise license required.
              </p>
              <div className="mt-1 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setConnecting(true)}
                  className="h-9 px-4 text-[13px] font-semibold rounded-control bg-brand-primary text-white hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                >
                  Connect OIDC provider
                </button>
                <a
                  href={docsUrl('administration/single-sign-on')}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="h-9 inline-flex items-center px-3 text-[13px] font-medium border border-neutral-border rounded-control text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                >
                  Read the docs
                </a>
              </div>
            </div>
          </SettingsCard>
        </div>
      </div>
    );
  }

  const testResult = test.data;

  return (
    <div>
      <SettingsPageTitle
        title="Single sign-on"
        subtitle="Log in with your own OIDC identity provider (part of the open-source core)."
      />

      <div className="px-6 pb-8 max-w-[920px]">
        {/* Status banner */}
        <SettingsCard
          className={`mb-5 ${data.enabled ? 'bg-semantic-on-track-bg' : 'bg-neutral-surface-sunken'}`}
        >
          <div className="px-4 py-3" role="status">
            <p className="text-[13px] font-medium text-neutral-text-primary">
              {data.enabled ? 'OIDC sign-in is live' : 'OIDC sign-in is not enabled yet'}
            </p>
            <p className="mt-0.5 text-[12px] text-neutral-text-secondary">
              {data.enabled
                ? 'Users on an allowed email domain can sign in with your identity provider.'
                : 'Fill in the provider details below and enable SSO to turn it on.'}
            </p>
          </div>
        </SettingsCard>

        {saveError && (
          <div
            role="alert"
            className="mb-5 rounded-card border border-semantic-critical/40 bg-semantic-critical-bg px-4 py-3"
          >
            <p className="text-[13px] font-medium text-semantic-critical-text">
              Couldn&apos;t save SSO configuration
            </p>
            <p className="mt-0.5 text-[13px] text-semantic-critical-text">{saveError}</p>
            <p className="mt-1 text-[12px] text-neutral-text-secondary">
              Your entries are kept — fix the values and save again.
            </p>
          </div>
        )}

        {/* Enable toggle */}
        <FieldRow label="SSO sign-in" hint="Requires a complete configuration below.">
          <Toggle
            on={form.enabled}
            onChange={(on) => set('enabled', on)}
            onLabel="Enabled"
            offLabel="Disabled"
            ariaLabel="Enable SSO sign-in"
          />
        </FieldRow>

        {/* Provider */}
        <h3 className="mt-8 mb-1 text-[13px] font-semibold text-neutral-text-primary">Provider</h3>
        <FieldRow label="Display name" hint="Shown on the sign-in screen.">
          <label htmlFor={displayNameId} className="sr-only">
            Display name
          </label>
          <input
            id={displayNameId}
            type="text"
            value={form.displayName}
            onChange={(e) => set('displayName', e.target.value)}
            className={INPUT_CLASS}
            placeholder="Acme SSO"
          />
        </FieldRow>
        <FieldRow label="Issuer URL" hint="Discovery base — the server appends /.well-known/openid-configuration.">
          <label htmlFor={issuerId} className="sr-only">
            Issuer URL
          </label>
          <input
            id={issuerId}
            type="url"
            value={form.issuerUrl}
            onChange={(e) => set('issuerUrl', e.target.value)}
            className={`${INPUT_CLASS} tppm-mono`}
            placeholder="https://id.example.com"
          />
        </FieldRow>
        <FieldRow label="Client ID">
          <label htmlFor={clientIdId} className="sr-only">
            Client ID
          </label>
          <input
            id={clientIdId}
            type="text"
            value={form.clientId}
            onChange={(e) => set('clientId', e.target.value)}
            className={`${INPUT_CLASS} tppm-mono`}
          />
        </FieldRow>
        <FieldRow
          label="Client secret"
          hint={data.secret_set ? 'Leave blank to keep the current secret.' : undefined}
        >
          <label htmlFor={secretId} className="sr-only">
            Client secret
          </label>
          <input
            id={secretId}
            type="password"
            autoComplete="off"
            value={form.clientSecret}
            onChange={(e) => set('clientSecret', e.target.value)}
            placeholder={data.secret_set ? '•••• (set — leave blank to keep)' : 'Paste client secret'}
            className={INPUT_CLASS}
          />
        </FieldRow>
        <FieldRow label="Redirect URI" hint="Add this to your IdP's allowed redirect list.">
          <div className="flex items-center gap-2 max-w-[520px]">
            <input
              type="text"
              readOnly
              value={data.redirect_uri}
              aria-label="Redirect URI (read-only)"
              className={`${INPUT_CLASS} tppm-mono bg-neutral-surface-sunken`}
            />
            <CopyButton value={data.redirect_uri} />
          </div>
        </FieldRow>
        <FieldRow label="Scopes" hint="Fixed in the open-source core.">
          <span className="tppm-mono text-[13px] text-neutral-text-secondary">
            {data.scopes.join(' ')}
          </span>
        </FieldRow>

        {/* Sign-in policy */}
        <h3 className="mt-8 mb-1 text-[13px] font-semibold text-neutral-text-primary">
          Sign-in policy
        </h3>
        <FieldRow
          label="Allowed email domains"
          hint="Only these domains may sign in via SSO. Comma- or space-separated."
        >
          <label htmlFor={domainsId} className="sr-only">
            Allowed email domains
          </label>
          <input
            id={domainsId}
            type="text"
            value={form.allowedDomains}
            onChange={(e) => set('allowedDomains', e.target.value)}
            className={INPUT_CLASS}
            placeholder="example.com, example.io"
          />
        </FieldRow>
        <FieldRow
          label="Auto-create members"
          hint="Create a member on first SSO sign-in for an allowed domain."
        >
          <Toggle
            on={form.autoCreateMembers}
            onChange={(on) => set('autoCreateMembers', on)}
            onLabel="On"
            offLabel="Off"
            ariaLabel="Auto-create members on first SSO sign-in"
          />
        </FieldRow>
        {form.autoCreateMembers && (
          <FieldRow label="Default role" hint="Role granted to auto-created members.">
            <label htmlFor={roleId} className="sr-only">
              Default role for auto-created members
            </label>
            <select
              id={roleId}
              value={form.defaultRole}
              onChange={(e) => set('defaultRole', Number(e.target.value))}
              className={`${SELECT_CLASS} w-[180px]`}
              style={SELECT_STYLE}
            >
              <option value={ROLE_MEMBER}>Member</option>
              <option value={ROLE_ADMIN}>Admin</option>
            </select>
          </FieldRow>
        )}
        {/* Enforced-SSO (disable local accounts) is Enterprise — render informational
            with an upsell, never a functional switch (ADR-0187 §4). */}
        <FieldRow label="Password sign-in">
          <div className="flex items-center text-[13px] text-neutral-text-secondary">
            <span>Password and SSO sign-in are both allowed.</span>
            <EnterpriseBadge />
          </div>
        </FieldRow>

        {/* Test connection — probes the entered issuer's discovery + JWKS */}
        <SettingsCard className="mt-8">
          <div className="px-4 py-3.5">
            <h3 className="text-[13px] font-semibold text-neutral-text-primary">Test connection</h3>
            <p className="mt-0.5 text-[12px] text-neutral-text-secondary">
              Checks that the issuer&apos;s discovery document and signing keys are reachable.
            </p>
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                disabled={test.isPending || !form.issuerUrl.trim()}
                onClick={() => test.mutate({ issuer_url: form.issuerUrl.trim() })}
                className="h-8 px-3 text-[13px] font-medium border border-neutral-border rounded-control text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed"
              >
                {test.isPending ? 'Testing…' : 'Test connection'}
              </button>
              <p className="text-[12px]" aria-live="polite">
                {testResult?.ok === true && (
                  <span className="text-semantic-on-track-text">✓ Reachable.</span>
                )}
                {testResult?.ok === false && (
                  <span className="text-semantic-critical-text">
                    ✗ {testResult.detail || testResult.error || 'Not reachable.'}
                  </span>
                )}
              </p>
            </div>
          </div>
        </SettingsCard>

        {/* Disable SSO — deletes the config entirely */}
        {!isBlank(data) && (
          <SettingsCard className="mt-3 border-semantic-critical/30">
            <div className="px-4 py-3.5 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-[13px] font-semibold text-neutral-text-primary">Disable SSO</h3>
                <p className="mt-0.5 text-[12px] text-neutral-text-secondary">
                  Removes the provider configuration. Users fall back to password sign-in.
                </p>
              </div>
              <button
                type="button"
                disabled={del.isPending}
                onClick={() => {
                  if (!window.confirm('Disable SSO and delete this provider configuration?')) return;
                  void del.mutateAsync().then(() => {
                    setConnecting(false);
                    setSaveError(null);
                  });
                }}
                className="h-8 px-3 text-[13px] font-medium border border-semantic-critical/50 rounded-control text-semantic-critical-text hover:bg-semantic-critical-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1 disabled:cursor-not-allowed shrink-0"
              >
                {del.isPending ? 'Disabling…' : 'Disable SSO'}
              </button>
            </div>
          </SettingsCard>
        )}
        {dirty && <span className="sr-only">You have unsaved SSO changes.</span>}
      </div>
    </div>
  );
}
