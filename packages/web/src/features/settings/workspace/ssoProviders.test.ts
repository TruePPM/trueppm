import { describe, it, expect } from 'vitest';
import {
  PROVIDERS,
  providerDef,
  providerTypeLabel,
  resolvedIssuer,
  seedFields,
} from './ssoProviders';

describe('provider registry', () => {
  it('exposes the ten fixed provider types keyed by slug', () => {
    expect(PROVIDERS.map((p) => p.slug)).toEqual([
      'generic',
      'google',
      'entra',
      'gitlab',
      'keycloak',
      'authentik',
      'zitadel',
      'okta',
      'auth0',
      'github',
    ]);
    expect(providerDef('keycloak')?.name).toBe('Keycloak');
    expect(providerDef('nope')).toBeUndefined();
  });

  it('labels GitHub as OAuth and OIDC providers as OIDC', () => {
    expect(providerTypeLabel(providerDef('github')!)).toBe('GitHub · OAuth');
    expect(providerTypeLabel(providerDef('okta')!)).toBe('Okta · OIDC');
  });
});

describe('resolvedIssuer', () => {
  it('returns the constant for a fixed provider (Google) regardless of input', () => {
    expect(resolvedIssuer(providerDef('google')!, {})).toBe('https://accounts.google.com');
  });

  it('returns empty for the oauth provider (GitHub has no issuer)', () => {
    expect(resolvedIssuer(providerDef('github')!, { org: 'acme' })).toBe('');
  });

  it('echoes the free issuer, trimming a trailing slash', () => {
    expect(resolvedIssuer(providerDef('generic')!, { issuer: 'https://id.example.com/' })).toBe(
      'https://id.example.com',
    );
  });

  it('composes Entra from the tenant', () => {
    expect(resolvedIssuer(providerDef('entra')!, { tenant: 'abc-123' })).toBe(
      'https://login.microsoftonline.com/abc-123/v2.0',
    );
  });

  it('composes Keycloak from base + realm', () => {
    expect(
      resolvedIssuer(providerDef('keycloak')!, { base: 'https://id.example.com/', realm: 'main' }),
    ).toBe('https://id.example.com/realms/main');
  });

  it('composes Authentik from base + application slug', () => {
    expect(
      resolvedIssuer(providerDef('authentik')!, {
        base: 'https://auth.example.com',
        slug: 'trueppm',
      }),
    ).toBe('https://auth.example.com/application/o/trueppm/');
  });

  it('prefixes https for Okta / Auth0 bare domains', () => {
    expect(resolvedIssuer(providerDef('okta')!, { domain: 'acme.okta.com' })).toBe(
      'https://acme.okta.com',
    );
    expect(resolvedIssuer(providerDef('auth0')!, { domain: 'https://acme.us.auth0.com/' })).toBe(
      'https://acme.us.auth0.com',
    );
  });

  it('returns empty while a derived provider is incompletely filled', () => {
    expect(resolvedIssuer(providerDef('keycloak')!, { base: 'https://id.example.com' })).toBe('');
    expect(resolvedIssuer(providerDef('entra')!, {})).toBe('');
  });
});

describe('seedFields — decompose round-trips resolve for Edit pre-fill', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['generic', { issuer: 'https://id.example.com' }],
    ['entra', { tenant: 'abc-123' }],
    ['gitlab', { instance: 'https://gitlab.example.com' }],
    ['keycloak', { base: 'https://id.example.com', realm: 'main' }],
    ['authentik', { base: 'https://auth.example.com', slug: 'trueppm' }],
    ['zitadel', { instance: 'https://acme.zitadel.cloud' }],
    ['okta', { domain: 'acme.okta.com' }],
    ['auth0', { domain: 'acme.us.auth0.com' }],
  ];

  it.each(cases)('round-trips %s', (slug, fields) => {
    const def = providerDef(slug)!;
    const issuer = resolvedIssuer(def, fields);
    const seeded = seedFields(def, issuer);
    // Re-composing the seeded fields must reproduce the same issuer.
    expect(resolvedIssuer(def, seeded ?? {})).toBe(issuer);
  });

  it('returns {} for an empty issuer (nothing to seed)', () => {
    expect(seedFields(providerDef('keycloak')!, '')).toEqual({});
  });

  it('returns null when a stored issuer does not match the provider shape', () => {
    // A hand-edited issuer that is not a Keycloak realm URL cannot be decomposed.
    expect(seedFields(providerDef('keycloak')!, 'https://weird.example.com/oauth')).toBeNull();
    expect(seedFields(providerDef('entra')!, 'https://example.com')).toBeNull();
  });

  it('treats fixed / oauth providers as having no fields to seed', () => {
    expect(seedFields(providerDef('google')!, 'https://accounts.google.com')).toEqual({});
    expect(seedFields(providerDef('github')!, '')).toEqual({});
  });
});
