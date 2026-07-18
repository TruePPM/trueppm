# Design handoff — SSO provider picker (django-allauth, multi-provider)

**Issue:** #2108 · **ADR:** 0517 (supersedes 0187) · **Source:** Claude Design project
"TruePPM" → `sso-provider-preset.jsx` / `SSO Provider Preset.html`.

Admin surface for **Workspace settings → Single sign-on**, rebuilt on django-allauth's
`socialaccount` framework. The admin picks a provider **type** from a fixed registry;
each type pre-knows its endpoints, so the admin only supplies credentials (+ a small
provider-specific field). **Multiple providers** can be configured at once.

## Page structure

1. **Page head** — `<h1>` "Single sign-on", subtitle "Log in with your own identity
   provider (part of the open-source core)." Info callout "SSO sign-in is not enabled
   yet — Add a provider below to turn it on. Existing password logins keep working
   until you do." Then a **Status** card with the master **SSO sign-in** toggle
   (`role="switch"`, Enabled/Disabled). Master switch gates whether providers appear
   on the sign-in screen.
2. **Sign-in providers** section — a bordered list of configured providers. Each row:
   provider tile (glyph) · display name · `"{Provider} · {OIDC|OAuth}"` subtitle ·
   status pill (Enabled/Disabled) · **Edit** · **Remove**. Header has an **Add
   provider** button. Empty state: dashed card, key glyph, "No providers yet — Add one
   to let your team sign in with their existing identity," Add provider CTA.
3. **Add / configure provider panel** — accented-border card. Header "Add provider" +
   close. Body is a stack of two-column rows (`230px minmax(0,1fr)`, collapses to one
   column below 720px). Footer: primary **Add provider** + ghost **Cancel**.

## Provider registry (source of truth for both FE and BE)

`slug` drives the allauth redirect path `/accounts/<slug>/login/callback/`.

| id | name | allauth slug | type | kind | issuer resolution | extra field(s) |
|----|------|--------------|------|------|-------------------|----------------|
| `generic` | Generic OIDC | `openid_connect` | OIDC | free | admin enters Issuer URL | Issuer URL (mono) |
| `google` | Google | `google` | OIDC | fixed | `accounts.google.com` (auto) | — |
| `entra` | Microsoft Entra ID | `microsoft` | OIDC | derived | `https://login.microsoftonline.com/{tenant}/v2.0` | Tenant ID |
| `gitlab` | GitLab | `gitlab` | OIDC | derived | `{instance}` (trim trailing /) | Instance URL |
| `keycloak` | Keycloak | `keycloak` | OIDC | derived | `{base}/realms/{realm}` | Base URL, Realm |
| `authentik` | Authentik | `authentik` | OIDC | derived | `{base}/application/o/{slug}/` | Base URL, Application slug |
| `zitadel` | Zitadel | `zitadel` | OIDC | derived | `{instance}` | Instance URL |
| `okta` | Okta | `okta` | OIDC | derived | `https://{domain}` | Org domain |
| `auth0` | Auth0 | `auth0` | OIDC | derived | `https://{domain}` | Tenant domain |
| `github` | GitHub | `github` | **OAuth** | oauth | none (OAuth2, no discovery) | Organization |

**`kind` drives the panel's conditional middle section:**
- `free` → editable **Issuer URL** input (mono).
- `fixed` → read-only accented "Issuer: `{value}` (auto-configured)" line + **auto** pill.
- `derived` → one/two labeled inputs + a live **Resolved issuer** strip
  (`aria-live="polite"`) showing the composed URL; placeholder "Fill the fields above
  to compose the issuer…" when incomplete.
- `oauth` → info **callout** "GitHub uses OAuth 2.0 — endpoints are configured
  automatically; no issuer URL needed. Email & profile come from the GitHub user API."
  + **Organization** field (restricts sign-in to org members).

## Common fields (every provider)

- **Display name** — text, "Shown on the sign-in button." Live hint "→ Continue with {name}".
- **Client ID** — mono.
- **Client secret** — password input + show/hide eye toggle. Hint "Encrypted at rest."
- **Redirect URI** — read-only mono + **Copy** button. Value `https://{host}/accounts/<slug>/login/callback/`. "Updates automatically per provider type."
- **Scopes** — three read-only pills `openid` `email` `profile` + lock glyph "read-only".
  Hint "Fixed in the open-source core." (OSS must never widen scope.)

## Design tokens (names used verbatim; resolve from the app theme, do NOT hard-code hex)

Layout: `--bg --desk --panel --panel-raised --sunken --input`.
Lines: `--border --border-soft --hairline`.
Text: `--text --text-2 --muted --faint`.
Accent (sage): `--accent --accent-strong --accent-dim --ring`.
Info callout: `--info --info-bg --info-bd`.
Provider tiles use per-provider brand hex via `color-mix()` (decorative only — the tile
glyph is `aria-hidden`; the accessible name comes from the adjacent provider name text).

## Accessibility / interaction

- Provider dropdown is `role="listbox"` / `option`, keyboard-navigable (Enter/Space
  select), closes on outside click; button carries `aria-haspopup`/`aria-expanded`.
- Every input has an associated `<label htmlFor>`; hints are wired via `aria-describedby`.
- Resolved-issuer strip is a polite live region.
- Master toggle and per-provider status use `role="switch"` / status pill.
- Focus rings: `box-shadow: 0 0 0 3px var(--ring)` + `border-color: var(--accent)`.
- Responsive < 720px: rows → single column, controls full-width; provider-list rows
  wrap Edit/Remove under the title; settings nav stacks.

## Notes for implementation

- The panel is used for both **Add** and **Edit** (Edit pre-fills from the SocialApp).
- `Add provider` in the list opens the panel with the dropdown focused; the default
  design state opens on **Keycloak** (the richest, derived, two-field case).
- On save, the FE POSTs/PUTs the resolved config to the SocialApp admin endpoint; the
  server persists issuer + client credentials and derives nothing the FE couldn't
  (server re-validates the composed issuer as an absolute https URL).
