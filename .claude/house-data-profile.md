# House Data Profile

**Measured 2026-08-22** against the local dev stack (`docker compose exec db psql -U trueppm -d trueppm`), read-only.

## Read this before you cite a single number

**This is a developer laptop database. There are no customers in it.** Every row was
created either by our own demo authoring scripts or by a developer clicking around. It
contains exactly two populations, and neither one is a real project:

| Population | How to find it | Projects | Tasks | What it is |
|---|---|---|---|---|
| **Authored demo** | `projects_project.is_sample = true` | 6 | 176 | Hand-written fiction in `scripts/seeds/build_samples.py` (~93k lines of authored WBS, deps, and an event timeline). Deliberately shaped to demo well. |
| **Developer scratch** | `is_sample = false` | 19 | 178 | Throwaway QA debris. The actual names are `test`, `test`, `test2313`, `blah`, `blah`, `New`, `new one`, `new test`, `20260731`, `20260607`. |

So the honest framing for **every** fact below is one of three labels:

- **[AUTHORED]** — a deliberate choice a human made when writing the demo. It tells you what
  we *think* a project looks like. It is evidence about our own assumptions, not about users.
- **[DEBRIS]** — an accident of manual testing. Tells you nothing about anything.
- **[STRUCTURAL]** — true because of how the *code* works, and would remain true on a real
  instance. These are the only facts here that transfer.

**Total corpus: 25 projects / 354 tasks / 162 dependencies.** That is small enough that
several percentages below rest on double-digit row counts; where that happens it is stated
inline. A panel citing a percentage from a 27-row population is doing numerology.

---

## The facts

### 1. Connectivity is bimodal by methodology — the average is a lie [AUTHORED, but the mechanism is STRUCTURAL]

44.6% of live tasks (158/354) touch any dependency edge. **That average describes no
actual project.** Per-project, with 10+ tasks:

| Project | Methodology | Tasks | % with any edge |
|---|---|---|---|
| Bayside Civic Center | WATERFALL | 28 | **79%** |
| Migration Tooling | WATERFALL | 24 | **79%** |
| Helios CRM | HYBRID | 27 | 26% |
| GTM Readiness | HYBRID | 14 | 29% |
| Platform Core | AGILE | 52 | **4%** |
| Aurora App | AGILE | 31 | **0%** |

```sql
WITH d AS (SELECT predecessor_id, successor_id FROM projects_dependency WHERE NOT is_deleted)
SELECT p.name, p.methodology, count(t.id) AS tasks,
  round(100.0*count(t.id) FILTER (WHERE EXISTS(SELECT 1 FROM d
    WHERE d.successor_id=t.id OR d.predecessor_id=t.id))/nullif(count(t.id),0),0) AS pct
FROM projects_project p JOIN projects_task t ON t.project_id=p.id AND NOT t.is_deleted
WHERE NOT p.is_deleted GROUP BY p.id,p.name,p.methodology HAVING count(t.id)>=10;
```

**Why this changes a decision:** any feature whose behavior depends on the dependency graph
(bulk reschedule, "let CPM place it", critical path, slip cascade) has *two* golden paths,
not one. On an Agile project it is operating on a set of disconnected rows and CPM has
nothing to propagate. Designing against the 44.6% mean produces a feature that is wrong on
both ends. The split is authored — but it is authored *because* Agile boards genuinely do
not carry FS edges, so the direction is trustworthy even though the ratio is not.

### 2. The graph is a chain, not a network — max fan-in is 3 [AUTHORED]

```sql
WITH d AS (SELECT successor_id FROM projects_dependency WHERE NOT is_deleted)
SELECT n AS predecessors, count(*) FROM (SELECT t.id,
  (SELECT count(*) FROM d WHERE d.successor_id=t.id) AS n
  FROM projects_task t WHERE NOT t.is_deleted) pc GROUP BY n ORDER BY n;
```

`0 → 212 tasks · 1 → 123 · 2 → 18 · 3 → 1`. No task anywhere has 4 predecessors.

**Why this changes a decision:** this is a **seed artifact and you should not trust it.**
The seed scripts build dependencies in a `prev → wbs` loop, which can only ever produce
fan-in of 1 plus a few hand-added joins. Real schedules have merge points with 5–15
predecessors, and merge bias is exactly where CPM and Monte Carlo get interesting. **Any
feature validated only against this corpus has never been tested against a real merge
point.** Do not use this to conclude "fan-in is rare".

### 3. Half of all tasks show an owner that capacity math cannot see [STRUCTURAL — the trap is real; the magnitude is AUTHORED]

