# ADR-0048: Notes field normalization

## Status
Accepted

## Context

User-facing entities accumulated free-form "notes" fields organically as features
landed. By 0.1 the surface drifted into three different shapes:

| Entity            | Field                                | Shape                            |
| ----------------- | ------------------------------------ | -------------------------------- |
| `Task`            | `notes = TextField(blank=True)`      | TextField, no explicit default   |
| `ProjectResource` | `notes = CharField(max_length=500)`  | CharField (length-capped)        |
| `Risk`            | (none)                               | missing — PMs requested it       |
| `Sprint`          | (none)                               | missing — `goal` is distinct     |
| `SprintRetro`     | `notes = TextField(blank=True, default="")` | TextField, default ""     |

The frontend mirrored the inconsistency: `Task.notes` was `notes?: string`,
`ProjectResource.notes` was `notes: string`, and `Risk` / `ApiSprint` had no
`notes` field at all. This forced every consumer to defensively coalesce to
`""` and made it impossible to write generic "edit notes" UI.

## Decision

Normalize `notes` to `models.TextField(blank=True, default="")` on every
primary user-facing entity, and to required `notes: string` on the matching
TypeScript interface. Empty notes are stored as the empty string, never NULL.

### Backend

- `Task.notes` — already `TextField`; add `default=""` to match the canonical shape.
- `ProjectResource.notes` — change from `CharField(max_length=500)` to
  `TextField(blank=True, default="")`. PostgreSQL alters this as a metadata-only
  change; no table rewrite, no data conversion.
- `Risk.notes` — add `TextField(blank=True, default="")`. Expose on
  `RiskSerializer.Meta.fields`.
- `Sprint.notes` — add `TextField(blank=True, default="")`. Expose on
  `SprintSerializer.Meta.fields`. Editable past PLANNED state — notes are PM
  annotations, not commitments, and freezing them on activation would be
  surprising. (Compare `name`/`goal`/`start_date`/`finish_date` which remain
  frozen on activation.)
- `SprintRetro.notes` — already conforms; no change.

### Frontend

- `Task.notes` — change from `notes?: string` to required `notes: string` in
  `packages/web/src/types/index.ts`.
- `ApiSprint.notes` — add required `notes: string`.
- `Risk.notes` — add required `notes: string` in
  `packages/web/src/api/types.ts`.
- `ProjectResource.notes` — already `notes: string`; no change.

## Consequences

**Positive:**

- Frontend code can drop defensive `task.notes ?? ''` coalescing.
- Generic "edit notes" UI surfaces (e.g. the unified detail drawer in #303) work
  uniformly across Task, Risk, Sprint, and ProjectResource.
- Risks now have a place to record discussion context distinct from the formal
  `description` / `trigger` / `contingency` risk framework fields.
- Sprints can carry mid-sprint PM annotations without overloading `goal`.

**Negative / cost:**

- Existing test fixtures that built `Task` objects without `notes` need a one-time
  update to include `notes: ''`. Mechanical change; ~30 fixture sites.

**Migration safety:**

- All schema operations are additive or metadata-only. No `NOT NULL` without
  default; no data backfill required. The `CharField` → `TextField` change on
  `projectresource.notes` is a no-op rewrite in PostgreSQL — existing rows
  preserved verbatim.

## References

- Issue #294 — backend implementation
- Issue #295 — frontend type alignment
