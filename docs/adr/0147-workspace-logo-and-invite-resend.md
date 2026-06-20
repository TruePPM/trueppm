# ADR-0147: Workspace Logo Upload and Invite Resend

## Status
Accepted

## Context
Issue #969 ("wire remaining Workspace settings actions") tracks the last unimplemented
controls on the Workspace settings surface introduced by ADR-0087-b. Two remain:

1. **Resend a pending invite.** The Members page shows pending `WorkspaceInvite` rows
   with disabled "Resend" (per-row) and "Resend all" (bulk header) buttons, both stubbed
   to #969. Today an admin whose invite email bounced or was lost has no recovery path
   except revoke + re-create. The invite email outbox already exists (ADR-0087-b:
   `email_pending` / `email_sent_at` / `email_attempts`, drained by `drain_invite_emails`
   every 30 s); a resend is a re-queue into that same outbox.

2. **Upload a workspace logo.** The General page renders a hardcoded `"tS"` letter-mark
   and a disabled "Replace" button stubbed to #969. The `Workspace` singleton has no
   image field of any kind. The logo is **branding shown to everyone** — top bar,
   exports, and anonymous public share pages — not a sensitive per-user asset.

A third #969 item — the **holiday-calendar** stub — is deferred to its dependency #906
(composable calendars) and is explicitly out of scope here. CSV member export already
shipped.

**Forces:**
- The logo is user-uploaded content that will be **served publicly**. SVG can embed
  `<script>`; serving attacker-controlled SVG inline is a stored-XSS vector.
- Pillow is **not** an installed dependency (verified), and `ImageField` requires it.
  The established, security-reviewed upload precedent in this codebase (`TaskAttachment`,
  ADR-0075) deliberately uses `FileField` + magic-byte sniffing, **not** Pillow.
- Resend is an email-bomb / enumeration-adjacent surface — it must be RBAC-gated and
  rate-limited, and must not leak whether an email address is already a member.
- Workspace is a single-tenant, self-hosted singleton. A workspace logo is basic
  personalization (like the workspace name), **not** multi-tenant white-labeling.

**P3M layer:** Programs and Projects / Operations — instance-level configuration a PM/
admin needs to make the tool feel like theirs. Per the adoption lens (enterprise-check),
single-workspace personalization is an OSS adoption anchor; per-tenant theming, custom
domains, and white-label branding remain the Enterprise governance overlay.

## Decision

### 1. Invite resend

Add two endpoints, both `IsAuthenticated, IsWorkspaceAdmin` (same gate as create/revoke),
both carrying `IdempotencyMixin`:

- `POST /api/v1/workspace/invites/<uuid:id>/resend/` — resend one invite.
- `POST /api/v1/workspace/invites/resend-all/` — resend every eligible pending invite in
  one transaction (one throttle hit), returns `{"requeued": <n>}`.

**Eligibility:** only `PENDING` and `FAILED` invites are resendable. `ACCEPTED`,
`REVOKED`, and `EXPIRED` return `409 Conflict` with a generic message. An `EXPIRED`
invite is **not** silently revived — the admin revokes + re-creates (or we may later add
an explicit "renew" but that is out of scope).

**Re-queue mechanics** (inside `transaction.atomic()`, under `select_for_update()` on the
invite row):
- regenerate a fresh raw `email_token` = `secrets.token_urlsafe(32)` and recompute
  `token_hash` (the old token's hash is overwritten — any link in a previously-sent email
  stops working, which is the correct security posture for a re-issue);
- `expires_at = now + INVITE_TTL_DAYS` (7 days), `status = PENDING`,
  `email_pending = True`, `email_sent_at = None`, `email_failed_at = None`,
  `email_attempts = 0` — this is exactly the field shape the existing
  `_do_drain_invite_emails` filter selects on, so the row re-enters the **existing** drain
  with no new task.
- `transaction.on_commit()` makes a best-effort `drain_invite_emails.delay()` (broker
  errors swallowed); the 30 s Beat drain is the durability backstop.

**Idempotent no-op guard:** if the row is already `email_pending=True` (a send is in
flight in the outbox), resend is a no-op that returns `202` without regenerating the
token — this prevents a double-click or retry from re-issuing the token mid-flight and
bounds single-invite spam independent of the throttle.

