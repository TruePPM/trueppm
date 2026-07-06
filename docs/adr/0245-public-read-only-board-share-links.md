# ADR-0245: Public read-only board share links (revocable token)

## Status
Proposed

## Context

Issue #283 asks for a **public, read-only, revocable URL** that lets a stakeholder
*without a TruePPM account* view a single project's Kanban board. The classic
"send the client a link to the board" ask — Jordan (PO) confirms customers request
it directly, and Sarah (PM) has the same need pointed at schedule (see #1486).

**P3M layer**: Programs and Projects → **OSS**. A single-board stakeholder view is
project-scoped collaboration, the core adoption unit. The classification test —
"does a PM/team need this to run their program?" — is yes. The Enterprise line is
*org-wide share governance*: an org-admin runtime policy that force-disables sharing
across all projects, an immutable SOC-2 audit trail of every access, and group→role
mapping. Those stay in `trueppm-enterprise`. The OSS MVP ships the capability plus a
**deploy-time instance kill switch** (an operator setting, not an org-admin UI).

**VoC panel** (avg 3.9/10 — narrow persona-fit for a comms feature, not a fatal
signal) surfaced four 🔴 design blockers that this ADR must resolve, plus 🟡 polish:

1. 🔴 **Data minimization** — a public serializer must hard-exclude comments/notes/
   attachments and default-hide assignee identity; no cost/budget fields (none exist
   on `Task` yet anyway).
2. 🔴 **Instance kill switch** — Marcus (PMO/compliance) and Omar (operator) both
   hard-block on a novel unauthenticated egress surface with no org-wide off lever.
3. 🔴 **Access + create/revoke attribution** — who created/revoked, and access
   metering (count + last-accessed).
4. 🔴 **Team awareness** — the team must be able to learn a public link is live
   (Morgan: publishing assignee names without consent = a surveillance window).

Plus 🟡: revoked → `410 Gone` (not raw 404); empty-board state; anon rate limiting;
`ETag`/`Cache-Control` on the snapshot; bounded payload.

**Forward-compat with #1486** (`needs-design`, "tokenized share links for schedule
**and** board"): design the model with a `content_kind` discriminator so #1486 adds
`content_kind="schedule"` and a sibling endpoint, rather than reworking the schema.

**Established patterns to reuse** (research): the `ApiToken`/`WorkspaceInvite` token
lineage (ADR-0068/0087/0214) — `secrets.token_urlsafe(32)`, store only the SHA-256
`token_hash` (unique), keep an 8–12-char `token_prefix` for non-revealing audit
display, soft-revoke via `revoked_at`. Public access follows `InviteAcceptView`
(`AllowAny`, `authentication_classes=[]`, dedicated `AnonRateThrottle`,
enumeration-safe generic errors). Everything routes under `/api/v1/`.

## Decision

Add a single **`ShareLink`** model (generic name, `content_kind` discriminator) in
the `projects` app, a management API scoped to project **Admin+**, and a **public
`AllowAny` read-only** board endpoint whose serializer emits only a whitelisted,
minimized field set.

### Model — `ShareLink` (plain `models.Model`, not `VersionedModel`)

A share link is a server-side credential/config, never synced to the mobile offline
delta — so it is a plain model with a UUID pk, matching `ApiToken` /
`WorkspaceInvite` / `ProjectExportJob`.

| Field | Type | Notes |
|---|---|---|
| `id` | `UUIDField(primary_key, default=uuid.uuid4)` | convention |
| `project` | `FK(Project, CASCADE, related_name="share_links")` | scope |
| `content_kind` | `CharField(choices=ShareContentKind, default=BOARD)` | forward-compat (#1486 adds `SCHEDULE`) |
| `token_hash` | `CharField(max_length=64, unique=True)` | SHA-256 of raw; raw never stored |
| `token_prefix` | `CharField(max_length=12, db_index=True)` | first chars, audit display only |
| `label` | `CharField(max_length=120, blank=True)` | optional ("Client X board") |
| `show_assignees` | `BooleanField(default=False)` | 🔴 assignees default-HIDDEN |
| `created_by` | `FK(User, SET_NULL, null=True, related_name="+")` | attribution |
| `created_at` | `DateTimeField(auto_now_add=True)` | |
| `revoked_at` | `DateTimeField(null=True, db_index=True)` | soft-revoke; null = active |
| `revoked_by` | `FK(User, SET_NULL, null=True, related_name="+")` | attribution |
| `access_count` | `PositiveIntegerField(default=0)` | metering |
| `last_accessed_at` | `DateTimeField(null=True)` | metering |

`Meta`: `indexes=[Index(fields=["project", "revoked_at"])]` (listing active links per
project); `db_table="projects_sharelink"`. `is_active` is a property: `revoked_at is
None`. Enum `ShareContentKind(TextChoices)` ships with `BOARD = "board"` only;
`SCHEDULE` is added by #1486.

Migration: single additive `CreateModel` (next number **0110**) — no `RunSQL`, no
destructive op, trivially reversible on rollback (Omar 🟢).

### Token lifecycle

- **Mint**: `raw = secrets.token_urlsafe(32)` (≈256 bits — non-enumerable). Store
  `token_hash = sha256(raw).hexdigest()`, `token_prefix = raw[:12]`. The **raw token
  is returned exactly once** in the create response and never retrievable again.
- **Lookup** (public GET): `sha256(url_token).hexdigest()` → `ShareLink.objects
  .filter(token_hash=…, content_kind=BOARD)` — single O(1) unique-index hit.
- **Revoke**: set `revoked_at`/`revoked_by` (soft — the row survives for attribution).

### Endpoints

**Management** (authenticated, project **Admin+**) — a `ShareLinkViewSet` following
the board-endpoint precedent (resolves `Project`, `check_object_permissions`,
`IsProjectAdmin`):
- `GET  /api/v1/projects/{project_id}/share-links/` — list this project's links
  (never emits `token_hash`; shows `token_prefix`, `label`, `show_assignees`,
  `created_by`, `created_at`, `revoked_at`, `access_count`, `last_accessed_at`,
  and a reconstructed `share_url` **only** on the create response).
- `POST /api/v1/projects/{project_id}/share-links/` → `201` `{... , "token": "<raw>",
  "share_url": "<origin>/share/board/<raw>"}` (raw shown once). Body: `label?`,
  `show_assignees?` (default false). Throttle scope `share_mint`.
- `POST /api/v1/projects/{project_id}/share-links/{id}/revoke/` → `200` (idempotent —
  re-revoke is a no-op).

**Public** (unauthenticated, read-only) — a GET-only `APIView` mirroring
`InviteAcceptView` (`permission_classes=[AllowAny]`, `authentication_classes=[]`,
`http_method_names=["get"]`, `throttle_classes=[ShareLinkAccessThrottle]`):
- `GET /api/v1/share/board/{token}/` → `200` minimized board snapshot, or `410`
  (revoked), `404` (unknown/invalid/`content_kind`≠board/kill-switch off).

### Public board serializer — minimized, whitelisted

Response shape (bounded):

```json
{
  "content_kind": "board",
  "project": { "name": "…", "short_id": "…" },
  "columns": [
    { "key": "in_progress", "label": "In Progress",
      "cards": [ { "short_id": "RIV-12", "name": "…", "status": "in_progress",
                   "is_milestone": false, "percent_complete": 40,
                   "due_date": "2026-08-01", "assignee": null } ] }
  ],
  "show_assignees": false,
  "generated_at": "…",
  "truncated": false
}
```

- **Card fields emitted** (safe minimum): `short_id`, `name`, `status`,
  `is_milestone`, `percent_complete`, `due_date` (from `planned_finish`/`early_finish`).
- **`assignee`**: emitted as a display name **only when `show_assignees=True`**;
  otherwise `null`. Never emits email/user-id/avatar.
- **Hard-excluded, never serialized**: comments, `notes`/`TaskNote`, attachments,
  `blocked_reason`/blocker detail, `story_points`, `business_value`,
  reach/impact/confidence/effort, priority_rank, `assignee` PII. (Comments/notes/
  attachments are separate models — exclusion is structural, not a filter that can
  regress.)
- **Columns**: derived from `TaskStatus`, honoring the project's `BoardColumnConfig`
  labels/order when present. Backlog column omitted from the shared board.
- **Bounded**: excludes soft-deleted tasks; caps at `SHARE_BOARD_MAX_CARDS` (default
  1000) and sets `"truncated": true` if exceeded (no silent cap).

### Instance kill switch

`settings.TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED = env.bool(
"TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED", default=True)`, surfaced as a Helm
`values.yaml` key wired to the env var. When **False**:
- mint endpoint → `403` (`{"detail": "Public board sharing is disabled on this
  instance."}`),
- public access endpoint → `404` (uniform — hides feature existence, retroactively
  disables every existing link).

Default `True` is safe because *no data is exposed until an Owner/Admin explicitly
mints a link* — exposure is opt-in per link; the switch is the org-wide off lever the
operator/PMO demanded.

### "Public sharing" policy integration (ADR-0135)

TruePPM already ships an inheritable **workspace → program → project `public_sharing`
policy** (ADR-0135 / #978), surfaced on the General settings page as *"Public sharing —
Anyone with the link can view, no sign-in required."* Its OSS default is **off**
(`Workspace.public_sharing = False`), so board sharing is opt-in at the admin level too,
not just per link. This feature **layers on top of** that policy — both the operator
kill switch *and* the effective `public_sharing` policy must be on:

- **Mint** (`POST`) resolves `resolve_effective_sharing(project, "public_sharing")` and
  returns `403` ("Public sharing is turned off for this project.") when off — so an
  admin can't mint a public link on a project (or under a program/workspace, or an
  Enterprise org-wide lock) where public sharing is disabled.
- **Public serve** (`GET`) re-checks the same policy and returns a uniform `404` when
  off — so turning "Public sharing" off *after* links exist immediately stops every one
  of the project's links from resolving, exactly like the instance kill switch.

This keeps the "Public sharing: Off means off" guarantee intact rather than introducing
a second, unpoliced public-egress path.

### Rate limiting & caching

- `ShareLinkAccessThrottle(AnonRateThrottle)`, `scope="share_access"`, default
  `60/min` (env-configurable) — caps scraping/abuse of the unauthenticated endpoint.
- `ShareLinkMintThrottle`, `scope="share_mint"`, default `20/min`.
- Public response sets a weak `ETag` (hash of the snapshot) + `Cache-Control:
  private, max-age=30` so a viewer's own browser doesn't re-pull the full board every
  hit (Nadia 🟡), while a `304` short-circuits the transfer. `private` (not `public`)
  is deliberate: a revoked link must stop resolving promptly, so a shared/CDN cache
  must never serve a since-revoked board to a *different* viewer (security-review 🟡).

### Access metering (non-blocking)

On a successful public GET: `ShareLink.objects.filter(pk=…).update(
access_count=F("access_count") + 1, last_accessed_at=now())` — a single atomic
UPDATE (the `ApiToken.last_used_at` pattern), no `.save()`, no history row, safe under
retry. A double-count from a client retry is acceptable for a meter.

### Team awareness (MVP stance)

Active links are listed in **Project Settings → Sharing**, visible to every project
Admin, with `created_by` attribution and access metering. Because assignee identity is
**default-hidden**, no individual is exposed without an explicit Admin opt-in. A
team-wide "a public link is active" banner/notification for non-admin members is
deferred to a follow-up (frontend-only). This resolves Morgan's 🔴 at the data level
(nobody's name leaks by default) while deferring the visibility affordance.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. New `ShareLink` model + `content_kind` (chosen)** | Forward-compat with #1486 (schedule) with no rework; clean minimized serializer; matches token lineage | One more model |
| B. Extend `ApiToken` with a `share:board` scope (ADR-0214 style) | Single token table, one hot-path lookup | `ApiToken` is an *authenticated actor* credential with a `scope XOR` constraint and audit semantics; a public no-identity read link is a different animal — overloading it muddies both; no `show_assignees`/board-view fields |
| C. Stateless signed token (like password-reset, ADR-0209) | No table | **Not revocable** by construction — the #283 hard requirement — and can't meter access. Rejected for the same reason 0209 notes |
| D. Board-only `BoardShareLink` (no discriminator) | Slightly simpler | Forces #1486 to add a second model or rename — the rework this ADR exists to avoid |
| E. Public route outside `/api/v1/` | "Feels" more public | No precedent; every existing AllowAny endpoint lives in-prefix; publicness = `AllowAny`, not routing |

## Consequences

- **Easier**: #1486 becomes additive (`content_kind="schedule"` + a sibling public
  serializer/endpoint reusing the same model, throttle, kill switch, and web shell).
- **Easier**: the security surface is small and auditable — one unauthenticated GET,
  one minimized serializer, one kill switch, one throttle.
- **Harder**: the public board view cannot reuse the authed `BoardView` (apiClient/
  Zustand/WebSocket coupled) — a lightweight standalone public page is required
  (mirrors `InviteAcceptPage`: bare `axios`, no store, no WS).
- **Risk**: an unauthenticated egress surface. Mitigated by non-enumerable tokens,
  the kill switch, anon throttling, default-hidden assignees, and hard field
  exclusion. Residual: a leaked URL exposes the minimized board until revoked — the
  accepted trade of any share-by-link feature; revocation + metering + (deferred) TTL
  bound it.
- **Boundary**: immutable SOC-2 access audit and org-admin runtime governance are
  **Enterprise** — the OSS MVP intentionally stops at row attribution + metering +
  operator kill switch.

## Implementation Notes

- **P3M layer**: Programs and Projects
- **Affected packages**: `api` (model/migration/serializer/views/urls/settings/
  throttle), `web` (settings sharing section + public `/share/board/:token` page),
  `helm` (kill-switch value), `website`/`docs` (feature + admin + api docs)
- **Migration required**: yes — `projects/0110_sharelink.py`, single additive
  `CreateModel`, reversible
- **API changes**: yes — 3 authed management routes + 1 public read route; OpenAPI
  regenerated
- **OSS or Enterprise**: **OSS** (`trueppm-suite`)

### Durable Execution
1. **Broker-down behaviour**: **N/A** — create/revoke/access have zero async side
   effects; access metering is a synchronous single-row `UPDATE`, no Celery, no
   `.delay()`, so there is no dispatch gap.
2. **Drain task**: **N/A** — no async work category is introduced.
3. **Orphan window**: **N/A** — no outbox rows, no `on_commit` dispatch.
4. **Service layer**: new `apps/projects/share_services.py` —
   `mint_share_link(project, user, *, label, show_assignees) -> (ShareLink, raw)`,
   `resolve_public_token(token, content_kind) -> ShareLink | None`,
   `serialize_public_board(link) -> dict`. Keeps token hashing + minimization in one
   auditable place.
5. **API response on best-effort dispatch**: **N/A** — mint is synchronous (`201`
   with the raw token once); nothing is queued.
6. **Outbox cleanup**: **N/A**.
7. **Idempotency**: mint is intentionally non-idempotent (each POST is a new link);
   the viewset's `IdempotencyMixin` dedups client retries. Revoke is idempotent
   (`revoked_at` set-once; re-revoke is a no-op). Access-count `F()+1` is retry-safe
   (a rare double-count on a meter is acceptable).
8. **Dead-letter / failure handling**: **N/A** — no async/queue path.

### Broadcast decision (pre-empting broadcast-check)
Creating/revoking a share link does **not** call `broadcast_board_event()`. A share
link is Project-Settings configuration, not board *content* (no card/column mutation),
and is authored at admin frequency; the settings list refetches on mount. Broadcasting
would add a fanout path for a non-collaborative resource. Deliberately omitted — not
an oversight. (If a future "active link" banner needs live push, it can broadcast a
dedicated settings event then.)
