/**
 * Add / edit one SSO provider (#2108, ADR-0517).
 *
 * An accented inline card used for both Add (pick a type, fill credentials) and
 * Edit (pre-filled from the stored `SocialApp` + policy). The middle "issuer"
 * section is driven by the registry `kind`:
 *   - `free`   → a single editable Issuer URL input;
 *   - `fixed`  → a read-only auto-configured issuer line;
 *   - `derived`→ one/two composition inputs + a live "Resolved issuer" strip;
 *   - `oauth`  → a GitHub info callout + optional Organization restriction.
 * The client secret is write-only (blank keeps/rotates nothing); the redirect URI
 * is server-derived and copy-only; scopes are fixed in the OSS core.
 */

import { useCallback, useId, useMemo, useState } from 'react';
import {
  useCreateSsoProvider,
  useUpdateSsoProvider,
  useTestSsoConnection,
  type SsoProvider,
  type SsoProviderWrite,
} from '@/hooks/useSso';
import { ROLE_ADMIN, ROLE_MEMBER } from '@/lib/roles';
import { FieldRow } from '../SettingsShell';
import { Toggle } from '../components/Toggle';
import { EnterpriseBadge } from '../components/EnterpriseBadge';
import { FieldHelp } from '@/components/FieldHelp';
import {
  PICKER_PROVIDERS,
  providerDef,
  resolvedIssuer,
  seedFields,
  type ProviderDef,
} from './ssoProviders';
import { extractFieldErrors, extractFormLevelMessage } from '@/lib/apiError';

const INPUT_CLASS =
  'w-full max-w-[420px] h-8 px-2.5 rounded-control border border-input-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary aria-invalid:border-semantic-critical disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed';
const SELECT_CLASS =
  'h-8 pl-2.5 pr-7 rounded-control border border-input-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none bg-no-repeat bg-[right_0.45rem_center] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary aria-invalid:border-semantic-critical disabled:cursor-not-allowed';
const SELECT_STYLE = {
  backgroundImage:
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 16 16'><path d='M4 6l4 4 4-4' stroke='%23667085' stroke-width='2' stroke-linecap='round' fill='none' /></svg>\")",
};

/** Split the domains free-text into a clean list (lowercased, `@`-stripped). */
function parseDomains(text: string): string[] {
  const seen: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const d = raw.trim().toLowerCase().replace(/^@/, '');
    if (d && !seen.includes(d)) seen.push(d);
  }
  return seen;
}

/**
 * `aria-invalid` + `aria-describedby` for an input whose DRF field error should
 * highlight it and point at the inline message, or nothing when there's no error.
 * Spread onto the input so each field is one line instead of a pair of ternaries.
 */
function fieldErrorAria(message: string | undefined, errorId: string) {
  return message ? { 'aria-invalid': true as const, 'aria-describedby': errorId } : {};
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
      {copied ? (
        <>
          Copied <span aria-hidden="true">✓</span>
        </>
      ) : (
        'Copy'
      )}
    </button>
  );
}

/**
 * Client-secret field — write-only (blank keeps/rotates nothing) with a show/hide
 * toggle. The reveal state is local to the field; the secret value stays in the
 * parent so `onSave` can read it. Extracted from SsoProviderPanel to keep the
 * component body under the cognitive-complexity budget.
 */
