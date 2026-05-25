# ADR-0086: `schema_version` Convention for User-Saved JSON State

## Status
Accepted

## Context

**P3M layer:** Cross-cutting persistence convention. Repo: **OSS** — it governs how
OSS saved-state surfaces version their payloads; Enterprise surfaces inherit the same
contract.

TruePPM persists a growing number of **user-saved JSON blobs**: board saved views
(`useBoardSavedViews`), filter presets, dashboard/overview layouts, column orderings,
and similar per-user or per-board UI state. These are stored as opaque `JSONField`
payloads on the API side and round-tripped through TanStack Query / Zustand on the web
side.

None of them currently carry a version marker. That is fine until the *shape* of a
payload needs to change — at which point a consumer reading a previously-saved blob has
no reliable way to tell which shape it is looking at. The options without a convention
are all bad:

1. **Structural sniffing** (`if "columns" in payload and isinstance(...)`) — fragile,
   accretes a new branch on every shape change, and silently mis-reads ambiguous blobs.
2. **Best-effort + try/except** — a malformed-vs-old-shape payload is indistinguishable
   from a corrupt one, so genuine bugs get swallowed as "old data."
3. **Big-bang data migration on every shape change** — expensive, and impossible for
   web-only `localStorage`-backed state that never touches a Django migration.

This is debt that compounds: every new saved-state surface shipped without a version
marker is one more payload family that becomes un-evolvable. The convention is cheap to
adopt now and expensive to retrofit later, so it should land in 0.2 and constrain all
new saved-state work, even though the implementation rollout for existing surfaces is
deferred to 0.3 (#645).

## Decision

Adopt a single versioning convention for **all** user-saved JSON state, on both sides
of the API boundary.

### 1. Every saved payload carries a top-level `schema_version: int`

Every user-saved JSON payload includes a top-level integer field:

```json
{ "schema_version": 1, "columns": ["todo", "doing", "done"], "...": "..." }
```

Existing payloads that predate this ADR are treated as `schema_version: 1` by default
when the field is absent. New surfaces start at `1` and increment by one on each
breaking shape change.

### 2. Consumers read through a forward-migration registry keyed on `(surface, version)`

No business code reads a raw saved payload. Every consumer dispatches through a
forward-migration registry that upgrades a payload to the current version **on read**,
before any business logic sees it:

```
upgrade(surface, payload) -> payload_at_current_version
```

The registry holds an ordered chain of pure `(vN) -> (vN+1)` transforms per surface.
Reading a `v1` payload when the current version is `v3` applies `v1→v2` then `v2→v3`.
Writes always emit the current version. An unknown *future* version (payload newer than
the running code, e.g. after a downgrade) is a hard error, not a silent best-effort read.

### 3. The registry contract is mirrored between `packages/api` and `packages/web`

The same `(surface, version)` keys and the same per-step transform semantics exist on
both sides. A payload upgraded by the web client and one upgraded by the API must reach
an identical current-version shape. Surface keys are shared string constants, not
duplicated literals, so the two registries can be audited against each other.

### 4. New surfaces MUST include the field from day one

Any user-saved-state surface introduced **after** this ADR must include
`schema_version` from its first commit. The `data-model` and `architect` skills enforce
this in review: a new `JSONField` (or web-persisted blob) holding user state without a
`schema_version` and a registered surface is a blocking finding.

## Scope

**Lands in 0.2 (this ADR):** the convention above. It is documentation + a review gate;
it constrains all new saved-state work immediately.

**Deferred to 0.3 (#645):** the implementation rollout — building the registry helpers
on both sides, retro-applying the field to existing surfaces (starting with
`useBoardSavedViews`), and migrating already-saved payloads. Grouped with other 0.3
saved-state work because it is a multi-package change; the ADR alone is cheap to merge
and is the thing that stops the debt from growing in the meantime.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. No convention (status quo)** | Nothing to build | Every shape change forces structural sniffing or a bespoke migration; debt compounds per surface. Rejected — this ADR exists to stop that. |
| **B. Per-surface ad-hoc versioning** | Each surface solves its own evolution | No shared contract → api/web drift, every surface reinvents upgrade logic, no review gate. Rejected. |
| **C. Version the whole blob with a content hash / timestamp** | No explicit integer to maintain | Hash/timestamp can't drive an *ordered* upgrade chain; you still can't answer "which shape is this." Rejected. |
| **D (chosen). Top-level `schema_version: int` + forward-migration registry, mirrored api/web** | One contract, ordered upgrades, explicit unknown-version failure, enforceable in review | Requires discipline (the day-one rule) and a small registry on each side; rollout to existing surfaces is real work (deferred to #645). |

## Consequences

- **Easier:** Evolving a saved-state shape becomes a localized change — add a
  `vN→vN+1` transform and bump the writer. Old payloads upgrade transparently on read.
  A new surface has a clear, reviewable contract to satisfy.
- **Harder:** Every new saved-state surface now carries a small obligation (the field +
  a registered surface), and the day-one rule is enforced in review rather than by a
  compiler. Existing surfaces remain unversioned until #645 — this ADR does not
  retrofit them, so until then the convention binds new work only.
- **Risks:** (1) api/web registries drifting — mitigated by shared surface-key constants
  and the mirror requirement. (2) A forgotten version bump on a breaking change would
  let an old payload reach new code unmigrated — mitigated because the transform chain
  is the only read path, so a missing step is a visible gap, not a silent mis-read.

## Implementation Notes

- P3M layer: **Cross-cutting (persistence convention)**
- Affected packages: **none in 0.2** (ADR only). Rollout in #645 touches **api** and
  **web** registry helpers + existing saved-state surfaces.
- Migration required: **no** (0.2). Existing-payload migration is deferred to #645.
- API changes: **no** (0.2).
- OSS or Enterprise: **OSS** (Enterprise saved-state surfaces inherit the same contract).

## Related

- **#645** — Implementation rollout (0.3): registry helpers on both sides, retro-apply
  to `useBoardSavedViews`, migrate existing payloads. This ADR was split from #645 so
  the convention lands a release earlier and constrains new work in the interim.
- **#649** — This ADR.