```sql
WITH tr AS (SELECT DISTINCT task_id FROM resources_task_resource)
SELECT count(*) AS live,
  count(*) FILTER (WHERE EXISTS(SELECT 1 FROM tr WHERE tr.task_id=t.id)) AS has_taskresource,
  count(*) FILTER (WHERE t.assignee_id IS NOT NULL) AS has_assignee,
  count(*) FILTER (WHERE t.assignee_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM tr WHERE tr.task_id=t.id)) AS assignee_only
FROM projects_task t WHERE NOT t.is_deleted;
```

354 live · **166 have `assignee_id`** · **85 have a `TaskResource`** · **165 have an
assignee and NO TaskResource** · 104 have neither.

Capacity, utilization, and the heat map sum `TaskResource.units` and never read
`Task.assignee`. So **165 tasks (47%) display an owner in the UI and contribute exactly
zero load.** The overlap between the two mechanisms is *one task*.

It splits cleanly by population, which is the tell:

| | assignees | tasks with TaskResource |
|---|---|---|
| Authored demo (6 projects) | 150 | **1** |
| Developer scratch (19) | 16 | 84 |

`grep -c "TaskResource\|task_resource" scripts/seeds/build_samples.py` → **0**. The demo
seeds set `assignee` and have never once written an assignment row.

**Why this changes a decision:** the *trap* is structural and will hit real instances — two
parallel ownership mechanisms, one of which is invisible to the math. But the 47% figure is
manufactured by our own seeds. The sharper finding is about us: **every demo we show and
every screenshot we ship has a fully-staffed board and an empty resource histogram.** A
panel must not treat "users under-assign resources" as observed behavior. It is not
observed; it is authored.

### 4. Projects are tiny, and the non-demo ones are debris [DEBRIS]

```sql
SELECT p.is_sample, count(*) AS projects, min(t.n), percentile_cont(0.5)
  WITHIN GROUP (ORDER BY t.n)::int AS median, max(t.n)
FROM projects_project p JOIN LATERAL (SELECT count(*) AS n FROM projects_task tk
  WHERE tk.project_id=p.id AND NOT tk.is_deleted) t ON TRUE
WHERE NOT p.is_deleted GROUP BY p.is_sample;
```

Demo: min 14 / median 28 / max 52. Scratch: min 0 / **median 4** / max 32. Two live
projects have zero tasks.

**Why this changes a decision:** **this tells us nothing about real project size and must
never be cited as if it did.** MS Project schedules routinely run 500–5,000 tasks. Our
largest object anywhere is 52 rows. Any claim that a list, a Gantt render, or a bulk action
"performs fine" is backed by a 52-row worst case. (This is also why `perf:load` measured a
one-task project for its entire life — same root cause: nothing in this database is big.)

### 5. 42% of tasks are `NOT_STARTED`; only 12% are `BACKLOG` [AUTHORED]

```sql
SELECT status, count(*), round(100.0*count(*)/sum(count(*)) OVER (),1)
FROM projects_task WHERE NOT is_deleted GROUP BY status ORDER BY 2 DESC;
```

`NOT_STARTED 147 (41.5%) · COMPLETE 99 (28.0%) · IN_PROGRESS 50 (14.1%) · BACKLOG 41
(11.6%) · REVIEW 16 (4.5%) · ON_HOLD 1 (0.3%)`

**Why this changes a decision:** `BACKLOG` is a much smaller slice of the whole corpus than
the #2987 discussion implies (see fact 6 for why). But note the flip side: **28% of tasks
are already COMPLETE**, so any bulk operation over "all tasks" is mostly operating on
history. Scope bulk actions to incomplete work by default.

### 6. Tasks CPM has never dated are overwhelmingly ones CPM cannot help [STRUCTURAL mechanism, thin evidence]

This is the fact that overturned a panel, so it gets audited rather than repeated.

**"Unscheduled" is not one population.** Three raw columns and one compound predicate all
have a claim to the word, and they differ by an order of magnitude:

| "Unscheduled" means | n | % isolated | % BACKLOG |
|---|---|---|---|
| **`useUnscheduledTasks` — what the gutter actually shows** | **44** | **95%** | **82%** |
| `planned_start IS NULL` (raw column) | 148 | 93% | 25% |
| `early_start IS NULL` (raw column) | 27 | 100% | 78% |

