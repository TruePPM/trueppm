# ADR-0215: Unified Assets surface (project + program)

## Status
Accepted

## Context

Reference material for a project lives scattered across individual tasks in two separate
child relations:

- **`TaskAttachment`** (`apps/projects/models.py`) — a `file` XOR `external_url`, with
  `external_title`. Plain `models.Model`, `related_name="attachments"`.
- **`TaskLink`** (`apps/integrations/models.py`) — the git/cloud-file external-link model
  (#970/#571), `VersionedModel`, `related_name="links"`. This is where `custom_title`,
  `labels`, `provider`, `status`, and `preview_type` live (**not** on `TaskAttachment` — the
  issue framing conflated them).

There is **no aggregation endpoint** for either at project or program scope. A PM running a
program cannot answer "what specs / PRs / reference docs exist across this project (or across
the program's projects)?" without opening tasks one at a time. Issue #971 adds a unified,
read-only **Assets** surface that aggregates both models per Project and per Program.

**P3M layer:** Programs and Projects → **OSS**. Per the adoption-vs-governance test and the
Program=OSS rule: Project Assets and *within-a-single-program* Assets both serve a PM/program
manager running their own program. Cross-program / portfolio asset rollups are Enterprise and
out of scope (they would register against the existing extension points). VoC value is the
issue's own motivation — the PM persona at the Programs-and-Projects layer needs this to run a
program; the classification is unambiguously OSS, so a full VoC panel was not separately run
(noted per the CLAUDE.md carve-out for a clearly-motivated, single-persona OSS feature).

**Forces:**
- The RBAC boundary must be exactly "no asset a user can't already see via its task." Both
  models expose a `project_id` property, so the per-task boundary is the parent project's
  membership (`IsProjectMember`) — there is no finer object-level gate to replicate.
- Aggregating two different tables (in two apps, one a `VersionedModel` and one not) into one
  paginated, sorted feed is the core technical problem. Naively loading every row to merge in
  Python is unbounded for a large program.
- The program query path exists and has a canonical precedent: `ProgramViewSet.task_search`
  narrows to the caller's **readable** member-projects via one `ProjectMembership` query, then
  filters by `project_id__in=readable`.

## Decision

Add **read-only aggregation endpoints** that unify `TaskAttachment` + `TaskLink` into a single
`AssetItem` shape:

1. **Endpoints:**
   - `GET /api/v1/projects/{project_pk}/assets/` — `[IsAuthenticated, IsProjectMember]`.
   - `GET /api/v1/programs/{program_pk}/assets/` — `[IsAuthenticated, IsProgramMember]`, then
     narrowed to the caller's readable member-projects (copy the `task_search` pattern:
     `ProjectMembership.objects.filter(project__program=program, user=user, is_deleted=False)`
     → `project_id__in=readable`). A program member with no readable child projects gets an
     empty list, never a 403 leak.

2. **Unified `AssetItem` serializer shape** (read-only):
   ```
   { kind: "file" | "link",
     id, title,                       # file: external_title or file_name; link: custom_title or title or url
     url,                             # link.url; file: null (use download)
     download_url,                    # file: signed_url action target / null for external_url attachments; link: null
     provider, status, preview_type,  # link only; null for file
     labels: [str],                   # link only; [] for file
     task: { id, name },
     added_by, added_at }             # attachment.uploaded_by/created_at; link.created_at (+ link has no uploader → null)
   ```
   `is_deleted=False` on both sources. Files never expose the raw storage path; a signed
   download URL is produced on demand via the existing attachment `signed_url` action (external-URL
   attachments surface their `external_url` as `url`).

3. **Filters** (applied at the DB on each source before merge): `kind` (file|link), `label`
   (link labels contains), `provider` (link provider), and `q` full-text on title/url.

