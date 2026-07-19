# ADR-0531: TOTP Two-Factor Authentication for Local Password Accounts

## Status

Proposed (planning artifact for #2216, milestone 0.5 — implementation deferred; this ADR records the design so 0.5 development starts from a settled plan)

## Context

Local password accounts authenticate with a single factor. Basic SSO (ADR-0517, 0.4)
lets a team delegate login — and therefore MFA — to its own IdP, but self-hosters
using local accounts have password-only login. Missing 2FA is a fast disqualifier in
security-conscious self-host evaluations (ranked the #2 untracked OSS adoption gap in
the 2026-07-19 gap analysis), and it blocks teams that cannot or will not run an IdP.

"Google Authenticator support" is standard TOTP (RFC 6238): a shared secret
provisioned via an `otpauth://` QR code. Any authenticator app works. Nothing leaves
the box.

**P3M layer: Operations** — account-level security for every persona; nothing
cross-project about it. The VoC panel (avg 5.5/10, infra-hardening profile, ship
recommendation) surfaced four binding constraints, folded into the Decision below:
admin lockout recovery must have a documented shell path (Omar 🔴); PAT mint/revoke
must require a TOTP step-up or MFA is theater (Nadia 🟡); the challenge must fire at
online login only — never against an authenticated offline PWA session (Sarah/Priya
🟡); and enrollment status is an admin-security-surface fact, never a PMO-facing
roster metric (Morgan/Janet tension resolution).

Relevant prior art discovered in research:

- **ADR-0517** — allauth is a *library*; our views own the flow; `allauth.urls` are
  never mounted. Local password login is `CookieTokenObtainPairView`
  (`core/auth_views.py`, ADR-0187/#897); the OIDC callback mints the same JWT cookies
  through its own view, bypassing the password path entirely.
- **ADR-0141** — short-lived, single-purpose, server-stored tokens for auth
  transitions (WS ticket). The MFA-pending token follows this shape.
- **ADR-0208/-0209** — scoped-throttle convention (`login`, `login_account`,
  `password_reset`) and the precedent that a credential change revokes refresh
  tokens.
- **ADR-0214** — PATs: hash-at-rest, one-time reveal, append-only
  `ApiTokenAuditEntry`, auto-revoke on password change. The enrollment UX
  (reveal-once recovery codes) and the step-up surface both build on this.
- **ADR-0157** — workspace-grain `AuditEvent` with the Enterprise signing extension
  point: the home for human auth-security events.
- **ADR-0049 §3** — secrets at rest are Fernet-encrypted with
  `INTEGRATION_ENCRYPTION_KEY` (not Django `SECRET_KEY`); reused by SSO (ADR-0517)
  and SMTP (ADR-0213).
- **Load-bearing library finding**: `allauth.mfa` ships in our installed
  django-allauth (≥ 65.18) but is not in `INSTALLED_APPS`, and its
  `DefaultMFAAdapter.encrypt`/`decrypt` are **no-ops** — adopting it unmodified
  would store TOTP secrets in plaintext, violating the ADR-0049 §3 bar.
- **Stale surface**: `WorkspaceMemberSerializer.two_fa` is a hardcoded-`False`
  placeholder commented "SSO / 2FA are Enterprise identity features" — a
  classification that predates the auth carve-out (basic SSO is OSS, ADR-0517).
  This ADR supersedes that comment's classification for self-service 2FA.

## Decision

Adopt **`allauth.mfa` as a library** behind our own views — the ADR-0517 pattern
extended to MFA — with a custom adapter closing the encryption gap.

1. **Storage**: add `allauth.mfa` to `INSTALLED_APPS` for its `Authenticator` model
   (types `totp` and `recovery_codes`; `webauthn` deliberately unused for now) and
   validation internals. Ship a `TruePPMMFAAdapter` subclassing `DefaultMFAAdapter`
   whose `encrypt`/`decrypt` delegate to `apps/integrations/encryption.py`
   (Fernet, `INTEGRATION_ENCRYPTION_KEY`) so TOTP secrets are encrypted at rest.
   `allauth.mfa`'s URLs and views stay unmounted. Auth state does not sync to
   mobile (no `server_version`, matching `profiles`/`sso` convention).

2. **Login challenge** (the only change to the password path; SSO/OIDC callback is
   untouched — a federated IdP is the trust anchor and MFA is delegated to it,
   deliberately, with no double challenge):
   - `POST /api/v1/auth/token/` — in `CookieTokenObtainPairView.post()`, after
     credential validation and before `local_login_allowed()`: if the user has a
     confirmed TOTP authenticator, do **not** mint cookies; return
     `409 {"mfa_required": true, "pending_token": "<opaque>"}`.
   - The **MFA-pending token** is an opaque random token stored server-side in
     Redis (ADR-0141 shape): 5-minute TTL, bound to the user id, carrying an
     attempt counter (max 5, then invalidated). It is a first-class documented
     schema type — named error shapes (`mfa_invalid_code`, `mfa_pending_expired`,
     `mfa_attempts_exhausted`), documented rates — not a repurposed JWT.
   - `POST /api/v1/auth/token/mfa/` — pending token + 6-digit TOTP **or** a
     recovery code → mints the normal access token + refresh cookie, updates
     `last_used_at`, consumes the pending token. Throttled by a new
     `mfa_verify` per-account scope (mirroring `LoginAccountRateThrottle`) plus
     the IP-scoped default.
   - **Challenge frequency**: the challenge exists only at password login. Refresh
     rotation (7-day sliding sessions) is untouched, so an authenticated device —
     including an offline PWA session with queued writes — is never re-challenged
     mid-session. Enrollment is per-user opt-in in OSS.

3. **Enrollment / disable** (new `me/`-scoped endpoints, mirroring the PAT surface):
   activate returns the provisioning URI + QR seed and requires a confirming code
   before the authenticator is live; recovery codes are generated on confirm and
   revealed once (ADR-0214 idiom — the UI requires an explicit acknowledgment);
   disable and recovery-code regeneration require the current password **and** a
   valid code. A security email ("2FA was enabled/disabled on your account") uses
   the inline-render idiom (no template directory exists, per ADR-0209).

4. **PAT step-up** (Nadia's constraint): for MFA-enrolled users,
   `MyApiTokenViewSet.create()` and `.destroy()` require an `otp_code` field in the
   request, verified inline — stateless step-up, no sudo-session state. Documented
   in the OpenAPI schema with its error shape. Project/program token endpoints
   (Admin-gated, ADR-0214) follow the same rule for enrolled callers. Existing
   bearer-token *requests* are unaffected — a PAT remains a bearer credential;
   the gate is on minting and revoking, closing the "re-mint a token to bypass
   MFA" hole. Scripted consumers still doing password auth must migrate to PATs
   once they enroll; the release notes call this out.

5. **Recovery — the 2 a.m. path** (Omar's 🔴): a management command
   `manage.py mfa_reset <username-or-email>` (at
   `apps/access/management/commands/`, `create_admin.py` shape) deletes the user's
   authenticators, **revokes all refresh tokens and active PATs**, writes the
   audit event, and sends the security email. Ops docs ship in the same MR:
   NTP-drift as a named failure mode (symptom signature: valid password, all codes
   rejected), and the backup/restore note that TOTP secrets decrypt with
   `INTEGRATION_ENCRYPTION_KEY` — restoring the database without that key orphans
   all enrollments (already true for SSO/SMTP secrets; now called out).

6. **Audit & visibility**: enroll / disable / admin-reset / verification-failure
   events write ADR-0157 `AuditEvent` rows (Owner/Admin-visible; Enterprise signing
   extension applies automatically) and structured `trueppm.auth` log lines
   (existing `_emit_login_failure_event` idiom). The existing
   `WorkspaceMemberSerializer.two_fa` placeholder is wired to real enrollment
   state, exposed **only** on the admin members surface (Owner/Admin) — never on
   PMO-facing rosters, boards, or dashboards (Morgan's constraint; Janet/Marcus
   get their compliance signal on the admin security surface).

7. **Enterprise seam** (mechanism OSS, governance Enterprise — the auth carve-out
   applied to MFA): a single-callable slot `mfa_required_for(user) -> bool` in the
   `sso/extensions.py` idiom — OSS default returns `False` (opt-in), registered
   lazily in `AppConfig.ready()`, fail-safe to the OSS default. The Enterprise
   org-policy overlay (per-role mandates, grace windows, local-account-fallback
   lockout) registers against it; when it returns `True` for an unenrolled user,
   login responds with an `mfa_enrollment_required` state the frontend routes to
   enrollment. Enterprise-side policy must be team-visible configuration, not a
   silent flip (Morgan). Filed separately in `trueppm-enterprise`.

### Frontend

- **Login**: `LoginPage` handles the `mfa_required` response by advancing to a
  challenge step (code input + "use a recovery code" toggle) inside the existing
  `AuthShell` — the `passwordReset/` multi-page pattern, not a new flow idiom.
- **Enrollment**: a "Two-factor authentication" section on the personal security
  settings surface (`features/me/`, structurally mirroring
  `PersonalAccessTokensPage`: QR + secret reveal, confirm-code input,
  recovery-codes reveal-once with forced acknowledgment, disable dialog).

### Threat-model deltas (STRIDE, design-stage — binding on implementation)

The paired threat model confirmed the mitigations above and added five requirements:

1. **Atomic attempt counting** — the pending token's attempt counter is an atomic
   Redis increment-and-check, not read-modify-write, so parallel verify requests
   cannot race past the 5-attempt cap. Verification compares in constant time.
2. **Replay guard** — a successfully used TOTP code (same time step) is rejected on
   reuse for the same user; if `allauth.mfa`'s validator does not already cache the
   last-used step, the service layer adds that cache. Uniform `mfa_invalid_code`
   error regardless of failure reason.
3. **No broadcast leak** — `two_fa` is a REST-only, Owner/Admin-gated serializer
   field; it is excluded from every WebSocket broadcast payload (broadcasts fan out
   without per-recipient filtering). Enrollment state never rides a broadcast.
4. **Recovery command hardening** — `mfa_reset` requires `--confirm`, records the
   invoking OS user in the audit event, and its session/PAT revocation sweep is the
   non-optional part of the command.
5. **Flow invariants** — password reset does **not** clear MFA (an email-inbox
   attacker still faces the second factor); provisioning URIs, secrets, and
   submitted codes never appear in logs or OTel spans (ADR-0517 redaction
   precedent); the `mfa_required_for` seam **fails open** to the OSS opt-in default
   for availability, but a provider exception is loudly logged and audited so
   silently-disabled enforcement is visible, and the seam's return value is
   coerced to a strict bool (extension inputs are untrusted, defense in depth).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. `allauth.mfa` as library + custom adapter (chosen)** | Battle-tested TOTP/recovery internals; zero new crypto code; dependency already installed; consistent with ADR-0517; WebAuthn is a config-away follow-up | Must close the adapter encryption no-op; adds allauth.mfa migrations |
| B. Hand-rolled `pyotp` + own `Authenticator` model | Full control; UUID-PK/house-style models | New dependency; re-implements recovery codes, drift windows, replay guard — the exact code most likely to be subtly wrong; more surface for security review |
| C. `django-otp` | Mature, widely used | Second auth framework alongside allauth — two libraries owning the same concern; session-middleware-oriented design fights the JWT bridge |
| D. Enable allauth.mfa's full mounted flow | Least code | Mounts allauth views/URLs, contradicting ADR-0517's settled architecture; session-based flow doesn't fit the SPA/JWT bridge |
| E. Do nothing (document reverse-proxy MFA, e.g. Authelia) | Zero code | Fails the adoption gap this feature exists to close; unusable for the PWA/native API paths; punts account security to infrastructure many adopters don't run |

## Consequences

- **Easier**: security-conscious self-host adoption (a documented top-list
  disqualifier removed); the Enterprise MFA-enforcement product gets its OSS
  mechanism and seam; WebAuthn/passkeys later is adapter config plus UI, not a new
  subsystem; the stale `two_fa` placeholder becomes a real fact.
- **Harder**: the login flow gains a second state the SPA, docs, and OpenAPI schema
  must model; PAT mint/revoke gains a conditional required field (schema change,
  though additive); `INTEGRATION_ENCRYPTION_KEY` becomes load-bearing for login
  (previously only for integrations/SSO/SMTP secrets) — its loss now locks out
  enrolled users rather than just breaking connectors, which raises the stakes on
  the backup runbook.
- **Risks**: (1) locked-out admins — mitigated by recovery codes, `mfa_reset`, and
  ops docs shipped in the same MR, non-negotiable; (2) clock drift breaking all
  logins — mitigated by allauth's tolerance window plus the documented NTP
  callout; (3) pending-token brute force — mitigated by the attempt counter,
  `mfa_verify` per-account throttle, and 5-minute TTL; (4) scripted password-auth
  consumers breaking on enrollment — mitigated by release-note guidance to PATs
  (the API-first-correct credential for automation anyway).

## Implementation Notes

- P3M layer: **Operations**
- Affected packages: `api` (core/auth_views, apps/sso extensions idiom, apps/projects
  token viewsets, apps/access management command, settings), `web`
  (features/auth, features/me), `helm` (docs only — `INTEGRATION_ENCRYPTION_KEY`
  already provisioned), docs site
- Migration required: **yes** — `allauth.mfa`'s shipped migrations (0001–0003) via
  `INSTALLED_APPS`; additive only, no destructive ops
- API changes: **yes** — `409 mfa_required` state on `/auth/token/`; new
  `/auth/token/mfa/`; new `me/mfa/` enrollment endpoints; conditional `otp_code`
  on token mint/revoke; `two_fa` on the admin members serializer becomes real.
  All documented in the OpenAPI schema with named error shapes in the same MR
- OSS or Enterprise: **OSS** (mechanism + opt-in + seam); org-wide enforcement
  policy is a separate `trueppm-enterprise` issue registering against
  `mfa_required_for`

### Durable Execution

1. Broker-down behaviour: security emails (enable/disable/reset) follow the
   password-reset idiom — rendered inline and dispatched through the existing
   notification email path; if the broker is down the email is deferred by that
   substrate, and the state change itself is synchronous and unaffected. All other
   flows (challenge, verify, enroll) are synchronous request/response — no async
   side effects.
2. Drain task: reuses the existing notification-email drain (ADR-0085); no new
   category of async work, so no new drain.
3. Orphan window: N/A — no new outbox category.
4. Service layer: new `apps/access/mfa_services.py` (`begin_enrollment`,
   `confirm_enrollment`, `verify_challenge`, `disable_mfa`, `admin_reset_mfa`) —
   views and the management command both call it; no view-layer crypto.
5. API response on best-effort dispatch: N/A — auth responses are synchronous;
   the only async effect (email) is fire-and-forget by existing convention.
6. Outbox cleanup: N/A — no new outbox rows. Redis pending tokens expire by TTL.
7. Idempotency: enrollment confirm is idempotent per authenticator (unique
   `(user, type)` constraint in `allauth.mfa` 0003); challenge verify is
   single-use by pending-token consumption (atomic Redis check-and-delete on
   success); `mfa_reset` is idempotent (deleting zero rows is a no-op that still
   audits); duplicate security emails are acceptable and harmless.
8. Dead-letter / failure handling: email failures land in the existing
   notification dead-letter path (ADR-0084 alerting applies). Verification
   failures are not retried — they are counted (attempt counter) and audited.