The first row is the one that governs a design decision about the Unscheduled tray, because
it is the predicate the code uses: `status IN (NOT_STARTED, BACKLOG) AND planned_start IS
NULL AND NOT summary AND (sprint_id IS NULL OR status = 'BACKLOG')`
(`packages/web/src/hooks/useUnscheduledTasks.ts`). Both halves of the original claim hold on
it. The raw `planned_start IS NULL` row looks like a contradiction — BACKLOG collapses to
25% — but it is a different population: it sweeps in IN_PROGRESS and COMPLETE work and
summary rows, none of which the tray ever displays.

**Why this changes a decision:** *tasks CPM has never dated are overwhelmingly ones CPM
cannot help* — they have no edges, and/or sit in a status CPM excludes (`status != BACKLOG`
is a filter in `apps/scheduling/tasks.py`). So "just let CPM place them and accept the
result" is a no-op that looks like a result. That is a **structural** consequence of how CPM
selects rows and will hold on real instances.

**But cite the mechanism, not the percentage.** 44 rows is thin, and the population is
concentrated in the two Agile demo projects that have almost no dependency edges at all
(fact 1) — so the 95% is partly measuring an authoring choice, not a law. And whenever you
say "unscheduled", say which definition you mean; a reader who assumes the raw column will
reach the opposite conclusion about BACKLOG share and be right, about a different question.

### 7. 58% of tasks carry a committed `planned_start` [AUTHORED]

206/354 have `planned_start`; 327 have a CPM-computed `early_start`; **27 have no date of
any kind**.

```sql
SELECT count(*) AS live, count(*) FILTER (WHERE planned_start IS NOT NULL),
  count(*) FILTER (WHERE early_start IS NOT NULL),
  count(*) FILTER (WHERE planned_start IS NULL AND early_start IS NULL)
FROM projects_task WHERE NOT is_deleted;
```

**Why this changes a decision:** a majority of rows already have a human-committed date.
Any bulk action that recomputes dates is overwriting a human decision on most rows it
touches, not filling a blank. Default to "fill blanks only"; make "overwrite committed
dates" an explicit, separately-confirmed choice.

### 8. WBS is shallow and wide: max depth 3, ~4.6 children per summary [AUTHORED]

```sql
WITH live AS (SELECT id, project_id, wbs_path FROM projects_task
              WHERE NOT is_deleted AND wbs_path IS NOT NULL)
SELECT count(*) FILTER (WHERE EXISTS(SELECT 1 FROM live c WHERE c.project_id=l.project_id
    AND c.wbs_path <@ l.wbs_path AND c.id<>l.id)) AS summaries,
  count(*) FILTER (WHERE NOT EXISTS(SELECT 1 FROM live c WHERE c.project_id=l.project_id
    AND c.wbs_path <@ l.wbs_path AND c.id<>l.id)) AS leaves
FROM live l;
```

**50 summaries / 299 leaves** (14% summary). Depth: `1 → 130 · 2 → 204 · 3 → 15`. Nothing
is deeper than 3. Median 4 children per summary, max 18. Five live tasks have a NULL
`wbs_path` at all.

> Note for anyone re-running this: `wbs_path` values repeat across projects, so the
> descendant check **must** be scoped with `c.project_id = l.project_id`. Without it you
> get 303 summaries / 46 leaves — inverted and completely wrong.

**Why this changes a decision:** an outline UI validated here has never rendered depth 4+.
Real WBS routinely reaches 5–7 levels. Indentation, breadcrumbs, and collapse-state are
untested past 3.

### 9. Finish-to-Start is 94% of all edges; lag is almost always zero [AUTHORED]

```sql
SELECT dep_type, count(*), count(*) FILTER (WHERE lag<>0) AS nonzero_lag,
  min(lag), max(lag) FROM projects_dependency WHERE NOT is_deleted GROUP BY dep_type;
```

`FS 152 · SS 6 · FF 3 · SF 1`. Non-zero lag on **7 of 162 edges (4.3%)**, range −3 to +7.

**Why this changes a decision:** SS/FF/SF together are **10 rows**. We advertise all four
dependency types as a headline differentiator against competitors, and our own corpus
exercises three of them ten times total — SF exactly **once**. This is not evidence that
users don't need them; it is evidence that **we have almost no test data for them**.
Calendar-aware lag (a shipped, differentiating behavior) is exercised by 7 rows.

### 10. Sprints are used by 11 of 25 projects; the median sprint holds 3 tasks [DEBRIS-heavy]

36 live sprints across 11 projects. 127/354 tasks (36%) sit in a sprint. Tasks per sprint:
min 0, **median 3**, max 14. Methodology declared: `HYBRID 15 · AGILE 6 · WATERFALL 4`.

