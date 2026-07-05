# ADR-0211: Writable Workspace SMTP Configuration

## Status
Accepted (2026-07-04) — implemented in #712

## Context

**P3M layer:** Operations (OSS). A solo PM or self-hoster must be able to point
TruePPM at their own mail transport without editing Helm env and redeploying —
"BYO SMTP" is table-stakes for a self-hosted product, and gating it kills adoption.
This is workspace configuration, not cross-program governance.

Issue #639 (ADR-0085 §5) deliberately shipped email as **read-only**:
`notifications/tasks.py::_send_email_for_notification` builds a
`django.core.mail.EmailMessage` and calls `.send()` on the process-global
`EMAIL_BACKEND` sourced from Django settings / Helm env, and
`EmailSettingsStatusView` (`GET /api/v1/workspace/email-settings/`,
`IsAuthenticated + IsOrgAdmin`) surfaces a **safe** read-only subset of those
settings (transport, host, From identity — never the password). ADR-0085 §5
explicitly flagged the **writable** SMTP admin (transport switch, BYO credentials,
DKIM, throttle) as a follow-up requiring "encrypted-at-rest credential storage +
a dynamic `EmailBackend` swap + transport validation — material new infra and a
credential-handling security surface." #712 is that follow-up.

Forces:
1. **Credential at rest.** A stored SMTP password must be encrypted (Fernet, the
   established `apps/integrations/encryption.py` pattern) and **never** echoed to a
   client — write-only, mirroring `IntegrationCredential.secret_ciphertext`.
2. **Lock-out risk.** A bad transport (wrong host/port/credentials) silently
   configured would stop *all* outbound mail. The transport must be validated
   (connection opened) **before** the row is persisted.
3. **SSRF.** Two admin-supplied network targets — the custom SMTP host and the
   bounce webhook URL — are server-side egress vectors (cloud metadata,
   cluster-internal services). The integrations egress chokepoint
   (`assert_url_allowed`, ADR-0049 §3) already enumerates the deny-list.
4. **One send path.** All outbound email flows through the notifications drain
   (`_send_email_for_notification`); the dynamic backend must slot in there so a
   single seam governs both notification mail and the test-email action.

## Decision

Add a `WorkspaceEmailSettings` **singleton** model in the `notifications` app
(email already lives there; the endpoint path `workspace/email-settings/` is
already served by it), a dynamic connection resolver used at send time, a writable
`IsOrgAdmin`-gated viewset that upgrades the existing read-only path, a test-email
action, and a deliverability (SPF/DKIM/DMARC) health surface.

### 1. `WorkspaceEmailSettings` model (`notifications/models.py`)

- UUID PK. **Not** a synced/board-scoped model, so **no `server_version`** — it is
  installation config, following the `workspace.Workspace` singleton precedent
  (unique `singleton_key=1` + a `load()` classmethod that `get_or_create`s the row).
- Fields:
  - `transport_mode` — `cloud | smtp | sendgrid | ses` (default `cloud`). `cloud`
    means "unconfigured / fall back to Django settings," so a fresh install behaves
    exactly like today.
  - `host`, `port` (default 587), `security` — `none | tls | ssl`.
  - `username`.
  - `password_ciphertext = BinaryField(blank=True, default=b"")` — Fernet-encrypted;
    set via the write-only serializer field, decrypted only server-side at send time.
  - `from_name`, `from_email`, `reply_to`.
  - `dkim_selector`.
  - `max_recipients` (int, default 50), `throttle_per_min` (int, default 0 = off).
  - `bounce_webhook_url`.
  - `updated_at`, `updated_by` (FK to user, nullable), plus a helper
    `password_is_set` property (`bool(password_ciphertext)`) for the serializer.
- `set_password(plaintext)` encrypts via `encrypt_secret`; `get_password()` decrypts
  via `decrypt_secret`. An empty submitted password on update is a **no-op** (keeps
  the existing secret) so the admin can edit other fields without re-entering it.

### 2. Dynamic connection resolver (`notifications/email_backend.py`)

`resolve_email_connection() -> BaseEmailBackend` reads the singleton:
- `transport_mode == cloud` (or the row is unconfigured) → return
  `django.core.mail.get_connection()` (the process-global `EMAIL_BACKEND`) — today's
  behaviour, no change.
- `smtp` → `get_connection('django.core.mail.backends.smtp.EmailBackend', host=…,
  port=…, username=…, password=<decrypted>, use_tls=…, use_ssl=…, timeout=…)`.
- `sendgrid` / `ses` → SMTP relay backends with the provider's fixed
  host/port/security and the stored API key as the password
  (`smtp.sendgrid.net:587` TLS / `email-smtp.<region>.amazonaws.com:587` TLS). This
  keeps 0.4 to **one** backend class (SMTP) — no new dependency — while presenting
  the four transport choices the mock requires. A native SES/SendGrid API backend is
  a later hardening item.

`_send_email_for_notification` passes `connection=resolve_email_connection()` and the
resolved From identity (`from_name`/`from_email`/`reply_to` from the model when set,
else `DEFAULT_FROM_EMAIL`) to `EmailMessage`. The test-email action reuses the same
resolver, so "test" exercises the exact path production mail takes.

### 3. Validation-before-persist

The serializer's `update()` builds a **candidate** connection from the *incoming*
values (not the persisted row) and, for SMTP/SendGrid/SES, opens it
(`connection.open()` / `.close()`) inside `validate()` **before** `save()`. A
failure raises `serializers.ValidationError` → HTTP 400, and the row is never
written — the workspace cannot be locked out of mail by a bad config. `cloud` mode
skips the probe (nothing to validate). The probe has a short timeout
(`EMAIL_TIMEOUT`, 10 s) so a hung host can't wedge the request.

