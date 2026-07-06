# ADR-0265: Tokenized public read-only schedule share links

## Status

Accepted

## Context

Issue #1486 asks for a **public, read-only, revocable link** that lets a
stakeholder *without a TruePPM account* view a single project's **schedule /
Gantt** — the same "send the client a link" affordance #283 (ADR-0245) shipped for
the Kanban board, pointed at the timeline instead. ADR-0245 explicitly anticipated
this: it added a `content_kind` discriminator to `ShareLink` and reserved
`SCHEDULE` for #1486, noting the endpoint, throttle, kill switch, and web shell
would all be shared.

This ADR is therefore **not a new subsystem** — it is the second `content_kind` on
an already-threat-modeled surface, plus two additive capabilities the #1486 design
handoff introduced: **link expiry** and a **toolbar "Share this view" dialog**.

**P3M layer / boundary**: OSS — identical to ADR-0245. A single-project stakeholder
schedule view is project-scoped collaboration (the adoption unit). Org-wide share
governance, SOC-2 access audit, and group→role mapping remain Enterprise.

## Decision

### Model

No new model. `ShareContentKind` gains `SCHEDULE`; `ShareLink` gains one nullable
field, `expires_at` (a single additive migration). `is_active` becomes
`revoked_at is None and not is_expired` — backward-compatible, since a link with no
`expires_at` is active iff not revoked, exactly as in #283.

### Discriminator firewall (the core security property)

A board token must never resolve a schedule view or vice-versa. This is enforced
**at the query layer, already**: `resolve_share_link(token, content_kind)` filters
`content_kind=` in SQL, so a board row resolved as `SCHEDULE` returns `None` → a
uniform 404. The URL path segment (`/board/` vs `/schedule/`) is *presentational*;
authorization is bound to the `(token_hash, content_kind)` tuple in the database,
not the route. A dedicated pytest proves both directions 404.

### Unauthenticated read-only schedule projection

`serialize_public_schedule(link)` mirrors `serialize_public_board`: whitelisted,
bounded (`SHARE_SCHEDULE_MAX_TASKS`, default 1000, `truncated` flag), soft-delete
excluded, `select_related("assignee")`, dependencies fetched in **one** query and
mapped to short_ids (no N+1). Emitted per task: `short_id`, `name`, `wbs_path`,
`duration`, `planned_start`, `early_start`, `early_finish`, `is_milestone`,
`is_critical`, `percent_complete`, `status`, and `assignee` **only** when the #283
`show_assignees` opt-in is on. Dependency edges carry `{predecessor_short_id,
successor_short_id, dep_type, lag}` — short_ids only, never task UUIDs.

**Hard-excluded by omission** (structural, not a regressible filter): `late_start`,
`late_finish`, `total_float`, `free_float`, all PERT/Monte-Carlo durations and
percentiles, baseline overlay, SPI/variance, resource/cost, `priority_rank`, blocker
fields, comments, notes, attachments. A schedule carries more internal intelligence
(slack, risk) than a board, so this exclusion list is the security-critical artifact
of #1486.

### Link expiry

`expires_at` (nullable) auto-expires a link. Once past, the public endpoint returns
**410** — the same "intentionally gone" signal as revocation, so the recipient asks
the owner for a new link rather than retrying a mistype (a 404). The mint serializer
rejects a past `expires_at` (400). The web classifier collapses revoked + expired
into one "no longer active" 410 message.

### Endpoints

- **Public** (new): `GET /api/v1/share/schedule/{token}/` — `AllowAny`,
  `authentication_classes=[]`, the shared anon throttle, and the identical serve
  envelope as board (kill switch → 404, revoked → 410, expired → 410, ADR-0135 off
  → 404, weak `ETag` + `private, max-age=30`). Board and schedule both delegate to a
  single `_serve_public_share(request, token, content_kind, serialize)` helper so
  the security envelope cannot drift between the two thin sibling views.
- **Management** (extended): the existing `ProjectShareLinkListCreateView` mint
  accepts `content_kind` (default `board`) and `expires_at`; `share_path` is derived
  as `/share/{content_kind}/{token}`. One Admin+ surface mints both kinds.

### RBAC

Unchanged from ADR-0245: minting is project **Admin+**, blocked on archived
projects, gated by both the instance kill switch and the effective ADR-0135
`public_sharing` policy. Toolbar Share affordances (Schedule + Board) render only
for Admin+; the dialog surfaces the server's verbatim 403 detail if sharing is off.

### Kill switch

One lever governs both kinds. `TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED` (env var name
kept for #283 back-compat) turns off minting (403) and every public share endpoint
(uniform 404, retroactively disabling existing links). A second switch was rejected
as an operational footgun — a deployment could otherwise leak schedules while "board
sharing" reads off. The `WorkspaceGeneralPage` "Public sharing" toggle now shows the
downstream cascade (toolbars, settings, public pages) so the effect is legible.

### Referrer leakage

The token is a capability URL. Both public share pages inject
`<meta name="referrer" content="no-referrer">` for their lifetime (a shared
`useNoReferrer` hook — this also retroactively hardens the #283 board page), and the
public responses carry `Referrer-Policy: no-referrer`. This is the one genuinely new
open finding from the threat-model delta; #283 never addressed it.

## Alternatives considered

| Option | Verdict |
|---|---|
| **Extend `ShareContentKind` + sibling endpoint + shared serve helper (chosen)** | The path ADR-0245 pre-committed to; additive, discriminator already enforced, no envelope drift. |
| Parametrize one `PublicShareView` over a URL kwarg | A per-kind serializer switch inside one view muddies OpenAPI response docs; two thin views over a shared helper is clearer. |
| Second kill switch for schedule | Operational footgun (two levers, one egress surface). Rejected. |
| Expose float / Monte-Carlo on the public schedule | Publishes internal risk posture with no stakeholder need. Rejected on data-minimization. |

## Consequences

- The web reuses the ADR-0245 public shell pattern (a new `PublicScheduleSharePage`
  rendering a lightweight non-interactive bar timeline — **not** the authenticated
  canvas Gantt engine, which is Zustand/WASM/apiClient-coupled).
- A single `ShareViewDialog` (create / reveal / manage, `content_kind`-aware, with
  the expiry control) is launched from the Schedule and Board toolbars and from
  Project Settings → Sharing.
- New surface delta is small and auditable: one enum value, one nullable field + a
  one-op migration, one projection function, one sibling view, one public page, one
  dialog, and settings/toolbar wiring.
- **Residual risk**: a leaked schedule URL exposes the minimized timeline until
  revoked or expired — the accepted trade of any share-by-link feature, bounded by
  non-enumerable 256-bit tokens, the shared kill switch, the anon throttle,
  default-hidden assignees, hard field exclusion, expiry, revocation + metering, and
  `no-referrer`.
