# ADR-0789: Project templates carry shape, not moment — a frozen structure document, a versioned adoption record, and one undo step

## Status

Accepted — proposed 2026-08-04 for #2729 (0.4); child of epic #2740 ("the way in"),
the load-bearing item of Epic B.

## Context

There is no project template system. No model, no endpoint, no gallery, no picker.
The nearest thing, ADR-0242's `copy_settings_from`, copies **settings values only** —
no tasks, no phases, no dependencies. Every project in the product starts from zero
rows regardless of what the user chose, including the methodology they just picked.

Four things had to be decided before any code, and one of them moved a stated
dependency.

### 1. What a template carries, and what it must refuse to carry

The design position is **structure over content**: phases, gates, milestones and
dependencies rather than sixty guessed task names. The working assumption is that
teams delete most of what a template writes, and that deleting is a first-class act
(#2730 makes it computable, B4 makes it an action). If it turns out teams keep it,
nothing is lost by having started small.

A template therefore carries **shape** and strips **moment and person**. That is not
a tidiness rule — every stripped field is a live defect if carried:

| Stripped | Why carrying it is a bug, not just noise |
|---|---|
| Owners / assignees | The publisher's teammates are not the adopter's, and a user id from another workspace is unresolvable or, worse, resolvable to the wrong person |
| Dates, baselines | A template applied in November must not schedule to the publisher's March. Dates come from the adopter's Start sheet and calendar |
| Comments, files, time entries | Somebody else's conversation and evidence, re-attributed to work that has not happened |
| `actual_*`, `percent_complete` | Progress on work nobody has done |

### 2. The structure is a frozen document, not a live query against the source project

A template published from a project must not keep reading that project. The source
gets edited, archived, deleted; a template whose content moved after two teams
adopted it is unexplainable, and "delete this project" would silently mutate
everybody's template. So publishing **serializes** the shape into a stored document,
and the source project is thereafter irrelevant.

This is the same copy-at-create-not-live-binding decision ADR-0242 made for
settings, for the same reason, and it is worth stating twice because the opposite is
the intuitive default.

### 3. `#2615` is open, and it is a real dependency

The issue names #2615 (bound concurrent seed-import jobs per user) as a dependency.
It is **open and milestoned 0.5**, so it will not land first. #2615's own analysis
is the relevant part: the per-program in-flight de-dupe "is inert as a resource bound
on the path that matters", and **"the real bound today is `SeedImportThrottle` at
6/min/account"**.

Template application is a third background seeding path alongside seed import and
CSV/MS Project import. Shipping it with *no* bound would widen a known gap; pulling
#2615's per-user concurrency cap forward would land a 0.5 issue's scope inside this
one. So this ADR takes the middle course and says so plainly: template apply
registers against the **existing** `seed_import` throttle scope, inheriting exactly
the bound the other seeding paths have today, and #2615 remains the issue that
closes the concurrency gap for all three at once. This buys no new safety; it avoids
adding a *fourth* unbounded path and keeps the fix in one place.

### 4. Undo needs a record of what was written, and it cannot wait for #2730

"Apply is a single undo step" needs to know exactly which rows an application
created. #2730 adds per-row provenance (`source_kind='template'`, `source_id`,
`source_version`) which answers this — but #2730 is on its own branch and this one
is cut from `main`, so building on it would couple two MRs that are otherwise
independent.

