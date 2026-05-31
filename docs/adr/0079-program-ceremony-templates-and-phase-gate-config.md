# ADR-0079: Program Ceremony Templates and Phase Gate Config

## Status
Accepted (2026-05-31) — implemented in #528

## Context

The Program Settings → Cadence page currently renders a hardcoded list of five
ceremony templates (Program sync, Steering committee, Phase gate review, Risk
review, Resource sync). Issue #528 requires wiring this page to a real API so a
Program Admin can configure their own recurring ceremonies plus a phase-gate
calendar invite template.

A VoC panel (avg 3.9/10) surfaced three constraints that the implementation must
honour even though they are not in the issue body:

1. **Program-vs-sprint boundary must be enforced as code, not docs** — Alex (5/10
   🟡) and Morgan (7/10 🟡) both flagged the risk that a Program Admin will
   create a "Sprint Planning" or "Daily Scrum" template at the program level,
   silently absorbing Scrum events into PMO surface. The API must reject the
   reserved Scrum vocabulary with a clear error.
2. **`enabled` toggle is ADMIN-only** — Morgan's hard NO is "PM-level RBAC can
   change sprint scope without team consent." Applied to this feature: a
   `MEMBER`-role user must not be able to silently re-enable a ceremony the team
   disabled. The existing `IsProgramAdmin` gate handles this — make sure the
   inline toggle uses it.
3. **Audit trail via `HistoricalRecords`** — toggles to `enabled` must be
   attributable. Reuse the existing `django-simple-history` pattern that already
   covers `Program`, `Project`, `Task`, `Sprint`.