function ClientSecretField({
  secretSet,
  value,
  error,
  onChange,
}: {
  secretSet: boolean;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const inputId = useId();
  const errorId = useId();
  const [showSecret, setShowSecret] = useState(false);
  return (
    <FieldRow
      label="Client secret"
      hint={
        secretSet
          ? 'Encrypted at rest. Leave blank to keep the current secret.'
          : 'Encrypted at rest.'
      }
      help={
        <FieldHelp
          label="Client secret"
          body="The confidential key paired with the Client ID, issued by your identity provider when you register the TruePPM application. It is stored encrypted; when editing, leave the field blank to keep the current secret."
          docHref="administration/single-sign-on"
        />
      }
      error={error}
      errorId={errorId}
    >
      <div className="flex items-center gap-2 max-w-[520px]">
        <label htmlFor={inputId} className="sr-only">
          Client secret
        </label>
        <input
          id={inputId}
          type={showSecret ? 'text' : 'password'}
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...fieldErrorAria(error, errorId)}
          placeholder={secretSet ? '•••• (set — leave blank to keep)' : 'Paste client secret'}
          className={INPUT_CLASS}
        />
        <button
          type="button"
          onClick={() => setShowSecret((s) => !s)}
          aria-label={showSecret ? 'Hide client secret' : 'Show client secret'}
          aria-pressed={showSecret}
          className="h-8 px-2.5 text-[12px] font-medium border border-neutral-border rounded-control text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 shrink-0"
        >
          {showSecret ? 'Hide' : 'Show'}
        </button>
      </div>
    </FieldRow>
  );
}

interface SsoProviderPanelProps {
  mode: 'add' | 'edit';
  existing?: SsoProvider;
  /** redirect_uri shared by every provider (from any configured one), for Add preview. */
  sharedRedirectUri: string;
  onClose: () => void;
}

/**
 * Seed the type-specific field values (and raw-issuer fallback) for the Add/Edit
 * form. On Add, or for OAuth providers, the seed is trivial; on Edit of an OIDC
 * provider it decomposes the stored issuer back into its structured fields,
 * falling back to a raw editable issuer when the stored URL doesn't match the
 * expected shape. Extracted from SsoProviderPanel (#2245) to keep the component
 * body under the cognitive-complexity budget; logic verbatim.
 */
function computeSeed(
  mode: 'add' | 'edit',
  existing: SsoProvider | undefined,
  def: ProviderDef,
): { values: Record<string, string>; raw: boolean } {
  if (mode !== 'edit' || !existing) return { values: {} as Record<string, string>, raw: false };
  if (def.kind === 'oauth') return { values: { org: existing.github_org }, raw: false };
  const decomposed = seedFields(def, existing.server_url);
  // decompose() returns null when the stored issuer doesn't match the expected
  // shape (e.g. edited via the API) — fall back to a raw, editable issuer.
  if (decomposed === null) return { values: { issuer: existing.server_url }, raw: true };
  return { values: decomposed, raw: false };
}

/**
 * The issuer/endpoint section of the provider form, whose fields are driven
 * entirely by the provider `kind`: an auto-issuer note (fixed), the OAuth
 * "no issuer URL" note plus its org field (oauth), the structured fields with a
 * live resolved-issuer strip (free/derived), or a raw editable issuer fallback.
 * Extracted from SsoProviderPanel (#2245) to keep the component body under the
 * cognitive-complexity budget; markup verbatim.
 */