**Throttle:** add `"invite_resend": "5/min"` to `DEFAULT_THROTTLE_RATES` and apply a
`ScopedRateThrottle` (scope `invite_resend`) to **both** resend views. The bulk endpoint
counts as one bucket hit regardless of how many invites it re-queues, so "Resend all" can
never email-bomb. 5/min/admin caps the per-recipient blast at 5 emails/min worst case.

**API response:** `202 {"queued": true}` for the single endpoint (best-effort outbox
dispatch — no synchronous task id), `202 {"requeued": <n>}` for bulk. The Members list is
refetched client-side to reflect the bumped `expires_at`.

### 2. Workspace logo

**SVG: dropped.** Accept **raster only** — `image/png` and `image/webp`. SVG is rejected
with `415`. This eliminates the stored-XSS class outright rather than betting on SVG
sanitization. (The General-page hint copy changes from "SVG or PNG" to "PNG or WebP".)

**Storage:** add `Workspace.logo = FileField(upload_to=_workspace_logo_upload_to,
blank=True, default="")` — **not** `ImageField` (avoids a new Pillow dependency and
matches the `TaskAttachment` precedent). `_workspace_logo_upload_to` returns
`workspace/logo/<uuid4>_<sanitized_filename>` so a replaced logo never overwrites the
previous file in-place (cache-busting + avoids storage races). Plus `logo_mime`
(CharField) recording the validated content type for the serve endpoint. Uses the
operator-configurable `STORAGES["default"]` backend (local FS in dev, S3/MinIO in prod) —
no new storage wiring.