`TemplateApplication` (below) is therefore self-sufficient: it is the adoption record
the issue asks for (§1, "adoption records a versioned link") *and* the undo target,
and it does not need provenance columns to exist. When #2730 lands, its per-row
columns become a denormalization of the same fact, useful for the outline margin
tick and the divergence digest — two different questions ("which application wrote
this batch" vs "what wrote this row"), so both records earn their place.

## Decision

### 1. Two models

```
ProjectTemplate
  name, description, source_kind (workspace|community|personal), owner,
  program (nullable), version, carries[], structure (JSONB), is_published,
  published_at, published_by
TemplateApplication
  template, template_version, project, applied_by, applied_at,
  status (pending|running|done|failed|undone), created_task_ids[]
```

`ProjectTemplate.version` is an integer that increments on each republish of the
same template. An application records the version it adopted, so "this project came
from Delivery Skeleton v3" survives the template moving to v4.

### 2. Provenance is a stored field, not derived at read time

The gallery shows a **Workspace / Community / Yours** chip *before* adoption,
because who published a skeleton is the first thing a delivery lead judges it by. A
chip computed at read time from "is `owner_id == request.user.id`" would make the
same template read "Yours" to one person and "Workspace" to another — which is
correct for *Yours* and wrong for the other two. So `source_kind` is stored at
publish, and *Yours* is the one chip additionally narrowed by ownership at read
time.

### 3. The structure document is validated on the way in, not trusted on the way out

`structure` is JSONB, so the seeding job could be handed anything. It is validated
against an explicit schema at publish **and re-validated at apply**, because a
template row can be edited by any path that reaches the database and the apply job
is the one that turns it into rows in somebody's project. The node cap
(`MAX_SEED_NODES`) and the existing seed validation vocabulary are reused rather
than reinvented.

### 4. Apply is async, returns `202 {"queued": true}`, and the Start sheet never blocks

Seeding runs as a Celery job through the transactional outbox, exactly like seed
import (ADR-0726). The Start sheet gets the application id and shows progress; it
does not wait. This is the issue's §2 requirement ("The sheet never blocks on
seeding") and it is also what makes the throttle bound meaningful.

### 5. Undo deletes only what the application wrote, and only if nobody has touched it

Undo soft-deletes the tasks in `created_task_ids` and flips the application to
`undone`. It is a **single** step from the user's side.

It deliberately does **not** delete rows a person has since edited. An undo that
discards typed work to reverse a machine's write is the same unrecoverable failure
#2730's ADR-0786 §4 is organized around, and the same asymmetry applies: leaving a
row behind is disappointing, deleting a sentence somebody wrote is not recoverable.
Until #2730's `edited_at` lands, the conservative proxy is `server_version` — a
seeded row is written once, so `server_version > 1` means something saved it again.
The proxy is replaced by `edited_at IS NULL` when #2730 merges; both answer "has a
person touched this", and the ADR names the swap so the proxy is not mistaken for
the intended predicate.

### 6. RBAC follows ADR-0773, which already decided this

ADR-0773's matrix lists **"Apply a template"** as Admin+ (Owner and Admin only;
Viewer, Member and Scheduler cannot). Publishing a template is likewise Admin+ on
the source project. Reading the gallery requires only project read — a Member should
be able to see what skeletons exist without being able to fire one.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Frozen `structure` JSONB + application record** (chosen) | Template survives its source being edited or deleted; undo has an exact target; no new join on the task read path | JSONB needs its own validation on both ends |
| Template as a live pointer at a source project | Nothing to serialize; a template is "just a project" | A published template silently changes when its source is edited, and deleting the source destroys it for every adopter. Unexplainable to the two teams who adopted v1 |
| Normalized `TemplateTask` / `TemplateDependency` tables | Queryable, FK integrity | Two more synced-adjacent tables for a document that is only ever written whole and read whole; no query ever asks "which templates contain a task named X" |
| Reuse the seed-import JSON schema verbatim as the template format | One format, one validator | The seed schema carries programs, users, risks, sprints, baselines and dates — precisely the moment-and-person a template must strip. Sharing the *validator vocabulary* is right; sharing the *schema* would smuggle back everything §1 excludes |
| Synchronous apply | Simpler; no job, no outbox, no polling | The Start sheet would block on a CPM pass over a whole skeleton, and an unbounded synchronous path is worse than the throttled async one |
| Pull #2615's per-user cap forward into this MR | Actually closes the concurrency gap | Lands a 0.5 issue inside a 0.4 one and fixes it for one of three paths. Reusing `seed_import`'s throttle keeps the fix in one place |

