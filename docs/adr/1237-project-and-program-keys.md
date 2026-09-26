# ADR-1237: Project and program keys — `code` becomes the unique key, resolved to the UUID at the edge

## Status

Accepted (2026-09-26)

> **Implementation status (2026-09-26, #4148):** design only. Nothing in this ADR is on
> `main`. Verified against `packages/api/src/trueppm_api/apps/projects/models.py`
> (`Project.code` is `CharField(max_length=12, blank=True, default="")`, `Program.code`
> is `CharField(max_length=40, blank=True, default="")`, neither unique) and
> `packages/web/src/router.tsx` (routes are `projects/:projectId` / `programs/:programId`,
> UUID-valued).

## Context

P3M layer: **Programs and Projects**. A key addresses one project or one program inside
one workspace; nothing here aggregates across programs. OSS.

UUIDs are the canonical identifier and stay that way. What users paste into Slack, type
into a browser, and cite in a governance pack is not a UUID, and #50 / ADR-0016 shipped
only the per-object half of a human identifier (`short_id`, rendered `T-10`, `SP-10`,
`<CODE>-R-7`). The project half — the `<CODE>` — is optional and non-unique, so it cannot
address anything.

#2025 made `code` non-unique because the model had no workspace to scope a constraint
to. `Workspace` is now a singleton and hosted multi-tenancy is schema-per-tenant
(ADR-0189), so "unique across the install" *is* "unique per workspace". That reason no
longer holds.

Facts that shape the decision, read from the tree on 2026-09-26:

- **The shipped reference separator is `-`, not `#`.** `format_short_id_display` renders
  `T-10` / `SP-10`; the Risk serializer renders `<CODE>-R-7` (#929, #520). ADR-0016's
  `{slug}#000A3F` form was never the shipped display.
- **`validate_code` allows interior hyphens** (`[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?`, ≤12),
  so a key like `GA-SEC` exists today and a `-`-separated reference must parse around it.
- **`Program.code` is not project-shaped.** Every sample and seed persists its lowercase
  `program.slug` (`atlas-platform-launch`, ≤40) into `Program.code`, and seed re-import
  (`seed/replace.py`, `seed/importer.py`) keys on that value, scoped to programs the
  importer owns. There is no `validate_code` on the program serializer.
- About 41 web files read `:projectId` from the route.

A simulated persona panel (not user research) surfaced five constraints; they are
handled below and named where they bind: making `code` **required** on create would
break existing API and importer callers; editing a key would 404 every shared key link;
a trashed project's key could be reused and point an old link at a different project;
during a rolling upgrade an old pod writes `code=""` against the new constraint; and
`KEY#…` fights both Jira muscle memory and our own shipped `-R-` form.

## Decision

### 1. The field stays `code`; the server derives it when omitted

No `key` rename. Renaming the API field is a second breaking change on top of the
constraint, for vocabulary alone. Docs and UI copy call it the project **key**; the wire
name stays `code`.

`code` is **not required** on create. When a create omits it or sends `""`, the service
derives one from the name (`derive_key(name, kind)`: uppercase initials/letters, a
numeric suffix on collision — `PLAT`, `PLAT2`). Importers (MS Project, P6, CSV, seed)
go through the same path. A client that never sent a code keeps working and now gets
one back.

### 2. Format

| | Project key | Program key |
|---|---|---|
| New keys | `[A-Z][A-Z0-9]{1,9}` — **no hyphens** | `[a-z0-9](?:[a-z0-9-]*[a-z0-9])?`, ≤40 — slug |
| Comparison | case-insensitive | case-insensitive |
| Existing values | grandfathered as-is (hyphens, ≤12) | grandfathered as-is |
| URL | `/projects/PLAT/…` | `/programs/atlas-platform-launch/…` |

Project keys lose hyphens for *new* values so a reference is `-`-separated like Jira and
like the shipped `PLAT-R-7`: `PLAT-T-10`, `PLAT-SP-3`, `PLAT-R-7`. Existing hyphenated
codes are not rewritten — the backfill changing a code someone typed is exactly the
surprise the panel flagged — and they still parse, because the resolver splits on the
**rightmost** `-(T|SP|R)-<n>` marker (`GA-SEC-T-10` → key `GA-SEC`, task 10).

Program keys stay slugs because seed replace keys on them; forcing them into the project
shape would rewrite every sample program's code and re-key seed import for no
addressing gain. The two namespaces are separate: `ATLAS` may be both a project key and
a program key, and the route (or the resolver's `kind`) disambiguates.

Reserved words (both kinds): `new`, `settings`, `trash`, and any value matching the UUID
pattern, so a key can never shadow a route segment or be mistaken for a UUID.

### 3. One key table, keys are never reused

A new model `ObjectKey`:

```python
class ObjectKey(models.Model):
    id = UUIDField(primary_key=True, default=uuid4)
    kind = CharField(choices=[("project", ...), ("program", ...)])
    key = CharField(max_length=40)
    project = ForeignKey(Project, null=True, on_delete=SET_NULL)
    program = ForeignKey(Program, null=True, on_delete=SET_NULL)
    is_current = BooleanField()
    # Why this key exists: typed by a user, derived because a create omitted it,
    # or rewritten by the 0.4 backfill. "Why is my project PLAT2?" is answerable
    # from the row, not from an upgrade log nobody kept.
    source = CharField(choices=[("user", ...), ("derived", ...), ("backfill", ...)])
    created_by = ForeignKey(User, null=True, on_delete=SET_NULL)
    created_at = DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            UniqueConstraint(F("kind"), Upper("key"), name="objectkey_kind_key_uniq"),
            # exactly one of project / program set while the owner exists
        ]
```

Every key a project or program has ever held is a row. The unique constraint spans
**current and retired** keys, so the namespace is enforced by the database, not by a
service-layer check across two tables.

- **Who can edit a key:** whoever can already edit the project's (program's) General
  settings — `assign_key()` is called from the existing `PATCH` path, so it inherits that
  endpoint's permission class, its agent write gate, and its history/audit record rather
  than defining its own. There is no separate key endpoint to gate.
- **Editing a key** (the minimal half of #3888's alias table, pulled into 0.4): the old
  row flips `is_current=False`, a new current row is inserted, `Project.code` /
  `Program.code` is updated — one transaction, one `assign_key()` service. The resolver
  honors retired rows, so every shared link keeps working and is rewritten to the
  current key. At most 10 retired keys per object (see Threat model). #3888 keeps the rename UX, MCP payloads, `⌘K`, and the citation display.
- **Trash / restore:** a trashed project keeps its rows; its key stays reserved, so
  restore can never collide.
- **Purge (hard delete):** `SET_NULL` leaves the rows as tombstones. A purged project's
  key is **never reissued**, so an old link 404s rather than opening a different project.
  That is Jira's rule and the one the panel asked for.

`Project.code` / `Program.code` remain as the denormalized current key (read on every
serializer that already reads them), with their own case-insensitive unique constraint.

### 4. Migration and the rolling-upgrade window

One migration per model family, in this order (migration rule 7):

1. `CreateModel(ObjectKey)`.
2. `RunPython` repair: for every project/program with a blank code, derive one; for
   every case-insensitive duplicate, keep the oldest row's code and suffix the rest
   (`PLAT`, `PLAT2`). Write one current `ObjectKey` row per object. Record every rewritten
   code into the upgrade log, and the upgrade notes tell operators which query lists them.
3. `AddConstraint` on `Upper("code")` **with `condition=~Q(code="")`**.

The partial condition is the rolling-upgrade answer (migration rule 8). `values-prod.yaml`
ships `replicaCount: 2` with the default RollingUpdate, so an **old** pod can still
create a project with `code=""` after the migration runs. A full unique index would 500
its second such create. With the blank-excluded condition the old pod's insert succeeds,
and the new code heals it: the resolver treats a blank-coded project as UUID-only, and
the first `assign_key()` touch (or the next release's repair step) derives its key. The
blank exclusion is dropped, and a `CheckConstraint(code <> "")` is added, in 0.5, after
one full release in which no code writes a blank.

**Residual gap, accepted (migration-check 🟡):** the window is covered for a *blank*
code, not for a *typed, non-blank* one. An old pod (pre-0.4 image, no `assign_key()`)
can still save two case-insensitively identical non-blank codes during the window —
the partial index does not exclude those, so the second `INSERT`/`UPDATE` surfaces as
an unhandled `IntegrityError` (a 500), not the graceful 400 a new pod's serializer
gives. Accepted rather than closed further: it needs two users to type the *same*
non-blank code inside a minutes-long rollout window, which self-resolves the moment
every pod is on the new image — and an old pod cannot be patched retroactively to
catch it gracefully.

### 5. Resolver

`GET /api/v1/resolve/?ref=<ref>&kind=project|program` →
`{type, id, project_id, program_id, key, canonical_ref}`

- `ref` is a key, a retired key, a UUID, or `<KEY>-<T|SP|R>-<n>`; `type` is `project`,
  `program`, `task`, `sprint` or `risk`. `key` and `canonical_ref` are always the
  **current** form, so a client holding a retired key learns the new one.
- **Visibility is the queryset, not a check after the lookup.** The lookup runs against
  projects/programs the caller can read — membership **intersected with the token's
  `project_scope`** for an agent or project token. Anything outside that set, and
  anything that does not exist, returns the **same** `404 {"detail": "Not found."}`,
  byte for byte. The body never contains a name.
- Throttle scope `resolve` (per user), in the same bucket as the key-availability check
  below.
- Read-only, no side effects, no audit event. It carries no computed value, so no
  `_provenance` envelope.

### 6. Key availability and suggestion

`GET /api/v1/keys/?kind=project&name=<name>` → `{suggestion}` and
`GET /api/v1/keys/?kind=project&key=<KEY>` → `{available, suggestion}`. They back the
create form's live suggestion and inline check; `POST`/`PATCH` still validate, and a race
lost between check and save returns a `400` on `code` naming the conflict ("already in
use"), never the holder.

**This is an existence oracle, and it is accepted.** A workspace-unique namespace
cannot refuse a taken key without saying it is taken, so a user can learn that *some*
project holds `ACME`, even one they cannot see. They learn nothing else: no name, no
UUID, no type beyond the `kind` they asked about. Jira has the same property. The
resolver's 404-indistinguishability protects **what** a key points at; it was never able
to hide **whether** a key is taken, and this ADR says so rather than implying otherwise.
`threat-model` reviews this trade explicitly.

### 7. Web

- Routes keep their param names (`:projectId`, `:programId`, `:taskId`) but accept a key,
  a retired key, or a UUID. A route-boundary component resolves the param once
  (TanStack Query key `['resolve', kind, ref]`, long `staleTime`), provides the UUID
  through context, and `history.replace`s the URL to the current key form. It skips the
  network when the param is a UUID whose project is already in cache.
- **The web never parses a reference.** Splitting `GA-SEC-T-10` into key and marker,
  honoring retired keys, and deciding visibility all happen in the resolver; the
  boundary passes the raw param through. A client-side parser would be a second
  implementation an MCP or headless client could not share.
- Components read the UUID from `useProjectId()` / `useProgramId()`, never from
  `useParams()`. Every API call keeps using the UUID. The ~41 files that read the param
  directly are migrated in the same MR; a lint rule bans `useParams().projectId` outside
  the boundary.
- Task routes use the display form: `/projects/PLAT/tasks/T-10`. A raw hex `short_id` or
  a UUID resolves too and is rewritten.
- An unknown or invisible key renders the existing not-found page. The UI does not
  distinguish the two cases.
- Create forms (project, program) suggest the key from the name as the user types,
  debounced against `/keys/`, and let the user edit the suggestion before saving.

## Threat model (STRIDE, design stage)

**Assets:** the key→object mapping (internal: a key names a project to anyone who can see
the URL); the set of taken keys (internal, and deliberately not confidential, see §6);
object visibility (confidential: which projects exist and what they are called).

**Boundaries crossed:** Internet↔API only (1). No Celery, no new broadcast payload (the
existing `project_updated` event already carries `code` to the project's own
subscribers), no extension point, no sync-protocol change.

| Threat | Where | Mitigation / accepted risk |
|---|---|---|
| **I** — resolver distinguishes "hidden" from "missing" | `/resolve/` | One queryset already scoped to readable ∩ `project_scope`, so there is no second lookup to time. Byte-identical 404 body. A retired key of a hidden project is also a 404. Tests assert body **and** status equality across all four cases (missing, hidden, out-of-token-scope, retired-hidden). |
| **I** — "key taken" oracle | `/keys/`, `POST`/`PATCH` 400 | **Accepted** (§6). Leaks existence only, never the holder. `suggestion` leaks the same class (that `PLAT` and `PLAT2` are taken) and nothing more. Throttled under scope `resolve`. |
| **I** — keys in URLs reach logs and history | web routes | A key is less opaque than a UUID. Off-site `Referer` is already cut to the origin (`Referrer-Policy: strict-origin-when-cross-origin`, nginx and Helm, #3553). **Accepted:** keys are labels, not secrets; the settings help text says not to put confidential words in a key. |
| **S** — look-alike or route-shadowing keys | format | ASCII-only regex (no homoglyphs); reserved words; a value shaped like a UUID is rejected, so a key can never be mistaken for, or shadow, a UUID route. |
| **S** — an old link silently repointed | purge / reuse | Keys are never reissued (§3). A purged project's link 404s. |
| **T / E** — who can change a key | `PATCH` | Inherits the endpoint's existing gate and agent write gate (§3). `rbac-check` confirms the class at implementation. No new endpoint writes a key. |
| **R** — who renamed it | `ObjectKey` | `created_by`, `source` and `created_at` on every row, plus the project's existing history record of the `PATCH`. |
| **D** — namespace squatting and row growth | `ObjectKey` | Project creation is open to any authenticated member, and a rename loop would reserve keys forever. **Cap: 10 retired keys per object.** The 11th rename returns a 400 naming the cap. Creation-based squatting is bounded by the existing create throttle, and it is no worse than squatting names today. |
| **D** — resolver as a scan engine | `/resolve/`, `/keys/` | Per-user throttle scope `resolve`. Lookups are single indexed queries on `Upper(key)`. |

**Top risks:** (1) a future refactor adds a "fast path" (`ObjectKey.objects.get(...)`
followed by a permission check) that reintroduces the hidden/missing distinction. The
four-case equality test is the tripwire. (2) The existence oracle is misread later as a
bug and "fixed" by making `/keys/` member-scoped, which silently allows duplicate keys.
§6 documents it as a deliberate trade. (3) A web component reads `useParams()` and sends
a key to a UUID-typed endpoint. Blocked by the lint rule in §7.

**SOC 2 mapping:** scoped resolver and inherited write gate → CC6.1 (logical access);
`ObjectKey` actor/source rows → CC7.2 (monitoring and change evidence); throttles →
CC6.6 / A1.1 (protection against abuse, capacity).

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| Separate `slug` field | Leaves `code` untouched | A third identifier beside UUID and code; decided against in #4148 |
| Rename `code` → `key` on the wire | Vocabulary matches the UI | A breaking change on 21 operations for a word |
| `code` required on create | Simplest invariant | Breaks every existing create caller and importer (the panel's 🔴) |
| `KEY#000A3F` references | Unambiguous with hyphenated keys | Disagrees with the shipped `PLAT-R-7`; `#` must be URL-encoded; alien to Jira users |
| Normalize program codes to project format | One key shape | Rewrites every sample program's code; re-keys seed replace |
| Freeze keys after create (no alias) | No alias model in 0.4 | A backfilled `PLAT2` cannot be fixed until 0.5 |
| Editable keys, no alias | No new model | Every rename silently breaks shared links |
| Alias as a second table, uniqueness in the service | Smaller migration | Uniqueness across two tables is a race; `ObjectKey` puts it in one index |
| Full unique index (no blank condition) | Stronger constraint now | Old pods 500 on project create during a rolling upgrade (rule 8) |
| Key-accepting REST routes (`/projects/PLAT/tasks/`) | No resolver hop | ~45 view sites read `kwargs["project_pk"]`; widens the RBAC surface |

## Consequences

- **Easier:** readable, pasteable, stable URLs; `PLAT-T-10` means the same thing in Slack,
  in the URL, and in a risk ID; old links survive renames; seed replace becomes
  unambiguous (its two-candidate 409 paths become unreachable and can be retired in a
  follow-up).
- **Harder:** one more model and one more resolution hop on a cold load of a key URL; a
  web-wide migration off `useParams()`; the upgrade may rewrite some users' codes (logged
  and documented, but visible).
- **Risks:**
  - The existence oracle (§6), accepted and documented.
  - A blank-coded project can exist for one release window (§4) and is addressable only
    by UUID while it does.
  - Retired keys accumulate for good. Negligible at workspace scale.

## Implementation Notes

- P3M layer: Programs and Projects
- Affected packages: api, web (and the website docs)
- Migration required: yes. `ObjectKey`, the repair, and the partial unique constraints
  on `Project.code` / `Program.code`
- API changes: yes.
  - New `GET /api/v1/resolve/` and `GET /api/v1/keys/`.
  - `code` gains derivation on create and uniqueness validation.
  - Program `code` gains format validation for new values.
  - `openapi.json`, `types.ts`, and the e2e schema-guard fixtures are updated.
- OSS or Enterprise: OSS
- Upgrade note: blank and duplicate codes are backfilled, and the notes say how to list
  the rewritten ones.
- Out of scope (stay in #3888, 0.5): MCP payloads, `⌘K` lookup, citation display
  everywhere, and the rename UX beyond the settings field.

### Durable Execution

1. Broker-down behaviour: N/A. Every path is synchronous in the request; nothing is
   dispatched.
2. Drain task: N/A. There is no async work.
3. Orphan window: N/A.
4. Service layer: new functions `derive_key()` and `assign_key()` in
   `apps/projects/services.py`. Every write of `code` goes through `assign_key()`.
5. API response on best-effort dispatch: N/A. Responses are synchronous `200`/`201`/`400`/`404`.
6. Outbox cleanup: N/A.
7. Idempotency: `assign_key()` is a no-op when the key is already current. The unique
   index makes a concurrent duplicate a `400`, never two rows.
8. Dead-letter / failure handling: N/A. A failure is a synchronous `400` to the caller.

### On Acceptance

- [x] Open issues naming this ADR re-read against the settled decision:
      `python3 scripts/adr-accepted-issue-sweep.py --adr 1237` → 0 (no issue named the
      ADR before acceptance).
- [x] Pre-ADR scope rewritten: **1** — #4148's body now leads with a dated correction
      note (2026-09-26) listing the five superseded points; its title still holds. #3888's
      remaining 0.5 scope does not conflict.

## UX specification

### Object → lens map

| Object | Scope | Edition | Relationships | Lens |
|---|---|---|---|---|
| Project key (`Project.code` + `ObjectKey`) | workspace | OSS | names one Project; prefixes `T-`/`SP-`/`R-` refs | Sarah: the label on the governance pack · Priya: the thing in the link she pastes · Theo/Nadia: an address the resolver turns into a UUID |
| Program key (`Program.code`) | workspace | OSS | names one Program; seed-replace identity | Sarah: the program's URL name |

One object, no new mental model: the field the settings page already calls **Project
code** is the key. UI copy changes from "Project code" to **"Project key"** and from
"Program code" to **"Program key"**. The wire name stays `code`.

### 1. Create: `NewProjectModal` and `NewProgramModal`

Placement: directly **below Name**, above Program (project) / Methodology (program).
Same `label` + `input` markup and classes as Name, with `tppm-mono` added, width
`w-[160px]` (project) / `w-full` (program, slugs are long).

```
Name *
[ Platform Migration                        ]
Key
[ PM        ]  ✓ Available                        ← status line, text-xs
Used in links and IDs like PM-T-12. You can change it later.
```

- **Suggestion.** While the key field is *untouched*, it follows Name: 300 ms debounce →
  `GET /keys/?kind=…&name=` → the field's value is set to `suggestion`. Nothing is
  suggested for an empty Name, and the field stays empty.
- **Touched.** The first keystroke in the key field marks it touched. From then on Name
  no longer drives it. Clearing the key field completely un-touches it, so it resumes
  following Name. Project input is uppercased as typed (the existing settings behavior);
  program input is lowercased as typed.
- **Availability.** A touched value is checked with a 300 ms debounce via
  `GET /keys/?kind=…&key=`. The status line (`role="status"`, `aria-live="polite"`) shows
  one of:
  - `✓ Available`, in `text-status-success`.
  - `Checking…`, in secondary text, shown only if the check takes over 300 ms. No spinner.
  - `Already in use — try PM2`, in `text-status-danger`, where `PM2` is a button that
    sets the field to the suggestion.
  - A format error, in `text-status-danger`: `Letters and digits only, starting with a
    letter, 2–10 characters` (project) or `Lowercase letters, digits and hyphens, up to
    40 characters` (program). The format check is client-side and instant, and it
    suppresses the network check.
  - `That word is reserved`.
- **Submit.** Submit stays enabled while the check is pending, because the server
  re-validates. It is disabled only for a format error or a confirmed "in use". If `POST`
  returns 400 on `code`, the status line shows the server's message, focus moves to the
  key field, and nothing else resets.
- **Blank submit** is legal: the server derives the key. This happens only if the user
  cleared the key and Name is also still resolving.
- The input has `aria-describedby` pointing at the status line and the hint.

### 2. Settings: General page (project and program)

The existing `FieldRow` is relabeled **"Project key"** / **"Program key"**. The hint
becomes `Used in links and IDs like PM-T-12. Letters and digits, 2–10 characters.` (the
program variant says `Used in this program's link.`). Same availability status line and
debounce as create, but it checks only when the value differs from the saved key.

When the value differs from the saved key, one line appears under the status line,
`text-xs text-neutral-text-secondary`:

> Old links using **PLAT** will keep working and open this project. **PLAT** can't be
> used by another project.

The save bar commits as it does today. No modal, because a rename is recoverable (rename
back; the old key is still this project's).

**Cap.** When the object already has 10 retired keys, the input is `readOnly`. The hint is
replaced by `This key has been changed 10 times, the most allowed. Contact your workspace
admin` (the cap is fixed in 0.4; the copy states the fact and nothing more). If the
server returns the cap 400 anyway, it shows in the status line.

**Permissions.** A caller who can't edit General settings already sees the page
read-only. The key renders as plain `tppm-mono` text with a copy-link button
(`aria-label="Copy project link"`), which copies the key URL.

### 3. Key URLs

- **Resolving.** On a cold load of `/projects/PLAT/…` the route boundary renders the
  **existing ProjectShell skeleton**: no spinner, no blank frame, no new component. The
  resolve is one request, and TanStack Query de-duplicates it with the project fetch
  that follows.
- **Rewrite.** On success, `history.replace` to the current key form, preserving the
  rest of the path, query and hash. There is no toast and no visual change. A retired
  key or UUID URL simply becomes the current one in the address bar.
- **Not found.** A 404 renders the existing `ProjectNotFound` (`This project isn't
  available`, the same state as a UUID the user can't see), with the same copy, because
  the two cases must be indistinguishable. Programs use their existing not-found
  equivalent.
- **Unknown task ref** under a valid project (`/projects/PLAT/tasks/T-999`): the project
  renders and the task panel shows the existing task-not-found state.
- **Offline.** A key URL whose resolution is in the query cache works offline. An
  uncached key URL while offline shows the existing offline banner over the
  `ProjectNotFound` body, with copy `This link needs a connection the first time it's
  opened.` UUID URLs keep working offline as today.
- **Mobile (320–428px).** No layout change. The create key field stacks full-width under
  Name, and the status line wraps. Tap targets are the existing inputs (h-9 / h-8).
  The "try PM2" button is padded to a 44px hit area with `py-3 -my-3`.

### API dependencies

`GET /api/v1/keys/?kind=&name=` · `GET /api/v1/keys/?kind=&key=` ·
`GET /api/v1/resolve/?kind=&ref=` · `POST /api/v1/projects/`, `POST /api/v1/programs/` ·
`PATCH /api/v1/projects/{id}/`, `PATCH /api/v1/programs/{id}/`. No new WebSocket event:
`project_updated` / `program_updated` already carry `code`, and a peer who is viewing
the project rewrites their URL on the next render (the boundary re-derives the key from
the cached project).
