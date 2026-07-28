# ADR-0627: Server-persisted per-user Pin on Projects and Programs

## Status

Proposed (2026-07-25)

> **Promotes the device-local rail pin shipped under ADR-0126/ADR-0127 (#1682) to a
> server-persisted, per-user, API-first object.** The user-visible vocabulary is
> **unchanged** — it stays "Pin" (D1). This ADR does **not** touch `pinnedMobileViews`
> (#1591), `TaskNote.pinned` (#740), or `TaskAttachment.is_pinned` — three distinct pin
> concepts that keep both the word and their current behavior (D1, D1.1).

## Context

**P3M layer:** Programs and Projects / Operations. A pin is per-user navigation state over
projects and programs the caller can already read. It performs no cross-project aggregation,
carries no health or comparison dimension, and grants no access. **Repo: OSS**
(`trueppm-suite`) — squarely inside the ADR-0428 seam ("a workspace-scoped read narrowed to
the caller's own readable set is not a portfolio rollup").

### What already ships (verified against the tree, 2026-07-25)

The feature is **not greenfield on the web** — a pin already exists and is half-right:

| Thing | Location |
|---|---|
| `pinnedProjectIds` / `togglePin`, key `trueppm.rail.pinned` | `packages/web/src/stores/shellStore.ts:14,80,116` |
| `pinnedProgramIds` / `togglePinProgram`, key `trueppm.rail.pinnedPrograms` | `shellStore.ts:18,83,125` |
| `PinToggle` — real `<button>`, `aria-pressed`, `aria-label`, `h-11 w-11`, `focus:ring-2` | `features/shell/Sidebar.tsx:1455` |
| `PinnedTier` + `<h2>Pinned</h2>` | `Sidebar.tsx:688,713` |
| `Pinned {name}` / `Unpinned {name}` toasts | `Sidebar.tsx:1472`, `ProgramCard.tsx:117` |
| Pinned-first ordering across every sort key | `features/programs/programListSort.ts:101-106` |
| A pin toggle on `ProgramCard` — **already present** | `ProgramCard.tsx:55,115-140` |

Two corrections to the brief that shaped this design:

1. **`ProgramCard` already has the toggle** (`ProgramCard.tsx:115`), *and* already carries the
   touch fix (`max-md:opacity-100`). The touch bug — hover-gated reveal with no touch
   fallback — is **Sidebar-only** (`Sidebar.tsx:1477` has `opacity-0 group-hover:opacity-100`
   with no `max-md:` escape). The fix is to port `ProgramCard`'s class list to `PinToggle`.
2. **The glyph is already a five-pointed star.** Both toggles render
   `M8 1.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.8 4.2 13.3l.7-4.3-3.1-3 4.3-.6L8 1.5z`
   (`Sidebar.tsx:1487`, `ProgramCard.tsx:129`). The glyph is **unchanged** by this ADR — a
   star-shaped glyph labeled "Pin" is the shipped status quo and is out of scope here.

### The two real defects

1. **Device-local.** `localStorage` only. Pins vanish on a new browser, do not follow the user
   across machines, and are invisible to the API — therefore invisible to MCP. ADR-0599 is
   explicit that this is not one of the three sanctioned client-authority exceptions (drag
   preview, offline recompute, engine-as-library): *"is its result authoritative? If a
   persisted value depends on it, it belongs server-side, behind the API."* ADR-0139 rejected
   localStorage for `hidden_views` on exactly this ground.
2. **Reachable from one surface.** No control on the Project Overview header, the Program
   Overview header, `ProgramProjectsPage` rows, or `UngroupedProjectsSection` rows.

### Decisions inherited, not re-litigated

- **Vocabulary is "Pin"** — the user's recorded decision on #2390 stands. D1 records it and the
  evidence weighed against it.
- **Morgan's 🔴 hard constraint** (Agile Coach): *"the minute it's a server-side row instead of
  localStorage, somebody has to prove nobody with a badge can query it."* The failure mode to
  design out is *"she hasn't pinned the client project in weeks, is she disengaged?"* This is
  the same surveillance boundary ADR-0104 and ADR-0428's non-goals already draw. D5 is the
  written answer.
- **ADR-0112 agent constraint.** A pin becomes a durable write; it must not be default-granted
  to agents and it must be audited. D6.
- **Janet's 🟡**: pinning must not become a de facto RAG substitute that buries unpinned
  at-risk projects. D7.
- **The 4.8 VoC panel average is not a scope signal.** It scored a *vocabulary* question, on
  which every persona correctly measured a wayfinding convenience against their headline
  criteria. Morgan scored the **feature** 7/10 ("will adopt if conditions are met" — the
  condition being D5). Proceed.

## Decision

### D1 — Vocabulary: **Pin** is retained; there is no rename

The user-visible verb stays **Pin** / **Unpin**, the rail heading stays **Pinned**, and the wire
fields are `is_pinned` / `pinned_at`. Every shipped symbol — `PinToggle`, `PinnedTier`,
`togglePin`, `togglePinProgram`, the `Pinned {name}` / `Unpinned {name}` toasts, the
`Pin {name}` / `Unpin {name}` aria-labels, `programListSort`'s `pinnedIds` — **keeps its name**.

A rename to "Star" was proposed and **declined by the user**. Both sides were on the table:

- *For Star:* the VoC panel favored it 5–1 on the ground that "pin" reads as *shared* in the
  tools these users live in (Slack, GitHub) while "star" reads as *private-to-me* (Jira,
  Confluence, GitHub repos); TruePPM's own `TaskNote.pinned` / `TaskAttachment.is_pinned` carry
  exactly those shared semantics (D1.1); and the shipped glyph is already a star, so the rename
  would have cost no icon work. Measured churn was small — three E2E specs, four vitest files,
  two doc lines.
- *For Pin (chosen):* zero user-visible churn, zero E2E/doc/test churn, and continuity with a
  concept users of the current build already have. The engineering value of #2390 is entirely
  in the server promotion and the missing surfaces; the vocabulary carries none of it.

**Consequence: the entire "rename blast radius" work item disappears.** All call sites keep
their current names, so the web diff is confined to *where the state lives* (D8), not what it is
called. The one thing this decision does incur is a deliberate, accepted naming collision,
recorded next.

### D1.1 — Accepted collision: `pinned` means two different things

**This ADR knowingly ships `pinned` with two opposite privacy semantics in one API.** This was
raised explicitly, weighed, and accepted by the user; the alternative (Star) was considered and
declined. It is recorded here so no future reader mistakes it for an oversight.

| Field | Resource | Semantics | Who can toggle | Who can see it |
|---|---|---|---|---|
| `is_pinned` **(this ADR)** | `Project`, `Program` | **Private** per-user bookmark | Only the owner, for themselves | **Only the owner** |
| `TaskNote.pinned` (#740, `models.py:6001`) | `TaskNote` | **Shared** curation — *"Pin is curation, not authorship"* | Any project writer (Member+) | Every project member |
| `TaskAttachment.is_pinned` (`models.py:5846`) | `TaskAttachment` | **Shared** curation | Any project writer (Member+) | Every project member |
| `pinnedMobileViews` (#1591, `shellStore.ts:92`) | mobile BottomNav | **Private**, and genuinely *sticky/ordering* ("ordered by pin recency") | The user, client-side | Only that device |

`pinnedMobileViews` is a **third, separate, legitimately-sticky** use with real ordering
semantics — it promotes a view into the primary nav rail ahead of the methodology defaults. It
is untouched by this ADR and keeps both its name and its localStorage persistence.

**Why the collision is safe despite the confusion.** The two meanings never meet on one
resource: `is_pinned` is a field on `Project`/`Program`; `pinned` / `is_pinned` are fields on
`TaskNote`/`TaskAttachment`. There is no resource on which a reader must ask "which kind of pin
is this?" And the private one is not merely documented as owner-only — it is *enforced* owner-only
by the six normative rules in D5 (annotation bound positionally to `request.user`, no `?user=`
parameter, no aggregate field, no admin registration, read-only serializer field, guard test).

**Concrete mitigation — the OpenAPI description is load-bearing, not decoration.** Per Nadia's
ask, the `description` on the `is_pinned` field of `ProjectSerializer` and `ProgramSerializer`,
and on all three pin endpoints, **MUST** carry this text verbatim, precisely so an API consumer
or MCP client does not carry over the shared-curation meaning it learned from notes and
attachments:

> **Per-user, private, idempotent, and reversible.** This pin is a personal bookmark visible
> **only to its owner**. It changes nothing about the project or program, affects no workflow,
> schedule, permission, or notification, and is invisible to every other user — including
> workspace administrators. Note this is a *different* concept from `TaskNote.pinned` and
> `TaskAttachment.is_pinned`, which are **shared** team curation togglable by any Member+.
> Safe to call repeatedly; the only effect is on the caller's own navigation surfaces.

A schema test asserts this description is present on all four surfaces, so a serializer refactor
cannot silently drop the one artifact that disambiguates the collision for machine consumers.

### D2 — Data model: one `UserPin` in `apps/profiles`, nullable-FK XOR

```python
class UserPin(models.Model):
    """A per-user private pin on one Project XOR one Program (#2390, ADR-0627).

    NOT the same concept as ``TaskNote.pinned`` / ``TaskAttachment.is_pinned``, which
    are SHARED team curation togglable by any Member+ (ADR-0627 D1.1). This pin is
    private to its owner and visible to no one else.

    Deliberately NOT a ``VersionedModel``: this is personal navigation state, not a
    board-scoped collaborative entity. It carries no ``server_version``, never enters
    the offline delta/sync protocol, and is never broadcast — mirroring
    :class:`UserProfile`, :class:`ProjectVisit`, and ``UserNotificationSettings``.
    Unpinning HARD-deletes the row: nothing downstream needs a tombstone to
    converge (see ADR-0627 D3).

    PRIVACY INVARIANT (ADR-0627 D5, Morgan's constraint): a pin is readable ONLY by
    its owner. There is no endpoint, query parameter, annotation, serializer field, or
    admin registration that answers "who pinned X" or "how many users pinned X".
    Adding one is a breaking change to ADR-0627 and requires a superseding ADR.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="pins"
    )
    # Exactly one target is non-null (XOR CheckConstraint below) — the ADR-0076
    # Webhook/ApiToken project-XOR-program shape, which ADR-0214 later relaxed to add
    # a third scope. Widening an XOR is a pure relaxation; a GenericForeignKey is not
    # used anywhere in this repo (ADR-0075 "team aversion", ADR-0369 "the repo
    # convention — no GenericForeignKey").
    project = models.ForeignKey(
        "projects.Project", on_delete=models.CASCADE, null=True, blank=True,
        related_name="user_pins",
    )
    program = models.ForeignKey(
        "projects.Program", on_delete=models.CASCADE, null=True, blank=True,
        related_name="user_pins",
    )
    pinned_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "user pin"
        constraints = [
            models.CheckConstraint(
                name="ck_userpin_project_xor_program",
                check=(
                    Q(project__isnull=False, program__isnull=True)
                    | Q(project__isnull=True, program__isnull=False)
                ),
            ),
            # Partial uniques — one per target kind. Each also BACKS the is_pinned
            # Exists() annotation (D4): the (user, project) unique index is exactly
            # the index that subquery seeks on.
            models.UniqueConstraint(
                fields=["user", "project"], condition=Q(project__isnull=False),
                name="uq_userpin_user_project",
            ),
            models.UniqueConstraint(
                fields=["user", "program"], condition=Q(program__isnull=False),
                name="uq_userpin_user_program",
            ),
        ]
        indexes = [
            # Serves GET /me/pinned/ (newest-first, own rows only). Mirrors
            # ProjectVisit's (user, -visited_at) index (ADR-0150).
            models.Index(fields=["user", "-pinned_at"], name="userpin_user_recent_idx"),
        ]
```

**Home: `apps/profiles`.** ADR-0292 drew the line — `profiles` is *"scoped to app-navigation
preferences"*; DND went to `notifications` because it lives with its consuming gate. A pin is
navigation state, so `profiles` is correct, next to `ProjectVisit` which it structurally mirrors.

**No Django admin registration.** A `ModelAdmin` changelist over `UserPin` is precisely the
"somebody with a badge can query it" surface Morgan named. Omitted deliberately; see D5.

**No `server_version`, no `HistoricalRecords`, no `deleted_at`.** Not a `VersionedModel`.

**Cap: 100 pins per user, total across both kinds.** Read at request time from
`settings.TRUEPPM_MAX_USER_PINS` (the ADR-0497 / #2021 operator-retunable convention, mirroring
`MAX_PERSONAL_ACCESS_TOKENS`). Exceeding it returns `400 {"detail": "You have reached the
maximum of 100 pinned items. Unpin one to add another.", "code": "pin_limit_reached"}` — the
`detail` is rendered by the view from `PinLimitReached.limit`, never by stringifying the
exception, so the copy lives on the surface that owns it. This bounds the `/me/pinned/`
payload, bounds the rail band,
and is the mechanical half of Janet's 🟡 (D7) — an unbounded pinned band *is* the RAG-substitute
failure mode.

### D3 — Offline sync: **no**, and unpin is a hard delete

`UserPin` does **not** participate in the WatermelonDB delta. Three independent reasons:

1. **The delta is project-scoped; a pin is not.** `sources: list[SyncSource]`
   (`apps/sync/views.py:233` project slice, `:862` program slice) is built per *project* /
   per *program* for a member. A pin belongs to a **user** and spans both kinds; it has no
   natural home in either slice.
2. **ADR-0142 forbids it by default.** *"Only the 12 union tables get receivers. Other
   `VersionedModel` subclasses … are not in the project sync union and must not bump it."* Adding
   a collection means a `SyncSource` entry, a `Sync*Serializer`, a `register_watermark_receivers`
   resolver (`apps/sync/receivers.py:137`), a `_snapshot_max_version` union branch, a
   `_TOMBSTONE_MODEL_REGISTRY` entry (ADR-0197), and a stable-order protocol bump — all to carry
   a boolean.
3. **Every per-user model in this codebase already opted out**, in identical words:
   `UserProfile` (*"never participates in the offline delta/sync protocol, and is never
   broadcast"*), `ProjectVisit` (*"never synced to mobile, never broadcast"*),
   `UserNotificationSettings`, `ProjectNotificationPreference`, `AgentAction`.

**Unpin = hard `DELETE` of the row.** A tombstone exists to let an offline client converge; no
offline client holds this collection, so there is nothing to converge. Hard delete also means
the table cannot accumulate an unpin *history* — which is itself a privacy property (there is
no "she unpinned it three weeks ago" record to mine).

**Mobile**, when it needs pinned items, gets a plain cached read of `GET /me/pinned/` — a read
cache, not protocol participation. This is the ADR-0508 #2104 posture.

**No `broadcast_board_event()`.** A pin is not a board-scoped mutation; nobody else's client
has anything to update.

### D4 — API shape

**Writes — `@action` on the two viewsets** (object-level RBAC for free):

```
POST   /api/v1/projects/{id}/pin/    -> 200 {"is_pinned": true, "pinned_at": "<iso>"}
DELETE /api/v1/projects/{id}/pin/    -> 204
POST   /api/v1/programs/{id}/pin/    -> 200 {"is_pinned": true, "pinned_at": "<iso>"}
DELETE /api/v1/programs/{id}/pin/    -> 204
```

- Mirrors `ProjectViewSet.visit` (`views.py:1648`) — the shipped precedent for a per-user
  write against a project id. ADR-0150's rule holds: **a GET never writes**.
- **Permission:** `IsAuthenticated` + `IsProjectMember` / `IsProgramMember` (Viewer+). Anyone who
  can *read* it can pin it; a pin grants no access and confers nothing.
- **`IsProjectNotArchived` / `IsProgramNotClosed` deliberately skipped**, mirroring `visit`. You
  must be able to *unpin* an archived project, and pinning one is harmless.
- **Idempotent** via `get_or_create` on the unique constraint: `POST` on an already-pinned
  target is a no-op returning the existing `pinned_at` (200, not 201 — 201 would be a lie on
  re-pin). `DELETE` on an unpinned target returns 204. This is what makes the localStorage
  migration (D9) safely retryable.
- `200`/`204` synchronous. No `{"queued": true}` — nothing is dispatched.
- Every endpoint carries the D1.1 disambiguating `description`.

**Read collection — `GET /api/v1/me/pinned/`:**

Per ADR-0508's reasoning for `/me/recent-projects/`: *"the resource is my pinned set, keyed on
`request.user`, not a project sub-resource."* One merged endpoint (not two) because the rail
renders programs-then-projects as a **single** band — two calls would be a waterfall for one
visual group.

- Slim navigation-only serializer, no counts, no health rollups (a governance rollup would push
  this toward Enterprise — ADR-0508's stated line):
  `{kind: "project"|"program", id, name, code, program_id, program_name, pinned_at}`
- Ordered `-pinned_at`. `?kind=project|program` optional facet. `?limit` default 50, max 100
  (the cap). No other parameters — **and specifically no `?user=`, ever** (D5).
- **Membership re-filtered on every read**, exactly like `MeRecentProjectsView`: a pin for a
  project the user lost access to (revoked membership, soft-delete) never leaks its name. The
  row is left in place — access can be restored — but it is not returned.
- `McpReadableViewMixin` (D6).
- Empty readable set → empty page, **never 403** (ADR-0428).

**Per-row flag — `is_pinned` on `ProjectSerializer` / `ProgramSerializer`:**

The list-render question — "how does a client answer *is this one pinned* for 40 projects?" — is
answered by a single `Exists()` annotation, not by a client-side join against `/me/pinned/`. A
client-side join is fine for the 40 the rail shows, but it breaks the moment a surface paginates
(`DirectoryPagination` is page_size 200, max 500, ADR-0401) or renders a project the pinned
fetch did not include. One boolean per row is the correct shape.

```python
# ONE helper, TWO call sites. The user is taken positionally from request.user;
# it is never a request parameter. See ADR-0627 D5.
def annotate_is_pinned(qs, user):
    if user is None or not user.is_authenticated:
        return qs.annotate(is_pinned=Value(False, output_field=BooleanField()))
    return qs.annotate(
        is_pinned=Exists(UserPin.objects.filter(user=user, project=OuterRef("pk")))
    )   # program variant filters program=OuterRef("pk")
```

Call sites: `ProjectViewSet.get_queryset()` (`views.py:822`, beside the existing
`_my_role=Subquery(...)`) and `ProgramViewSet.get_queryset()` (`program_views.py:118`, beside the
existing `_is_sample=Exists(...)`). Both viewsets **already** carry per-request per-caller
annotations of exactly this shape, so this adds no new query class and no N+1 — the `Exists`
seeks the `(user, project)` / `(user, program)` unique index from D2.

`is_pinned` is **read-only** on both serializers and never appears in a write payload; the only
way to change it is the `@action`.

### D5 — Morgan's constraint: why `is_pinned` cannot leak another user's pins

This is the design's load-bearing requirement, and it is answered structurally, not by policy.

**Why the annotation is safe.** `annotate_is_pinned(qs, user)` binds `user` to
`self.request.user` at both call sites. There is no filter backend entry, no `filterset_fields`
member, no `ordering_fields` member, and no serializer field that carries a user id into it. The
subquery's `user=` is a **bound object, not a parseable parameter** — a `?user_id=` could not
reach it by DRF's generic filtering machinery even if someone added the query param; it would
have to be threaded through the helper deliberately, in a diff, at both call sites.

This is not a new trust assumption. `_my_role` (ADR-0186 §F, `views.py:817-822`) is the identical
shape and already ships: it answers *"what is **my** role here"* and is structurally incapable of
answering *"what is Priya's role here"*. `is_pinned` inherits that property exactly.

**Why it is not aggregable.** `is_pinned` is a boolean *about the caller*, not a fact about the
project — two users GET the same project and get different values. There is no `pinned_by`, no
`pin_count`, no reverse lookup, and no endpoint that takes a project id and returns users. The
question "who pinned project X" has no representation anywhere in the API surface.

**Why `pinned_at` never reaches a shared payload.** The timestamp appears **only** on
`/me/pinned/` (self-scoped). `ProjectSerializer` / `ProgramSerializer` carry a bare boolean.
This is deliberate: `pinned_at` is the recency signal that makes *"she hasn't pinned the client
project in weeks"* expressible, and it is confined to the one endpoint that can only ever be read
by its own owner.

**Enforcement, so this survives future diffs.** All six are normative:

- **(a)** No Django admin registration for `UserPin` (D2).
- **(b)** No `?user=`, `?user_id=`, or `?pinned_by=` parameter on any endpoint — restating
  ADR-0428's explicit hard non-goal (*"no `?user=` or any parameter letting one user read
  another user's `mine` scope"*).
- **(c)** A **guard test**, `test_no_cross_user_pin_leak`, asserting that (i) passing
  `?user=`/`?user_id=`/`?pinned_by=<other-uuid>` to `/projects/`, `/programs/`, and
  `/me/pinned/` produces a response identical to the unparameterized call; (ii) user A's
  `is_pinned` is `false` for a project only user B has pinned; (iii) no URLConf route name
  matches a pin-plus-user segment. This test is the written proof Morgan asked for and is a
  **release gate**, not a nicety.
- **(d)** `is_pinned` declared read-only on both serializers.
- **(e)** The privacy invariant is repeated verbatim in the `UserPin` docstring and in the
  OpenAPI description of every pin endpoint (D1.1), so it is visible to anyone reading the
  schema. Given the D1.1 collision, this is doing double duty: it is both the privacy statement
  and the disambiguator against `TaskNote.pinned`.
- **(f)** No `pin_count`, no `pinned_by`, no "trending projects" — adding any of them converts
  a personal navigation read into the Enterprise governance surface (ADR-0428 non-goals) and
  requires a superseding ADR.

**Result:** the pinned set is self-scoped by construction. A workspace admin with full RBAC has
no query, no endpoint, and no admin page that answers who pinned what.

### D6 — Agent / MCP (ADR-0112, ADR-0186, ADR-0497)

**Reads are agent-reachable now.** `MePinnedView` mixes in `McpReadableViewMixin`, inheriting in
one line: `McpInstanceEnabled` (the `TRUEPPM_MCP_ENABLED` operator kill switch, ADR-0497),
`TokenReadOnlyMethods`, `TokenHasScope("mcp:read")`, `TokenIsOwnerScoped`, the per-token read
throttle, and the automatic `AgentAction` audit in `finalize_response`
(`access/permissions.py:1342-1418`). `is_pinned` on project/program payloads needs **no** scope
change — `ProjectViewSet` and `ProgramViewSet` already carry the mixin.

`TokenIsOwnerScoped` is what makes this self-scoping hold for agents too: only an owner-scoped
(personal) token reaches the MCP surface, and *"a personal token **is** its owner"* — so
`/me/pinned/` under a token returns the minter's own pins and nothing else. No `_provenance`
(the response echoes stored rows, ADR-0112 / ADR-0368).

**Writes are human-only in 0.4.** Correcting the brief: there is no `schedule:simulate` scope in
OSS code. `API_TOKEN_SCOPES` is exactly `("legacy:full", "mcp:read")`
(`projects/models.py:5229-5234`); the fuller taxonomy is deferred to 0.6 (ADR-0186 §E). So *"not
in the default capability set"* is satisfied **by construction, with no new code**:
`TokenReadOnlyMethods` refuses `POST`/`DELETE` for any `mcp:read` token. The refusal is itself
audited — verdict `REFUSED`, reason `POLICY`, constraint `CAPABILITY_SCOPE` — so an agent that
attempts to pin lands on the hash chain. This matches ADR-0528's precedent (*"human-only until
0.6 — no MCP token write path"*).

**Reserved for 0.6, deliberately not added now:** the scope name **`me:write`** (ADR-0112's
`<domain>:<verb>` form). It is **not** appended to `API_TOKEN_SCOPES` in this ADR — minting it
early would create a default-permissive surface that `ai-review`'s capability-default check
flags, and ADR-0112 RC4 requires an agent write to route through the single-approver
human-in-the-loop gate rather than be default-granted. When 0.6 opens it, the pin write calls
`record_agent_action(..., capability_used="me:write", ...)` **inside the same
`transaction.atomic()`** as the `UserPin` row; the `agent_action_recorded` signal is then
dispatched on commit by the service itself (`agents/services.py:196`) — the caller does not wire
its own `on_commit`.

**MCP tool:** a `list_pinned` tool in `packages/mcp/src/trueppm_mcp/tools.py::register_tools` is
in scope, and `docs/administration/mcp-server.md` must be updated in the same MR or
`packages/mcp/tests/test_docs_drift.py` fails. Its tool description carries the D1.1 text — an
MCP client is the consumer most likely to conflate this pin with note/attachment pinning.

### D7 — Janet's 🟡: pinning reorders, it never filters

Three rules, all normative:

1. **Pinned floats; nothing is ever hidden.** Pinning adds a shortcut, it does not relocate or
   remove — the shipped `PinnedTier` comment already states this (*"Items also keep their normal
   tree position"*) and it is preserved. `/programs` continues to render every program; the
   Pinned rail band is **additive** to the Programs tree, not a replacement.
2. **No "pinned only" default.** No surface defaults to a pinned filter. If a pinned facet is
   ever added it is opt-in, visibly labeled, and never sticky across sessions.
3. **Health ordering survives inside both bands.** `filterAndSortPrograms` already applies the
   chosen sort key *within* the pinned and unpinned partitions (`programListSort.ts:100-106`) —
   a critical unpinned program still sorts worst-first among unpinned ones. Combined with the
   100-pin cap (D2), the pinned band cannot grow to swallow the list.

### D8 — Web change surface: no rename, only relocation of state

Because D1 keeps every name, there is **no rename blast radius**. Nothing in
`packages/web/e2e/`, no user-facing copy, no aria-label, no toast, no heading, no doc line, and
no glyph changes. The web diff is confined to *where the state lives*:

| Concern | Change |
|---|---|
| `shellStore.pinnedProjectIds` / `pinnedProgramIds` (`shellStore.ts:80,83,116,125`) | **Deleted.** ADR-0127 records that `shellStore` is session state; persistence moves to the server. Replaced by a `usePinned()` TanStack Query hook. |
| `togglePin` / `togglePinProgram` (`shellStore.ts:81,84,117,126`) | **Names kept.** They become the callbacks returned by a `useTogglePin()` mutation (optimistic update, revert-on-error, following `useUpdateHiddenViews` / ADR-0139). **Every call site in `Sidebar.tsx` and `ProgramCard.tsx` is unchanged.** |
| `PINNED_KEY` / `PINNED_PROGRAMS_KEY` (`shellStore.ts:14,18`) | Become read-once inputs to the D9 migration, then removed. **No new localStorage key is introduced** — the state is server-side now. |
| `PinToggle` (`Sidebar.tsx:1455`) | Promoted to `components/PinToggle.tsx` **unchanged in behavior**, consolidating the duplicate copy in `ProgramCard.tsx:113-143` (identical strings and glyph today). Plus the one fix below. |
| **Touch bug** (`Sidebar.tsx:1477`) | Port `ProgramCard`'s `max-md:opacity-100` onto `PinToggle`. This is the only behavior change to an existing control: today an *unpinned* row's toggle is permanently invisible on touch, so a first pin cannot be created on mobile from the rail. |
| `programListSort.ts` `pinnedIds` | **Unchanged signature.** It is a pure function with no store import; only the caller (`ProgramListPage.tsx:54`) switches its source from the store to `usePinned()`. |
| Vitest | `shellStore.test.ts:51-66` (the `togglePinProgram` store test) is **deleted** — the behavior moved to the server; replaced by hook + migration tests. `Sidebar.test.tsx` / `ProgramCard.test.tsx` / `ProgramListPage.test.tsx` swap `useShellStore.setState({pinned…})` seeding for a mocked `usePinned()`. **Copy assertions are untouched.** |
| Playwright | `shell-rail.spec.ts:120-123` seeds `localStorage.setItem('trueppm.rail.pinned', …)` directly — this **hard-breaks** under server persistence and must become a route mock of `GET /me/pinned/`. `toast-host.spec.ts` (the app-wide toast smoke test, driven by pinning a project) and `programs.spec.ts:879-894` (touch-reveal + 44×44 target) need the same mock swap. **No copy or locator changes in any of the three.** |

**🚫 Untouched, and must stay that way** — grep before committing:
`pinnedMobileViews` / `toggleMobileViewPin` / `trueppm.mobilenav.pinned`
(`shellStore.ts:22,92,94,143`, `BottomNav.tsx:38,39,87,184,185`, `MoreSheet.tsx`,
`bottomNavItems.ts`, `bottom-nav-mobile.spec.ts`); `TaskNote.pinned` and
`TaskAttachment.is_pinned` and their web bindings; and the ~25 prose uses of "pinned" meaning
*anchored/fixed* (TopBar, StatusBar, `formatUtcDate.ts`, "pin a fixed date", "ENFORCE pins the
policy", version pinning in `contributing/`).

**Docs:** no rename edits. Additive only — a new "Pinned projects and programs" section under
`docs/features/` covering cross-device persistence and the new surfaces; an update to
`features/programs.md:42-45` noting pins now follow the user; `docs/api/` + regenerated
`docs/api/openapi.json`; `docs/administration/mcp-server.md` for `list_pinned`.
**Version-tense rule:** 0.4 is *Underway*, not shipped — any new sentence anchoring this to a
version must be future tense ("ships in 0.4"). Behavior prose ("Pinned programs float to the
top") is not a version claim and stays present tense.

### D9 — Migration from the existing localStorage pins

A one-time, client-side, **idempotent** upload — there is no server-side alternative, because
`localStorage` is unreadable from the server and no record of these pins exists anywhere else.

**Two mechanical facts constrain the implementation.** (a) `shellStore` uses **no zustand
`persist` middleware** — persistence is hand-rolled through `readIds`/`writeIds`
(`shellStore.ts:26-41`), so there is **no `version`/`migrate` hook to piggyback on**; the
migration must be written by hand. (b) `readIds()` runs at **module-evaluation time**
(`shellStore.ts:116,125`), i.e. before authentication resolves — so the migration cannot live in
the store's initializer. It runs as a `usePinMigration()` effect in the authenticated shell,
after `/auth/me/` resolves, and it is the last reader of those keys.

```
on first authenticated app load, once per device:
  if localStorage['trueppm.rail.pinsMigrated'] == '1': stop
  local = read('trueppm.rail.pinned') ∪ read('trueppm.rail.pinnedPrograms')
  if local is empty:
      set sentinel; stop                      # no network call
  server = await GET /me/pinned/              # already fetched by the shell for the rail
  for id in (local \ server):
      await POST /{projects|programs}/{id}/pin/
  on full success:  removeItem(both keys); set sentinel
  on any failure:   keep both keys; do NOT set sentinel   # retried next load
```

**Conflict rule: UNION, never replace.** Server pins are authoritative and untouched; local ids
are added on top. Both sets were created deliberately by the same person, `localStorage` carries
no timestamps to reconcile against, and a pin is additive and one click to undo — so the
false-positive cost (one extra pin to remove) is far below the false-negative cost (a silently
lost pin). Per-item idempotency means a partial run is safe to resume.

**Failure modes, stated:**

| Scenario | Behavior |
|---|---|
| Network/500 mid-upload | Keys kept, sentinel unset → full retry next load; already-uploaded ids are no-ops |
| Cap exceeded (>100 union) | Surplus `POST`s 400; client stops, shows one toast ("Some pins couldn't be moved — you have more than 100 pinned items"), **keeps the keys** so nothing is lost |
| Two devices migrate | Union across both — {p1,p2} then {p2,p3} → {p1,p2,p3}. Correct and intended |
| **User unpins on web, then opens a dormant device that still holds the pin** | The pin **comes back**, once, on that device's migration. This is the one genuinely surprising outcome. Accepted: bounded to one occurrence per device, one click to undo. The alternative — a server-side per-device migration ledger — is disproportionate for a bookmark |
| **User never returns to the old device** | Those pins are **lost**, permanently. Unavoidable; there is no server-side record to recover. Mitigation: the migration path and sentinel are **retained through 0.6** (two minor releases) rather than deleted in 0.5, so a device dormant for a release cycle still migrates. Because the new state is server-side, the old keys are never overwritten in the meantime |

**Test coverage:** a vitest suite over the pure migration function — empty local, local-only,
server-only, overlapping, failure-keeps-keys, cap-400-keeps-keys, sentinel-short-circuits.

### D10 — Surfaces (corrections to the issue's Tier-1 table)

| Surface | State today | Action |
|---|---|---|
| Sidebar rail | ✅ present | **Fix the touch bug**: port `ProgramCard`'s `max-md:opacity-100` onto `PinToggle` (`Sidebar.tsx:1477` is the only hover-gated toggle with no touch fallback) |
| `ProgramCard` | ✅ **already present**, touch fix already applied | Source of pinned state switches to `usePinned()`; no other change |
| Project Overview header | ❌ missing | Add to `ProjectHeader`'s `ml-auto` action cluster (`ProjectOverviewPage.tsx:169-272`, cluster at `:233`), left of `Export`. **Note there is no visible `<h1>`** — the page title is `sr-only "Overview"` (`:1018,:1359`) and the project name lives in the TopBar `LocationSwitcher`, so the pin anchors to the action cluster, not to a name |
| Program Overview header | ❌ missing | Add to the identity `<header>` (`ProgramOverviewPage.tsx:372`) — symmetry with project |
| `ProgramProjectsPage` rows | ❌ missing | Row-level toggle leading the trailing action group, before `Remove` (`ProgramProjectsPage.tsx:211`) |
| `UngroupedProjectsSection` rows | ❌ missing | Same row-level toggle (`:24`, section `:74-98`). **This is the only way to reach a standalone project outside the rail** — there is no `/projects` index route (`router.tsx:467` is `projects/:projectId` only), so omitting it leaves ungrouped projects unpinnable from any list surface |
| `/programs` ordering | ✅ present | Server-fed via `usePinned()`. Note pin order is **not** preserved — pinned form a boolean top-partition and the chosen sort key still applies *within* it (`programListSort.ts:100-104`), which is what makes D7 rule 3 true today |
| LocationSwitcher pickers (Tier 2) | ❌ | Read-only "Pinned" group at top; no toggle in the dropdown |
| ⌘K palette (Tier 2) | ❌ | A `pinned` group following ADR-0508's `recent`: cold-visible in the **empty-query state only**, hidden once the user types, so it never duplicates `jump`. Plus a `Pin / Unpin {current project}` command |
| TopBar breadcrumb | — | **Excluded** — wayfinding, width-constrained (rule 174); a write control there is a mis-affordance |
| Tasks / boards / sprints / risks | — | **Out of scope.** Project and Program only |

**Landing behavior is unchanged.** A pin must not rewrite where `/` sends you — that is
`UserProfile.default_landing` (ADR-0129), a separate explicit preference.

---

## Design revision (2026-07-26) — D11–D15

A full visual design for the pin system landed after D1–D10 were written
(`Pin System.html`, Claude Design project `e01d4825`). It agrees with the data model,
the privacy shape, and the surface list, and **supersedes** the "no user-visible churn"
framing of D8 and the Context note that put the glyph out of scope. These five decisions
record where the design won, and the one place it could not be followed literally.

### D11 — Glyph: a map pin, not a star

**Superseded:** Context correction #2 ("the glyph is unchanged by this ADR").

The design is categorical: *"never star, never favourite, never bookmark"*, on the grounds
that a star reads as **rate this** to half an audience and **favorite** to the other half,
while a pin is spatial — *hold this where I can see it* — which is exactly what the rail
group does.

D1 kept the **word** "Pin" and D1.1 accepted the resulting collision. Shipping a star-shaped
glyph under that word was the weakest part of the compromise: the noun, the verb, the group
heading, the endpoint, and the toast all said *pin* while the picture said *star*.

Adopted: the design's teardrop map pin at 16/18/20px, filled with a knocked-out hole when
pinned and stroked when not. Two collisions were checked before adopting it:

- **`Icons.tsx::PinIcon` is a thumbtack**, used for `TaskNote.pinned` / `TaskAttachment.is_pinned`
  / mobile-nav view pins. A teardrop map pin is plainly a different shape, so D1.1's
  *shared vs private* distinction now has a visual carrier it did not have before.
- **`★` is already spoken for** elsewhere in the app — the board lens banner, the CalmToolbar,
  and `SprintClosedOutcome`'s demo-ready marker. Leaving the pin as a star kept a fourth
  meaning on one glyph.

The hole is a genuine `fill-rule="evenodd"` knock-out over a single path, not a
background-colored dot, so it inherits the row, the hover plate, and the focus ring with no
color to keep in sync.

### D12 — Pinned ink stays **neutral**; the design's brand accent is not adoptable here

**The one place the design is not followed literally.** It specifies the pinned glyph in
`--brand-primary` (`#1C6B3A` light / `#7DD3A8` dark). In this token set that is not available
as an accent, because:

```
--brand-primary:      49 111 87    /* light */      --semantic-on-track: 49 111 87
--brand-primary:      102 185 152  /* dark  */      --semantic-on-track: 102 185 152
```

`globals.css:112,130` and `:118,137` — **the same value**. A brand-filled pin therefore renders
in precisely the "On track" health hue, and it lands next to health in both places it is most
used: beside the health chip on the Project Overview header, and beside the health dot on every
rail row. A pinned at-risk project would show an orange dot and a green pin on one line.

The design's own rule settles it — *"No colour-only difference — the glyph fill changes too, so
it survives greyscale and colour-blind vision"* — so hue is decorative here by the design's own
construction, and dropping it costs nothing the design relies on. State is carried by fill
(solid vs outline), ink weight (primary vs secondary), and `aria-pressed`.

The **card accent border** in §4.3 *is* adopted in brand: a border is not confusable with a
health dot, health on that card is a dot plus a word, and nothing else on it uses a tinted
border. Tested by `PinToggle.test.tsx` ("the pinned pin is not a status") and
`ProgramCard.test.tsx`.

> If the brand accent is wanted later, it needs a pin-specific token that is provably distinct
> from `--semantic-on-track` in both themes — not a reuse of `--brand-primary`.

### D13 — Reveal is a pointer **capability**, not a breakpoint

**Supersedes D10's** "port `ProgramCard`'s `max-md:opacity-100` onto `PinToggle`".

`max-md:` fixes phones and leaves the actual gap open: a tablet and a Windows touch laptop are
both **wider** than `md` and neither fires `:hover`, so an unpinned toggle stayed at
`opacity-0` there — a first pin could not be created at all, only found by a lucky tap on an
invisible 44px box. The old E2E guard (`programs.spec.ts`, "pin star is visible without hover
below md") resized the viewport but left Chromium on a *fine* pointer, so it would have passed
against exactly the bug it was meant to catch.

Adopted, in the design's precedence order:

1. **Pinned is always full strength** — a pin you cannot see is a pin you cannot undo.
2. **Unpinned + coarse pointer → 60%, always rendered** (`@media (hover:none),(pointer:coarse)`).
   Not 100%: a dozen fully-lit pins out-shout the names beside them.
3. **Unpinned + fine pointer → hover-revealed**, and on `:focus` regardless of hover.
4. **Never `display:none`** — opacity only, so the control keeps its box, tab order, and
   screen-reader presence at all times.

Rules 1–2 are resolved in **JS from the `pinned` prop**, not by stacking `aria-pressed:` over a
media variant: those are equal-specificity in Tailwind and their order is an implementation
detail of the generator, not something to bet the touch path on.

Also from the design, same decision: **44×44 at every size** (the header was `md:h-7 md:w-7` —
a 28px target, a straight 2.5.5 violation), an **inset** focus ring so a 44px control in a 36px
dense row cannot clip it, and the `sm` size painting a 36px plate while a `before:inset-[-4px]`
bleed restores the 44px target (rule 211 / #2207 — `min-w` would reflow the row).

The design's *last-input-type* subscription for hybrid touch laptops is **not** implemented:
it assumes a tracker this codebase does not have (`useIsCoarsePointer` is a live matchMedia
subscription, not an input-event history). The CSS capability query covers every device that
reports coarse; a mouse-and-touch hybrid still gets the hover-reveal. Filed as follow-up.

### D14 — The toast carries **Undo**; ordering defers instead of floating

**Supersedes D7 rule 3** ("pinned float to the top of every sort"), which shipped as a silent
partition plus the static sentence *"Pinned programs shown first."*

Two defects the design names, both real here:

1. **A silent float reads as a broken sort.** "Depot Electrification, 40m ago" rendering below
   "Northgate, 3d ago" under a control that plainly says *Recently active* is
   indistinguishable from a bug. Adopted: two labelled groups — `Pinned · 3` /
   `Everything else · 9` — each heading carrying its count *and* restating that the chosen
   sort still applies inside it. Real `<h2>`s in presentational `<li>`s, so the grid keeps one
   row track and the list keeps one accessible name and one item count.
2. **Live re-ordering makes every pin feel like a mistake.** Adopted: grouping membership is
   seeded once per mount and then **held still**. Pinning marks the card in place; the move
   lands on the next visit or immediately via **"Re-sort now"** in the toast.

`filterAndSortPrograms` loses its `pinnedIds` parameter entirely — grouping supersedes it, and
leaving a dead float in a pure sort function invites it to be re-enabled by accident.

**Toasts** gain the design's §5.3 shape: `Pinned {name}` / `Unpinned {name}` with **Undo**;
`Pinned {name} — it'll move to the top next time` with **Re-sort now** on a grouped list;
`Couldn't pin {name}` with **Retry**. 6s, 10s on a coarse pointer. **One pin toast at a time** —
a second replaces the first, so the Undo on screen always belongs to the newest pin rather than
to whichever of four identical buttons the user guesses at.

Two deliberate exceptions: the undo of a pin is **silent** (two toasts each offering to undo
the other never terminates), and the **cap error gets no Retry** — it is the one failure
retrying cannot fix.

**A "Pinned first" toggle** persists per browser (`trueppm.programs.pinnedFirst`, default on)
and is the escape hatch: off returns one flat list in pure sort order with pinned cards keeping
their glyph. Sort and grouping are independent controls; neither silently overrides the other.
Searching flattens the groups so relevance is never overridden by pin state mid-search.

### D15 — ⌘K: a Pinned strip, pin commands, and `⌥P` — **not** a bare `P`

D10 anticipated this row; the design specifies it. Adopted:

- A **`pinned` group leading `recent`** in the cold (empty-query) palette, hidden the moment a
  query is typed. Pinned leads because a pin is a standing intent the user declared and a
  recent visit is only where they happened to be.
- **`Pin {name}` / `Unpin {name}` as searchable commands**, query-gated — cold, an Unpin command
  for every reachable project would bury the navigation the palette exists to provide.
- An **in-place accelerator** on the highlighted row that does not close the palette, so
  pinning several projects in one visit is one keyboard sequence.

**The accelerator is `⌥P`/`Alt+P`, not the design's bare `P`.** Focus lives in the palette's
search input by construction, so an unmodified letter has to type — a bare `P` would either
break search or silently not fire. `⌘P`/`Ctrl+P` is Print. `Alt` is the one modifier that is
neither browser-reserved nor already bound in this dialog. The footer advertises the key only
while the highlighted row is actually pinnable; a hint for a key that does nothing is worse
than no hint.

### Deferred from the design — filed, not dropped

| Design section | Why deferred |
|---|---|
| §4.1 manual drag order inside the rail group (`position` column) | New nullable column + migration + a drag-and-drop surface. Independent of everything above; `pinned_at desc` is the design's own documented fallback |
| §4.5 location-picker pinned group + `indicatorOnly` | There is no "Move task to project" picker with pinned grouping in the tree today; adding the prop now would ship an API with no call site |
| §5.3 bulk-pin summary toast ("Pinned 4 projects · Undo") | No multi-select on any pinnable surface yet |
| §7.1 offline queue in IndexedDB | Contradicts **D3** (pins are deliberately outside the sync delta). The shipped behavior — an explicit "you're offline" toast — is the D3-consistent one; revisit only if D3 is revisited |
| §3.4 last-input-type subscription (hybrid touch laptops) | Needs an input-history tracker the codebase does not have — see D13 |

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **One `UserPin`, nullable project XOR program** (chosen) | One model, one endpoint, one serializer, one migration; the merged `/me/pinned/` the rail actually renders; ADR-0076/0214 house pattern; partial uniques double as the annotation indexes | Two nullable columns; a CHECK constraint to maintain |
| Two tables (`ProjectPin` + `ProgramPin`) | No nullable columns, no XOR | Doubles models/serializers/migrations/tests for one concept; `/me/pinned/` needs a UNION or two round trips; no clean total cap across kinds |
| `GenericForeignKey` (contenttypes) | Extends to any entity later | **Zero GFK usage in this repo** — ADR-0075 "team aversion", ADR-0369 "the repo convention — no GenericForeignKey"; ContentType join defeats the `Exists()` index seek; scope is Project+Program only |
| M2M `pinned_by` on Project and Program | Least code | An implicit through table gives no `pinned_at` without an explicit through model (at which point it *is* the two-table option, minus the constraint clarity); a symmetric M2M invites `project.pinned_by.all()` — the exact "who pinned X" query D5 forbids |
| JSON list on `UserProfile` | No new table; rides `/auth/me/` | **ADR-0150 rejected this exact shape**: cannot index or order in SQL, whole blob deserialized on every `/auth/me/`, unbounded growth, lost-update race on concurrent writes |
| Keep localStorage, add the missing controls | Zero backend work | Violates ADR-0599 (a persisted fact outside the API, not one of the three exceptions) and ADR-0139's rejected alternative; invisible to MCP; does not follow the user — i.e. it does not fix either defect |
| `is_pinned` **not** on the list serializers; client joins `/me/pinned/` | Nothing new on the shared payload | Breaks at pagination (`DirectoryPagination` 200/500, ADR-0401) and on any surface rendering a project the pinned fetch missed; the annotation is self-referential and provably safe (D5) |
| `pinned_at` on the project/program serializer | Uniform payload | Puts a per-user **recency** signal on a shared surface — the exact *"hasn't pinned it in weeks"* affordance Morgan named. Confined to `/me/pinned/` |
| Sync-delta collection for pins | Offline pin toggling | Protocol bump + watermark receiver + tombstone registry to carry a boolean; ADR-0142 forbids it by default; every peer per-user model opted out |
| **Rename to "Star"** | Removes the D1.1 collision outright; VoC panel favored it 5–1; glyph already a star so no icon work; measured churn was small (3 E2E specs, 4 vitest files, 2 doc lines) | User-visible churn for zero functional gain — the engineering value of #2390 is entirely the server promotion and the missing surfaces. **Considered and declined by the user**; collision accepted and mitigated per D1.1 |
| Add `me:write` scope now for agent pinning | Agent-complete | Default-permissive capability — fails ADR-0112 RC4 and `ai-review`'s capability-default check; 0.6 owns the scope taxonomy |

## Consequences

**Easier**

- Pins follow the user across browsers and devices, and are a first-class API fact — an MCP
  client can finally answer *"what are my pinned programs?"* (ADR-0599 satisfied).
- **Zero *vocabulary* churn.** No copy, aria-label, or heading changes — the noun, the verb,
  the group, and the endpoint all still say *pin*. (The **glyph** does change, star → map pin,
  per D11; that is a picture change, not a rename, and it makes the word and the icon agree
  for the first time.)
- `is_pinned` costs one `Exists()` per list query on an index that already exists for the unique
  constraint — no N+1, no new query class.
- `shellStore` sheds two persisted collections and gets closer to its ADR-0127 charter
  (session state only).
- The privacy posture is *structural* (annotation bound to `request.user`, no aggregate surface,
  no admin page) and *tested* (`test_no_cross_user_pin_leak`), not merely asserted.
- The duplicated `PinToggle` / `ProgramCard` toggle collapses into one component, and the
  Sidebar touch bug is fixed on the way through.

**Harder / caveats**

- **`pinned` now carries two opposite privacy semantics in one API** (D1.1). Accepted
  deliberately; mitigated by the mandatory OpenAPI descriptions and the schema test that keeps
  them present. Future readers of `TaskNote.pinned` and `Project.is_pinned` must not assume
  symmetry, and reviewers should watch for a "make pinning consistent" refactor that would
  quietly widen the private one.
- Toggling a pin is now a network round trip. Mitigated by optimistic update + revert-on-error;
  a failed toggle must surface a toast, not silently revert (the #2149-#2151 silent-write rule).
- The XOR `CheckConstraint` must be honored by every writer. Only the two `@action`s write, and
  each sets exactly one FK — but a future third target kind is a migration, not a field add.
- One-way localStorage migration: pins on a device never revisited before 0.6 are lost, and a
  dormant device can resurrect one unpinned item exactly once (D9).
- The 100-pin cap is a new user-facing limit that did not exist for localStorage pins.

**Risks**

- **Privacy regression by accretion** — the highest-consequence risk, and D1.1 raises it: because
  `TaskNote.pinned` *is* a shared, queryable, Member+-toggleable field, a future contributor
  reasoning by analogy could add `pinned_by` or `pin_count` to Project/Program believing it
  matches existing precedent. Mitigated by the six normative rules in D5, the guard test, the
  docstring, and the requirement that any such addition supersede this ADR. This risk is
  strictly higher than it would have been under the "Star" naming and is the accepted cost of D1.
- **E2E**: `shell-rail.spec.ts` currently seeds pins through `localStorage`; it must switch to
  mocking `GET /me/pinned/`, and every spec navigating a surface that now reads that endpoint
  needs it mocked with its real shape (the catch-all list envelope will not do for an
  object-shaped read). `toast-host.spec.ts` and `programs.spec.ts` need the same swap.

## Implementation Notes

- **P3M layer:** Programs and Projects / Operations — per-user navigation state; no
  cross-program aggregation.
- **Affected packages:** `api` (`profiles` model + migration + serializer + view; two `@action`s
  and two annotations in `projects`), `web` (store removal, hooks, `PinToggle` promotion +
  touch fix, four surfaces, migration, ⌘K + LocationSwitcher), `mcp` (`list_pinned` tool),
  `website` (docs). **Not** `mobile` (D3), **not** `scheduler`, **not** `helm`.
- **Migration required:** **yes** — one migration in `profiles`, creating `UserPin` with its
  XOR check, two partial uniques, and one index. Purely additive; no backfill (the localStorage
  migration is client-side, D9). Follow the CLAUDE.md recipe: batch the model edit, run
  `makemigrations` once, then `ruff check --fix` + `ruff format` on the generated file.
- **API changes:** **yes** — `POST|DELETE /projects/{id}/pin/`, `POST|DELETE
  /programs/{id}/pin/`, `GET /me/pinned/`, and read-only `is_pinned` on `ProjectSerializer` /
  `ProgramSerializer`, each carrying the D1.1 description. Merge `origin/main` **before** running
  `scripts/export-openapi.sh`. `packages/web/src/api/types.ts` is hand-maintained — update it in
  the same commit.
- **OSS or Enterprise:** **OSS** (`trueppm-suite`). Registers against no enterprise hook;
  `grep -r "trueppm_enterprise" packages/` stays at zero imports. The ADR-0139 §7 seam for a
  future Enterprise "admin pins for everyone" layer stays open: compose it at the single
  `usePinned()` selector, and it must carry a visible disclosure indicator, never a silent
  override.
- **Gates from here:** `ux-design` (four new surfaces) → implement → parallel pre-MR batch
  (`regression-check`, `security-review`, `rbac-check`, `perf-check`, `migration-check` —
  **no** `broadcast-check`, no board-scoped write) → `ai-review` (MCP surface touched) →
  `ux-review` → `test-scaffold` → `api-docs` → `docs-writer` → `changelog` → MR.

### Durable Execution

1. **Broker-down behaviour:** **N/A** — a pin write is a single synchronous DB row
   insert/delete. It enqueues no Celery work, triggers no CPM recalculation, and dispatches no
   outbox row. Nothing to lose if the broker is down.
2. **Drain task:** **N/A** — no async category is introduced, so no new Beat drain and none
   reused.
3. **Orphan window:** **N/A** — no outbox rows, therefore no drain and no orphan filter.
4. **Service layer:** new synchronous `profiles/services.py::set_pin(user, *, project=None,
   program=None, pinned: bool) -> UserPin | None` — enforces the XOR, enforces
   `TRUEPPM_MAX_USER_PINS`, and performs the `get_or_create` / hard delete. Both `@action`s go
   through it so the cap and the XOR are enforced in exactly one place. It does **not** call
   `enqueue_recalculate()`.
5. **API response on best-effort dispatch:** synchronous `200 {"is_pinned": true,
   "pinned_at": …}` on POST and `204` on DELETE. **Not** `{"queued": true}` — there is no async
   handoff.
6. **Outbox cleanup:** **N/A** — no outbox rows are written.
7. **Idempotency:** the `(user, project)` / `(user, program)` partial unique constraints are the
   idempotency keys. `POST` is `get_or_create` — a repeat returns the existing row's
   `pinned_at` with no write and no timestamp churn. `DELETE` is a filtered delete — a repeat
   removes zero rows and still returns `204`. This is what makes D9's retry loop safe. Rows are
   removed by `CASCADE` when the user, project, or program is hard-deleted; a project
   *soft*-delete leaves the row, which `/me/pinned/`'s membership re-filter simply stops
   returning.
8. **Dead-letter / failure handling:** synchronous request/response, so there is no async
   failure surface. Validation/cap → `400`; non-member → `403`; unknown or unreadable
   project/program id → `404` (never a 403, so the endpoint is not an existence oracle); an
   agent token attempting a write → `403`, itself recorded on the `AgentAction` chain as
   `REFUSED` / `POLICY` / `CAPABILITY_SCOPE`.

## Resolved questions

1. **Vocabulary — RESOLVED: keep "Pin".** The user's recorded decision on #2390 stands. The
   findings surfaced by this gate — that `pin` already means *shared, Member+-toggleable* on
   `TaskNote.pinned` / `TaskAttachment.is_pinned` in the same schema, that the shipped glyph is
   already a star, and that the measured rename cost was only ~3 E2E specs + 4 vitest files + 2
   doc lines — were put to the user explicitly and Pin was chosen anyway. The resulting collision
   is recorded, justified, and mitigated in **D1.1**. Endpoints and fields therefore use `pin`.
2. **VoC panel average (4.8) — RESOLVED: proceed.** It scored a *vocabulary* question, not the
   feature; every persona correctly measured a wayfinding convenience against their headline
   criteria. Morgan scored the feature 7/10. Not a scope signal, so the `< 6 → rethink scope`
   rubric line does not apply.

## Open questions

3. **🟡 Cap value and shape.** D2 proposes **100 total across both kinds**, env-overridable via
   `TRUEPPM_MAX_USER_PINS`. Alternatives: no cap (unbounded rail band — weakens Janet's 🟡),
   or per-kind caps (50/50). Confirm 100-total, or name the number.

4. **🟡 Merged vs split `/me/pinned/`.** D4 proposes **one** endpoint returning both kinds with
   a `kind` discriminator, because the rail renders one Pinned band and two calls would be a
   waterfall. Confirm, or split into `/me/pinned/projects/` + `/me/pinned/programs/`.

5. **🟡 Scope of the `is_pinned` annotation.** D4 annotates unconditionally on both list and
   detail. ADR-0401 warns that *"every list consumer pays the aggregation"* — here the cost is a
   single indexed `Exists()`, well below the health-summary aggregation that warning was about,
   so unconditional is proposed. If you want it behind ADR-0125's `?fields=` sparse-fieldset
   machinery instead, say so now; retrofitting it later is a breaking payload change.