function IssuerFields({
  def,
  rawIssuerMode,
  fieldValues,
  setField,
  composedIssuer,
  serverUrlError,
  githubOrgError,
}: {
  def: ProviderDef;
  rawIssuerMode: boolean;
  fieldValues: Record<string, string>;
  setField: (id: string, value: string) => void;
  composedIssuer: string;
  /** DRF `server_url` message — the composition inputs all feed this one key. */
  serverUrlError?: string;
  /** DRF `github_org` message for the OAuth org-restriction input. */
  githubOrgError?: string;
}) {
  const serverUrlErrId = useId();
  const githubOrgErrId = useId();
  // One shared FieldHelp for the issuer (web-rule 263): "issuer URL" is OIDC
  // jargon, so explain it once and attach it to whichever issuer row this
  // provider kind renders — the single free/raw field, or the derived
  // resolved-issuer strip (#2266). `fixed` (auto) and `oauth` (no issuer) rows
  // are self-evident and get none.
  const issuerHelp = (
    <FieldHelp
      label="Issuer URL"
      body="The base URL of your identity provider's OpenID Connect configuration. TruePPM appends /.well-known/openid-configuration to it to discover the sign-in, token, and signing-key endpoints. Copy it from your provider's admin console — for realm-based products like Keycloak it includes the realm path."
      docHref="administration/single-sign-on"
    />
  );
  // Composition inputs all contribute to `server_url`; when it is rejected,
  // mark each aria-invalid and point them at the one inline message (rendered
  // on the resolved-issuer strip for derived, or the single field otherwise).
  const issuerAria = serverUrlError
    ? { 'aria-invalid': true as const, 'aria-describedby': serverUrlErrId }
    : {};
  return (
    <>
      {/* Issuer section — driven by kind */}
      {def.kind === 'fixed' && (
        <FieldRow label="Issuer" hint="Auto-configured for this provider.">
          <span className="tppm-mono text-[13px] text-neutral-text-primary inline-flex items-center gap-2">
            {def.fixedIssuer}
            <span className="text-[10px] font-semibold uppercase tracking-wide text-brand-primary bg-brand-primary/10 rounded px-1.5 py-0.5">
              auto
            </span>
          </span>
        </FieldRow>
      )}

      {def.kind === 'oauth' && (
        <div className="my-3 rounded-card border border-neutral-border bg-neutral-surface-sunken px-3.5 py-2.5">
          <p className="text-[12px] text-neutral-text-secondary leading-relaxed">
            GitHub uses OAuth&nbsp;2.0 — endpoints are configured automatically, so there is no
            issuer URL. Email and profile come from the GitHub user API, and only verified primary
            emails are accepted.
          </p>
        </div>
      )}

      {(def.kind === 'free' || def.kind === 'derived') &&
        !rawIssuerMode &&
        def.fields?.map((f, i) => (
          <FieldRow
            key={f.id}
            label={f.label}
            hint={f.hint}
            // Help rides the single `free` issuer field; `derived` composition
            // fields defer to the resolved-issuer strip below to avoid repeating
            // the same ⓘ on every part.
            help={def.kind === 'free' && i === 0 ? issuerHelp : undefined}
            // `free` has a single field and no resolved-issuer strip, so the
            // `server_url` message lands on that row; `derived` shows it on the
            // strip below instead (avoid duplicating it on every field).
            error={def.kind === 'free' && i === 0 ? serverUrlError : undefined}
            errorId={serverUrlErrId}
          >
            <input
              type="text"
              aria-label={f.label}
              value={fieldValues[f.id] ?? ''}
              onChange={(e) => setField(f.id, e.target.value)}
              placeholder={f.placeholder}
              className={`${INPUT_CLASS} ${f.mono ? 'tppm-mono' : ''}`}
              {...issuerAria}
            />
          </FieldRow>
        ))}

      {/* Raw-issuer fallback when a stored issuer could not be decomposed. */}
      {rawIssuerMode && (
        <FieldRow
          label="Issuer URL"
          hint="Stored issuer (could not be split into fields) — edit directly."
          help={issuerHelp}
          error={serverUrlError}
          errorId={serverUrlErrId}
        >
          <input
            type="text"
            aria-label="Issuer URL"
            value={fieldValues.issuer ?? ''}
            onChange={(e) => setField('issuer', e.target.value)}
            placeholder="https://id.example.com"
            className={`${INPUT_CLASS} tppm-mono`}
            {...issuerAria}
          />
        </FieldRow>
      )}

      {/* Live resolved-issuer strip for derived providers. */}
      {def.kind === 'derived' && !rawIssuerMode && (
        <FieldRow
          label="Resolved issuer"
          hint="Composed from the fields above."
          help={issuerHelp}
          error={serverUrlError}
          errorId={serverUrlErrId}
        >
          <span
            className="tppm-mono text-[12px] text-neutral-text-secondary"
            aria-live="polite"
            data-testid="resolved-issuer"
          >
            {composedIssuer || 'Fill the fields above to compose the issuer…'}
          </span>
        </FieldRow>
      )}

      {/* GitHub org restriction */}
      {def.kind === 'oauth' &&
        def.fields?.map((f) => (
          <FieldRow
            key={f.id}
            label={f.label}
            hint={f.hint}
            error={f.id === 'org' ? githubOrgError : undefined}
            errorId={githubOrgErrId}
          >
            <input
              type="text"
              aria-label={f.label}
              value={fieldValues[f.id] ?? ''}
              onChange={(e) => setField(f.id, e.target.value)}
              placeholder={f.placeholder}
              className={INPUT_CLASS}
              aria-invalid={f.id === 'org' && githubOrgError ? true : undefined}
              aria-describedby={f.id === 'org' && githubOrgError ? githubOrgErrId : undefined}
            />
          </FieldRow>
        ))}
    </>
  );
}