### 4. SSRF guards

- `bounce_webhook_url` and the custom SMTP `host` are validated through the
  integrations egress chokepoint `assert_url_allowed` (ADR-0049 §3) — reused, not
  reimplemented. For the SMTP host (no scheme) we validate `smtp://<host>:<port>`.
  A DNS-resolution failure at save is allowed through (host may resolve later),
  mirroring the webhook-URL validator; a resolved private/loopback/link-local/
  metadata address is rejected.
- The deliverability health check performs DNS TXT lookups on the *From* domain
  (SPF/DMARC records, DKIM selector). It resolves **names to TXT records only**, does
  not open connections to caller-controlled hosts, is `IsOrgAdmin`-gated, and is
  rate-limited by the existing throttle stack — bounded work, not an open SSRF relay.
  Uses `dnspython` (already transitively present via `cryptography`/email stack? — if
  not vendored, fall back to a stdlib-only SPF/DMARC presence check via
  `socket`-based TXT is not available, so the health surface degrades to
  "DNS lookup unavailable" rather than adding a dependency without the `dependency`
  gate). **Resolved at implementation:** use `dnspython` only if it is already a
  dependency; otherwise ship the health panel reading records the admin pastes /
  a best-effort check and file the live-DNS enhancement as follow-up.

### 5. Writable viewset (`notifications/views.py`)

Replace `EmailSettingsStatusView` with `WorkspaceEmailSettingsView`
(`GET`/`PUT`/`PATCH` at the existing `workspace/email-settings/` path),
`IsAuthenticated + IsOrgAdmin`. `GET` returns the singleton via
`WorkspaceEmailSettings.load()` serialized with the password **write-only**
(response carries `password_is_set: bool`, never the secret). A sibling
`workspace/email-settings/send-test/` action sends a test email to the requesting
admin's address through the resolved connection and returns success/failure. A
`workspace/email-settings/health/` action returns the SPF/DKIM/DMARC surface.
The read-only status fields (`configured_via`, effective transport) are preserved in
the GET payload for backward compatibility with the existing frontend hook.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Singleton in `notifications`** (chosen) | email + endpoint already live here; migration 0007 is local; one send seam | notifications app grows a config model |
| Model in `workspace` app | co-locates with `Workspace` singleton | splits the email surface across two apps; endpoint already served by notifications; cross-app import at send time |
| Store password in plaintext / Django settings only | no crypto | credential at rest unencrypted; can't edit without redeploy — the whole point of #712 |
| Native SendGrid/SES API backends now | provider features (templates, event webhooks) | new pip deps + `dependency` gate + more backend classes; SMTP relay covers send in 0.4 |
| Validate after persist (save then probe) | simpler serializer | a bad config is already written → workspace locked out of mail (the exact risk #712 must avoid) |

## Consequences

- **Easier:** self-hosters configure BYO SMTP/SendGrid/SES from the UI, rotate the
  password without redeploy, send a test email, and see deliverability posture. One
  resolver seam governs all outbound mail.
- **Harder:** the send path now has a DB read per drain batch (mitigated: resolve
  once per `_do_drain_emails` batch, not per message) and a decrypt. Two send shapes
  (model-configured vs settings-fallback) must both stay tested.
- **Risks:** (a) a wrong-but-openable transport (opens TCP but rejects mail) passes
  the probe — accepted; the test-email action is the human confirmation. (b) crypto
  key rotation invalidates stored passwords (Enterprise concern per ADR-0049 §6) —
  decrypt failure at send falls back to settings + logs, never crashes the drain.

## Implementation Notes
- **P3M layer:** Operations
- **Affected packages:** api (notifications), web
- **Migration required:** yes — `notifications/0007_workspaceemailsettings.py` (new
  table, additive, no backfill).
- **API changes:** yes — `workspace/email-settings/` gains `PUT`/`PATCH`; new
  `send-test/` and `health/` actions. Password write-only, never echoed.
- **OSS or Enterprise:** OSS. `grep -r trueppm_enterprise packages/` stays zero.

### Durable Execution
1. **Broker-down behaviour:** N/A for config writes (synchronous DB write, no async
   side effect). The **test-email** send is **synchronous** inside the request (an
   admin wants immediate pass/fail feedback) — no broker involved; a transport error
   returns 400/502 to the caller directly.
2. **Drain task:** Reuses the existing `drain_notification_emails` (ADR-0075/0085)
   unchanged — it now calls `resolve_email_connection()` per batch. No new drain.
3. **Orphan window:** N/A — no new async rows; the existing 5-min notification-email
   orphan window is unchanged.
4. **Service layer:** New `notifications/email_backend.py::resolve_email_connection`
   is the single connection-construction seam; `WorkspaceEmailSettings.load()` is the
   single read seam. No new Celery dispatch path.
5. **API response on best-effort dispatch:** N/A — the test-email send is synchronous
   (200 `{"sent": true}` / 502 `{"sent": false, "error": …}`), not queued.
6. **Outbox cleanup:** N/A — no outbox rows added.
7. **Idempotency:** Config PUT/PATCH is naturally idempotent (last write wins on the
   singleton row). Test-email is a manual admin action; re-sending is harmless.
8. **Dead-letter / failure handling:** A send failure in the drain follows the
   existing 3-attempt cap → `email_failed_at` path (unchanged). A decrypt failure at
   send logs and falls back to the settings connection so one corrupt row can't
   dead-letter the whole batch.
