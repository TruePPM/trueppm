# ADR-1048: Waterfall governance — the OSS-basic / Enterprise-governance line for change control, phase gates, leveling, and status reporting

## Status

Proposed (2026-09-05). Resolves #3337. Extends the boundary rule in `CLAUDE.md`
("adoption versus governance") to the five waterfall-governance surfaces the
2026-09-03 methodology audit graded **Engine A, Governance D**. Companion records:
ADR-1049 (constraint types) and ADR-1050 (configurable task status) settle the two
engine-adjacent questions the same audit raised.

## Context

TruePPM's scheduling engine — four dependency types, CPM with float, Monte Carlo,
a program-true critical path — is ahead of every self-hosted competitor. The
governance layer a waterfall or hybrid PM needs to *run* a governed project is
absent or stubbed, and until now nothing said which half of it the OSS core would
ever carry:

| Surface | On `main` today (verified 2026-09-05) | Tracked |
|---|---|---|
| Change control | `Baseline` has a name and a frozen calendar (ADR-0845); no rebaseline reason, no changeset, no amend flow. Change Requests (#1312) are scoped to **agent** proposals only. | #101 (0.5), #3150 (0.4), #1312 (0.6) |
| Phase gates | `PhaseGateConfig` is a per-program `enabled` flag plus an `invite_template` with zero readers (its own docstring: "v1 is config-only"). No gate row, no state, no hold. | #2983 (0.5) |
| Cost / earned value | none — `RollupKpi.COST_VARIANCE` and `BUDGET_UTILIZATION` resolve to `"no_cost_data"` unconditionally | #1444, #2139 (0.8), #2557 (1.0), #3426 (hide the dead controls, 0.5) |
| Resource leveling | none. `services.py` describes the sprint-capacity read as "NOT cross-program resource leveling … (those are Enterprise)" — which is consistent with the ruling below and needs no change | #1442 leveling, #2625 smoothing (0.6), #744 (0.5) |
| Status / variance reporting | `Project.health` is a four-value enum with no narrative; Reports tab is one burn chart; export is Gantt PDF only | #3425 (0.5, filed from this ADR's audit), #147 (0.5), #370 (0.8) |

The P3M layer is **Programs and Projects** throughout: every surface here is what one
PM needs inside one program. The question is not the layer; it is where, inside each
surface, the PM's own working record ends and organizational governance begins.

The `enterprise-check` run recorded on #3337 proposed a per-surface split. This ADR
adopts it, states the single principle that generates every row, and names the one
row where the principle and an existing code comment could be read to disagree.

### Why decide this before the 0.4 beta cut

The beta positioning is "beta for the schedule, alpha for governance". That sentence
is honest only if the gaps page can say, for each governance surface, which half is
coming to the OSS core and which is Enterprise. Today it says neither for reporting,
change control, or gates, because there was no ruling to cite. #3429 rewrites that
page against this ADR.

## Decision

**One principle generates every row: the PM's own record is OSS; a second party's
mandated sign-off is Enterprise.** The line is *who must approve*, never *what is
recorded*. A record that a PM writes for themselves — a reason, a changeset, a gate
verdict, a status narrative, a leveled schedule — is OSS however formal its
vocabulary. The moment the record cannot be finalized without an organizationally
mandated approver, a multi-step chain, or an org-wide policy, it is governance and it
is Enterprise.

One deliberate widening: a **single, PM-chosen approver** is OSS. #1312 already drew
this line for agent proposals ("single approver = OSS; multi-step chains, delegated
authority, org policy = Enterprise"), and a team-level soft gate the PM opts into is
the PM's own working practice, not an imposed control. It stays OSS whether the
proposer is a human or an agent.

Applied per surface:

| Surface | OSS basic | Enterprise governance |
|---|---|---|
| **(a) Change control** | Rebaseline reason and visible changeset with an amend flow (#101, #3150). A **change request** raised by a human *or* an agent, with impact analysis and a disposition by one PM-chosen approver (#1312, re-scoped 2026-09-05, 0.6). | Multi-approver change-control board, mandated approval before commit, org policy on what requires a CR, CCB sign-off ceremony and its audit trail. |
| **(b) Phase gates** | A gate as a **first-class row** on a phase-boundary milestone: gate date, deliverables checklist, state `open / passed / failed` set by the PM or a Scheduler, and an optional **hold** that blocks status advance on the next phase's tasks until the gate passes. Dispatch of the gate review from the existing `PhaseGateConfig` template (#2983). | Multi-approver sign-off with recorded evidence, policy-locked gates the PM cannot override, cross-program gate conformance, and the audit trail of who ruled and when. |
| **(c) Cost / earned value, single project** | PV / EV / AC with SPI / CPI within one project, resource rates, cost rollup on the WBS — already on the roadmap as OSS (0.8–1.0). | Portfolio cost rollup, ERP integration, a report builder. |
| **(d) Resource leveling, single program** | Leveling (#1442) and smoothing (#2625) **within one program**: delay non-critical tasks inside float, manual trigger, preview before apply, per-activity derivation (#2624). Rule 8 in the boundary table (core scheduling algorithm) and `CLAUDE.md` ("*cross-program* resource leveling" is Enterprise) both place this in OSS. | Cross-program leveling, the cross-portfolio heat map, scenario comparison across programs. |
| **(e) Status / variance reporting** | A **project status update**: PM-chosen RAG, written narrative, and a computed snapshot (milestones with baseline variance, CPM finish vs baseline, P50 / P80, top risks, completed and slipped counts, open decisions), with history, a program-level rollup, a one-page PDF, and a read-only share render (#3425, #147, #1200, #1596). A generated draft narrative from that snapshot (#370) is also OSS — it is the PM's own report, drafted. | A report builder, scheduled delivery to arbitrary audiences, narrative forensics across periods, cross-program status packs, regulator-shaped evidence bundles. |

The `services.py` comments #3337 flagged (lines 1473 and 1636 at audit time) say the
sprint-capacity read is "NOT cross-program resource leveling or a cross-portfolio heat
map (those are Enterprise)". That is exactly ruling (d). No reconciliation edit is
needed; the acceptance item on #3337 closes as verified-consistent.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. All governance is Enterprise** (the reading the audit found implied by the stubs) | Cleanest upsell story; nothing to build in OSS | Fails the adoption test outright. A PM who cannot record why they rebaselined, or produce a status report, cannot run a governed project in OSS at all, and the Tier-1 market runs regulated phase gates over agile squads. OpenProject Community ships project status, budgets, and workflow rules for free. |
| **B. Per-surface splits with no shared principle** (the raw `enterprise-check` table) | Each row defensible on its own | Every future surface re-litigates the line; two rows in the table already used different tests ("PM needs it" vs "cross-program"). |
| **C. One principle — the PM's own record vs a mandated second-party sign-off — applied per surface (chosen)** | Generates every row above from one test; matches the precedent #1312 already set for agent proposals; keeps the single-approver soft gate in OSS where team practice lives | The line inside (b) is subtle: a PM-set gate verdict is OSS, an org-mandated approver on the same gate is Enterprise. The gate model must carry an extension point for the approver chain from day one. |
| **D. Single approver is Enterprise** (the strict reading of "approval workflows are Enterprise") | Simpler Enterprise story | Contradicts #1312's accepted line; makes the OSS change request a log with no disposition, which is the half a PM actually needs; pushes the Tier-1 hybrid PM to Enterprise before they have felt value. |

## Consequences

**Easier.** The gaps page, the story page, and every evaluator conversation can now
say for each governance surface what the OSS core will do and what it will not. The
five OSS-basic slices each have an owning issue and a milestone. Future governance
surfaces (an assumption log, an issues register, a stakeholder register) are classified
by asking one question.

**Harder.** Every OSS-basic model in (a), (b), and (e) must ship with a stable
extension point — a `dispatch_extension_signal()` on finalize, or a registered slot —
so the Enterprise approver chain can register against it without the OSS write path
ever depending on it. That is a design constraint on #1312, #2983, and #3425, and it is
cheaper to carry from the first migration than to retrofit.

**Risks.** The single-approver widening is the row most likely to be read as
"approval workflows in OSS". The mitigation is vocabulary: the OSS object is a
*disposition by an approver the PM chose*, never a *workflow*; the Enterprise object is
the *policy* that makes an approver mandatory. Docs and serializer field names should
hold that distinction.

## Implementation Notes

- **P3M layer:** Programs and Projects.
- **Affected packages:** api, web, scheduler (for d), docs. No code ships with this
  ADR; it re-scopes issues.
- **Migration required:** no (this ADR). Each child issue carries its own.
- **API changes:** no (this ADR).
- **OSS or Enterprise:** OSS records the decision. Enterprise registers against the
  extension points the child issues expose.

### Durable Execution

1. **Broker-down behaviour:** N/A — design-only ADR; no dispatch. Each child issue
   answers this for its own write path (the gate dispatch in #2983 goes through the
   outbox; the status-update post in #3425 is synchronous with a best-effort digest fan-out).
2. **Drain task:** N/A.
3. **Orphan window:** N/A.
4. **Service layer:** N/A here. Children: `services.py` functions named in their own ADRs.
5. **API response on best-effort dispatch:** N/A.
6. **Outbox cleanup:** N/A.
7. **Idempotency:** N/A.
8. **Dead-letter / failure handling:** N/A.

### On Acceptance

- [ ] Open issues naming this ADR re-read against the settled decision:
      `python3 scripts/adr-accepted-issue-sweep.py --adr 1048`
- [ ] #3337 acceptance items closed: (a)–(e) line recorded here; `services.py` comments
      verified consistent (no edit); child issues #3425, #1312 (re-scoped), #2983, #1442,
      #2625 carry milestones; #3429 rewrites `overview/what-it-does-not-do.md`.
- [ ] #2983 re-titled to name the gate row and the hold, and its body cites this ADR's
      (b) row for the OSS / Enterprise split it asks about.
- [ ] Record the count of issues rewritten, including zero.