4. **Pagination across two tables — no silent truncation.** Filter and order each source at the
   DB (`ORDER BY created_at DESC, id DESC`), then combine with a **keyset merge cursor** on
   `(created_at, id)`: each page fetches `WHERE (created_at, id) < cursor LIMIT page_size` from
   *each* source, merges the two ordered streams in Python, takes `page_size`, and emits the
   next cursor. Worst case loads `2 × page_size` rows per page — bounded regardless of program
   size. (An equivalent `.union()` projection is acceptable if the implementer finds it cleaner;
   the hard requirement is **bounded memory and no dropped assets** — the CLAUDE.md "no silent
   caps" rule forbids a `LIMIT 500`-style truncation.) The `perf-check` gate validates N+1 and
   index coverage (`task__project_id` + `created_at`; label/provider filters).

5. **Web:** a new **Assets** tab/page on both shells:
   - **Program:** add an `assets` entry to the fixed `TABS` array in
     `features/shell/ProgramTabs.tsx` + a route child in `router.tsx` (program block).
   - **Project:** the data-driven registry — add `assets` to `VIEW_TAB_META` (`viewMeta.ts`),
     place it in a group in `viewGroupsFor()` (`methodologyTabs.ts`, e.g. TRACK), and add the
     route child in `router.tsx` (project block).
   - Reuse the #970 presentation primitives from `features/schedule/sections/ExternalLinksSection.tsx`:
     `providerIcon`, `StatusBadge` (already exported), `TypeChip`, `LabelPills` (lift/export the
     file-local ones into a shared module). Page: chip filters (kind/label/provider), a search box,
     a flat chronological list grouped-by-task toggle (default flat chronological — resolves the
     issue's open question), empty state, and pagination ("Load more" on the keyset cursor).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Keyset-merge over two DB-filtered, DB-ordered sources (chosen)** | Bounded memory (2×page); correct across pages; no dropped assets; filters pushed to DB | Two queries per page + a Python merge; cursor must handle `(created_at, id)` ties |
| Load all rows, merge + offset-paginate in Python | Simplest code | Unbounded memory on a large program; O(N) per page |
| `LIMIT 500` merged list | Trivial | Silent truncation — violates the "no silent caps" rule; a big program hides assets |
| Single DB `.union()` projection | One query, DB-paginated | Rigid column typing across two dissimilar models; post-union filtering is awkward; needs a second hydrate pass for task names — kept as an allowed implementation variant, not mandated |

## Consequences

- **Easier:** one place to answer "what reference material exists for this project/program";
  future asset types (e.g. a third source) slot into the same merge + serializer shape.
- **Harder:** two-source pagination is more code than a single queryset; every filter must be
  applied to *both* sources consistently.
- **Risks:**
  - A filter applied to only one source would silently drop matching assets from the other.
    Mitigation: a shared filter helper applied to both querysets + a test asserting a label/q
    filter returns both file and link matches.
  - Program-scope leak if the readable-projects narrowing is skipped. Mitigation: copy the
    audited `task_search` pattern verbatim; `rbac-check` + a test that a member of project A
    (not B) in the same program sees only A's assets.
  - N+1 on `task`/`project`/`uploaded_by`. Mitigation: `select_related`; `perf-check` gate.

## Implementation Notes

- **P3M layer:** Programs and Projects
- **Affected packages:** api (serializer, two viewset actions/views, urls, a shared filter +
  merge helper; **no model change**), web (Assets page, project + program tab registration,
  router children, a hook, api types, shared presentation primitives extracted from
  ExternalLinksSection)
- **Migration required:** **no** — read-only aggregation over existing models. (Add a DB index
  only if `perf-check` finds the `created_at`/`project` filters unindexed; declared in model
  `Meta` if so.)
- **API changes:** yes — two new read endpoints; OpenAPI schema regenerated.
- **OSS or Enterprise:** OSS. Cross-program/portfolio rollups explicitly deferred to Enterprise.

### Durable Execution
1. **Broker-down behaviour:** N/A — read-only aggregation endpoints, zero async side effects,
   zero writes.
2. **Drain task:** N/A — no async work.
3. **Orphan window:** N/A — no outbox rows.
4. **Service layer:** a synchronous `build_asset_feed(project_ids, filters, cursor)` helper
   (new function) shared by both endpoints; no Celery.
5. **API response on best-effort dispatch:** N/A — synchronous `200` with a paginated list +
   next cursor.
6. **Outbox cleanup:** N/A.
7. **Idempotency:** N/A — reads are naturally idempotent and side-effect-free.
8. **Dead-letter / failure handling:** N/A — no task; a failed read is a normal request error.
