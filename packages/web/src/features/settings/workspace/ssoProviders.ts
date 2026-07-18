/**
 * SSO provider registry (#2108, ADR-0517) — the FE half of the fixed provider
 * table shared with the backend (`apps/sso/services.REGISTRY`) and the design
 * handoff (`docs/design/handoff/2026-07-sso-provider-preset/`).
 *
 * The admin picks a provider **type** by `slug`; each type pre-knows how its
 * issuer is composed, so the admin supplies only credentials (+ a small
 * provider-specific field). `slug` is the value sent to the API (`generic`,
 * `google`, `entra`, …) — NOT allauth's internal provider name; every OIDC IdP
 * maps to allauth's `openid_connect` and GitHub to `github` on the server.
 *
 * `resolve()` composes the `server_url` (issuer) the FE sends; `decompose()` is
 * its best-effort inverse, used to pre-fill the Edit panel from the stored
 * issuer (the server persists only the composed issuer, not its parts). The
 * server re-validates the composed issuer as an absolute https URL, so the FE
 * derives nothing the server could not — this table is a convenience, not a
 * trust boundary.
 */

export type ProviderKind = 'free' | 'fixed' | 'derived' | 'oauth';
export type ProviderType = 'OIDC' | 'OAuth';

/** One labeled composition input for a `free`/`derived`/`oauth` provider. */
export interface ComposeField {
  /** Key into the panel's field-values record. */
  id: string;
  label: string;
  hint: string;
  placeholder: string;
  /** Render monospace (URLs/ids). */
  mono?: boolean;
}

export interface ProviderDef {
  /** API slug + registry key + `SocialAccount.provider`. */
  slug: string;
  name: string;
  type: ProviderType;
  kind: ProviderKind;
  /** Decorative tile: a short glyph + a brand hue (glyph is aria-hidden). */
  tile: { glyph: string; color: string };
  subtitle: string;
  /** `fixed`: the auto-configured issuer (absolute https). */
  fixedIssuer?: string;
  /** `free`/`derived`: the inputs the admin fills. */
  fields?: ComposeField[];
  /** `free`/`derived`: compose the issuer; '' when the inputs are incomplete. */
  resolve?: (v: Record<string, string>) => string;
  /**
   * `free`/`derived`: best-effort inverse of `resolve` for Edit pre-fill.
   * Returns `null` when the stored issuer does not match the expected shape
   * (e.g. hand-edited via the API) — the panel then falls back to a raw issuer
   * field so the value is still editable.
   */
  decompose?: (issuer: string) => Record<string, string> | null;
}

/** Strip a trailing slash (issuer URLs are compared without one). */
function trimSlash(s: string): string {
  return (s || '').trim().replace(/\/+$/, '');
}

