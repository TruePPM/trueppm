---
name: api-docs
model: sonnet
description: >
  API documentation sync audit for TruePPM. Use when a diff adds or changes a DRF
  view, viewset, @action, serializer field, permission class, or URL route to verify
  docs/api/openapi.json is regenerated and — the check no CI job performs — that the
  declared response schema matches the shape the endpoint actually returns.
---

# API Docs Skill

You are auditing whether a TruePPM branch's API-surface change is reflected in the
published API documentation before merge.

## Scope

Run this gate when the diff touches `packages/api/src/` in any of these ways:

- a new or modified `APIView` / `ViewSet` / `@action`
- a serializer field added, removed, renamed, or retyped (including `read_only_fields`)
- a permission class added, removed, or changed on any endpoint
- a URL route added, removed, or re-pathed
- a pagination, throttle, or filter-backend change that alters a response envelope
- a new or renamed WebSocket event type (the WS contract is documented prose, not schema)

`n/a` if the diff touches only tests, frontend, Helm, CI, or docs prose with no API
surface behind it.

## What "the API docs" means in this repo

| Artifact | Path | Maintained by |
|---|---|---|
| Generated OpenAPI schema | `docs/api/openapi.json` | `scripts/export-openapi.sh` (and the `openapi-schema` pre-commit hook) |
| Human-facing REST reference | `packages/website/src/content/docs/api/reference.md` | hand-written |
| Error/status-code contract | `packages/website/src/content/docs/api/errors.md` | hand-written |
| WebSocket contract | `packages/website/src/content/docs/api/websockets.md` | hand-written |
| Idempotency protocol | `packages/website/src/content/docs/api/idempotency.md` | hand-written |
| Stability & change classes | `packages/website/src/content/docs/api/stability.md` | hand-written |

`docs/api/` holds **only** the generated `openapi.json`. Regenerating it does not
update anything a human reads. Both halves are in scope for this gate.

## Checklist

### Generated schema is present and honest

- [ ] `docs/api/openapi.json` is regenerated and committed **on this branch**, in the
  same commit as the code change
