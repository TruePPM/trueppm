# ADR-0711: Risk-Driver Monte Carlo and the Multi-Axis Impact Model

## Status
Proposed

**Tracked by**: #2556 (0.5 — implementation) · #2557 (1.0 — the cost-model shape
this ADR's cost axis is blocked on) · documented as a 0.4 known limitation.

## Context

TruePPM has a risk register (ADR-0010) and a Monte Carlo engine, and they do not
touch each other.

`Risk.probability` and `Risk.impact` are `PositiveSmallIntegerField` on a 1–5
**ordinal** scale; `RiskSerializer.get_severity` returns `probability * impact`
(1–25). `Risk.tasks` has been a first-class M2M through `RiskTask` since ADR-0010,
and ADR-0566 has just surfaced it in the UI — linked tasks, a task picker, and a
one-click "create mitigation task".

Meanwhile `monte_carlo()` in `packages/scheduler/src/trueppm_scheduler/engine.py`
has **zero** concept of risk. `_sample_duration_matrix` samples each task's
duration column by one of exactly three paths (engine.py:2502):

1. velocity bootstrap, for `delivery_mode=SCRUM` with `story_points` on a project
   carrying `velocity_samples`;
2. PERT-Beta over `(optimistic, most_likely, pessimistic)`;
3. the fixed `duration`.

Nothing else influences a sampled duration.

The consequence is that the register produces a number that says nothing about the
schedule. A severity-20 risk on a task with 30 days of total float contributes
exactly zero to P80. A severity-6 risk on the critical path may own it. The
register ranks risks by a product of two ordinals; the forecast is computed from a
completely disjoint set of inputs.

Today the only way for a risk to reach the forecast is for a human to inflate
`pessimistic_duration` by feel. That is wrong for four reasons:

1. **It models a bimodal reality with a unimodal distribution.** A 40%-likely
   +10-day event produces "usually 10 days, occasionally 20" — a distribution with
   a hole in the middle. PERT-Beta smears probability mass across the gap. The
   resulting P80 is the percentile of a shape nobody believes.
2. **It is not recoverable.** Once the padding is inside `pessimistic_duration`,
   nothing can answer "what does closing this risk buy me?" The mitigation loop
   ADR-0566 just wired up dead-ends: the work completes and the forecast does not
   move.
3. **The padding is permanent.** Nobody re-estimates a task when a risk retires.
   It stays in the plan as unattributed fat.
4. **It destroys correlation, which is the entire point of a register.** One risk
   affecting five tasks either fires for all five or none. Folding it into five
   independent PERT spreads models it as five independent events and collapses the
   tail. This is the largest single source of understated P80s in hand-rolled
   Monte Carlo.

**P3M layer**: Programs and Projects. A single-project risk register feeding a
single-project simulation is exactly what one PM needs to run their program.
Cross-program and portfolio-level risk rollup remains Enterprise.

### Forces

- **The engine must stay Django-free.** `trueppm-scheduler` ships standalone on
  PyPI; risk drivers must reach library consumers who have no `Risk` model.
- **Seeded reproducibility is a documented, load-bearing invariant.**
  `_sample_duration_matrix` samples column-by-column in lexicographic topological
  order "from the single seeded `rng` so the stream — and therefore seeded
  P50/P80/P95 — is independent of task insertion order", and the completed-task
  collapse is deliberately done *after* sampling so the stream stays
  "byte-for-byte unchanged" (engine.py:2502-2560). Any new draw taken from that
  same generator shifts every existing seeded result and every conformance
  fixture.
