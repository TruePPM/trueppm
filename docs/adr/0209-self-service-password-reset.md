# ADR-0209: Self-service password reset (forgot-password flow)

## Status
Accepted

## Context
The community edition has **no self-service password reset**. The only recovery
path today is an operator running `manage.py changepassword <username>` inside the
API container (documented in `docs/administration/admin-password.md`). This is a
hard adoption blocker: a self-hoster's team member who forgets their password
cannot recover it without pestering an admin with shell access, and the "SSO tax"
carve-out in CLAUDE.md is explicit that basic account recovery is table-stakes OSS,
not an Enterprise governance feature.

Issue #765 asks for the full five-screen forgot-password flow (request link → sent
→ set new password → done → expired) plus the two backend endpoints that drive it.

**P3M layer:** Operations / cross-cutting auth. This is not a project, program, or
portfolio concern — it is account-recovery plumbing that every layer depends on. It
is unambiguously **OSS** (the Auth carve-out in CLAUDE.md: "log in via your own IdP
→ OSS; provision, deprovision, and govern accounts from a directory → Enterprise").
Password reset is neither directory governance nor enforced SSO; it is basic local
account recovery.

Forces at play:
1. **No user enumeration.** The request endpoint must return an identical response
   whether or not the submitted email maps to an account. This is the single most
   important security property of a password-reset endpoint (OWASP).
2. **Reuse existing primitives, invent nothing.** The repo already has: Django's
   stateless `default_token_generator` (a `PasswordResetTokenGenerator`), a cookie
   JWT session with the `token_blacklist` app installed (ADR-0187, #897/#910), an
   SMTP transport + inline email-render idiom (ADR-0085, #639/#764), a scoped-
   throttle convention (ADR-0208), and a `FRONTEND_BASE_URL` link-building pattern.
   A reset flow should compose these, not add a new token table, mailer, or broker.
3. **Session invalidation on confirm.** Screen 4 promises "for your security, we
   signed out your other sessions." A password change must revoke every active
   refresh token for the user, not just the (nonexistent) reset session.
4. **SSO hint without leaking.** Screen 1 shows a banner that an account *might* be
   SSO-backed. That hint must be **static** — it must never be driven by a per-
   account lookup, because a per-account SSO signal is itself an enumeration oracle.

## Decision

### Token scheme — Django's stateless generator, no new model
Use Django's built-in `django.contrib.auth.tokens.default_token_generator`
(`PasswordResetTokenGenerator`) plus a URL-safe base64 encoding of the user PK
(`urlsafe_base64_encode(force_bytes(user.pk))`), exactly as Django's own
`PasswordResetConfirmView` does. The token is a keyed HMAC over
`(user.pk, user.password, last_login, timestamp)` — it is **stateless** (no DB row
to persist, queue, or clean up) and **self-invalidating**: once the password hash
changes on a successful reset, the same token can never validate again (single-use
by construction), and a login (which bumps `last_login`) also invalidates
outstanding tokens.

Set `PASSWORD_RESET_TIMEOUT = 1800` (30 minutes) in settings so the generator's
`check_token` rejects tokens older than the window. This is the one knob that gives
Screens 2 and 5 their "valid for 30 minutes" / "this link has expired" copy.

- `POST /api/v1/auth/password/reset/` — body `{email}`. Look the user up by
  (case-insensitively normalized) email; if found, generate uid+token and send the
  reset email; **always** return `200 {"detail": "If an account exists for that
  address, a reset link is on its way."}` regardless.
- `POST /api/v1/auth/password/reset/confirm/` — body `{uid, token, new_password}`.
  Decode uid → user, `check_token`, run `validate_password` (Django's configured
  `AUTH_PASSWORD_VALIDATORS`), `user.set_password`, save, then revoke all sessions.
  Returns `200 {"detail": "..."}` on success; `400` with a stable, non-leaking
  error code (`invalid_token`) when uid/token are bad or expired — the frontend maps
  this to the "expired link" screen. The same `400 invalid_token` is returned for a
  malformed uid, an unknown uid, and an expired token, so confirm carries no
  enumeration signal either.

### Session invalidation — blacklist every OutstandingToken
There is no existing "logout everywhere" helper. Add
`revoke_all_refresh_tokens(user)` in `apps/access/services.py` that iterates
`OutstandingToken.objects.filter(user=user)` and calls
`BlacklistedToken.objects.get_or_create(token=ot)` for each. Because
`BLACKLIST_AFTER_ROTATION` and the `token_blacklist` app are already active
(ADR-0187), a blacklisted refresh token can no longer be exchanged at the refresh
endpoint — so blacklisting **all** of a user's outstanding refresh tokens is the
complete, correct "sign out every device" mechanism for this JWT/stateless session
design. The access token (15-minute TTL, in-memory only) self-expires; there is no
server-side access-token revocation by design, and 15 minutes is the accepted blast
radius (ADR-0187).

**Django sessions are deliberately *not* cleared.** Research confirms the SPA never
authenticates via `django.contrib.sessions` — `SessionAuthentication` exists only
for the Django admin and DRF browsable API. Clearing `django_session` rows would
add complexity (sessions key the user id inside encoded blobs, not a queryable FK)
for a surface the app's users never touch. The JWT blacklist is the SPA's entire
session surface, so revoking refresh tokens fully satisfies the Screen 4 promise.

### No user enumeration — response shape + accepted timing residual
Both endpoints return byte-identical success bodies across the exists / does-not-
exist branches. The **residual** is a timing signal: the exists branch does extra
work (token generation + a synchronous SMTP send), so its latency is measurably
higher than the not-exists branch. We accept this residual rather than engineer a
constant-time response (which would require a queue + a decoy send path), because:
(a) it is the exact behavior of Django's own `PasswordResetView`, (b) the practical
attack — bulk timing-probing to enumerate accounts — is bounded by a dedicated
`password_reset` throttle scope (5/min per IP), and (c) SMTP latency is noisy enough
that a single-probe timing oracle is unreliable. The throttle is the primary
enumeration defense; the identical body is the secondary. Documented as a known,
accepted residual so a future reviewer does not "rediscover" it as a finding.

### SSO hint — static banner, never a per-account signal
Screen 1 renders a **static** informational banner ("If this account uses single
sign-on, you'll be guided to your provider instead — resetting a password here won't
affect SSO sign-in."). It is present unconditionally and driven by nothing about the
submitted address. The issue's original sketch of returning
`{"detail": "sso_redirect", "provider": ...}` is **rejected**: any per-account SSO
response is a user-enumeration oracle (it reveals the address exists *and* is SSO-
backed). The static banner delivers the same user reassurance with zero leak. A
future SSO-aware request screen (should the product ever want provider auto-redirect
from the login page) belongs on the *login* surface behind the domain-discovery
endpoint (`oidc_discover`, which reveals only domain-level SSO, never account
existence — ADR-0187), not on the password-reset request endpoint.

### Email — synchronous best-effort multipart, inline-rendered
Follow the established inline-render idiom (`workspace/tasks.py::_render_invite_email`,
`notifications/tasks.py`): build the message in a `_render_password_reset_email`
helper and send it with `EmailMultiAlternatives` (plain-text body + HTML alternative)
via `msg.send(fail_silently=...)`, riding the configured `EMAIL_BACKEND`
(ADR-0085). The reset link is `{FRONTEND_BASE_URL}/reset-password/confirm/{uid}/{token}/`.
The send is **synchronous and best-effort**: wrapped in try/except so an SMTP outage
never changes the 200 response or leaks via a 500. No outbox/drain is used because
the reset token is stateless and fully re-requestable — a lost email has no
persisted state to reconcile; the user simply clicks "Resend" (which re-POSTs the
same request). This is the correct durability posture for a re-issuable, stateless
credential and is called out explicitly in the Durable Execution section below.

### Frontend — five screens, one feature module
`packages/web/src/features/auth/passwordReset/` with public (no-auth) routes:
`/forgot-password`, `/forgot-password/sent`, `/reset-password/confirm/:uid/:token`,
`/reset-password/done`, `/reset-password/expired`. A pure `passwordStrength.ts`
utility (client-side heuristic; no new dependency — see Alternatives) drives the
4-segment / 5-label strength bar and the requirements checklist. The strength bar
is advisory UX only; the server's `AUTH_PASSWORD_VALIDATORS` are the authority.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **Django `default_token_generator` (chosen)** | Stateless, single-use by construction, no table/migration, standard, 30-min via one setting | HMAC token is opaque to us (fine) |
| Custom DB-backed reset-token model (like invite tokens) | Explicit expiry/revoke rows, queryable | New model + migration + purge task; re-invents what Django ships; more attack surface |
| Redis single-use ticket (ADR-0141 idiom) | Short-TTL, atomic consume | Needs Redis for a flow that must work even if cache is degraded; Django generator already gives single-use |
| **Blacklist all OutstandingTokens (chosen)** | Complete SPA session revocation, reuses installed app | O(n) rows per user (n = active devices, tiny) |
| Bump a `token_version` claim / rotate a per-user secret | O(1) revoke | No such field exists; would need model change + JWT claim plumbing; overkill for expected device counts |
| **Static SSO banner (chosen)** | Zero enumeration, matches mockup | Doesn't auto-redirect SSO users (acceptable; that's a login-page concern) |
| Per-account `sso_redirect` response | Auto-redirect UX | **Enumeration oracle** — rejected on security grounds |
| **Client heuristic strength meter (chosen)** | No dependency, no bundle cost, deterministic (testable) | Less sophisticated than zxcvbn |
| `zxcvbn` dependency | Better strength modeling | ~400 KB bundle; new dep needs `dependency` gate; server validators are the real gate anyway |
| Synchronous best-effort email (chosen) | Simple, testable, standard Django behavior | Timing residual (accepted, throttle-bounded); blocks request on SMTP latency (bounded, rare) |
| Outbox + drain email (invite pattern) | Constant-time response, non-blocking | Needs a persisted row for a *stateless* token; re-invents durability the re-request already provides |

## Consequences
- **Easier:** Team members self-recover; admins stop fielding `changepassword`
  requests. The flow composes entirely from primitives already in the tree.
- **Easier:** Session-revocation-on-password-change (`revoke_all_refresh_tokens`)
  is now a reusable helper — a future "sign out all devices" account-security action
  can call it directly.
- **Harder:** The reset email only actually delivers once `EMAIL_*` transport is
  configured (#764). Until then the endpoint still returns 200 and the flow is inert
  from the user's side — matching every other email in the product (invites,
  notifications). Documented in the admin docs.
- **Risk (accepted):** Timing-based enumeration, bounded by the `password_reset`
  throttle (5/min/IP) and the identical response body. Documented above.
- **Risk (mitigated):** A leaked reset link is single-use and 30-min-scoped; using it
  invalidates itself (password hash changes) and revokes all other sessions.
- **Risk (low):** Synchronous SMTP send adds request latency on the exists branch;
  bounded by the throttle and by SMTP timeouts. If this ever becomes a problem it can
  move to a fire-and-forget `.delay()` without changing the API contract.

## Implementation Notes
- P3M layer: Operations / cross-cutting auth (not project/program/portfolio).
- Affected packages: **api** (endpoints, serializers, email render, service helper,
  settings, URLs, throttle scope), **web** (5 screens, strength util, router, login
  link), **docs** (admin-password page, OpenAPI schema).
- Migration required: **no** — Django's token generator is stateless; no new model.
  `token_blacklist` tables already exist. No `models.py` change.
- API changes: **yes** — two new `AllowAny` POST endpoints under
  `/api/v1/auth/password/reset/` and `/api/v1/auth/password/reset/confirm/`, each with
  a dedicated `password_reset` `throttle_scope`. Added to the OpenAPI schema.
- OSS or Enterprise: **OSS** (`trueppm-suite`). Basic local account recovery, not
  directory governance or enforced SSO. `grep -r trueppm_enterprise packages/` stays
  at zero real imports.

### Durable Execution
1. **Broker-down behaviour:** N/A for a broker — no Celery task is dispatched. The
   reset email is sent **synchronously and best-effort** inside the request. If SMTP
   is unreachable the send is caught and swallowed; the endpoint still returns 200
   (no enumeration, no 500). No committed DB state depends on the send succeeding, so
   there is nothing to reconcile — the user re-requests via "Resend."
2. **Drain task:** None. The reset token is stateless (no persisted row to drain).
   Reusing the invite/notification outbox+drain would require inventing a row purely
   to carry an already-re-issuable credential — rejected as needless state.
3. **Orphan window:** N/A — no outbox rows, no on_commit race.
4. **Service layer:** New helper `revoke_all_refresh_tokens(user)` in
   `apps/access/services.py` for session revocation. Email rendering/sending lives in
   a `_send_password_reset_email` / `_render_password_reset_email` pair colocated with
   the reset view (mirrors the inline-render idiom), not a new dispatch service.
5. **API response on best-effort dispatch:** Synchronous. `200 {"detail": ...}` on the
   request endpoint (always), `200`/`400 invalid_token` on confirm. No `202 queued`
   because the work is synchronous, not queued.
6. **Outbox cleanup:** N/A — no outbox rows. The `token_blacklist` rows created by
   `revoke_all_refresh_tokens` are cleaned by the existing nightly
   `access.flush_expired_blacklisted_tokens` task (#910) once they expire.
7. **Idempotency:** Both endpoints are naturally idempotent. Repeating the request
   endpoint re-issues a fresh token and re-sends (this *is* "Resend"); the old token
   remains valid until its 30-min window or first use. Repeating confirm with an
   already-used token fails closed with `400 invalid_token` because the password hash
   (part of the token's HMAC input) has already changed —
   `revoke_all_refresh_tokens` is itself idempotent via `get_or_create`.
8. **Dead-letter / failure handling:** A failed SMTP send is logged at WARNING and
   discarded (best-effort). This is acceptable because the credential is re-issuable:
   the user retries via "Resend," and there is no persisted state left in a bad
   status. No DLQ, no retry counter — a durable queue for a re-requestable stateless
   token would be over-engineering.
