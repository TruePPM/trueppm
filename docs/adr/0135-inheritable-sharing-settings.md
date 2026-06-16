# ADR-0135: Inheritable Sharing Settings (public_sharing, allow_guests) with Per-Scope Override

## Status
Accepted

## Context
`public_sharing` and `allow_guests` exist only on the `Workspace` singleton
(`workspace/models.py:153-154`). `Program` and `Project` have no equivalent field, so a
PM looking at Program- or Project-level General settings sees the toggle silently absent
at those scopes — the setting appears workspace-global with no way to scope it (#978).

Three things are conflated in the issue:
1. The two sharing booleans are not scope-overridable.
2. There is no server-resolved "effective" value or "what would I inherit" indicator.
3. The broader settings surface is inconsistent about which settings exist at which scope.

TruePPM already solved (1) and (2) for the iteration-container label in ADR-0116/#1106:
nullable override columns on `Program`/`Project` (`null` = inherit), a server-side
resolver (`apps/projects/iteration_label.py`) computing the effective value
computed-on-read (ADR-0108), exposed as read-only `effective_*`/`inherited_*` serializer
fields, with an Enterprise-gated `ENFORCE` lock registered through a neutral OSS seam.
This ADR applies that exact precedent to the two sharing booleans.

**P3M layer:** Programs and Projects (OSS). The override is per-program/per-project
configuration a single PM/team needs to run their own program. Only the cross-scope
*enforcement lock* (a workspace admin preventing downstream loosening) is governance →
Enterprise, consistent with the "per-team config = OSS / enforcement = Enterprise"
boundary precedent (ADR-0116, ADR-0029/0049).

## Decision
Make `public_sharing` and `allow_guests` inheritable across the existing
Workspace → Program → Project chain, mirroring `iteration_label` exactly:

1. **Override columns.** Add nullable `BooleanField`s to `Program` and `Project`:
   `public_sharing`, `allow_guests`. `null` = inherit from the parent scope; `True`/`False`
   = explicit override. The `Workspace` columns stay non-null (they are the root default).

2. **Resolver (computed-on-read).** New `apps/projects/sharing_settings.py` resolves the
   effective value: `project ?? program ?? workspace`. No stored/denormalized effective
   column — there is nothing to keep in sync (ADR-0108).

3. **Serializer fields.** Add read-only `SerializerMethodField`s on the Program and Project
   serializers: `effective_public_sharing`, `inherited_public_sharing`,
   `effective_allow_guests`, `inherited_allow_guests` — naming and `_inherited_` semantics
   (skip the object's own override so the UI can render "Inherit (On/Off)") follow
   `effective_iteration_label`/`inherited_iteration_label` verbatim. The raw nullable
   override columns are writable; the `effective_*`/`inherited_*` fields are read-only.

4. **Override rights.** Writing an override on a Program/Project uses the **existing
   General-settings write gate** — `role >= Role.ADMIN` (Owner or Admin), the same gate
   already enforced by `IsProjectAdmin` / the program-admin permission
   (`access/permissions.py`). Lower roles receive the same serializer payload (the
   `effective_*`/`inherited_*` read-only fields) and render a read-only inherited
   indicator — server-derived gating, ADR-0133 / `can_user_edit_task` style.

5. **OSS guardrail = loosen *or* tighten.** In OSS the parent value is a *default*, not a
   ceiling. A project may be made public even when the workspace has sharing off, and
   vice versa. The resolver does not clamp.

6. **Governance lever (Enterprise-gated).** Add a workspace field
   `public_sharing_override_policy` (`TermOverridePolicy` choices: `suggest` default,
   `enforce`) modeled on `iteration_label_override_policy`. `suggest` = downstream may
   override (OSS behavior). `enforce` = hard ceiling: downstream cannot *loosen* (cannot
   turn sharing on when the workspace has it off). OSS ships the field + `suggest`
   behavior + a neutral registration seam; the lock is implemented by trueppm-enterprise.
   With no provider registered, `enforce` degrades to `suggest` (no lock), exactly like
   `terminology_enforcement_active()`. A trueppm-enterprise follow-up issue will be filed.

7. **Enterprise seam.** Add `register_sharing_enforcement_provider(provider)` and
   `sharing_enforcement_active()` in `sharing_settings.py`, mirroring
   `register_terminology_enforcement_provider` (`iteration_label.py:39-51`). Enterprise
   calls it from `AppConfig.ready()` (ADR-0029/0049 integrations-registry idiom). OSS never
   imports enterprise; `grep -r "trueppm_enterprise" packages/` stays zero.

8. **Audit.** No new audit machinery. `Program` and `Project` carry
   `HistoricalRecords(excluded_fields=_HISTORY_EXCLUDED_BASE)`. The new override columns
   are *not* in `_HISTORY_EXCLUDED_BASE` (`["server_version","deleted_version"]`), so every
   override write is automatically captured as a history row (actor, timestamp, old→new)
   through the existing settings write path. No code change required to satisfy the audit
   requirement.

9. **Consistency scope (Problem 3).** Fill only the genuine gap — sharing/guests on Program
   and Project. Document the full inheritance model + a scope matrix in
   `docs/administration/`. Other scope-specific settings (visibility, health, methodology,
   program-has-no-timezone, accent color, export) stay as-is, each with a one-line
   rationale in the doc. **No migrations** for those.

## Alternatives Considered
| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Hard ceiling in OSS (parent value clamps downstream) | Simple "secure by default" mental model | Breaks the established `iteration_label` precedent (parent = default, not ceiling); makes the governance lock indistinguishable from base behavior, leaving Enterprise nothing to sell; a single PM could not make their own project public — adoption-hostile | **Rejected** — clamping is the Enterprise `enforce` behavior, not OSS default |
| Frontend reads workspace settings directly, no serializer field | No backend change | Violates API-first (ADR-0108/0116): MCP/mobile clients would each re-implement precedence; no `inherited_*` indicator possible; resolution logic strands client-side where an agent can't reach it | **Rejected** — effective value must be a server fact |
| Denormalized stored `effective_*` columns + signal repair | Cheap reads | Sync-maintenance burden, repair jobs, drift risk — the exact problem ADR-0108 computed-on-read exists to avoid; iteration_label already proved computed-on-read is cheap (one Workspace query per list via serializer cache) | **Rejected** |

## Consequences
- **Easier:** PMs scope sharing per program/project; clients get one server-resolved truth
  (`effective_*`) plus an inheritance hint (`inherited_*`); Enterprise plugs in the lock
  with zero OSS churn via the existing seam idiom; audit is free.
- **Harder:** Two more `effective_/inherited_` pairs to keep cached efficiently — reuse the
  serializer's existing per-instance Workspace cache so a list of N projects stays at one
  Workspace query (extend that helper, don't add a second one).
- **Risks:** A reader could assume OSS `enforce` actually locks — mitigated by documenting
  the degrade-to-suggest behavior in the field `help_text` and the admin doc, identical to
  the iteration_label treatment.

## Implementation Notes
- P3M layer: Programs and Projects (OSS); enforcement lock = Enterprise
- Affected packages: api, web (docs)
- Migration required: **yes** — one additive migration (5 new nullable/defaulted columns,
  no backfill, no NOT NULL without default)
- API changes: yes — 4 new read-only serializer fields per Program/Project serializer; raw
  nullable override columns become writable on the settings serializers
- OSS or Enterprise: OSS (enforce-lock implementation lands in trueppm-enterprise)

### Durable Execution
1. Broker-down behaviour: **N/A** — pure synchronous settings write + computed-on-read
   resolution; no Celery task, no async side effect.
2. Drain task: **N/A** — no async work.
3. Orphan window: **N/A**.
4. Service layer: settings writes go through the existing Program/Project settings
   serializer `update()`; resolution through new `sharing_settings.resolve_effective_*`.
5. API response: synchronous (the updated serializer payload) — not best-effort dispatch.
6. Outbox cleanup: **N/A**.
7. Idempotency: a settings PATCH is naturally idempotent (last-writer-wins on a scalar
   column); `server_version` bump on save covers sync ordering.
8. Dead-letter / failure handling: **N/A** — synchronous validation error on bad input;
   no background task to fail.