- **Cost has no data model.** Every `DecimalField` in the API is allocation units,
  velocity, or a custom-field numeric. There is no rate, no budget, no currency,
  no cost baseline. Cost exists only as *references to a concept the model does
  not hold*: `MetricKind.COST_VARIANCE` / `BUDGET_UTILIZATION`
  (projects/models.py:719-720), a `WEIGHTED_BY_BUDGET` rollup mode, a `show_cost`
  display flag, and a `BUDGET_ALERT` notification type. Resource costs and cost
  reports are a **1.0** roadmap item; EV-lite (#2139) is 0.8 and is explicitly
  specified as computing from "the cost data landing here [1.0]".
- **Simulation cost is real but bounded.** The engine is vectorized numpy — the
  docstring records 10,000 runs on a 200-task project in "well under 100 ms", and
  `settings.base` records a 5,000-task × 1,000-run simulation at "a few seconds".
  The OSS caps are `MC_SIMULATION_CAP = 1_000` runs and `MC_TASK_CAP = 5_000`
  tasks, enforced by the engine raising `SimulationCapExceeded` → HTTP 402.

### Simulated-panel input (not user research)

A `/voice-of-customer` panel was run before this ADR. Its output is **modeled
opinion from composite personas at grounding tier T0**, with no real-user
corroboration — TruePPM has not shipped a beta and `.claude/persona-calibration.md`
records no calibration data. It is recorded here as a design input only. Four
findings changed this design and are resolved in the Decision below: the N+1
simulation cost, semantic drift on `probability`, the unenforceability of the
estimating convention, and the untouched agile path.

## Decision

### 1. Impact is multi-axis, and the axes are not symmetric

Risk impact is recorded across a fixed taxonomy of axes sorted into three classes
that receive **structurally different** treatment. Conflating them is the error
this ADR exists to prevent.

| Class | Axes | Treatment |
|---|---|---|
| **A — Simulable** | schedule, cost | Quantified: probability % + conditional three-point impact. Fed to the engine. Produces a distribution and a percentile. |
| **B — Consequential** | scope, quality | Recorded as a 1–5 rating only. Not simulated. |
| **C — Non-compensable** | safety, compliance, reputation, environmental | Recorded as a 1–5 rating. **Never aggregated with anything.** |

**Class A** are the only axes that flow through a network model: days propagate
through CPM to a finish date, money propagates through a rollup to a total. They
are the only axes with a Monte Carlo answer.

**Class B** are not independent impacts. Scope is usually a *dial the PM turns in
response* to schedule or cost pressure — "we will cut scope" is a mitigation, not
an impact. Quality *converts into* the other axes: a quality shortfall becomes
rework, which becomes days and money. Simulating them as third and fourth axes
double-counts. They are recorded so the PM can see them and decide whether to
express the conversion as a schedule or cost driver.

**Class C** must never enter arithmetic with the others. A 5-on-safety is not
worth five days and cannot be traded against a schedule-2. Any composite score
spanning these axes is not merely imprecise, it is actively misleading — it
invites exactly the trade a governance process exists to forbid. These axes drive
escalation, not simulation.

**Therefore `severity` stops being the headline number.** The existing
`severity = probability × impact` field is **retained unchanged** on the wire (see
§5 — it is load-bearing for the `matrix/` endpoint, `OrderingFilter`, and the CSV
export), but the register gains a `worst_axis` read-only field naming *which* axis
is worst and at what rating. A risk that is safety-5 / schedule-1 must never
present as "severity 5, low".

### 2. Quantifying the two simulable axes

Each risk carries, per Class-A axis:

- a **probability**, resolved from the 1–5 ordinal through configurable band
  definitions (§4), with an optional explicit override;
- a **conditional impact** — "given it fires, how bad" — expressed as its own
  three-point estimate. This is a materially easier question to answer honestly
  than "what is my all-in P95", which is what the current design implicitly asks;
- **residual** counterparts, used in place of the inherent values when a
  `response` is chosen. Simulating inherent probability on a risk whose mitigation
  is in flight forecasts a world where the mitigation was paid for *and* the full
  impact was absorbed. (ADR-0043 already listed residual probability/impact as a
  deferred column; this is where that lands.)

**The cost axis fields ship in the same migration as the schedule axis but are
inert until 1.0.** They are written and read, exposed in the API and the register
UI, and excluded from simulation with an explicit "not yet simulated" affordance.
This is deliberate: the alternative is a second migration, a second serializer
change, a second register-UI change, and a second CSV-export change at 1.0.

### 3. The engine contract

```python
@dataclass(frozen=True)
class RiskDriver:
    id: str
    probability: float          # 0.0–1.0, already band-resolved by the caller
    task_ids: frozenset[str]    # every task this risk stretches
    # conditional schedule impact, in days, as a three-point estimate
    impact_optimistic: float
    impact_most_likely: float
    impact_pessimistic: float

def monte_carlo(project, *, risks: list[RiskDriver] | None = None, ...) -> MonteCarloResult
```

A plain frozen dataclass with no Django import, consistent with every other engine
input. The band resolution happens in the API layer; the engine receives a
probability, never an ordinal. A PyPI consumer with no `Risk` model constructs
`RiskDriver` directly.

**Sampling, per iteration:**

```
fired[r]  ~ Bernoulli(p_r)          # ONE draw per risk per iteration
for each task t:
    d[t] = <existing three-path sampling, unchanged>
    for r in risks where t in r.task_ids and fired[r]:
        d[t] += PERT(r.impact_optimistic, r.impact_most_likely, r.impact_pessimistic)
```

The **shared** `fired[r]` across every linked task is the correlation structure and
is the whole reason this design is worth building. Drawing per-task would model one
risk as N independent risks and collapse precisely the tail the register exists to
expose. It is also a far more principled way to introduce inter-task correlation
than the arbitrary correlation matrices comparable tools ask for, because every
correlation here is named, owned, and auditable.

**The risk draws come from a separate RNG stream.** `_sample_duration_matrix`
consumes the single seeded `rng` in a documented, order-independent sequence, and
the codebase already goes out of its way to keep that stream byte-for-byte stable.
Interleaving risk draws into it would change every existing seeded P50/P80/P95 and
every cross-engine conformance fixture. Risk draws therefore use an independent
child generator derived from the same seed (`rng.spawn(1)` / an explicit
`default_rng` derived stream), so:

- a project with no risks produces **bit-identical** output to today;
- adding a risk does not perturb any other task's inherent samples;
- the whole thing stays reproducible under a fixed seed.

This is a hard requirement, not an optimization.

### 4. Band definitions inherit Workspace → Program → Project

The 1–5 ordinal is meaningless until the bands are defined. Band definitions
follow the established NULL-means-inherit pattern exactly — the same shape as
`estimation_scale.py`, `calendar_settings.py`, `methodology.py`,
`attachment_policy.py`, and `mcp_settings.py`:

- a nullable override on `Program` and `Project`, non-null with a default at the
  `Workspace` root (`Workspace.load()` singleton);
- a dedicated `apps/projects/risk_bands.py` module exposing
  `resolve_effective_risk_bands` / `resolve_inherited_risk_bands` /
  `resolve_risk_bands_source`, computed-on-read;
- serializer exposure of effective value + inherited value + `source`, driving the
  "Inherit (<value>)" affordance.

The default band set is the ISO 31000 / PMBOK convention:

| Ordinal | Label | Simulated probability |
|---|---|---|
| 1 | Rare (<10%) | 5% |
| 2 | Unlikely (10–30%) | 20% |
| 3 | Possible (30–50%) | 40% |
| 4 | Likely (50–75%) | 62% |
| 5 | Almost certain (>75%) | 88% |

**This is a composite value — five bands that travel together — not a scalar
enum.** Every existing inheritable setting in the codebase is a single nullable
enum or FK. This is the first composite, and it is the one genuine divergence from
the established shape. It is stored as a validated JSON structure rather than
fifteen columns, and the resolver returns the whole band set as a unit — partial
inheritance (taking band 3 from the program and band 4 from the workspace) is
explicitly **not** supported, because a half-inherited probability scale is not
interpretable by anyone.

### 5. The API surface, and the semantic-drift problem

Because bands are project-configurable, **an ordinal 3 means 40% on one project and
30% on another**. An additive-field migration passes the `api:schema-drift` CI gate
while the *meaning* of an existing field changes underneath consumers — invisible
to CI, and precisely the failure mode that gate cannot see.

The resolution:

- **`probability` keeps its current meaning forever** — the raw 1–5 ordinal,
  never reinterpreted, never repurposed to carry a percentage. Existing consumers,
  ETL jobs, and the `matrix/` endpoint are untouched.
- **`probability_pct` is a new read-only resolved field**, the band-resolved
  value the engine actually used.
- **The response carries band provenance** — which scope supplied the bands and a
  version marker — so a consumer can detect that the *meaning* changed, not just
  that a field was added.
- `severity` is retained unchanged. `worst_axis` is added alongside it.

### 6. Marginal contribution ships separately, behind #2273

"What does mitigating this risk buy me?" is answered by re-running the simulation
with each risk forced off and taking the P80 delta — a mitigation-spend ranking no
severity matrix can produce, and the output that justifies the whole feature.

It is also **N+1 full simulations**. At the OSS caps this is bounded but not free:
small projects are sub-second, a 5,000-task project at 1,000 runs is "a few
seconds" per run, so 40 risks is minutes. `run_monte_carlo` executes inline on the
request thread today.

Therefore **marginal contribution is not in the same deliverable as the sampling
change.** It is gated on **#2273** (move Monte Carlo to Celery) landing first, and
when it ships it carries:

- a **risk-count cap** above which the full N+1 is refused, degrading to a sampled
  or grouped approximation that is **labeled as such** in the response;
- its own throttle scope, following the `monte_carlo_whatif` precedent (already
  rate-limited more tightly than `monte_carlo` because it costs "double the CPU of
  a single run");
- a new **risks-per-project dimension in the published sizing envelope**.

The sampling change (§2–§4) is independently valuable without it: it makes P80
honest. The ranking makes it actionable.

### 7. Scope boundaries stated explicitly

- **The agile path is untouched.** `delivery_mode=SCRUM` tasks sample from the
  velocity bootstrap, which takes precedence over PERT. A risk linked to a
  velocity-sampled task is recorded but does not modify its sampled duration —
  adding days to a throughput-derived duration mixes two incompatible uncertainty
  models. Composing risk drivers with velocity sampling is deliberately deferred
  and needs its own design (a risk firing plausibly reduces *velocity* rather than
  adding *days*). This ADR does not solve it and must not be read as having done so.
- **The quantified register is PM/risk-owner-owned.** Teams are never asked to
  fill in probability bands or conditional impacts, and the marginal-contribution
  output is a schedule-confidence artifact scoped to the risk/program level. It is
  **never** surfaced per-team, per-sprint, or attributed to an estimator. This is a
  binding constraint on any consuming UI, not a suggestion.
- **Cross-program and portfolio risk rollup stays Enterprise.**
- **The Rust/WASM engine is unaffected** — it has no Monte Carlo at all (see
  `known-issues.md`, "The Rust engine has no Monte Carlo — not scheduled"). No
  conformance obligation is created.

### 8. Provenance

Marginal P80 contribution is a new computed value, and 0.4 ships the provenance
graph (#1058) under the "computed, not guessed" principle. It routes through the
same provenance stamping as other derived values so an MCP client can cite the
derivation rather than assert the number.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. Status quo — pad the pessimistic estimate** | Zero work; already possible | Bimodal reality in a unimodal distribution; padding is unattributable and permanent; kills the ADR-0566 mitigation loop; destroys cross-task correlation |
| **B. Expected-value inflation** — set `pessimistic = ML + p × impact` | Trivial; no schema change | Produces a number that is neither P50 nor P80; hides the tail entirely; still unattributable. The deterministic answer to a probabilistic question |
| **C. Risk drivers, schedule axis only** | Smallest correct change | Register field design, serializer, UI, and CSV export all get reopened at 0.8–1.0 when cost and EV arrive |
| **D. Full multi-axis taxonomy, staged build** *(chosen)* | Axis taxonomy decided once; cost slots in at 1.0 without redesign; non-compensable axes get correct treatment from day one | Ships fields that are inert for three releases; more design surface now |
| **E. Simulate all axes** | Superficially complete | Double-counts Class B; produces a safety-vs-schedule composite that is actively harmful |
| **F. Arbitrary inter-task correlation matrix** | Standard in some tools | Correlations are unnamed and unauditable; nobody can say *why* two tasks correlate. Risk drivers give the same tail behavior with a named cause |

## Consequences

**Easier**
- P80 stops ignoring the register. The two halves of risk management connect.
- "Closing this risk buys N days" becomes computable — the ADR-0566 mitigation
  loop closes.
- Fat tails arise from a named, auditable cause rather than a tuning parameter.
- The 1.0 cost work slots into an existing axis instead of reopening this design.
- Conditional impact ("if it fires, +5/+8/+15") is a far easier question to answer
  honestly than an all-in pessimistic estimate.

**Harder**
- Data-entry burden on the register grows. A register that was three fields is now
  quantified per axis. Mitigated by: bands (pick 1–5, not a percentage), PM-only
  ownership, and every new field being optional — a risk with no quantification is
  simply not a driver.
- Two numbers now describe uncertainty (inherent spread and register risk) and the
  boundary between them is a convention, not a mechanism. See the open question.
- Band configurability makes `probability` context-dependent across projects.
  Mitigated by §5, not eliminated.

**Risks**
- **Double-counting on day one.** Every project that was already padding
  `pessimistic_duration` for register risks gets counted twice the moment risks
  become drivers. This is the single largest correctness risk in the change and is
  an open question below, not a solved problem.
- **False precision.** Asking for a percentage and a day-count may produce
  confident-looking numbers with no more information than the ordinals had. The
  observable signal is band values clustering at defaults with no variance.
- **Blame artifact.** Per-risk schedule cost is one UI decision away from becoming
  a per-team performance metric. §7 is the guard; it must be enforced in review.

## 🔴 Open questions — human decision required

1. **How is the inherent/discrete boundary enforced, if at all?** "Stop padding
   your pessimistic number" is a document, not a mechanism, and double-counting is
   therefore the *default* outcome for every existing project. Options: (a) accept
   and document it as a known limitation; (b) a detection heuristic that flags a
   task with linked risks *and* an anomalous O–P spread; (c) an entry-UI split that
   asks "is this variability or a specific risk?" at estimate time; (d) a
   one-time migration-time prompt per project. **Needs sign-off.**

   **Recommendation: do not enforce. Make it visible, and never change an existing
   forecast silently.**

   Reject (c) and (d). (d) asks a PM at upgrade time about estimates entered months
   ago by other people; nobody knows the answer, and it does nothing about ongoing
   behavior. (c) intervenes in the right place but misreads the mechanism: the
   simulated panel's strongest cross-persona signal — three personas converging from
   different angles — was that padding is **protective behavior, not a modeling
   error**. An estimator asked to self-classify will answer "inherent variability",
   because that is the answer that preserves their margin. Enforcement pressure also
   pushes padding out of the pessimistic value and into the *most likely* value,
   where it moves P50 as well and is far harder to detect — trading a visible
   problem for an invisible one.

   Proposed shape for 0.5:

   - **Risk drivers are opt-in per project — default OFF for existing projects, ON
     for new ones.** One more inheritable flag on the machinery §4 already
     establishes, so it is nearly free. No existing project's P80 moves on upgrade;
     a PM opts in having reviewed their estimates. The flag must appear in the
     Monte Carlo response (`risk_drivers: included | excluded`) so two projects with
     different forecast semantics are distinguishable on the wire — the same class
     of problem as the band drift in §5, and the same resolution.
   - **A forecast-level advisory, not a per-task nag**: "N tasks carry both linked
     risks and a three-point spread — their risk may be counted twice." One line on
     the Monte Carlo result, where the person who can act on it is already looking.
     The danger was never that P80 is wrong; it is that it is wrong *invisibly*.
   - **A contextual hint at estimate entry, asking nothing**: when a task has linked
     risks, the estimate field names them and says "estimate the work going
     normally".

   Defer (b). "Anomalous spread" needs a baseline, and an invented threshold
   produces false positives that train people to ignore the warning. **#2299**
   (calibration flywheel) *is* that baseline — sequence the heuristic there.

   Cost to accept: a per-project flag that outlives its purpose becomes its own
   debt. Time-box it — once registers are routinely quantified, flip the default
   and delete the flag.

2. **Does the register need per-link impact weighting?** `RiskTask` is currently a
   bare join. A risk may plausibly affect one task severely and another mildly. A
   per-link weight on the through-model would express that, at the cost of
   significantly more data entry. Current design applies the same conditional
   impact to every linked task. **Deferred pending evidence that the uniform
   assumption is wrong.**

3. **Threats only, or opportunities too?** `RiskResponse` is threat-shaped
   (AVOID / MITIGATE / …). An opportunity is the same mathematics with a negative
   impact, and would need a fifth response value plus UI that does not read as a
   bug. **Not scoped here.**

## Reconciliation with adjacent work

Three open issues each want to modify sampled durations, and they should share a
seam rather than accrete three bespoke code paths in `_sample_duration_matrix`:

- **#2299** (calibration flywheel — learn actual-vs-estimate distributions per
  team/task-type) is the **inherent-variability** half of the same anti-guesswork
  problem this ADR solves for the **discrete-event** half. They are complementary,
  not overlapping: #2299 makes the PERT spread empirical instead of guessed; this
  ADR moves discrete events out of that spread entirely. Both are needed; neither
  subsumes the other.
- **#2300** (discrete-event simulation — review queues, WIP, rework loops)
  overlaps at one point: a risk that *adds a task* (rework, re-certification)
  rather than stretching one. This ADR deliberately covers only the
  duration-modifier form; conditional task insertion belongs to #2300.
- **#582** (Brooks' Law friction coefficient) is a third multiplier on sampled
  duration.

**Recommendation**: introduce the risk driver as the *first* implementation of a
general per-iteration duration-modifier seam, shaped so #582 and #2300 register
against it rather than each editing the sampling loop. That seam is not designed
in this ADR, but the `RiskDriver` contract should not foreclose it.

- **#1495** (MC subtracts deterministic elapsed from sampled PERT total for
  in-progress tasks) touches the same function. It should land **before** this, to
  avoid rebasing a correctness fix under a feature change.
- **#2273** (MC to Celery) is a hard prerequisite for §6 only.

## Implementation Notes

- **P3M layer**: Programs and Projects
- **Affected packages**: `scheduler` (RiskDriver, sampling), `api` (model,
  migration, serializer, band resolver, settings sub-page), `web` (register UI,
  band settings, `types.ts`), `mobile` (WatermelonDB schema — `Risk` is a
  `VersionedModel` and therefore on the sync surface, so new fields are a mobile
  schema migration too)
- **Migration required**: yes — **additive nullable only**, no backfill, no table
  rewrite. All model edits batched into **one** `makemigrations` per the migration
  discipline in CLAUDE.md, followed by `ruff check --fix && ruff format`. Band
  definitions are validated JSON, so no new enum columns; indexes via
  `Meta.indexes`, no `RunSQL`.
- **API changes**: yes — new nullable fields on `RiskSerializer`; new read-only
  `probability_pct`, `worst_axis`, and band-provenance fields; `risks=` accepted
  by the Monte Carlo endpoint; `MonteCarloResult` gains per-risk contribution
  (§6 only). `docs/api/openapi.json` regenerated after merging `origin/main`.
  The risk CSV export (ADR-0043) gains the new columns — coordinate with #2401.
- **OSS or Enterprise**: OSS. Cross-program risk-adjusted rollup is the Enterprise
  extension, registered against the existing `risk_changed` signal seam.

### Durable Execution

1. **Broker-down behaviour**: N/A for §2–§4 — the sampling change is pure
   computation inside an existing synchronous request path with no async side
   effects. For §6, dispatch inherits whatever #2273 establishes for
   `run_monte_carlo`; this ADR adds no new dispatch path of its own.
2. **Drain task**: reuses #2273's drain. No new category of async work is
   introduced — a marginal-contribution run is a Monte Carlo run.
3. **Orphan window**: N/A — no outbox rows are written by this feature.
4. **Service layer**: band resolution lives in
   `apps/projects/risk_bands.py` (new module, matching `estimation_scale.py`).
   Simulation dispatch continues through the existing scheduling service layer;
   no direct `.delay()`.
5. **API response on best-effort dispatch**: unchanged for §2–§4 (synchronous 200,
   or 402 on `SimulationCapExceeded`). §6 follows #2273's contract.
6. **Outbox cleanup**: N/A — no outbox rows.
7. **Idempotency**: a Monte Carlo run is a pure function of
   (project state, risk drivers, runs, seed) and is naturally idempotent —
   re-running produces the same result under a fixed seed and writes a new
   `MonteCarloRun` history row, which is the intended behavior (ADR-0175).
   Duplicate execution is therefore safe by construction.
8. **Dead-letter / failure handling**: N/A for §2–§4 (synchronous; errors surface
   as 4xx — `SimulationCapExceeded` → 402, `CyclicDependencyError` → 400). For §6,
   inherits #2273's retry limit and failure handling. The risk-count cap degrades
   to an approximation rather than failing, and labels the response accordingly.