**Why this changes a decision:** median 3 tasks per sprint is not a real sprint — it is a
developer making a sprint to check a button. Velocity, burndown, and capacity-per-sprint
features have effectively **no realistic fixture** in this database. Treat any sprint-math
claim as unvalidated. Note also that **HYBRID is the most common declared methodology
(15/25)** — which, combined with fact 1, means the most common project type is the one with
the least predictable graph shape.

### Smaller things worth knowing

- **12 programs** exist for 25 projects — programs are over-represented relative to any
  plausible real ratio. [DEBRIS]
- **137 Monte Carlo runs** against 25 projects, but only **8 baselines** across 5 projects.
  MC is heavily exercised (largely by the nightly job — see the known unsoundness in
  `project_nightly_monte_carlo_manufactures_drift`); baselines are barely touched.
- **46 risks**, **9 milestones** (2.5% of tasks). Milestones are nearly absent.
- **115 tasks have `actual_start`**, 118 are at `percent_complete = 100`, 216 at 0. Progress
  is bimodal — almost nothing is partially complete, so mid-flight progress rendering is
  thinly tested.
- **`seeded_at` is not the seed marker.** Only 10 tasks have it set; it belongs to the seed-
  *pack import* feature, not the demo scripts. Use `projects_project.is_sample`.
- **Zero soft-deleted dependencies and zero soft-deleted projects.** The soft-delete
  restore path has no data behind it here.

---

## What a panel should conclude from this

1. **Stop reasoning about "a TruePPM project." There isn't one.** There is a
   dependency-dense Waterfall project (~79% connected) and a dependency-free Agile board
   (0–4%), and the most common declared methodology is the Hybrid smear between them. Any
   recommendation phrased "the user's tasks will already have dependencies" is true for one
   of these and false for the other. Say which.

2. **CPM is not a fallback for undated work.** Structurally: a task with no predecessors
   gets the project start date, and a `BACKLOG` task is excluded from the pass entirely and
   keeps whatever stale value it had. "Let CPM figure it out" is not a safe default action —
   it is a no-op that *looks* like a result. This is the finding that overturned the #2987
   panel and it holds up, though on thin evidence (fact 6).

3. **Most rows already have a human's date on them.** 58% carry `planned_start`. Bulk date
   operations are overwriting decisions, not filling gaps.

4. **Assume you have no idea how the feature behaves at scale.** The largest object in this
   database is 52 tasks with fan-in of 3 and WBS depth 3. Nothing here validates
   performance, deep outlines, or merge-heavy graphs. If a recommendation depends on "this
   scales fine," that is an open question, not a finding.

5. **Never cite facts 2, 3, 4, or 10 as user behavior.** They are properties of our seed
   scripts and our QA clicking. Fact 3 in particular is tempting and wrong: users are not
   under-assigning resources — *our demo generator never writes assignments at all.*

6. **What this profile still cannot tell you:** anything about real project size, real WBS
   depth, real fan-in, actual SS/FF/SF usage, whether users prefer `planned_start` over CPM
   dates, or sprint sizing. Those need a real instance. If a panel question turns on one of
   them, the correct output is "unknown — needs telemetry from a real deployment," not a
   number from this file.

---

## Refresh me

Regenerate by re-running the SQL blocks above against a live dev stack:

```bash
cd /Users/kelly/repos/trueppm-suite/trueppm
docker compose ps                     # confirm db is up; do not start it just for this
docker compose exec -T db psql -U trueppm -d trueppm -c "<query>"
```

Read-only. Never `INSERT`/`UPDATE`/`DELETE`/DDL against this database.

**Stale numbers here are worse than no file at all.** The entire purpose of this profile is
to stop a panel from reasoning against an imagined project — a profile that has silently
drifted does exactly the thing it was written to prevent, while carrying the authority of
having been measured. This database changes whenever anyone runs the seeds or clicks around
the dev UI, so these numbers rot fast and invisibly.

Rules:

- **Re-measure before citing this in any panel more than ~30 days after the date at the
  top.** If you cannot re-measure, say the profile is stale and reason without it.
- **Re-measure after any seed-script change.** `scripts/seeds/build_samples.py` and
  `build_atlas_seed.py` *are* the [AUTHORED] facts in this file; editing them invalidates
  facts 1, 2, 3, 5, 8, and 9 directly.
- **Update the date at the top in the same commit** as any number change. A number without
  a matching date is unciteable.
- **When this instance gains real (non-seed, non-scratch) projects, rewrite the whole file.**
  The two-population framing at the top is the load-bearing part; the moment a third,
  genuine population exists, every `[AUTHORED]` / `[DEBRIS]` label needs re-deriving rather
  than patching.