/**
 * "Test connection" card — only meaningful for a saved provider (probes by
 * slug), so it self-guards to null on Add. Extracted from SsoProviderPanel
 * (#2245) to keep the component body under the cognitive-complexity budget;
 * markup verbatim.
 */
function TestConnectionSection({
  mode,
  def,
  test,
  slug,
}: {
  mode: 'add' | 'edit';
  def: ProviderDef;
  test: ReturnType<typeof useTestSsoConnection>;
  slug: string;
}) {
  if (mode !== 'edit') return null;
  const testResult = test.data;
  return (
    <div className="mt-5 rounded-card border border-neutral-border px-3.5 py-3">
      <h4 className="text-[13px] font-semibold text-neutral-text-primary">Test connection</h4>
      <p className="mt-0.5 text-[12px] text-neutral-text-secondary">
        {def.type === 'OAuth'
          ? "Checks that GitHub's API is reachable."
          : "Checks that the issuer's discovery document and signing keys are reachable."}
      </p>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          disabled={test.isPending}
          onClick={() => test.mutate(slug)}
          className="h-8 px-3 text-[13px] font-medium border border-neutral-border rounded-control text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed"
        >
          {test.isPending ? 'Testing…' : 'Test connection'}
        </button>
        <p className="text-[12px]" aria-live="polite">
          {testResult?.ok === true && (
            <span className="text-semantic-on-track">
              <span aria-hidden="true">✓</span> Reachable.
            </span>
          )}
          {testResult?.ok === false && (
            <span className="text-semantic-critical">
              <span aria-hidden="true">✗</span>{' '}
              {testResult.detail || testResult.error || 'Not reachable.'}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

export function SsoProviderPanel({
  mode,
  existing,
  sharedRedirectUri,
  onClose,
}: SsoProviderPanelProps) {
  const create = useCreateSsoProvider();
  const update = useUpdateSsoProvider();
  const test = useTestSsoConnection();

  const displayNameId = useId();
  const clientIdId = useId();
  const domainsId = useId();
  const roleId = useId();
  const typeId = useId();

  // On Add default to Keycloak (the richest derived, two-field case); on Edit
  // the type is fixed to the stored slug (immutable server-side).
  const [slug, setSlug] = useState(() => existing?.slug ?? 'keycloak');
  const def = providerDef(slug) as ProviderDef;

  const seed = useMemo(() => computeSeed(mode, existing, def), [mode, existing, def]);

  const [displayName, setDisplayName] = useState(existing?.display_name ?? '');
  const [clientId, setClientId] = useState(existing?.client_id ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(seed.values);
  const [rawIssuerMode, setRawIssuerMode] = useState(seed.raw);
  const [allowedDomains, setAllowedDomains] = useState(
    (existing?.allowed_email_domains ?? []).join(', '),
  );
  const [autoCreate, setAutoCreate] = useState(existing?.auto_create_members ?? false);
  const [defaultRole, setDefaultRole] = useState(existing?.default_role ?? ROLE_MEMBER);
  const [enabled, setEnabled] = useState(existing?.enabled ?? false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Per-field DRF 400 messages, keyed by serializer field name. Drives the
  // `aria-invalid` + inline `role="alert"` highlighting the banner promises.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /** Clear the banner and, if given, one field's inline error as the user edits it. */
  const clearError = useCallback((key?: string) => {
    setSaveError(null);
    if (!key) return;
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const setField = useCallback(
    (id: string, value: string) => {
      setFieldValues((prev) => ({ ...prev, [id]: value }));
      // The oauth `org` input feeds `github_org`; every other composition input
      // feeds the single `server_url` payload key.
      clearError(id === 'org' ? 'github_org' : 'server_url');
    },
    [clearError],
  );

  // Changing the provider type (Add only) resets the type-specific inputs.
  const onSelectType = useCallback((next: string) => {
    setSlug(next);
    setFieldValues({});
    setRawIssuerMode(false);
    setSaveError(null);
    setFieldErrors({});
  }, []);

  const composedIssuer = rawIssuerMode
    ? (fieldValues.issuer ?? '').trim().replace(/\/+$/, '')
    : resolvedIssuer(def, fieldValues);

  const scopes =
    existing?.scopes ??
    (def.type === 'OAuth' ? ['read:user', 'user:email'] : ['openid', 'email', 'profile']);

  const redirectUri = existing?.redirect_uri ?? sharedRedirectUri;
  const pending = create.isPending || update.isPending;

  const onSave = useCallback(async () => {
    const body: SsoProviderWrite = {
      display_name: displayName,
      client_id: clientId,
      enabled,
      allowed_email_domains: parseDomains(allowedDomains),
      auto_create_members: autoCreate,
      default_role: defaultRole,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    };
    if (def.kind === 'oauth') {
      body.github_org = (fieldValues.org ?? '').trim();
    } else {
      body.server_url = composedIssuer;
    }
    try {
      if (mode === 'add') {
        await create.mutateAsync({ ...body, slug });
      } else {
        await update.mutateAsync({ slug, body });
      }
      onClose();
    } catch (err) {
      // Highlight every offending input (aria-invalid + inline message) and
      // summarize in the banner — the form-level message when the server sent
      // one, else a lead-in pointing at the highlighted fields, else generic.
      const fieldErrs = extractFieldErrors(err);
      setFieldErrors(fieldErrs);
      const formLevel = extractFormLevelMessage(err);
      setSaveError(
        formLevel ??
          (Object.keys(fieldErrs).length > 0
            ? 'Please correct the highlighted fields below.'
            : 'Could not save the provider. Please try again.'),
      );
    }
  }, [
    displayName,
    clientId,
    enabled,
    allowedDomains,
    autoCreate,
    defaultRole,
    clientSecret,
    def,
    fieldValues,
    composedIssuer,
    mode,
    create,
    update,
    slug,
    onClose,
  ]);

  return (
    <div className="rounded-card border-2 border-brand-primary/45 bg-neutral-surface-raised">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-border">
        <h3 className="text-[14px] font-semibold text-neutral-text-primary">
          {mode === 'add' ? 'Add provider' : `Edit ${existing?.display_name || def.name}`}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close provider panel"
          className="h-7 w-7 inline-flex items-center justify-center rounded-control text-neutral-text-secondary hover:bg-neutral-surface-sunken hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
        >
          ✕
        </button>
      </div>

      <div className="px-5 py-4">
        {saveError && (
          <div
            role="alert"
            className="mb-4 rounded-card border border-semantic-critical/40 bg-semantic-critical-bg px-3.5 py-2.5"
          >
            <p className="text-[13px] text-semantic-critical">{saveError}</p>
            <p className="mt-0.5 text-[12px] text-neutral-text-secondary">
              Your entries are kept — fix the values and try again.
            </p>
          </div>
        )}

        {/* Provider type */}
        <FieldRow
          label="Provider type"
          hint="Sets the endpoints and issuer format."
          help={
            <FieldHelp
              label="Provider type"
              intro="The protocol TruePPM uses to talk to your identity provider. It's set by the product you pick and is fixed once the provider is added."
              options={[
                {
                  label: 'OIDC (Keycloak, Authentik, Authelia, Zitadel, Google, GitLab)',
                  desc: 'OpenID Connect. TruePPM discovers the endpoints from an issuer URL you provide.',
                },
                {
                  label: 'OAuth 2.0 (GitHub)',
                  desc: 'Fixed endpoints, so there is no issuer URL. Identity comes from the GitHub user API.',
                },
              ]}
              docHref="administration/single-sign-on"
            />
          }
          error={fieldErrors.slug}
          errorId={`${typeId}-err`}
        >
          <label htmlFor={typeId} className="sr-only">
            Provider type
          </label>
          {mode === 'add' ? (
            <select
              id={typeId}
              value={slug}
              onChange={(e) => onSelectType(e.target.value)}
              {...fieldErrorAria(fieldErrors.slug, `${typeId}-err`)}
              className={`${SELECT_CLASS} w-full max-w-[260px]`}
              style={SELECT_STYLE}
            >
              {PICKER_PROVIDERS.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name} ({p.type})
                </option>
              ))}
            </select>
          ) : (
            <span className="text-[13px] text-neutral-text-primary">
              {def.name} <span className="text-neutral-text-secondary">· {def.type}</span>
            </span>
          )}
        </FieldRow>

        <IssuerFields
          def={def}
          rawIssuerMode={rawIssuerMode}
          fieldValues={fieldValues}
          setField={setField}
          composedIssuer={composedIssuer}
          serverUrlError={fieldErrors.server_url}
          githubOrgError={fieldErrors.github_org}
        />

        {/* Common credential fields */}
        <h4 className="mt-6 mb-1 text-[12px] font-semibold uppercase tracking-wide text-neutral-text-secondary">
          Credentials
        </h4>
        <FieldRow
          label="Display name"
          hint="Shown on the sign-in button."
          error={fieldErrors.display_name}
          errorId={`${displayNameId}-err`}
        >
          <label htmlFor={displayNameId} className="sr-only">
            Display name
          </label>
          <input
            id={displayNameId}
            type="text"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              clearError('display_name');
            }}
            {...fieldErrorAria(fieldErrors.display_name, `${displayNameId}-err`)}
            className={INPUT_CLASS}
            placeholder={`${def.name} sign-in`}
          />
        </FieldRow>
        <FieldRow
          label="Client ID"
          help={
            <FieldHelp
              label="Client ID"
              body="The public identifier your identity provider assigns to the TruePPM application when you register it there. Paste the value from your provider's app or client registration."
              docHref="administration/single-sign-on"
            />
          }
          error={fieldErrors.client_id}
          errorId={`${clientIdId}-err`}
        >
          <label htmlFor={clientIdId} className="sr-only">
            Client ID
          </label>
          <input
            id={clientIdId}
            type="text"
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
              clearError('client_id');
            }}
            {...fieldErrorAria(fieldErrors.client_id, `${clientIdId}-err`)}
            className={`${INPUT_CLASS} tppm-mono`}
          />
        </FieldRow>
        <ClientSecretField
          secretSet={Boolean(existing?.secret_set)}
          value={clientSecret}
          error={fieldErrors.client_secret}
          onChange={(v) => {
            setClientSecret(v);
            clearError('client_secret');
          }}
        />
        <FieldRow
          label="Redirect URI"
          hint="Add this to your IdP's allowed redirect list."
          help={
            <FieldHelp
              label="Redirect URI"
              body="The callback address your identity provider must send users back to after they sign in. TruePPM fixes this value — copy it into your provider's list of allowed redirect (callback) URLs, or sign-in will be rejected."
              docHref="administration/single-sign-on"
            />
          }
        >
          {redirectUri ? (
            <div className="flex items-center gap-2 max-w-[520px]">
              <input
                type="text"
                readOnly
                value={redirectUri}
                aria-label="Redirect URI (read-only)"
                className={`${INPUT_CLASS} tppm-mono bg-neutral-surface-sunken`}
              />
              <CopyButton value={redirectUri} />
            </div>
          ) : (
            <span className="text-[12px] text-neutral-text-secondary">
              Shown here after you add the first provider.
            </span>
          )}
        </FieldRow>
        <FieldRow label="Scopes" hint="Fixed in the open-source core.">
          <span className="inline-flex items-center gap-1.5">
            {scopes.map((s) => (
              <span
                key={s}
                className="tppm-mono text-[11px] text-neutral-text-secondary bg-neutral-surface-sunken border border-neutral-border rounded px-1.5 py-0.5"
              >
                {s}
              </span>
            ))}
            <span className="text-[11px] text-neutral-text-secondary">
              <span aria-hidden="true">🔒</span> read-only
            </span>
          </span>
        </FieldRow>

        {/* Sign-in policy */}
        <h4 className="mt-6 mb-1 text-[12px] font-semibold uppercase tracking-wide text-neutral-text-secondary">
          Sign-in policy
        </h4>
        <FieldRow
          label="Allowed email domains"
          hint="Only these domains may sign in via this provider. Comma- or space-separated."
          error={fieldErrors.allowed_email_domains}
          errorId={`${domainsId}-err`}
        >
          <label htmlFor={domainsId} className="sr-only">
            Allowed email domains
          </label>
          <input
            id={domainsId}
            type="text"
            value={allowedDomains}
            onChange={(e) => {
              setAllowedDomains(e.target.value);
              clearError('allowed_email_domains');
            }}
            {...fieldErrorAria(fieldErrors.allowed_email_domains, `${domainsId}-err`)}
            className={INPUT_CLASS}
            placeholder="example.com, example.io"
          />
        </FieldRow>
        <FieldRow
          label="Auto-create members"
          hint="Create a member on first sign-in for an allowed domain."
        >
          <Toggle
            on={autoCreate}
            onChange={setAutoCreate}
            onLabel="On"
            offLabel="Off"
            ariaLabel="Auto-create members on first SSO sign-in"
          />
        </FieldRow>
        {autoCreate && (
          <FieldRow
            label="Default role"
            hint="Role granted to auto-created members."
            error={fieldErrors.default_role}
            errorId={`${roleId}-err`}
          >
            <label htmlFor={roleId} className="sr-only">
              Default role for auto-created members
            </label>
            <select
              id={roleId}
              value={defaultRole}
              onChange={(e) => {
                setDefaultRole(Number(e.target.value));
                clearError('default_role');
              }}
              {...fieldErrorAria(fieldErrors.default_role, `${roleId}-err`)}
              className={`${SELECT_CLASS} w-full max-w-[180px]`}
              style={SELECT_STYLE}
            >
              <option value={ROLE_MEMBER}>Member</option>
              <option value={ROLE_ADMIN}>Admin</option>
            </select>
          </FieldRow>
        )}
        <FieldRow
          label="Enable this provider"
          hint="Requires a complete configuration above."
          help={
            <FieldHelp
              label="Enable this provider"
              body="When on, this provider's button appears on the sign-in screen and allowed users can log in with it. When off, the configuration is kept but hidden from sign-in. A provider must be fully configured before it can be enabled."
              docHref="administration/single-sign-on"
            />
          }
          error={fieldErrors.enabled}
          errorId={`${typeId}-enabled-err`}
        >
          <Toggle
            on={enabled}
            onChange={(next) => {
              setEnabled(next);
              // The server rejects enabling a half-configured provider; clear that
              // message once the admin toggles it off again.
              clearError('enabled');
            }}
            onLabel="Enabled"
            offLabel="Disabled"
            ariaLabel="Enable this SSO provider"
          />
        </FieldRow>
        {/* Enforced-SSO (disable local accounts) is Enterprise — informational, never
            a functional switch (ADR-0187 §4 preserved). */}
        <FieldRow label="Password sign-in">
          <div className="flex items-center text-[13px] text-neutral-text-secondary">
            <span>Password and SSO sign-in are both allowed.</span>
            <EnterpriseBadge />
          </div>
        </FieldRow>

        <TestConnectionSection mode={mode} def={def} test={test} slug={slug} />
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-neutral-border">
        <button
          type="button"
          onClick={onClose}
          className="h-8 px-3 text-[13px] font-medium border border-neutral-border rounded-control text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => void onSave()}
          className="h-8 px-4 text-[13px] font-semibold rounded-control bg-brand-primary text-neutral-text-inverse hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {pending ? 'Saving…' : mode === 'add' ? 'Add provider' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
