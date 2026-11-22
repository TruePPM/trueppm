# ADR-1464: The derived health band reads P80 against the commitment; worst child stops at Program; Workspace has no health in OSS

## Status

Proposed (2026-11-22)

> **Implementation status (2026-11-22):** design only. Verified on `main`:
> `compute_health_band()` (`projects/views.py`) derives the band from
> `health_count_filters()`. An incomplete leaf with `is_critical` (`total_float == 0`, see
> `engine/backward.py`) makes the project **critical**, and one with ≤5 days of float makes
> it **at risk**. A PM's `Project.health` override wins and is labeled
> `health_band_source=reported`. `p80_delta_vs_commitment_days`, `commitment_date` and
> `commitment_source` already exist on the Monte Carlo payload (`scheduling/serializers.py`,
> `projects/metric_provenance.py`, ADR-1314). `Program.rollup_aggregation_policy`
> defaults to `AggregationPolicy.WORST`.

## Context

Layer: **Programs and Projects**, with Program rollup in OSS. Portfolio and Workspace health scores are Enterprise (#3901 enterprise-check ruling, 2026-09-18).

**Correction to earlier Pass 4 handoff text:** the derived health rule has **no dedicated ADR**. The handoff called it "ADR-0133", but ADR-0133 is *server-derived task capabilities*, which the health code cites only for its "one rule computed server-side" principle. Under **ADR-1314** the owner of `health_band` is `GET /projects/{id}/status-summary/`.

**Problem.** Every project with unfinished work has a zero-float chain, so the derived band reports **Critical for almost every active project** that has no PM override. A signal that is always red carries no information. Pass 4 (canvas section 5, decided 2026-11-22) chose these rules:
- The derived band is P80 against the commitment.
- The PM override stays, and is labeled.
- The worst-child rollup stops at Program.
- Workspace shows no health and no counts in OSS. Counts are Enterprise under the #3901 ruling (enterprise-check, 2026-11-22).

## Decision

1. **The derived branch** of `compute_health_band()` thresholds the **existing** owner metric `p80_delta_vs_commitment_days`:
   - ≤ 0 → `on_track`;
   - 1–5 → `at_risk`;
   - more than 5 → `critical`;
   - null → `not_computable`, with `health_reason` copied from `p80_delta_vs_commitment_reason` (`no_commitment`, `no_forecast`).

   The thresholds use that metric's documented unit ("calendar days measured in working time"). UI copy says "days", not "working days" (a correction to the Pass 4 frames). The thresholds are module constants, not settings (Q5.2 deferred).
2. **The PM override is unchanged.** `Project.health` still wins (`health_band_source=reported`). The response adds:
   - **`engine_band`**: the derived band even when overridden, so the UI shows “PM reports ◆ · engine says ✓”;
   - **`health_reported_at`**: a new nullable field on `Project`, set when `health` moves off AUTO. It drives the override's age display and a reconfirmation prompt at 14 days (Q5.8).
3. **Contract and versioning.** `health_band` keeps its name and values, plus the new value `not_computable`. New fields: `band_basis` ∈ {`p80_vs_commitment`, `float_counts`} (always present), `engine_band`, `health_reason` and `health_reported_at`.
   - `?health_basis=float_counts` returns the old derivation for **one minor release**, with `Deprecation` and `Sunset` headers and a `changed` changelog fragment that names the removal release (Q5.7).
   - `status_update_services.derived_health` and every other caller go through the one function (ADR-1314 owner rule).
4. **Program rollup.**
   - The worst-child rule is the existing `AggregationPolicy.WORST` (the default), so ADR-0088 is unchanged.
   - Not-computable children are **excluded from the band and disclosed**: the rollup gains `derivation{rule, driver_project, total, computable, reported}`.
   - A program whose children are all not computable is `not_computable` (“no child computable”).
   - The program's `as_of` is its oldest child's.
5. **Workspace has no health at all in OSS.** It has no band and **no counts**. The Work list shows each program's and standalone project's **own** badge, side by side, and nothing is computed across them.
   - Counts per band across programs would be an aggregation across programs. The #3901 enterprise-check ruling (2026-09-18) allows Workspace health in OSS only where “no computation, comparison, or aggregation across Programs happens anywhere”. Re-confirmed in this ADR's enterprise-check, 2026-11-22.
   - A workspace counts or summary view is an **Enterprise** read over the OSS per-program fact, and it must read that fact rather than recompute it.
   - #3901 receives a superseding note: computed band, override kept, and no manual 7-stage scale.
6. **ADR-0698 is unaffected.** The forecast's added time stays neutral. Color expresses only this band, which is the at-risk or critical signal that rule 172 reserves color for.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| Keep the float-count rule | No migration of meaning | Almost always red, so it can't inform |
| A manual 7-stage downward cascade (#3901 as filed) | Simple, and no engine involvement | Self-reported (“watermelon”). Seven colors can't each carry a glyph and a word, and three of them would be red. |
| A blended score (schedule, cost, staffing) | One number | Opaque, which contradicts “computed, not guessed”. Cost and staffing keep their own chips (Q5.1). |
| A Workspace band | One glance for executives | Portfolio health score territory, which is Enterprise (#3901 ruling) |

## Consequences

- Easier: the band now means something, every band traces to one number with an `as_of`, and the PM's voice is kept and labeled.
- Harder: a semantic change on a shipped field. That requires the deprecation window, `band_basis`, an upgrade note, and a check of downstream alert rules.
- Risks:
  - Projects without a baseline or program target become `not_computable`. That is honest, and the checklist (canvas 8c) prompts the user to set a commitment.
  - Stale PM overrides. These are mitigated by the age display and reconfirmation.

## Implementation Notes

- P3M layer: Programs and Projects.
- Affected packages: api, web (HealthBadge), mcp (reads carry `band_basis` and `_provenance`), docs.
- Migration: yes. `AddField(Project.health_reported_at, null=True)` and `AddField(Project.health_report_note, blank=True)` (AI-review), both expand-only.
- API changes: yes, as listed in items 3–5. `docs/api/openapi.json` is regenerated, and the schema-guard fixtures are updated.
- OSS.

### Durable Execution
1. Broker-down behavior: N/A. The band is computed on read from persisted Monte Carlo and baseline facts, with no new async work.
2. Drain task: N/A.
3. Orphan window: N/A.
4. Service layer: `compute_health_band()` remains the single function, extended in place.
5. API response: synchronous read.
6. Outbox cleanup: N/A.
7. Idempotency: a pure function of stored facts.
8. Dead-letter: N/A. A missing forecast yields `not_computable` with its reason, never a guess.

### AI-review amendments (2026-11-22)
- **Provenance:** the band carries `derivation{basis, p80, commitment_date, commitment_source, delta, mc_run_id, as_of}` from the owner metric (ADR-1314), so an agent can cite why a project is ◆. The program rollup's `derivation` names `driver_project` with that project's own derivation.
- **Write safety:** the PM override (`Project.health`) requires a human session. An agent cannot set a band. A token attempt is a `refused` `AgentAction`.
- **Decision memory:** setting an override takes an optional `health_report_note`, a new nullable text field on `Project`. The override (who, when, from what to what, the note) is a decision written to #1059 when that lands. Until then it goes to project history.
- **MCP:** the existing status-summary MCP read gains `band_basis`, `engine_band`, `health_reason`, `health_reported_at` and `derivation`.

### Enterprise-check (2026-11-22)
**OSS** for the project band, the PM override and the Program worst-child rollup. Program is an OSS entity, and rolling up within one program is not portfolio governance. **Enterprise** for any Workspace-level aggregate, including plain counts per band, under the #3901 ruling. Cited: `overview/the-oss-enterprise-line.md` (“OSS gives you reality and why”: a band with its derivation is reality, and a cross-program health summary is portfolio health-score territory).

### On Acceptance
- [ ] Sweep `--adr 1464` (#3901) and record the count. Add the superseding note to #3901.
- [x] Enterprise counterpart filed 2026-11-22: trueppm-enterprise#210 (workspace and portfolio health summary, reading the per-program fact).
- [ ] Update `METRIC_DEFINITIONS["health_band"]` and the HealthCluster docs in the same change.
