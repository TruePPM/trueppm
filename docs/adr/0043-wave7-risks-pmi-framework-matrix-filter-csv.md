# ADR-0043: Wave 7 — Risk Register: PMI Framework Fields, Matrix Cell-Filter, and CSV Export

## Status
Accepted

## Context

The TruePPM risk register (ADR-0010) shipped with a minimal data model — title,
description, probability (1–5), impact (1–5), status, and computed severity. A VoC
panel (wave 7, avg 4.8/10) identified three concrete gaps:

1. **Insufficient PMI structure** — Sarah (PM, 8/10) needs response strategy, due date,
   trigger, and category fields to produce client-facing registers without reformatting.
   Marcus (PMO, 6/10) needs audit-ready fields. All other personas confirmed the fields
   are acceptable overhead when hidden behind an optional "Advanced" section.

2. **Matrix is display-only** — the 5×5 heatmap has no interaction. Clicking a cell
   should filter the risk list to that P×I coordinate. Pure frontend change; no API
   work required.

3. **No export path** — CSV is table stakes for client reporting (Sarah) and PM
   portfolio summaries (Marcus). Client-side generation avoids a new API endpoint and
   keeps the implementation self-contained in the browser.

**Naming constraint** (from VoC panel): `response_strategy: ACCEPTED` would collide
visually with `status: ACCEPTED` in the serializer and UI. The field is named `response`
with choice `ACCEPT` (not `ACCEPTED`) to keep the two vocabularies distinct.

**OSS/Enterprise boundary**: Risk register is a single-project feature (Programs and
Projects layer) — OSS only. Cross-project risk roll-up (wanted by Marcus and Janet)
is deferred to Enterprise.

## Decision

### 1. PMI fields on the Risk model (all nullable — existing risks unaffected)

Add to `Risk` in `packages/api/src/trueppm_api/apps/projects/models.py`:

```python
class RiskCategory(models.TextChoices):
    TECHNICAL        = "TECHNICAL",        "Technical"
    EXTERNAL         = "EXTERNAL",         "External"
    ORGANIZATIONAL   = "ORGANIZATIONAL",   "Organizational"
    PROJECT_MANAGEMENT = "PROJECT_MANAGEMENT", "Project Management"

class RiskResponse(models.TextChoices):
    AVOID    = "AVOID",    "Avoid"
    MITIGATE = "MITIGATE", "Mitigate"
    TRANSFER = "TRANSFER", "Transfer"
    ACCEPT   = "ACCEPT",   "Accept"

# on Risk:
category            = CharField(max_length=20, choices=RiskCategory.choices, null=True, blank=True)
response            = CharField(max_length=10, choices=RiskResponse.choices, null=True, blank=True)
mitigation_due_date = DateField(null=True, blank=True)
trigger             = TextField(blank=True, default="")
contingency         = TextField(blank=True, default="")
```

Migration `0023_risk_pmi_fields.py` — five `ALTER TABLE ADD COLUMN` with NULL defaults.
Safe on a live PostgreSQL table; no lock escalation for nullable additions.

All five fields are added to `RiskSerializer.Meta.fields` as optional writable fields.
`validate_mitigation_due_date` warns (non-blocking) when `status=MITIGATING` and date
is in the past — the overdue state is UI-computed, not API-enforced, to avoid blocking
saves when PMs update overdue risks.

### 2. RiskMatrix cell-click filter

`RiskMatrix` gains two new props:

```tsx
interface RiskMatrixProps {
  risks: Risk[];
  selectedCell?: { probability: number; impact: number } | null;
  onCellSelect?: (cell: { probability: number; impact: number } | null) => void;
}
```

Clicking a cell calls `onCellSelect({ probability, impact })`. Clicking the active
cell calls `onCellSelect(null)` (toggle). Pressing Escape while the matrix has focus
also clears selection.

`RiskRegisterView` holds `selectedCell` state and passes it down. When non-null, the
risk table filters to `risks.filter(r => r.probability === sel.prob && r.impact === sel.imp)`.
A "Clear filter" chip appears in the table header above the risk rows.

