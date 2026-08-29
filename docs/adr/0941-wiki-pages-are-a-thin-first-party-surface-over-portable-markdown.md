# ADR-0941: Wiki pages are a thin first-party surface over portable Markdown

## Status

Accepted (2026-08-29)

Answers the scoping decision issue #2222 exists to make — *"docs surface vs. richer
task notes vs. deferral"* — with **a docs surface**, and constrains its shape. No
endpoint, model, or page ships with this ADR; it is the design gate that has to be
passed before #2222 can be implemented, and it is the record the implementer will
meet instead of re-deriving these choices.

## Context

#2222 was filed from the 2026-07-19 OSS-adoption gap analysis as Gap 7 (Med-High):
long-form editable project documentation. Task notes exist; a documentation surface
does not. It was re-triaged 0.7 → 0.5 on 2026-08-29 for a concrete reason rather than
a competitive one: **the Taiga importer (#3164, 0.5) has nowhere to put a Taiga
project's wiki pages.** Built in the other order, the importer has to tell a migrating
team their documentation did not come across, at the moment we least want that
conversation.

Three forces shape the decision, and they pull in different directions.

**1. Scope dilution against a scheduling-first identity.** The issue body flags this
and it is the reason the issue asks for a decision rather than a build. The
counter-argument recorded on the issue is that a wiki is *additive* — a new model and
a new route that touch nothing already shipped — so the risk is attention, not blast
radius. That is right as far as it goes, and this ADR takes it as the premise for
saying yes. It is not a licence to grow the surface: the attention risk is real and
the out-of-scope list below is the mechanism that bounds it.

**2. It is the highest-risk surface added to this product in a long time.** User-authored
markup, file attachments, and cross-page links, all rendered to other users. The
existing `react-markdown` allow-list posture (`TaskDescriptionField.tsx`: seven
elements, `unwrapDisallowed`, `skipHtml`, no `rehype-raw`) is the right foundation, but
a wiki needs headings, links, tables, and code blocks that a task description does not
— so the allow-list has to widen, and every element added to it is a decision, not a
default.

**3. Framework longevity.** The question this ADR was asked to answer explicitly:
*is there anything in Django land that could survive if Django were not used in the
future?* The answer is no — and that is the wrong thing to shop for. What survives a
backend rewrite is never a package. It is the stored format, the table shape, the API
contract, and the Postgres indexes. Each of those is a decision made at design time
and is unrecoverable afterwards, which is why they are pinned here rather than left to
implementation.

P3M layer: **Programs and Projects**. Project-scoped documentation is something a PM
and their team need to run their program, so it passes the adoption-lens test
unambiguously. Cross-portfolio knowledge governance — retention policy, org-wide
classification, legal hold over documentation — is the Enterprise counterpart and is
not in this ADR's scope.

## Decision

### 1. Build it. First-party, thin, in a new `apps/wiki` app.

No off-the-shelf wiki is adoptable, and the two families fail for different reasons.

**Django-land packages fail on licence or on coupling.** `django-wiki` is GPL-3.0 — a
hard stop against the Apache-2.0 core before its design is even worth reading, and it
additionally brings its own model graph, plugin system, and Django-template rendering,
which is the opposite of API-first. Wagtail is licence-clean (BSD-3) but is a second
application framework: its own page tree, StreamField, treebeard, permissions model and
admin. It is the deepest available coupling to Django, adopted to avoid a coupling to
Django. `django-markdownx` / `martor` are Django-admin editor widgets and solve nothing
for a React client. `django-reversion` is redundant against the `simple_history` already
in the tree.

**Standalone wikis fail on operations, before licence matters.** Wiki.js, BookStack,
Outline, Docmost, and XWiki are all separate services with their own database, their own
authentication, and their own permission model. Adopting one means a second container in
the Helm chart, SSO wired twice, a permission model that does not know about the 5-role
project RBAC, content invisible to search and to the importer, and a Taiga migration that
has to write into a foreign system. That is a distributed-systems project, not a shortcut.
Licences then finish the argument: Wiki.js and Docmost are AGPL-3.0, Outline is BSL 1.1
(not OSI open source), XWiki is LGPL — all of which change the obligations of a
self-hoster shipping our Helm chart.

The adoption precedent that *is* correct is #1281's Excalidraw for the collaborative
canvas: **adopt a component, never a system.** A Markdown editor widget is fair game
under the `dependency` gate. A wiki platform is not.

The code lands in a **new `apps/wiki` Django app**, not in `apps/projects`. One app per
domain is the house convention, and `apps/projects/models.py` is already past 8 000
lines; adding a fifth entity family to it is debt taken for no gain.

### 2. The stored format is raw CommonMark. This is the load-bearing decision.

`WikiPage.body` is a `TextField` holding **raw CommonMark text as the author typed it** —
never a serialized editor document.

This is the single decision that is unrecoverable later. Persisting a ProseMirror,
Tiptap, or Lexical AST would make the content shaped like its editor runtime: portable
only by reimplementing that editor's node semantics in whatever stack came next, and
convertible only through a lossy pass. Markdown text has a CommonMark implementation in
every language and needs no conversion at all.

It also makes the Taiga importer nearly a copy — Taiga wiki pages are already Markdown —
which is the reason this issue is in 0.5.

Exactly **two** authoring extensions are recognized, and both already exist in the
tree's vocabulary rather than being invented here:

- `[[page-slug]]` — an internal page link (ADR-0075 established the `[[…]]` convention).
- `[[attachment:uuid]]` — an attachment reference, identical in shape and soft-delete
  rendering semantics to the task-comment attachment reference in ADR-0075 §A.1.

`@mention` reuses the existing mention parser and auto-groups from ADR-0075. **No third
extension may be added without amending this ADR.** A private Markdown dialect is how a
portable format stops being portable.

### 3. Revisions are an explicit `WikiPageRevision` model, not `HistoricalRecords`.

The #2222 sizing comment lists `simple_history` as making revisions — "the hardest wiki
feature" — free. This ADR declines that, deliberately.

Every other `HistoricalRecords` use in this tree is an **audit side-effect**: something
written for reconstruction and conflict merge, consumed by `apps/sync/conflict.py` and
`apps/history/`. On a wiki, revisions are a **user-facing product feature** — a diff
view, a restore action, per-revision attribution, an edit summary. Exposing
`simple_history`'s shape (`history_id`, `history_type` `+`/`~`/`-` codes,
`history_change_reason`, a full row snapshot per save) through a public API means the
API contract has a Django package's internal schema in it, permanently.