- [ ] `git merge origin/main` happened **before** the regenerate. This is not style:
  `scripts/export-openapi.sh --check` verifies self-consistency (committed artifact
  matches this branch's code), so a branch behind main regenerates a schema missing
  everything main added since the cut and the drift check still passes. The
  vs-main regression guard (`scripts/check-schema-regression.py`) catches *dropped*
  paths and schemas, but merging first is what makes the artifact correct rather
  than merely non-regressive.
- [ ] If run from a worktree, generation used `scripts/export-openapi.sh` (which pins
  `PYTHONPATH` to its own checkout). A bare `manage.py spectacular` in a worktree
  resolves `trueppm_api` through the symlinked venv's editable install — i.e. the
  **main** checkout — and writes main's schema into the branch (#642).
- [ ] The diff to `openapi.json` is explainable line-for-line by the code change. An
  unexplained path or schema appearing or vanishing means the generation was run
  against the wrong tree or a stale base.

### Declared response shape matches the actual one — the highest-value check

**This is the one thing no CI job does.** `api:schema-drift` proves only that the
committed schema is what drf-spectacular generates from current code. When
spectacular generates the *wrong* schema — because an annotation is missing or a
heuristic could not see the pagination — the artifact is perfectly self-consistent
and perfectly wrong, and the gate passes (#2583, #2515). Integrators generate SDKs
from this file, so a mismatch breaks a client on its first call.

For every endpoint the diff adds or changes, read the actual `return`/`Response(...)`
and compare it to the declared `200` schema in `openapi.json`:

- [ ] **Every `@action` carries an explicit `@extend_schema(responses=...)`.** The
  fallback is the trap: an `@action` with no annotation inherits the viewset's
  `serializer_class`, so an action returning `{"events": [...]}` is published as
  `$ref: Sprint`. Absence of an annotation is itself the finding — do not wait for
  the shapes to visibly disagree.
- [ ] **A paginated response is declared as an envelope, not a bare list.** A plain
  `APIView` that paginates via an explicit paginator has no class-level
  `pagination_class`, so spectacular's auto-wrap heuristic never fires and the
  contract promises `type: array` while the endpoint returns
  `{next, previous, results}`. Declare the envelope explicitly, or set
  `pagination_class` so the heuristic can see it.
- [ ] **The `@extend_schema` landed on the method you think it did.** Decorators bind
  to the callable immediately below them. Inserting a new `@action` between an
  existing `@extend_schema` stack and the `def` it documented silently reassigns
  every one of those blocks to the new action, leaving the original endpoint
  undocumented and the new one triple-documented (#2455). Whenever the diff adds an
  `@action` to a viewset that already has stacked `@extend_schema` blocks, verify in
  the regenerated `openapi.json` that each summary/response landed on its intended
  path.
- [ ] **Sibling endpoints of the same feature declare the same shape.** One path
  annotated and its twin not is the signature of this defect class.
- [ ] Error responses the endpoint can actually return (`400`, `403`, `404`, `409`,
  `429`) are declared, and their `code` values exist in `errors.md`.

### Every declared name has a consumer — read params and enum members included

A declared thing that nothing reads is a published lie, and the check for it is
**grep for a consumer, never for the field**. The existing discipline covers new
*writable* fields; that is the narrowest third of this defect class, and the two
wider thirds are what keeps shipping:

- [ ] **Read parameters.** A query param that is *validated and accepted* by the view
  and then ignored by the service is worse than an unimplemented one, because the
  400 you would have got is the only signal that would have told you. Verified
  instance: `/projects/{id}/resources/heatmap/` validates and accepts
  `group_by=project` while `aggregate_utilization_weekly` implements only `role`.
  For every param the diff declares, find the line that branches on it.
- [ ] **Enum members.** A `TextChoices` member reaches the schema, the settings
  matrix, and a default — none of which is a consumer. Verified instance: **eight of
  nine** `ProjectNotificationEventType` values are persisted, defaulted mostly ON
  across in-app/email/Slack, rendered in the settings UI, and dispatched by nothing;
  the only consumer of the enum outside its own model file is `COMMENT_MENTION`.
  Grep each member name across the app tree and require a dispatch or read site, not
  just a definition and a default.
- [ ] **Hard-coded nulls and always-empty fields.** A field pinned to `None` in the
  view body is indistinguishable, from a client, from a field with a race. Verified
  instance: `status-summary` returns `monte_carlo_p80`, `last_saved` and
  `recalculated_at` as unconditional nulls while `Project.recalculated_at` is written
  on every CPM pass and a P80 is persisted — and the web reads that endpoint, so its
  primary `stats?.monteCarlop80 ?? mc?.p80` branch is dead by construction. If a
  field cannot yet carry a value, say so in the schema description with a `TODO(#NNN)`
  or drop it; do not ship a null that reads as data-not-ready.
- [ ] **Reason codes and availability flags decay.** The `{available: false, reason:
  "..."}` pattern is the right shape and creates an obligation: the reason string is a
  **published server fact** that clients render as user-facing copy. Verified
  instance: `program_rollup.py` published `no_montecarlo_store` for 72 days after the
  store shipped (ADR-0175, migration `0005_montecarlorun`, 2026-06-06), and the web
  turned it into "Needs a saved Monte Carlo run" — telling a PM to do the one thing
  that would not help. When a diff lands the dependency a reason code names, deleting
  that code is part of the same MR. Also confirm the KPI actually appears once the
  entry is gone: a `for` loop with no `else` branch omits it silently instead.
- [ ] **A field the server does not enforce is marked as advisory.** Where a name
  reads like a constraint and binds nothing (`Project.visibility`, `wip_limit`, an
  `ENFORCE` policy that degrades to `SUGGEST` in OSS), the schema must say so — the
  established in-tree pattern is a `policy_available: false` companion, per
  `program_rollup.py`. An integrator's documented hard NO is exactly this: "a field
  documented as a constraint that the server does not enforce."

### operationId churn is a breaking change

- [ ] **Check the `operationId` diff separately from the schema diff.** spectacular
  derives the suffix from the declared response: an object-shaped declaration yields
  `…_retrieve`, a list-shaped one yields `…_list`. So *correcting* a wrong response
  declaration can flip a shipped operationId — e.g. `v1_sprints_duration_events_retrieve`
  → `…_list` — and generated SDKs name their methods from it. Renaming a shipped
  operationId is a **Breaking** change under
  `packages/website/src/content/docs/api/stability.md`, requiring a deprecation
  window, not a drive-by fix. If a correction would rename one, pin the operationId
  explicitly with `@extend_schema(operation_id=...)` and raise the rename as its own
  decision. Flag any unintended operationId change as HIGH.

### Human-facing pages reflect the change

Regenerating `openapi.json` is not documenting the endpoint. Check each that applies:

- [ ] A new endpoint that integrators are expected to call is described in
  `reference.md` — not only present in the schema
- [ ] A new or changed **permission rule** is stated in prose. The schema encodes
  request/response shape and says nothing about which of the five roles may call the
  endpoint; if the rule is not written down, it is undocumented.
- [ ] A new error `code` is added to `errors.md` (the machine-readable `code` is part
  of the stable surface; the `detail` prose is not)
- [ ] A new or renamed WebSocket event type is in `websockets.md` **and** in
  `FROZEN_WS_EVENT_TYPES` (`packages/api/tests/apps/sync/test_broadcast.py`)
- [ ] An endpoint accepting `Idempotency-Key` is listed in `idempotency.md`
- [ ] A removal, rename, retype, or newly-required field is classified against
  `stability.md`'s change table and, if **Breaking**, carries the deprecation
  treatment that page describes
- [ ] Version-tense rule holds on every page touched: past/present tense only for
  versions at or below the latest shipped tag; future tense for anything the roadmap
  still lists as Underway or Planned

## How to verify locally

```bash
# Regenerate (merge main FIRST) and inspect the diff
git merge origin/main
scripts/export-openapi.sh
git diff --stat docs/api/openapi.json

# Same check CI runs: self-consistency + no paths/schemas dropped vs main
scripts/export-openapi.sh --check

# Declared response for one path
python3 -c "
import json; d = json.load(open('docs/api/openapi.json'))
print(json.dumps(d['paths']['/api/v1/<path>/']['get'], indent=2))
"

# operationId churn across the branch
git diff origin/main...HEAD -- docs/api/openapi.json | grep '"operationId"'

# Prose coverage for a new endpoint or field
grep -rn "<endpoint path or field name>" packages/website/src/content/docs/api/
```

## Output Format

State the verdict: **PASS**, **FAIL**, or **NEEDS REVIEW**.

For each issue:
```
### [CRITICAL|HIGH|MEDIUM|LOW] Issue Title
**Endpoint/File**: path:line
**Declared**: what openapi.json / the docs say
**Actual**: what the code returns or enforces
**Fix**: exact annotation or doc change needed
```

Severity guide: a declared-vs-actual response mismatch on a shipped endpoint is
CRITICAL (it breaks generated SDKs). An unintended operationId rename is HIGH. A
missing `@extend_schema(responses=...)` on a new `@action` is HIGH even when the
generated shape happens to be right — the next serializer change will break it
silently. Missing prose for a new endpoint or permission rule is MEDIUM.

If no issues: confirm that `openapi.json` was regenerated post-merge, name each
endpoint whose declared response you compared against its actual return, and list
which human-facing pages were updated or why none needed to be.

Report the outcome to the MR's `## Gates` section as
`gate: api-docs — <N> findings` (or `n/a` when the diff carries no API surface).