Keyboard: matrix cells are `<button type="button">`. Tab navigates between cells
(natural DOM order: P5I1 → P5I2 → … → P1I5). Enter = select/toggle. Escape = clear.

### 3. Client-side CSV export

`exportRisksToCSV(risks, projectSlug)` utility in `packages/web/src/features/risk/riskExport.ts`:

- Serialises all fields in column order: ID, Title, Status, Category, Response, P, I,
  Severity, Owner, Mitigation Due Date, Trigger, Contingency, Description
- RFC 4180 quoting: values containing commas, double-quotes, or newlines are
  double-quoted; embedded double-quotes are doubled
- Returns a `Blob` with `text/csv;charset=utf-8` and BOM prefix (`﻿`) for Excel
  compatibility
- Filename: `risks-{projectSlug}-{YYYY-MM-DD}.csv`

Button lives in the register toolbar (desktop) next to the Heatmap toggle. On mobile
it appears in a `···` overflow menu above the FAB. Downloading uses a temporary
`<a download>` element — no fetch, no API call.

### 4. Overdue mitigation badge

In the register table Status column: when `risk.status === 'MITIGATING'` and
`risk.mitigation_due_date` is non-null and in the past (compared to today ISO string),
render an amber `"Overdue"` badge inline. Row tint: `bg-semantic-at-risk/5`. This is
purely client-side derived state — no new API field.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Store PMI fields as a JSON `metadata` column | No migration per field; extensible | Breaks filtering, serializer validation, and OpenAPI schema generation |
| Separate `RiskPMIProfile` related model | Keeps Risk model lean; optional join | Extra JOIN on every list query; complicates serializer; over-engineering for 5 fields |
| Server-side CSV endpoint | Streams large files efficiently | Adds a new endpoint, auth surface, and test burden for a feature that works fine client-side at ≤1000 risks |
| Inline matrix filter via existing `/matrix/` API endpoint | Consistent with server-side filtering | API already returns count aggregates, not risk lists; adding per-cell filtering would require a new query param and API contract change for a purely UI concern |

## Consequences

**Easier:**
- PMs can produce client-ready risk registers without reformatting
- Risk categories enable future cross-project roll-up (Enterprise) without model changes
- Matrix interaction closes the "display-only heatmap" gap in every UX review to date

**Harder:**
- `RiskSerializer` grows by 5 fields — serializer tests need updating
- OpenAPI schema must be regenerated and committed (`scripts/export-openapi.sh`)
- Frontend `Risk` type is now partially optional — callers that assumed all fields
  present must handle `undefined` for new fields

**Risks:**
- `mitigation_due_date` overdue badge is computed client-side; if a user leaves the
  tab open past midnight, the badge won't update until refresh. Acceptable for v1.

## Implementation Notes

- **P3M layer**: Programs and Projects (single-project, OSS)
- **Affected packages**: api, web
- **Migration required**: yes — `0023_risk_pmi_fields.py`
- **API changes**: yes — five new optional fields on RiskSerializer; OpenAPI schema regeneration required
- **OSS or Enterprise**: OSS (`trueppm-suite`)

### Durable Execution

1. **Broker-down behaviour**: N/A — no async dispatch. All three changes are synchronous (model field writes, frontend state, client-side Blob generation).
2. **Drain task**: N/A — no new async work category introduced.
3. **Orphan window**: N/A — no outbox rows created.
4. **Service layer**: N/A — new fields are written directly through the existing `RiskViewSet` create/update path. No CPM recalculation triggered.
5. **API response on best-effort dispatch**: N/A — synchronous 200/201 responses unchanged.
6. **Outbox cleanup**: N/A — no outbox rows.
7. **Idempotency**: N/A — standard DRF create/update; idempotency guaranteed by the existing `short_id` unique constraint per project.
8. **Dead-letter / failure handling**: N/A — no background tasks. Validation errors return 400 in the normal DRF error envelope.
