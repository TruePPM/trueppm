const { useState, useRef, useEffect, useId } = React;

/* ── icons (simple single-path UI glyphs) ───────────────────────────── */
function Ico({ d, size = 16, sw = 1.6, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"
      style={{ display: "block", ...style }} aria-hidden="true">
      {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
    </svg>
  );
}
const ICON = {
  chevron: "M6 9l6 6 6-6",
  copy: ["M9 9h10v10H9z", "M5 15V5h10"],
  check: "M5 12.5l4.5 4.5L19 7",
  lock: ["M6 11h12v9H6z", "M8.5 11V8a3.5 3.5 0 017 0v3"],
  info: ["M12 3a9 9 0 100 18 9 9 0 000-18z", "M12 11v5", "M12 7.6v.2"],
  eye: ["M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z", "M12 9.2A2.8 2.8 0 1012 14.8 2.8 2.8 0 0012 9.2z"],
  link: ["M9.5 14.5l5-5", "M8 12l-2 2a3 3 0 004.2 4.2l2-2", "M16 12l2-2a3 3 0 00-4.2-4.2l-2 2"],
  plus: ["M12 5v14", "M5 12h14"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  edit: ["M4 20h4L18.5 9.5a2 2 0 00-2.8-2.8L5 17.2 4 20z"],
  trash: ["M4 7h16", "M9 7V5h6v2", "M6 7l1 13h10l1-13"],
  key: ["M15.5 3.5a5 5 0 00-4.6 6.9L3 18.3V21h2.7l.9-.9v-1.8h1.8l1.4-1.4v-1.8h1.8l1.1-1.1a5 5 0 102.1-9.5z", "M17.2 7.1v.2"],
};

/* ── provider registry (django-allauth social providers) ────────────── */
// slug drives the allauth redirect path /accounts/<slug>/login/callback/
const APP_HOST = "truescope.trueppm.app";
const PROVIDERS = [
  { id: "generic", name: "Generic OIDC", slug: "openid_connect", type: "OIDC", tile: { fg: "#7fb394", label: "◎" },
    kind: "free", sub: "Any standards-compliant OIDC provider" },
  { id: "google", name: "Google", slug: "google", type: "OIDC", tile: { fg: "#e6857c", label: "G" },
    kind: "fixed", fixed: "accounts.google.com", sub: "Google Workspace / consumer" },
  { id: "entra", name: "Microsoft Entra ID", slug: "microsoft", type: "OIDC", tile: { fg: "#5b93e6", label: "M" },
    kind: "derived", sub: "Formerly Azure AD",
    fields: [{ id: "tenant", label: "Tenant ID", hint: "Directory (tenant) ID or primary domain.", ph: "8f2c…-…-b19a" }],
    resolve: v => v.tenant ? `https://login.microsoftonline.com/${v.tenant}/v2.0` : "" },
  { id: "gitlab", name: "GitLab", slug: "gitlab", type: "OIDC", tile: { fg: "#e2864f", label: "G" },
    kind: "derived", sub: "gitlab.com or self-managed",
    fields: [{ id: "instance", label: "Instance URL", hint: "Your GitLab base URL.", ph: "https://gitlab.example.com" }],
    resolve: v => trim(v.instance) },
  { id: "keycloak", name: "Keycloak", slug: "keycloak", type: "OIDC", tile: { fg: "#4f8ada", label: "K" },
    kind: "derived", sub: "Self-hosted · realm-based",
    fields: [
      { id: "base", label: "Base URL", hint: "Your Keycloak server, no trailing slash.", ph: "https://id.example.com" },
      { id: "realm", label: "Realm", hint: "The realm your app lives in.", ph: "myrealm" },
    ],
    resolve: v => (v.base && v.realm) ? `${trim(v.base)}/realms/${v.realm}` : "" },
  { id: "authentik", name: "Authentik", slug: "authentik", type: "OIDC", tile: { fg: "#e2685d", label: "A" },
    kind: "derived", sub: "Self-hosted · application slug",
    fields: [
      { id: "base", label: "Base URL", hint: "Your authentik host.", ph: "https://auth.example.com" },
      { id: "slug", label: "Application slug", hint: "The provider's application slug.", ph: "trueppm" },
    ],
    resolve: v => (v.base && v.slug) ? `${trim(v.base)}/application/o/${v.slug}/` : "" },
  { id: "zitadel", name: "Zitadel", slug: "zitadel", type: "OIDC", tile: { fg: "#9a83ec", label: "Z" },
    kind: "derived", sub: "Cloud or self-hosted",
    fields: [{ id: "instance", label: "Instance URL", hint: "Your Zitadel instance domain.", ph: "https://acme.zitadel.cloud" }],
    resolve: v => trim(v.instance) },
  { id: "okta", name: "Okta", slug: "okta", type: "OIDC", tile: { fg: "#6f8ff0", label: "O" },
    kind: "derived", sub: "Okta org domain",
    fields: [{ id: "domain", label: "Org domain", hint: "Your Okta org domain.", ph: "acme.okta.com" }],
    resolve: v => v.domain ? `https://${trim(v.domain).replace(/^https?:\/\//, "")}` : "" },
  { id: "auth0", name: "Auth0", slug: "auth0", type: "OIDC", tile: { fg: "#e0704f", label: "A" },
    kind: "derived", sub: "Auth0 tenant domain",
    fields: [{ id: "domain", label: "Tenant domain", hint: "Your Auth0 tenant domain.", ph: "acme.us.auth0.com" }],
    resolve: v => v.domain ? `https://${trim(v.domain).replace(/^https?:\/\//, "")}` : "" },
  { id: "github", name: "GitHub", slug: "github", type: "OAuth", tag: "OAuth", tile: { fg: "#c2ccda", label: "GH" },
    kind: "oauth", sub: "OAuth 2.0 — no OIDC discovery",
    fields: [{ id: "org", label: "Organization", hint: "Restrict sign-in to members of this org.", ph: "acme-inc" }] },
];
const byId = id => PROVIDERS.find(p => p.id === id);
function trim(s) { return (s || "").replace(/\/+$/, ""); }
function redirectFor(p) { return `https://${APP_HOST}/accounts/${p.slug}/login/callback/`; }

const DEFAULT_VALUES = {
  generic: {}, google: {}, entra: { tenant: "8f2c1e4a-7d90-4c2b-9a11-b19a3c5d7e02" },
  gitlab: { instance: "https://gitlab.com" },
  keycloak: { base: "https://id.example.com", realm: "myrealm" },
  authentik: { base: "https://auth.example.com", slug: "trueppm" },
  zitadel: { instance: "https://acme.zitadel.cloud" },
  okta: { domain: "acme.okta.com" }, auth0: { domain: "acme.us.auth0.com" },
  github: { org: "acme-inc" },
};

/* NOTE: This is the imported Claude Design mockup (reference only, sonar-excluded).
   The production component lives in packages/web/src/features/settings/workspace/.
   The provider registry above is the shared source of truth — keep the two in sync. */