/** Strip scheme + trailing slash from a bare host/domain input. */
function bareHost(s: string): string {
  return (s || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

export const PROVIDERS: ProviderDef[] = [
  {
    slug: 'generic',
    name: 'Generic OIDC',
    type: 'OIDC',
    kind: 'free',
    tile: { glyph: '◎', color: 'var(--sso-tile-generic)' },
    subtitle: 'Any standards-compliant OIDC provider',
    fields: [
      {
        id: 'issuer',
        label: 'Issuer URL',
        hint: 'The server appends /.well-known/openid-configuration.',
        placeholder: 'https://id.example.com',
        mono: true,
      },
    ],
    resolve: (v) => trimSlash(v.issuer),
    decompose: (issuer) => ({ issuer: trimSlash(issuer) }),
  },
  {
    slug: 'google',
    name: 'Google',
    type: 'OIDC',
    kind: 'fixed',
    tile: { glyph: 'G', color: 'var(--sso-tile-google)' },
    subtitle: 'Google Workspace / consumer',
    fixedIssuer: 'https://accounts.google.com',
  },
  {
    slug: 'entra',
    name: 'Microsoft Entra ID',
    type: 'OIDC',
    kind: 'derived',
    tile: { glyph: 'M', color: 'var(--sso-tile-entra)' },
    subtitle: 'Formerly Azure AD',
    fields: [
      {
        id: 'tenant',
        label: 'Tenant ID',
        hint: 'Directory (tenant) ID or primary domain.',
        placeholder: '8f2c…-…-b19a',
        mono: true,
      },
    ],
    resolve: (v) =>
      v.tenant?.trim() ? `https://login.microsoftonline.com/${v.tenant.trim()}/v2.0` : '',
    decompose: (issuer) => {
      const m = /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0$/.exec(trimSlash(issuer));
      return m ? { tenant: m[1] } : null;
    },
  },
  {
    slug: 'gitlab',
    name: 'GitLab',
    type: 'OIDC',
    kind: 'derived',
    tile: { glyph: 'G', color: 'var(--sso-tile-gitlab)' },
    subtitle: 'gitlab.com or self-managed',
    fields: [
      {
        id: 'instance',
        label: 'Instance URL',
        hint: 'Your GitLab base URL.',
        placeholder: 'https://gitlab.example.com',
        mono: true,
      },
    ],
    resolve: (v) => trimSlash(v.instance),
    decompose: (issuer) => ({ instance: trimSlash(issuer) }),
  },
  {
    slug: 'keycloak',
    name: 'Keycloak',
    type: 'OIDC',
    kind: 'derived',
    tile: { glyph: 'K', color: 'var(--sso-tile-keycloak)' },
    subtitle: 'Self-hosted · realm-based',
    fields: [
      {
        id: 'base',
        label: 'Base URL',
        hint: 'Your Keycloak server, no trailing slash.',
        placeholder: 'https://id.example.com',
        mono: true,
      },
      {
        id: 'realm',
        label: 'Realm',
        hint: 'The realm your app lives in.',
        placeholder: 'myrealm',
      },
    ],
    resolve: (v) =>
      v.base?.trim() && v.realm?.trim() ? `${trimSlash(v.base)}/realms/${v.realm.trim()}` : '',
    decompose: (issuer) => {
      const m = /^(.*)\/realms\/([^/]+)$/.exec(trimSlash(issuer));
      return m ? { base: m[1], realm: m[2] } : null;
    },
  },
  {
    slug: 'authentik',
    name: 'Authentik',
    type: 'OIDC',
    kind: 'derived',
    tile: { glyph: 'A', color: 'var(--sso-tile-authentik)' },
    subtitle: 'Self-hosted · application slug',
    fields: [
      {
        id: 'base',
        label: 'Base URL',
        hint: 'Your authentik host.',
        placeholder: 'https://auth.example.com',
        mono: true,
      },
      {
        id: 'slug',
        label: 'Application slug',
        hint: "The provider's application slug.",
        placeholder: 'trueppm',
      },
    ],
    resolve: (v) =>
      v.base?.trim() && v.slug?.trim()
        ? `${trimSlash(v.base)}/application/o/${v.slug.trim()}/`
        : '',
    decompose: (issuer) => {
      const m = /^(.*)\/application\/o\/([^/]+)\/?$/.exec(issuer.trim());
      return m ? { base: m[1], slug: m[2] } : null;
    },
  },
  {
    slug: 'zitadel',
    name: 'Zitadel',
    type: 'OIDC',
    kind: 'derived',
    tile: { glyph: 'Z', color: 'var(--sso-tile-zitadel)' },
    subtitle: 'Cloud or self-hosted',
    fields: [
      {
        id: 'instance',
        label: 'Instance URL',
        hint: 'Your Zitadel instance domain.',
        placeholder: 'https://acme.zitadel.cloud',
        mono: true,
      },
    ],
    resolve: (v) => trimSlash(v.instance),
    decompose: (issuer) => ({ instance: trimSlash(issuer) }),
  },
  {
    slug: 'okta',
    name: 'Okta',
    type: 'OIDC',
    kind: 'derived',
    tile: { glyph: 'O', color: 'var(--sso-tile-okta)' },
    subtitle: 'Okta org domain',
    fields: [
      {
        id: 'domain',
        label: 'Org domain',
        hint: 'Your Okta org domain.',
        placeholder: 'acme.okta.com',
        mono: true,
      },
    ],
    resolve: (v) => (v.domain?.trim() ? `https://${bareHost(v.domain)}` : ''),
    decompose: (issuer) => ({ domain: bareHost(issuer) }),
  },
  {
    slug: 'auth0',
    name: 'Auth0',
    type: 'OIDC',
    kind: 'derived',
    tile: { glyph: 'A', color: 'var(--sso-tile-auth0)' },
    subtitle: 'Auth0 tenant domain',
    fields: [
      {
        id: 'domain',
        label: 'Tenant domain',
        hint: 'Your Auth0 tenant domain.',
        placeholder: 'acme.us.auth0.com',
        mono: true,
      },
    ],
    resolve: (v) => (v.domain?.trim() ? `https://${bareHost(v.domain)}` : ''),
    decompose: (issuer) => ({ domain: bareHost(issuer) }),
  },
  {
    slug: 'github',
    name: 'GitHub',
    type: 'OAuth',
    kind: 'oauth',
    tile: { glyph: 'GH', color: 'var(--sso-tile-github)' },
    subtitle: 'OAuth 2.0 — no OIDC discovery',
    fields: [
      {
        id: 'org',
        label: 'Organization',
        hint: 'Restrict sign-in to members of this org (optional).',
        placeholder: 'acme-inc',
      },
    ],
  },
];

const BY_SLUG: Record<string, ProviderDef> = Object.fromEntries(
  PROVIDERS.map((p) => [p.slug, p]),
);

/** Look up a provider definition by its API slug. */
export function providerDef(slug: string): ProviderDef | undefined {
  return BY_SLUG[slug];
}

/** Human "{Name} · {OIDC|OAuth}" subtitle for a configured-provider row. */
export function providerTypeLabel(def: ProviderDef): string {
  return `${def.name} · ${def.type}`;
}

/**
 * Compose the issuer (`server_url`) to send for `def` given the panel's field
 * values. `fixed` returns its constant; `oauth` (GitHub) has no issuer.
 */
export function resolvedIssuer(def: ProviderDef, values: Record<string, string>): string {
  if (def.kind === 'fixed') return def.fixedIssuer ?? '';
  if (def.kind === 'oauth') return '';
  return def.resolve ? def.resolve(values) : '';
}

/**
 * Best-effort seed of the composition fields from a stored issuer for Edit.
 * Returns the decomposed fields, or `null` when the issuer does not match the
 * provider's expected shape (the panel then offers a raw issuer input).
 */
export function seedFields(def: ProviderDef, serverUrl: string): Record<string, string> | null {
  if (!serverUrl) return {};
  if (def.kind === 'fixed' || def.kind === 'oauth') return {};
  return def.decompose ? def.decompose(serverUrl) : null;
}