`WikiPage` still extends `VersionedModel`, which is where the concurrency answer comes
from (§5) — but it declares no `HistoricalRecords`. `WikiPageRevision` is an immutable
row written in the same transaction as any change to `title` or `body`, carrying
`revision_number` equal to the `server_version` at the time of the write. One counter,
two readers, no second sequence to keep in step.

### 4. Structure: a parent FK and a slug-alias table. Not `ltree`, not a bare slug.

**Hierarchy is a self-referential `parent` FK plus an integer `position`.** It is
deliberately *not* the `wbs_path` `ltree` pattern used by `Task`: that pattern is the
only expression of parenthood on tasks and nothing enforces its integrity — a duplicate
path corrupts the next `rewrite_level` and an orphan renders at root (#3048). A wiki has
no need for subtree range queries, so it should not inherit a structure whose integrity
is unenforceable. Depth is capped at the serializer; a cycle is rejected there too.

**A page's slug is stable, and renames do not rot links.** `WikiPageSlug` is a small
table of `(page, slug, is_current)` rows with uniqueness on `(project, slug)`. Renaming
a page inserts a new current slug and retains the old one as an alias, so every
`[[old-slug]]` written before the rename still resolves. This is the one place v1 goes
beyond the minimum, and it is included because "renaming a page breaks every link to it"
is a defect class that becomes unfixable once content exists — the repair is a
content migration over prose nobody can validate.

`title` is free text and carries no structural meaning.

### 5. Concurrency is the existing optimistic lock. No new mechanism.

`WikiPage` extends `VersionedModel`, so it inherits the UUID primary key,
`server_version` under its atomic `UPDATE … RETURNING`, and soft-delete. Clients echo
`X-Base-Version` exactly as they do for a task; a stale write gets **409** with the
current body in the response so the client can render a conflict rather than a failure.

`sync_seq` stays `0` — wiki pages are **outside the offline sync union** in v1, alongside
the ~30 other `VersionedModel` tables that are. Offline authoring is a real feature and a
separate decision; inventing it here would drag the whole WatermelonDB delta protocol into
a documentation surface.

There is **no WebSocket event and no edit-awareness ring in v1.** The optimistic lock is
the correctness mechanism; advisory presence is additive and can follow the ADR-0914
shape when it does.

### 6. Rendering: the allow-list widens, and every widening is named here.

The renderer stays `react-markdown` with `skipHtml`, `unwrapDisallowed`, and **no
`rehype-raw`**. Raw HTML is never enabled on this surface, for any reason.

The allowed element set widens from the task-description subset to add: `h1`–`h4`,
`a`, `blockquote`, `hr`, `pre`, `table`/`thead`/`tbody`/`tr`/`th`/`td`, and `img`.
Two of those carry conditions:

- **`a` — link protocols are an explicit allow-list**, not the library default:
  `http`, `https`, `mailto`, and internal `[[page-slug]]` resolutions. Everything else,
  `javascript:` and `data:` included, is rendered as inert text. Relying on
  `react-markdown`'s default `urlTransform` would make an XSS boundary a transitive
  dependency's default value.
- **`img` resolves only to instance-hosted attachments.** An external image URL renders
  as a link, never as an `<img>`. On a self-hosted instance a remote image is an
  outbound request made by every reader — a tracking pixel and an IP disclosure that no
  one opted into. This is the same non-egress posture ADR-0913 takes for "seed from a
  brief", applied to the read path.

### 7. Attachments ship in v1, via an extracted abstract base — not a copied model.

The Taiga-importer argument does not hold if a migrated wiki arrives without its files,
so attachments are in scope. The wrong way to get there is a `WikiPageAttachment` that
duplicates `TaskAttachment`'s fifteen fields, its file-XOR-link `CheckConstraint`, and
its soft-delete semantics — that is debt created knowingly in the name of being additive.

Instead: extract `AbstractAttachment` from the shipped `TaskAttachment` (fields,
constraint, soft-delete, `deleted_by`), and let both `TaskAttachment` and
`WikiPageAttachment` inherit it. A Django abstract base keeps every field on its own
concrete table, so this is a no-op for existing data. **This is the one place the wiki is
not purely additive**, it touches shipped code, and it is therefore the one part of the
implementation that must land with `regression-check` run against the task-attachment
suite specifically.

### 8. Search joins the existing endpoint. RBAC is the existing project permission class.

`title` and `body` get `gin_trgm_ops` GIN indexes — the same pattern as
`task_name_trgm` / `task_notes_trgm` and the backlog's title index. Wiki results are
added to the **existing** cross-project search endpoint rather than getting their own,
and results are filtered by project membership at the query, not the serializer: a
snippet of a page body from a project the caller cannot read is a content leak, and
snippet endpoints are where that class hides.

Roles map to the shipped 5-role model with no new role and no page-level permissions:

| Role | Wiki |
|---|---|
| Viewer | read |
| Member, Scheduler | read, create, edit, restore a revision |
| Admin, Owner | all of the above, plus delete (soft) |

### 9. Wiki pages are not on the MCP surface, and this is a product decision.

A wiki page is the **first surface in this product that is deliberately not computed.**
Everything else an agent can read over MCP is an engine-derived fact with a derivation
it can cite — that is the whole of *computed, not guessed*. Freeform prose asserting
"the integration freeze is March 3" has no derivation and no verification, and an agent
that answers a scheduling question from it has silently converted the product's central
claim into a lie.

So wiki pages are **not exposed on the MCP read surface in v1.** If they ever are, they
must arrive under a distinct tool that types them as unverified human prose and never as
engine fact — and that is an amendment to this ADR and to ADR-0077, not an implementation
detail. This is the same reasoning the roadmap already applies to the collaborative
canvas: a whiteboard never becomes a second place the plan lives.

### 10. Explicitly out of scope for v1

Each of these is a deliberate refusal, not an oversight. Adding one is an amendment.

- **A WYSIWYG editor.** A textarea with a Markdown preview toggle is v1. WYSIWYG is a
  different project, and it is where the scope-dilution risk actually lives — it also
  pressures §2's storage format, which is the decision that must not move.
- **Real-time co-editing / CRDT.** §5's optimistic lock is the answer.
- **Page-level permissions.** Project RBAC only. Per-page ACLs are a governance feature.
- **Comments on pages, page templates, page-level PDF/Confluence export.**
- **Cross-project page links.** `[[slug]]` resolves within the owning project. Cross-project
  linking makes the RBAC story in §8 substantially harder and buys little at v1.
- **Public share links for wiki pages.** The tokenized share-link mechanism is scoped to
  schedules (ADR-0265) and boards (ADR-0245), under the ADR-0135 `public_sharing` gate;
  extending it to arbitrary user-authored prose is its own `threat-model`, not a reuse.
- **Program-scoped or portfolio-scoped wikis.** A program-scoped wiki would be OSS
  (`Program` is an OSS entity) but is not v1. Portfolio-level knowledge governance is
  Enterprise.
- **Offline authoring.** See §5.
- **Content i18n.** #728 decides the framework at 0.5; page *content* translation is not
  in that scope.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. First-party thin wiki over raw CommonMark** *(chosen)* | Single service, single DB, existing RBAC/search/notifications; Taiga import is near-copy; format and schema survive a backend rewrite | We own the editor, the diff view, and the XSS posture; ~1 500 lines we did not have |
| B. Adopt `django-wiki` | Revisions, attachments, plugins out of the box | **GPL-3.0 — disqualifying.** Django-template rendering breaks API-first; its model graph is not ours |
| C. Adopt Wagtail | BSD-3, mature, huge contributor pool | A second app framework for one feature; the deepest possible Django coupling, chosen to reduce coupling risk |
| D. Ship a separate wiki service (Wiki.js / BookStack / Outline) in the chart | Zero application code; a mature product | Second DB + second auth + a permission model that cannot see project RBAC; invisible to search, importer, and notifications; AGPL / BSL licence obligations land on every self-hoster |
| E. Richer task notes instead of pages | Smallest change; no new surface | Does not answer the gap — documentation that is not attached to a task has nowhere to live, and the importer still drops Taiga pages |
| F. Defer past 0.5 | Protects the staffing charter's attention budget | Ships the Taiga importer with known documentation loss; that is the decision this re-triage already made |
| G. Store an editor AST (Tiptap / Lexical JSON) | Enables WYSIWYG immediately | Content becomes editor-runtime-shaped; lossy to migrate, and unrecoverable once real content exists |
| H. `HistoricalRecords` for revisions | Free, already the house pattern | Puts a Django package's internal schema in a public API contract; revisions here are a product feature, not an audit trail |

## Consequences

**Easier.** The Taiga importer (#3164) can carry pages across without a lossy story.
The competitive gap named in `how-it-compares.md` against OpenProject Community closes
on its single largest row. Revisions, search, mentions, notifications, and RBAC are all
reuse rather than new subsystems. A future backend rewrite inherits Markdown text in
Postgres behind a published OpenAPI contract, which is a bounded re-implementation
rather than archaeology.

**Harder.** We own an XSS boundary on a surface whose entire purpose is rendering
user-authored markup to other users. The diff view is real frontend work with no
existing analogue in the tree. §7 touches shipped attachment code, which is the one
regression risk in an otherwise additive change.

**Risks.**

- *Scope creep toward WYSIWYG.* The mitigation is §2 and §10 being decisions of record
  rather than preferences: moving to WYSIWYG requires amending an accepted ADR.
- *Attention, not blast radius.* Correctly identified on #2222. This ADR does not
  resolve it — it is a milestone-scheduling judgment for 0.5, and the deliberately
  narrow v1 is what keeps it affordable.
- *A wiki becoming a second place the plan lives.* §9 is the structural mitigation;
  there is no product mechanism that stops a human pasting dates into prose, and none is
  proposed.

**Gates this ADR does not discharge.** `threat-model` and `security-review` are required
on the implementation on the merits, not as ceremony — §6's allow-list widening, §7's
file upload, and §8's cross-project snippet filter are each a finding class. `ux-design`
is required before the editor and diff view are built. `ai-review` is discharged in part
by §9, which is its central question here.

## Implementation Notes

- P3M layer: **Programs and Projects**
- Affected packages: `api` (new `apps/wiki`; a contained change to `apps/projects` for
  §7), `web`; not `scheduler`, `wasm-scheduler`, `mobile`, or `helm`
- Migration required: **yes** — one migration for `apps/wiki` (`WikiPage`,
  `WikiPageRevision`, `WikiPageSlug`, `WikiPageAttachment`, trigram indexes), plus a
  no-op-for-data `apps/projects` migration if the §7 abstract-base extraction produces
  one. No `AddConstraint` on a populated table, so the `# safe-constraint:` rule does not
  apply
- API changes: **yes** — a new project-scoped resource (pages, revisions, attachments)
  under the existing project permission class, plus wiki results added to the existing
  cross-project search endpoint. Regenerate `docs/api/openapi.json`; hand-update
  `packages/web/src/api/types.ts`
- OSS or Enterprise: **OSS** (`trueppm-suite`)

### Portability — what survives if Django is replaced

The question #2222 was asked to answer. Nothing adopted *from* Django-land survives a
Django exit; four things designed here do, and each is unrecoverable if got wrong now:

1. **The stored format** — raw CommonMark plus two documented extensions (§2). Readable
   by a CommonMark parser in any language, with no conversion step.
2. **The schema** — `WikiPage`, `WikiPageRevision`, `WikiPageSlug` are plain Postgres
   tables with UUID keys and a self-FK. §3 exists precisely so the revision table is ours
   rather than `simple_history`'s.
3. **The API contract** — the OpenAPI surface is what web, mobile, and importers bind to.
   Under the API-first principle (ADR-0599) a rewrite re-implements a published contract,
   which is a bounded, testable problem.
4. **The indexes** — `gin_trgm_ops` GIN indexes are Postgres objects. Only the query
   builder is Django. This is why §8 uses `pg_trgm` directly rather than a Django search
   abstraction.

What would *not* survive, and is therefore refused above: Wagtail's page tree, a GPL
Django app, an editor-specific AST, `simple_history`'s revision schema on the wire, and
Django template rendering of page content.

### Durable Execution

1. **Broker-down behaviour**: the page write path has **no async side effects of its own** —
   page, revision, and slug rows are written in one synchronous transaction. The only
   async work is `@mention` notification, which already goes through the ADR-0075
   notification dispatcher and its transactional outbox. No new dispatch path, and no
   direct `.delay()` is introduced.
2. **Drain task**: **reuses** the existing notification-outbox drain. Semantics match
   exactly — a wiki `@mention` is the same notification category as a task-comment
   `@mention`, differing only in the source object reference.
3. **Orphan window**: **N/A** — no new outbox category, so no new drain filter. The
   notification drain's existing threshold governs.
4. **Service layer**: **new function needed** — `apps/wiki/services.py::write_page()`,
   wrapping the page update, the `WikiPageRevision` insert, and any slug-alias insert in
   one `transaction.atomic()` block, with the mention dispatch under
   `transaction.on_commit()`. Nothing else may write `WikiPage.body` directly.
5. **API response on best-effort dispatch**: **synchronous** — `201`/`200` returns the
   persisted page with its new `server_version`. Never `202 {"queued": true}`: a
   documentation write that returns before it is durable is indistinguishable from data
   loss to the author.
6. **Outbox cleanup**: **N/A** — no wiki-owned outbox rows. Mention notifications are
   purged by the existing nightly notification retention.
7. **Idempotency**: page create is keyed on the `(project, slug)` uniqueness constraint
   in `WikiPageSlug`; a retried create collides and is rejected rather than minting a
   duplicate page. Page update is idempotent by construction — `X-Base-Version` makes a
   replayed write a 409 rather than a second revision. The existing `Idempotency-Key`
   middleware covers both.
8. **Dead-letter / failure handling**: **N/A for the write path** (synchronous — a failed
   transaction rolls back and the client sees the error). Mention-notification failures
   inherit the existing dispatcher's retry limit, dead-letter table, and alert threshold
   unchanged.