## Consequences

**Easier**

- The methodology choice on the Start sheet can finally seed something.
- #2730's `_SeedImporter(provenance_kind=…)` hook already exists, so a template seed
  records itself as `template` rather than `seed_import` the moment both land.
- "% of seeded rows still present at 14 days" becomes measurable per template
  version, which is what settles whether templates should shrink to phases and gates.

**Harder**

- A stored JSONB document needs a schema and a migration path when the shape grows.
- Two records now describe adoption (`TemplateApplication` and, later, per-row
  provenance). They answer different questions, but a future reader has to be told
  that — hence §4 of Context.

**Risks**

- *An unbounded `structure` document.* Bounded by `MAX_SEED_NODES` and validated at
  both ends; the same ceiling seed import uses.
- *Concurrency.* Explicitly not closed here — see Context §3. `seed_import`'s
  6/min/account is the bound, #2615 is the fix, and this ADR adds a path rather than
  a gap.
- *Undo racing a live editor.* Undo skips rows that have been saved again, so a
  teammate typing into a seeded row while someone undoes keeps their work.

## Implementation Notes

- **P3M layer**: Programs and Projects. A template is scoped to a program or a
  workspace and materializes into one project. Nothing aggregates across programs.
- **Affected packages**: api (models, serializers, viewset, Celery task, outbox),
  web (Start-sheet gallery, provenance chips, apply + undo)
- **Migration required**: yes — two new tables.
- **API changes**: yes — a `project-templates` collection, a publish action, an
  apply action returning `202 {"queued": true}`, and an undo action.
- **OSS or Enterprise**: **OSS.** A template is what one PM needs to stand up a
  project from a known-good shape — the ADR-0242 precedent exactly. The Enterprise
  counterpart is *governance* of templates: mandated org-wide skeletons, approval
  before publish, compliance evidence that a project was created from an approved
  template. None of that ships here, and a workspace-scoped template is not it.

### Durable Execution

1. **Broker-down behaviour**: transactional outbox. The `TemplateApplication` row
   and its outbox row are written atomically with the request; `.delay()` is
   best-effort and a drain re-dispatches. A broker outage leaves the application at
   `pending` and visible, never lost.
2. **Drain task**: reuses the seed-import drain — same semantics (a queued seeding
   job that must eventually run exactly once), same 10-minute orphan filter. A
   second drain would be a copy with no behavioural difference.
3. **Orphan window**: 10 minutes, matching the seed-import drain — the apply is
   dispatched inside `transaction.on_commit()`, so rows younger than the window may
   simply not have committed yet.
4. **Service layer**: `templates/services.py::enqueue_template_apply()`. Nothing
   calls the Celery task directly, mirroring the `enqueue_recalculate()` rule.
5. **API response on best-effort dispatch**: `202 {"queued": true, "application":
   "<uuid>"}`. Not a `task_id` — the caller cannot be given a Celery id it may never
   receive; the application id is the durable handle it polls.
6. **Outbox cleanup**: nightly purge at the existing 7-day retention, registered
   alongside the other `_do_purge` functions.
7. **Idempotency**: the `TemplateApplication` row is the idempotency token. The task
   claims it `pending → running` under `select_for_update` and returns immediately if
   the claim fails, so a redelivery (drain re-dispatch after a worker death, or an
   `acks_late` replay) finds nothing to claim and skips — the same claim-and-run
   pattern `csvimport.tasks._claim_import` uses. Claim and seed share one
   transaction, so a mid-apply failure rolls the claim back for a clean retry.
8. **Dead-letter / failure handling**: `max_retries=3` with exponential backoff; on
   exhaustion the application row goes to `failed` with the reason, which the Start
   sheet surfaces. The partially-written rows are **kept**, not rolled back — they
   are real, correctly-attributed tasks, and `created_task_ids` records exactly
   which, so undo remains exact after a failure.
