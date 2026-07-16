# ADR-0455: Informational Task-to-Task Relations (Relative Links)

## Status
Accepted

## Context

Tasks can be connected only three ways today: a scheduling `Dependency`
(predecessor/successor + `dep_type` + `lag` — a CPM constraint), parent/epic
grouping via `wbs_path`, and a `Risk`→task link. There is no way to say "this task
**relates to** / **blocks** (informationally) / **duplicates** that one" and click
through to it — the ordinary cross-reference every issue tracker ships (Jira/Linear/
Asana "linked issues"). Issue #2065 asks for exactly that: a *relative link* a
contributor follows to related work.

The temptation is to model it as a `Dependency`, but a "relates to" is **not a
schedule constraint** — forcing it through the CPM engine would move dates, invite
cycles, and trigger recomputes for a link that carries no timing meaning.

**P3M layer / boundary.** A team annotating its own work with cross-references is
**adoption**, not **governance** — a PM or team member needs it to run their program,
and it is a single team's annotation. Same-project and same-**program** cross-project
links are OSS (the ADR-0120 D1 envelope; `Program` is an OSS entity). What would push
a variant to Enterprise, and is explicitly out of scope: cross-**program** links
(rejected, per the ADR-0070 boundary), org-policy governance of which relation types
are allowed, approval workflows on inbound links, and portfolio-level relation
rollups. So: **OSS.**

**Prior art.** `Dependency` (ADR-0120) is the near-exact structural analog — a
`VersionedModel` edge between two tasks with no direct project FK, pull-only sync via
the source task's `server_version`, a tombstone `deleted_at` reap, and a board
broadcast on write. `TaskRelation` mirrors its envelope and diverges in exactly two
places (below).

## Decision

Introduce a first-class **`TaskRelation`** model — a directed, informational,
non-scheduling edge — with a small `RelationType` set: `RELATES_TO` (symmetric),
`BLOCKS`, `DUPLICATES` (directional, rendering an inverse label — "Blocked by" /
"Duplicated by" — on the target's side). Deliberately **not** `PARENT_OF`: parent/epic
grouping already exists via `wbs_path` and a second hierarchy would confuse.

- **Storage:** one directed row (`source` → `target`). A task's relations are the union
  of its outgoing (`relations_out`) and incoming (`relations_in`) rows; the inverse
  label is applied on read. `RELATES_TO` is deduped symmetrically (one canonical row
  per unordered pair, either direction).
- **Integrity:** partial `UniqueConstraint(source, target, relation_type)` where
  `is_deleted=False` (a re-create after soft-delete is not blocked by the tombstone);
  DB `CheckConstraint(source ≠ target)` plus a serializer self-link 400; **no cycle
  check** — an informational link cannot break a schedule.
- **API:** a top-level `/api/v1/task-relations/` viewset (like dependencies, because a
  relation can span two projects). `GET ?task=<id>` returns both directions. A
  cross-project counterpart is rendered as the ADR-0120 D5 `ExternalTaskCard` (title +
  identity only) when the caller cannot fully read that project — never "[redacted]".
  RBAC: write requires edit on the **source** and membership (read) on the **target**;
  gated like the label-attach endpoint (Member may relate their own editable task,
  Viewer cannot, PM+ any).
- **Sync:** pull-only `VersionedModel`, mirroring `Dependency` exactly (sync serializer,
  PULL source, watermark UNION via the source task, tombstone reap). Not writable
  offline (no `WRITABLE_COLLECTIONS` entry), same as `Dependency`.

**The two deliberate divergences from `Dependency`:**
1. **No consent gate.** A cross-project relation is inert, so there is no
   `pending_acceptance` — it is visible to the target team immediately.
2. **No schedule recompute.** `perform_create`/`update`/`destroy` broadcast a board
   event (`task_relation_*`) to both endpoint projects on commit, but **never enqueue a
   CPM recalculation** — the relation carries no timing, so recomputing would be
   pure waste and a correctness trap.

## Consequences

- **Positive:** the cross-reference is a first-class server fact (API-first, MCP-
  reachable — an agent can ask "what relates to task X"), offline-visible, and
  render-cheap (no CPM). The board/schedule stay N+1-free: relations are **not**
  embedded on `TaskSerializer` (unbounded, cross-project, drawer-only), fetched via
  `?task=` like dependencies — not eagerly like the 1–5 bounded `labels`.
- **Negative / accepted:** the benign sync re-delivery quirk `Dependency` already
  carries (a relation-only edit re-delivers under upsert until an accompanying task
  edit advances the watermark) applies here too — accepted for protocol consistency.
- **Enterprise seam left intact:** cross-program links, relation-type org policy, and
  approval workflows register against the OSS signal seam later; nothing here presumes
  them.
- Seed schema gains a per-task `links: [{target, link_type, note?}]` so the bundled
  samples can author realistic "see also" cross-references.