**Validation** (serializer, reusing the attachment helpers' approach):
- content-type allowlist `{image/png, image/webp}`; **magic-byte sniff** of the leading
  bytes to confirm the payload really is PNG/WebP (rejects polyglots / spoofed
  extensions) → `415` on mismatch;
- size cap **2 MB** (logos are small; well under the 100 MB attachment cap) → `413`;
- minimum dimensions (256×256) are validated **client-side** as an advisory quality hint
  before upload — **not** a server hard-fail — because enforcing it server-side would
  require Pillow. Documented as a deliberate non-goal.

**Endpoints** (dedicated, multipart — kept off the JSON `PATCH /workspace/`):
- `POST /api/v1/workspace/logo/` (multipart, field `logo`) — `IsWorkspaceAdmin`. Replaces
  any existing logo; the previous file is deleted via `storage.delete()` in
  `transaction.on_commit()` to avoid orphaned blobs.
- `DELETE /api/v1/workspace/logo/` — `IsWorkspaceAdmin`. Clears the field and deletes the
  file; the UI falls back to the letter-mark.
- `GET /api/v1/workspace/logo/` — **`AllowAny`**. Streams the bytes with the stored
  `Content-Type`, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, and a
  long `Cache-Control` with the file’s `updated_at` as the cache key. `404` if unset.
  Public because the logo is non-sensitive branding that must render in `<img src>` (which
  cannot send the JWT Authorization header) and on anonymous public share pages.

**Serializer:** `WorkspaceSerializer` gains a read-only `logo_url` =
`/api/v1/workspace/logo/?v=<updated_at_epoch>` when a logo is set, else `null`. The top
bar and General page consume `logo_url`; absence → the existing letter-mark.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Logo: accept + sanitize SVG** | vector crispness at any DPI | SVG sanitization is a moving target (foreignObject, CSS, `<use href>`); one miss = stored XSS on a public endpoint. Rejected. |
| **Logo: `ImageField` + Pillow re-encode** | strongest (re-encode strips payloads, enforces dims server-side) | new heavyweight dependency + `dependency` gate; diverges from the audited `FileField`+magic-byte precedent. Deferred — can revisit if Pillow lands for another reason. |
| **Logo served via authenticated endpoint / signed URL** (attachment pattern) | matches sensitive-file handling | `<img>` can't send JWT; logo isn't sensitive; would also need to work on public share pages. Over-engineered for branding. |
| **Logo via `MEDIA_URL` direct storage URL** | no serve endpoint | requires MEDIA_URL/nginx config per deploy; inconsistent across FS vs S3; no auth/nosniff control. |
| **Resend: client loops the single endpoint for "Resend all"** | no new endpoint | N invites = N requests = trips the 5/min throttle at >5 pending; racy. A single bulk endpoint = one transaction, one throttle hit. |
| **Resend: new field `last_resent_at` + per-invite cooldown** | precise per-invite spam bound | extra column + migration; the per-admin 5/min throttle + idempotent-pending guard already bound the blast. Deferred as unnecessary. |
| **Resend: reuse `PATCH /workspace/invites/<id>/`** | no new route | overloads a non-existent detail-PATCH with side effects; `POST .../resend/` is the clearer verb-as-action. |

## Consequences

- **Easier:** admins recover lost invites without revoke+recreate; workspaces feel owned
  via a logo; both reuse existing infra (invite outbox + drain, `STORAGES`, scoped
  throttles) with minimal new surface.
- **Harder / risks:**
  - **Migration collision:** workspace `0009` collides with `feat/1169`'s
    `0009_workspace_methodology`. Whichever merges second renumbers to `0010` and repoints
    `dependencies`. Flagged for `/fix-mr`.
  - **Public logo endpoint** is a new unauthenticated route — mitigated by raster-only +
    magic-byte + nosniff + inline disposition + size cap; only Owner/Admin can write.
  - **Token re-issue on resend invalidates the prior email's link** — intended, but worth
    a line in the docs so an admin isn't surprised that an old link stops working.
  - **No server-side min-dimension enforcement** (client-side advisory only) — a tiny
    logo can be uploaded; cosmetic, not a security issue. Documented non-goal.

## Implementation Notes
- P3M layer: Programs and Projects / Operations
- Affected packages: api, web
- Migration required: **yes** — workspace `0009` (additive `logo` `FileField` +
  `logo_mime` `CharField` on the singleton; schema-only, no data migration; single row;
  `ALTER TABLE ADD COLUMN DEFAULT ''` is safe). ⚠ renumber-at-merge vs `feat/1169`.
- API changes: **yes** — `POST/DELETE/GET /api/v1/workspace/logo/`,
  `POST /api/v1/workspace/invites/<id>/resend/`,
  `POST /api/v1/workspace/invites/resend-all/`; `logo_url` added to `WorkspaceSerializer`;
  `invite_resend` throttle rate added. Regenerate `docs/api/openapi.json`.
- OSS or Enterprise: **OSS** (`grep -r trueppm_enterprise packages/` stays zero).

### Durable Execution
1. **Broker-down behaviour:** Resend uses the **existing transactional-invite-outbox**
   (ADR-0087-b). The resend handler flips the outbox columns inside the request
   transaction and makes a best-effort `drain_invite_emails.delay()` in
   `transaction.on_commit()`; a broker outage is invisible to the caller and recovered by
   the drain. Logo upload has **no async side effect** — synchronous file write, N/A.
2. **Drain task:** **Reuses** `workspace.drain_invite_emails` (every 30 s,
   `@idempotent_task(on_contention="skip")`). Semantics are identical to an initial send —
   a resend is the same row re-set to the same pending shape — so no new drain is added.
3. **Orphan window:** unchanged 5 min (`created_at < now-5m`) inherited from the existing
   drain filter. (The resend bumps `expires_at`, not `created_at`, so an old invite is
   immediately eligible — correct, since it is a deliberate admin action, not an
   in-flight commit.)
4. **Service layer:** new `workspace/services.py::resend_invite(invite)` and
   `resend_all_pending(workspace)` encapsulate the field re-set + `on_commit` dispatch so
   the view and any future caller share one code path. Logo write goes through
   `services.py::set_workspace_logo(file)` / `clear_workspace_logo()` for the old-file
   cleanup `on_commit`.
5. **API response on best-effort dispatch:** `202 {"queued": true}` (single) /
   `202 {"requeued": n}` (bulk) — no `task_id`. Logo endpoints are synchronous `200`.
6. **Outbox cleanup:** unchanged — `purge_stale_invites` (nightly, 30-day retention)
   already covers resent rows. No new purge.
7. **Idempotency:** resend keys on the invite PK under `select_for_update()` +
   status check; an already-`email_pending` row is a no-op (no token re-issue). Views
   carry `IdempotencyMixin` for `Idempotency-Key`. Logo upload is naturally idempotent
   (last write wins; old file deleted on commit).
8. **Dead-letter / failure handling:** unchanged — invite email retries up to
   `EMAIL_MAX_RETRIES=3`, then `email_pending=False`, `status=FAILED`. A `FAILED` invite is
   **resendable** (that is the recovery path this ADR adds). Logo upload failures surface
   synchronously to the caller (`4xx`/`5xx`); nothing is queued.