Everything else from the VoC (mobile, calendar fan-out, cross-program bulk
apply, Janet's digest integration, ceremony completion signals) is out of scope
for #528 and is captured in §Out-of-scope follow-ups.

## Decision

Introduce **two new OSS models** in `apps/projects/`, both inheriting
`VersionedModel` (UUID PK, `server_version`, soft delete) and `HistoricalRecords`:

1. **`CeremonyTemplate`** — `program` FK, `name`, `cadence_type`
   (weekly/biweekly/monthly/on_milestone), `cadence_day`, `cadence_time`,
   `duration_minutes`, `owner_role`, `enabled`, `created_by`. Unique on
   `(program, name)`. Full CRUD via REST.
2. **`PhaseGateConfig`** — `OneToOneField(Program)`, `invite_template` (TextField),
   `enabled` (BooleanField). Lazy-created on first GET via `get_or_create`. Only
   GET + PATCH; no POST/DELETE (singleton).

URL routing uses an explicit `CeremonyTemplateViewSet` registered with manual
urlpatterns under `apps/projects/urls.py` (matching the program-scoped pattern
established by #523 and #525 without introducing `drf-nested-routers`):

```
GET    /api/v1/programs/<uuid:program_id>/ceremonies/
POST   /api/v1/programs/<uuid:program_id>/ceremonies/
GET    /api/v1/programs/<uuid:program_id>/ceremonies/<uuid:pk>/
PATCH  /api/v1/programs/<uuid:program_id>/ceremonies/<uuid:pk>/
DELETE /api/v1/programs/<uuid:program_id>/ceremonies/<uuid:pk>/
GET    /api/v1/programs/<uuid:program_id>/phase-gate-config/
PATCH  /api/v1/programs/<uuid:program_id>/phase-gate-config/
```

`owner_role` is a free-form `CharField(max_length=64)` — descriptive label
("Program Manager", "Risk Lead", "Scheduler"), **not** the access-control `Role`
enum. The Role enum governs RBAC; this field is "who chairs the meeting" — a
different concept the VoC reviewers (David) explicitly called out as distinct
from allocation. Keeping it free-form leaves room for custom organizational
titles without bleeding into the access-control layer.

Serializer-level validation rejects the **Scrum reserved-name list** with
HTTP 400 and a message pointing the user at sprint settings:

```python
RESERVED_SCRUM_NAMES = {
    "sprint planning", "sprint review", "sprint retrospective", "retrospective",
    "retro", "daily scrum", "standup", "daily standup", "scrum of scrums",
}
```

Match is case-insensitive on the trimmed value. Identical UX-side validation
fires in the modal to prevent the round trip.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. PhaseGateConfig as JSON column on Program** | Fewest moving parts, fits #523 pattern | Bloats Program with config-only fields; future calendar integration adds more nullable JSON; harder to add audit/history selectively |
| **B. PhaseGateConfig as separate 1:1 model** ✅ | Clean separation; stable extension point for future calendar wiring; can carry its own `HistoricalRecords` later | One extra migration; one extra `get_or_create` round-trip on first read |
| **C. `@action` methods on ProgramViewSet** | Matches `/programs/{id}/projects/` and `/programs/{id}/integrations-summary/` precedent | Awkward for true CRUD with item URLs (`/ceremonies/{id}/`); each verb becomes a separate `@action` |
| **D. Separate `CeremonyTemplateViewSet` with explicit urlpatterns** ✅ | Clean DRF `ModelViewSet`; `program_id` resolved from `self.kwargs`; no new dependency | Slightly more boilerplate than `@action` |
| **E. `owner_role` reuses the `Role` enum (integer)** | Type-safe; mirrors existing RBAC fields | Confuses chair-of-meeting with access-control role; David flagged this distinction; Scrum Master / Risk Lead don't map to OSS Role values |
| **F. `owner_role` is `CharField`** ✅ | Matches existing stub copy ("Program Manager", "Risk Lead", "Scheduler"); flexibility for org-specific titles | Loses type safety; could drift to free-for-all without UI guidance |

Chosen: **B + D + F**.

## Consequences

**Easier:**
- Program Admins can replace the disabled stub with their real ceremony cadence
- The five hardcoded ceremonies become a one-shot seed (or — preferred — no seed
  at all; a clean program starts with an empty table, and the empty state
  invites the user to add their first ceremony)
- Future calendar invite generation (out of scope) has a clear data source:
  enabled `CeremonyTemplate` rows + `PhaseGateConfig.invite_template`

**Harder:**
- Two new migrations (`CeremonyTemplate`, `PhaseGateConfig`) on a settled
  `apps/projects` schema (already at 0040)
- The "PMO sees ceremony skipped → flag at-risk" loop Janet wanted (VoC) is now
  *possible* but still requires a separate completion-tracking layer

**Risks:**
- A Program Admin could circumvent the Scrum reserved-name validation by using
  variants (e.g. "Sprint-Planning" with a hyphen). The list is a guard rail, not
  a forcefield; if abuse becomes a real pattern, harden later with stemming/fuzzy
  match. Acceptable for 0.2.
- `CharField` `owner_role` may drift to inconsistent labels across programs.
  Mitigated in UI with a `<datalist>` of common roles seeded from the stub copy.

## Implementation Notes

- P3M layer: **Programs and Projects** (single-program settings)
- Affected packages: `api` (models + serializers + views + urls + migration);
  `web` (replace stub, add modal, wire hooks)
- Migration required: **yes** — `0041_ceremony_template_and_phase_gate_config.py`,
  depends on `("projects", "0040_program_general_fields")`. Both tables ship in
  one migration; no NOT NULL columns without defaults, no destructive ops.
- API changes: **yes** (additive — seven new endpoints as listed above; OpenAPI
  schema regen required)
- OSS or Enterprise: **OSS** (Apache 2.0). Program is OSS (ADR-0070); program
  settings are OSS by extension. No cross-program rollup or aggregation here.
- Permission matrix:

| Action | Permission |
|---|---|
| GET list / retrieve ceremony / GET phase-gate | `IsAuthenticated` + `IsProgramMember` (role ≥ MEMBER) |
| POST / PATCH / DELETE ceremony | `IsAuthenticated` + `IsProgramAdmin` (role ≥ ADMIN) |
| PATCH `enabled` (inline toggle) | `IsAuthenticated` + `IsProgramAdmin` |
| PATCH phase-gate-config | `IsAuthenticated` + `IsProgramAdmin` |

- WebSocket broadcasts: **none**. Program mutations currently fire no
  `broadcast_board_event` (project-scoped only; no `broadcast_program_event`
  helper exists). TanStack Query invalidation on mutation is the established
  pattern. ADR-0070 noted "program-scoped broadcast" as a future follow-up; we
  do not add it here.
- Audit: `HistoricalRecords` on `CeremonyTemplate` (default excludes
  `server_version`/`deleted_version` via `_HISTORY_EXCLUDED_BASE`). Not on
  `PhaseGateConfig` v1 — the invite-template body is the only meaningful
  attribute, and add-it-later is cheap.

### Durable Execution
1. Broker-down behaviour: **N/A** — feature is synchronous CRUD on settings
   rows. The issue body explicitly states ceremony templates do not generate
   calendar invite instances themselves; that downstream work is out of scope.
2. Drain task: N/A.
3. Orphan window: N/A.
4. Service layer: N/A — viewset `perform_create` / `perform_update` sets
   `created_by` and lets `VersionedModel.save` handle `server_version`. No
   `services.py` function needed; the path is shorter than the rule's
   threshold.
5. API response on best-effort dispatch: synchronous 200/201/204.
6. Outbox cleanup: N/A.
7. Idempotency: GET/PATCH/DELETE inherently idempotent. POST collisions on the
   `(program, name)` unique constraint return HTTP 400 with a field-level
   message — not a 500.
8. Dead-letter / failure handling: N/A — no async work.

## Out-of-scope follow-ups

The VoC surfaced several pain points the architect declines to fold into #528.
Open these as new issues so the trail is visible:

1. **Calendar invite generation** (`.ics` export, outbound email/calendar
   integration). Touches ADR-0049 extension points; OSS-side surface, Enterprise
   may add a richer integration channel.
2. **Phase-gate-config wired to milestone-save signal** so an actual invite
   fires when a phase boundary milestone is saved. Out of scope here; the field
   is config-only for v1.
3. **Mobile UI for ceremony management** (Sarah's offline gap). Defer to mobile
   epic — settings configuration is not a high mobile priority anyway.
4. **Ceremony completion / no-show tracking → risk digest** (Janet's 10/10
   anchor). The aggregation across programs is **Enterprise** scope — file in
   `trueppm-enterprise`. The per-program completion record (if added) is OSS.
5. **Bulk apply / template inheritance across programs** (Marcus, Sarah). Could
   live in OSS as a "copy from program" import action; not in #528.
6. **`owner_role` typeahead / shared role catalog** so labels don't drift across
   programs. Cheap follow-up; depends on whether org-level "common roles"
   actually emerges as a pattern.
