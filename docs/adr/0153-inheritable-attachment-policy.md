# ADR-0153: Inheritable Attachment Policy (attachments_enabled, allowed_attachment_types) with Per-Scope Override and Non-Overridable System Denylist

## Status
Accepted

> **Numbering note:** renumbered 0150 → 0153 at merge — ADR-0150 (real
> last-visited tracking, #1182), 0151 (duration-change percent policy, #414),
> and 0152 (real-time card delta, #327) landed on main first (established repo
> pattern — flag, don't block).

## Context
Task attachments enforce a single, installation-wide MIME allow-list that is a
hardcoded `frozenset` (`projects/serializers.py:4890`, checked at `:5077`, mirrored
client-side at `web/src/hooks/useTaskAttachments.ts:18`). Two needs are unmet (#976):

1. **No on/off switch.** A PM cannot disable file uploads for a regulated program
   (e.g. one where files must live only in an external DMS) while still allowing
   pinned external links. Today attachments are all-or-nothing at the code level.
2. **No configurable allow-list.** A program handling only design assets wants to
   permit additional image types; one handling only documents wants to forbid
   images. The frozen `frozenset` cannot be scoped.

The settings must scope the same way every other inheritable setting already does:
**Workspace → Program → Project**, resolved computed-on-read, exposed as
server-derived `effective_*`/`inherited_*` fields. TruePPM has solved this exact
shape three times — `iteration_label` (ADR-0116), sharing booleans (ADR-0135),
and Monte-Carlo forecast-history config (ADR-0144). This ADR applies that precedent
to attachments and adds one new safety primitive the prior three did not need: a
**non-overridable system denylist** that no admin "widen" can re-enable.

Two forces are specific to this feature and shape the decisions below:

- **Stored-XSS floor.** The allow-list is *enabled* security: a stored
  `text/html` (or `image/svg+xml`) blob served from the app origin is stored XSS.
  Making the allow-list *configurable* must not let an admin widen the policy to
  re-admit those types. The denylist therefore cannot be a row in the same
  allow-list column — it must be an independent, code-level floor applied after
  resolution.
- **The OSS inheritance ceiling is the Workspace.** Any scope *above* Workspace
  (org / tenant), and any *enforcement* of a parent's policy onto a child
  (lock / audit-of-policy-changes / override-approval workflow), is governance →
  Enterprise (CLAUDE.md Two-Repo Rule; consistent with ADR-0135 §6/§7). OSS ships
  inherit + manual narrow/widen with no lock, plus the neutral registration seam
  Enterprise plugs its lock layer into.

**P3M layer:** Programs and Projects (OSS). The override is per-program/per-project
configuration a single PM/team needs to run their own program. Only the cross-scope
*enforcement lock* (a workspace admin preventing a downstream PM from widening) is
governance → Enterprise — identical boundary to ADR-0135.

**Enterprise-boundary reasoning (inline `/enterprise-check`):**
- "Would a PM/team need this to run their program?" → **Yes** for the toggle and
  the per-scope allow-list (intake control for their own program's files) → OSS.
- "Is this cross-program coordination, org-level policy, or compliance evidence?"
  → **Yes** for the lock (parent forces child), the audit *trail of policy changes*,
  and the permit-override approval workflow → **Enterprise**. These never ship in OSS.
- No scope above Workspace is introduced. `grep -r "trueppm_enterprise" packages/`
  stays zero (current hits are doc/comment references to the boundary, not imports).
- No `enterprise`/`portfolio` issue labels are added — this is OSS extension-point
  work, but the OSS issue does not carry the reserved labels (CLAUDE.md).

## Decision

### 1. Storage — `ArrayField(CharField)`, not JSONField
Store `allowed_attachment_types` as a Postgres `ArrayField(models.CharField(...))`
of MIME strings.

- **Workspace** (root, non-null): `ArrayField(CharField(max_length=255),
  default=default_allowed_attachment_types)` seeded from today's frozen `frozenset`
  (PDF/JPG/PNG/WebP/XLSX/CSV/DOCX) via a named module-level callable (migrations
  cannot serialize a lambda). This makes the migration purely additive — every
  existing install keeps exactly today's behavior.
- **Program** and **Project** (both in `projects/models.py`): nullable
  `ArrayField(CharField(max_length=255), null=True, blank=True)`. `null` = inherit
  the parent's effective policy; a non-null list = explicit override (which may
  contain *more or fewer* entries than the parent — narrow **or** widen).

`ArrayField` over `JSONField` because: the value is a flat list of short scalars
(no nesting), `ArrayField` is already an established primitive in this exact model
layer (`Workspace.work_week`, `models.py:171`), it gives a typed element with
length validation for free, and it admits a GIN index later if a "which projects
allow type X" query ever appears (none today, so **no index is added now**). A
JSONField would invite arbitrary nested shapes the resolver does not want and
buys nothing for a flat string list.

`attachments_enabled` is a plain boolean, identical in shape to `public_sharing`:
- **Workspace**: `BooleanField(default=True)` (non-null root; default preserves
  today's behavior).
- **Program / Project**: `BooleanField(null=True, blank=True)` — `null` = inherit.

Both new columns on Program and Project are **excluded from
`_HISTORY_EXCLUDED_BASE`**, so every override write is automatically captured as a
`HistoricalRecords` row (actor / timestamp / old→new) through the existing settings
write path — the same "audit is free" property ADR-0135 §8 relies on. (Note: this
is the per-row model history that already exists for all settings; it is **not**
the Enterprise "policy-change audit trail" feature, which is a separate governance
artifact and stays Enterprise.)

### 2. Resolution layer — new `apps/projects/attachment_policy.py`, the stable OSS extension point
Add a sibling resolver module mirroring `sharing_settings.py` / `forecast_history_settings.py`
exactly: field-agnostic resolver + zero-arg enterprise-enforcement seam +
`_settings_default()` fall-through + `_parent_value()` walk (Program's parent =
Workspace; Project's parent = its Program, else Workspace). Computed-on-read
(ADR-0108) — **no stored/denormalized effective column.**

The list-typed value reuses the `forecast_history_settings` non-boolean resolver
shape (which already returns ints/enums, not just booleans). The boolean toggle
reuses the `sharing_settings` boolean shape. Both live in the one module so the web
client reads one coherent policy object.

**This module is the stable OSS extension point** Enterprise registers its lock
layer against (ADR-0029/0030 registration idiom; identical to
`register_sharing_enforcement_provider`). Its shape is frozen as a public surface:

```python
# apps/projects/attachment_policy.py  (OSS — stable extension point)

# --- the inheritable fields (field-agnostic resolver keys) -----------------
ATTACHMENT_POLICY_FIELDS = ("attachments_enabled", "allowed_attachment_types")

# --- system floor: never re-enableable by any allow-list widen (decision 3) -
#: MIME types that are blocked at all scopes regardless of the resolved
#: allow-list. text/html and SVG are stored-XSS vectors served from the app
#: origin; this floor is intersected out AFTER resolution and cannot be widened.
SYSTEM_ATTACHMENT_DENYLIST: frozenset[str] = frozenset({
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
})

# --- enterprise enforcement seam (inert in OSS) ----------------------------
def register_attachment_policy_enforcement_provider(
    provider: Callable[[], bool] | None,
) -> None: ...

def attachment_policy_enforcement_active(workspace: "Workspace" | None = None) -> bool: ...

# --- resolvers (computed-on-read) ------------------------------------------
def resolve_attachments_enabled(
    obj: "Program | Project | Workspace",
    *,
    workspace: "Workspace | None" = None,
) -> bool: ...

def resolve_effective_attachment_types(
    obj: "Program | Project | Workspace",
    *,
    workspace: "Workspace | None" = None,
) -> list[str]:
    """Resolved allow-list with the system denylist subtracted (decision 3).

    Chain: project override -> program override -> workspace value -> settings
    default; first non-null wins. The returned list is ALWAYS
    ``resolved_allowlist - SYSTEM_ATTACHMENT_DENYLIST`` so a widened override can
    never re-admit a denied type.
    """

def resolve_inherited_attachment_types(
    obj: "Program | Project",
    *,
    workspace: "Workspace | None" = None,
) -> list[str]:
    """What ``obj`` would inherit if its own override were cleared (parent up),
    denylist already subtracted. Drives the settings 'Inherit (…)' affordance."""

def is_attachment_mime_allowed(
    obj: "Program | Project",
    mime: str,
    *,
    workspace: "Workspace | None" = None,
) -> bool:
    """Single enforcement predicate: True iff ``mime`` is in the resolved
    effective allow-list AND not in the system denylist. The serializer and any
    future MCP/agent write path call THIS — they never re-derive precedence."""
```

The `workspace` kwarg lets the serializer load the singleton once and pass it down
when resolving a list of N projects (one Workspace query per list, the ADR-0135 §99
caching property). `attachment_policy_enforcement_active()` returns `False` in OSS
(no provider) so a workspace `ENFORCE` policy degrades to `SUGGEST` (no lock) —
exactly like the three prior seams.

### 3. System denylist — a non-overridable floor independent of the allow-list
`SYSTEM_ATTACHMENT_DENYLIST` (above) is a **code-level `frozenset`**, never a
database column and never part of any allow-list. The resolver **subtracts** it
from the resolved allow-list on every read, and `is_attachment_mime_allowed()`
re-checks it as a final gate. Consequences:

- An admin who "widens" `allowed_attachment_types` to include `text/html` gets a
  policy that silently excludes it — the widen is a no-op for denied types, at
  every scope, in every edition (OSS and Enterprise alike).
- The denylist is independent of the magic-byte sniffer (`_sniff_attachment_content`,
  serializers.py:4974) — sniffing catches a *payload posing as* an allowed type;
  the denylist ensures the *declared* type can never be a known-dangerous one even
  if explicitly listed. Both stay in force.
- The XOR external-link path is untouched: `text/html` links are still allowed as
  external URLs (they are not served from the app origin), preserving the #976
  "external links unaffected" requirement.

This is the single most important safety decision in the ADR: **configurability of
the allow-list never weakens the stored-XSS floor.**

### 4. `attachments_enabled` resolution
Boolean inheritance identical to `public_sharing` (ADR-0135 §1–2): system default
`True`; Workspace non-null `True`; Program/Project `null` = inherit; first non-null
override down the chain wins. Resolved via `resolve_attachments_enabled()`. When an
active Enterprise lock is present the workspace value is the ceiling (OSS: never).
When `False` at the effective scope, the API rejects new file uploads (decision 5)
and the web hides the "+ Attach file" control with a visible "why" state
(decision 5 / UX).

### 5. API surface + enforcement + no new broadcast

**Where the resolved policy is exposed.** Add read-only `SerializerMethodField`s to
the **Project serializer** and **Program serializer** (the settings-bearing
serializers), mirroring the `effective_*`/`inherited_*` naming exactly:

- `effective_attachments_enabled` (bool), `inherited_attachments_enabled` (bool)
- `effective_allowed_attachment_types` (list[str], denylist already subtracted),
  `inherited_allowed_attachment_types` (list[str])

The raw nullable override columns become writable on the Program/Project **settings**
serializers (write gate `role >= Role.ADMIN`, the existing General-settings gate —
ADR-0135 §4). Lower roles receive the read-only `effective_*`/`inherited_*` payload
and render a read-only inherited indicator (server-derived gating, ADR-0133 style).

**Where the web client mirrors it for the upload control.** The
`TaskAttachmentSerializer` (the task-scoped upload serializer) is the enforcement
point, not the place the policy is *displayed*. To avoid a per-task Workspace/Project
query and to keep the web "+ Attach file" control in sync, expose the resolved policy
to the task-attachment flow via **serializer context injected from
`TaskAttachmentViewSet.perform_create`** (which already has `project_pk` in
`self.kwargs`, views.py:9204). The viewset loads the project once, resolves the
policy via `attachment_policy.is_attachment_mime_allowed` /
`resolve_attachments_enabled`, and:

- rejects the upload with a 400 (`attachment_uploads_disabled`) when
  `attachments_enabled` is effectively `False`;
- replaces the hardcoded `ALLOWED_ATTACHMENT_MIMES` membership check at
  serializers.py:5077 with `is_attachment_mime_allowed(project, mime)` (the
  `frozenset` is retired as the live gate but kept as the seeded Workspace default
  via the decision-1 named callable).

The **web** reads `effective_attachments_enabled` /
`effective_allowed_attachment_types` from the already-fetched Project object (no new
endpoint); `useTaskAttachments.ts` stops hardcoding `ALLOWED_ATTACHMENT_MIMES` and
consumes the resolved list. When `effective_attachments_enabled === false` the
"+ Attach file" control is hidden and replaced with a short disabled/explanatory
state ("File uploads are turned off for this project" — UX-design owns the exact
copy and affordance). This satisfies the #976 "needs a visible 'why' state"
requirement.

**No new WebSocket broadcast.** A policy change is a **settings write on
Project/Program/Workspace**, not a board-scoped mutation (no task/board state
changes). It follows the existing settings-PATCH path, which does not broadcast a
board event — consistent with ADR-0135/0144 (both `Durable Execution: N/A`,
synchronous settings write). Confirmed: no `broadcast_board_event` is added for the
policy itself. (The existing `task_attachment_created` broadcast on actual uploads
is unchanged.)

### 6. Edition boundary
- **OSS** (this ADR): the two columns at all three scopes, the resolver module, the
  system denylist floor, `effective_*`/`inherited_*` serializer fields, manual
  narrow **or** widen with no lock, and the neutral enforcement-registration seam.
- **Enterprise** (separate `trueppm-enterprise` follow-up issue, filed there from
  the start — not in the OSS tracker): the lock (`ENFORCE` policy that makes a
  parent's value a hard ceiling a child cannot widen past), the policy-change audit
  trail, the permit-override approval workflow, and any scope above Workspace. These
  register against `register_attachment_policy_enforcement_provider` from
  `AppConfig.ready()` (ADR-0029/0049 idiom). With no provider registered, `ENFORCE`
  degrades to `SUGGEST` — no lock in OSS.

A workspace `attachment_policy_override_policy` CharField (`TermOverridePolicy`
choices, default `SUGGEST`) is added to **Workspace** now, mirroring
`public_sharing_override_policy` — OSS stores it and ships `SUGGEST` behavior; the
`ENFORCE` value is the Enterprise extension point. (One policy column on the root
only, matching ADR-0135/0144 — Program/Project carry no policy column.)

## Alternatives Considered
| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Denylist as a row in the same allow-list column (admin can't *remove* it) | One storage concern | The denylist must survive a full *replace* of the override list; a widen that re-lists `text/html` would silently re-enable XSS unless special-cased anyway — i.e. you still need a code floor. Conflates "what's allowed" with "what's forbidden by policy". | **Rejected** — the floor must be code-level and independent (decision 3) |
| `JSONField` for `allowed_attachment_types` | Flexible shape | Invites nested/arbitrary structures the resolver doesn't want; no element typing or length validation; `ArrayField` is already the in-model precedent (`work_week`); a flat string list needs nothing JSON buys | **Rejected** |
| Hard ceiling in OSS (parent allow-list clamps child) | "Secure by default" mental model | Breaks the ADR-0116/0135/0144 precedent (parent = default, not ceiling); leaves Enterprise nothing to sell; a PM couldn't widen their own program's intake — adoption-hostile | **Rejected** — clamping IS the Enterprise `ENFORCE` behavior, not OSS default |
| Per-task policy field / per-task override | Maximum granularity | Wrong scope — #976 is program/project intake policy, not per-task; multiplies storage and write paths; no VoC demand | **Rejected** |
| Expose policy only via a new dedicated endpoint | Clean separation | Violates "effective value is a server fact on the resource"; the Project serializer is already fetched by every client that renders the attach control — a second round-trip for one client is waste | **Rejected** — fields on existing Project/Program serializers (decision 5) |

## Consequences
- **Easier:** a PM scopes attachment intake per program/project; clients get one
  server-resolved truth (`effective_*`) plus an inheritance hint (`inherited_*`);
  the stored-XSS floor is unforgeable regardless of admin intent; Enterprise plugs
  in the lock with zero OSS churn via the established seam; per-row settings audit
  is free.
- **Harder:** two more `effective_/inherited_` pairs to keep cached efficiently —
  reuse the serializer's existing per-instance Workspace cache so a list of N
  projects stays at one Workspace query (extend that helper; do not add a second).
  The MIME gate now lives behind a predicate call instead of a `frozenset` literal,
  so the two former call sites (serializer validate, web hook) both route through
  the resolver.
- **Risks:**
  1. A reader assumes OSS `ENFORCE` actually locks — mitigated by documenting the
     degrade-to-`SUGGEST` behavior in the field `help_text` and the admin doc,
     identical to the three prior seams.
  2. A widened allow-list could re-admit a *non-denylisted but risky* type (e.g. a
     macro-bearing Office format) — out of scope for #976's floor (which targets
     active stored-XSS only); the magic-byte sniffer still applies, and the
     denylist can be extended in a later ADR if a new active-content vector appears.
  3. Drift between the seeded Workspace default and the (retired-as-gate) frozen
     `frozenset` — mitigated by seeding the Workspace default *from* the same named
     callable, with a test asserting they match at migration time.
  4. ADR-number collision with a parallel branch — renumber-at-merge (see top note).

## Implementation Notes
- P3M layer: Programs and Projects (OSS); enforcement lock / policy-audit /
  override-approval = Enterprise
- Affected packages: api, web, docs (administration + features)
- Migration required: **yes** — one additive migration. New columns: Workspace
  `attachments_enabled` (bool, default True), `allowed_attachment_types`
  (ArrayField, default = named callable seeded from the frozenset),
  `attachment_policy_override_policy` (CharField, default SUGGEST); Program & Project
  `attachments_enabled` (nullable bool), `allowed_attachment_types` (nullable
  ArrayField). No backfill, no NOT NULL without default, no destructive op. Run
  `migration-check` (a `models.py` changed). Sync `HistoricalProgram` /
  `HistoricalProject` columns in the same migration (the django-simple-history
  shadow tables — the ADR-0149 gotcha).
- API changes: yes — 4 read-only serializer fields per Program/Project serializer;
  raw nullable override columns become writable on the settings serializers; the
  task-attachment upload validate() switches from the `frozenset` to
  `is_attachment_mime_allowed`, and `perform_create` adds the disabled-uploads gate.
- OSS or Enterprise: **OSS** (the `ENFORCE` lock, policy-change audit trail, and
  override-approval workflow land in trueppm-enterprise; file the EE issue there).

### Durable Execution
1. Broker-down behaviour: **N/A** — settings writes and the upload-time policy check
   are pure synchronous request/response with computed-on-read resolution; no Celery
   task, no async side effect introduced. (The unchanged `task_attachment_created`
   broadcast on actual uploads already follows the existing `transaction.on_commit`
   board-event path and is not modified by this ADR.)
2. Drain task: **N/A** — no new async work.
3. Orphan window: **N/A**.
4. Service layer: settings writes go through the existing Program/Project/Workspace
   settings serializer `update()`; resolution + enforcement through the new
   `apps.projects.attachment_policy` resolver (`is_attachment_mime_allowed`,
   `resolve_attachments_enabled`, `resolve_effective_attachment_types`).
5. API response on best-effort dispatch: **N/A** — synchronous serializer payload on
   settings write; synchronous 400 on a disallowed/disabled upload. No best-effort
   dispatch.
6. Outbox cleanup: **N/A**.
7. Idempotency: a settings PATCH is naturally idempotent (last-writer-wins on the
   scalar/array column); `server_version` bump on save covers sync ordering. The
   upload gate is a pure read-side check with no state mutation of its own.
8. Dead-letter / failure handling: **N/A** — synchronous validation error on bad
   input (disabled uploads, disallowed/denylisted MIME); no background task to fail.
