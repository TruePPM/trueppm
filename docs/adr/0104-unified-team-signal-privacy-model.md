# ADR-0104: Unified Team-Signal Privacy Model + Enterprise Rollup Extension Point

> **Companion ADRs (0.3 agile-team architecture batch).** ADR-0104 = Unified Team-Signal Privacy Model · ADR-0105 = PO Product-Backlog Hierarchy & Scoring · ADR-0106 = Agile/Waterfall Bridge. Where this ADR refers to "the Privacy ADR", "the Backlog ADR", or "the Bridge ADR" it means 0104 / 0105 / 0106 respectively. **ADR-0104** is this document.

## Status
Proposed

## Context

Three 0.3 issues each add a control over a team-private signal, and the Agile Coach (Morgan) requires they read as **one coherent privacy model**, not three inconsistent switches:

- **#553** — velocity-visibility gate: today the rolling-velocity series (`velocity_summary`, `services.py:391` — including a per-closed-sprint `sprints[]` array carrying `completed_points`, `services.py:445`) is exposed by `ProjectVelocityView` (`views.py:6182`) gated `[IsAuthenticated, IsProjectMember, IsProjectNotArchived]`. `IsProjectMember` (`permissions.py:101-125`) is **membership-only with NO role floor**, so **every VIEWER+ project member reads the full series today**. There is no tier control. The gap #553 closes is *upward* exposure (PM/PMO/cross-team), not the team's own read.
- **#854** — velocity/throughput rollup opt-in: 0.2 shipped a program rollup with no team-consent layer. Needs a per-project *consent* toggle (default OFF) before any program rollup exposes the metric.
- **#923** — retro team-health pulse: a single-team mood/energy poll inside the live retro board (#851). Ships **only** if team-private by default, opt-in to share, with the same posture as #553; a PM/PMO-visible-by-default pulse is a burnout-surveillance instrument and an instant 🔴.

**P3M layer**: Programs and Projects / Operations — single-project, team-scoped self-governance. **OSS** (the controls, the gate, the defaults, the consent record). Cross-team aggregation (velocity rollup #140, coaching-maturity dashboard #141, portfolio sprint-scope approval #142) is **Enterprise**, already filed in `trueppm-enterprise` at milestone 1.0 — this ADR defines the OSS *extension point* they register against; it does **not** build the cross-team feature.

### Grounding in the actual code (verified 2026-05-31)

1. **`ProjectGuardrailPolicy`** (`apps/projects/models.py:2330`, `VersionedModel`, OneToOne→Project, JSON levels map, `HistoricalRecords`) is the exact singleton-companion shape to mirror.
2. **`velocity_summary`** returns the band (`forecast_range_low`/`high`, `rolling_avg_points`/`stdev`) AND the raw `sprints[]` series (`services.py:445`). Its endpoint `ProjectVelocityView` (`views.py:6182`) gates on `IsProjectMember` — **membership-only, no role floor** (`permissions.py:101-125`): every VIEWER+ member reads the full series today. The suppression gate strips the series, keeps the band, **only when a team raises the audience above a reader's tier** — the default keeps today's any-member read intact (see §1).
3. **`RetroVisibility`** (`models.py:1941`: `TEAM_ONLY`/`PROJECT`/`ORG`, default `TEAM_ONLY`) gates `SprintRetro.team_visibility` (line 1976) — a project-*breadth* axis, NOT a management-*tier* axis. It is reconciled, not overloaded.
4. **`_membership_role(request, project_id)`** (`access/permissions.py:48`) returns `None` for a non-member and is per-request cached — the back-door close.
5. **Role ordinals** (`access/models.py`): VIEWER=0, MEMBER=100, SCHEDULER=200 ("Resource Manager"), ADMIN=300 ("Project Manager"), OWNER=400. The PM is ADMIN. There is no PO/SM ordinal; PO/SM is an agile *hat* (ADR-0101/0102), and the Team facet (`is_product_owner`) is in ADR-0078 (Proposed) — not yet in code.
6. **No OSS program/PMO velocity rollup endpoint exists** — the enterprise rollup is a future consumer.

### Forces

1. **Morgan's velocity-privacy hard-NO (🔴 if wrong)**: team metrics are team-private by default with no automatic velocity→PMO pipeline; sharing *upward* is explicit, team-owned, revocable, and enforced in OSS core. Critically, this means the team must NOT lose visibility of its OWN velocity — the sensitive direction is upward, and the default must not silently demote the team's existing read.
2. **Three controls, one mental model**: #553 (enum), #854 (consent toggle), #923 (pulse visibility) must compose on a single abstraction; the SM ratchet-down to team-only must be a first-class one-click move.
3. **Distinct per-signal defaults are required**: the pulse default MUST be strictly more private than velocity, and the velocity default must preserve today's any-member team read.
4. **Reconcile, don't overload `RetroVisibility`** (wrong axis).
5. **RBAC primitive**: a non-member (the only way an org/PMO principal arrives) is structurally below the lowest tier (the back-door close).
6. **Suppress, don't 403**: aggregates (milestone health, schedule confidence, action-item counts) stay visible; the gated detail (velocity points, pulse values, raw notes) is suppressed.

## Decision

### §1 — One model, one ladder, per-signal defaults

**New singleton `ProjectSignalPrivacyPolicy`** (`apps/projects`, OneToOne→`Project`, `get_or_create` lazily on first GET, PATCH-only — the `ProjectGuardrailPolicy` shape exactly; `VersionedModel` + `HistoricalRecords`; declare `objects = models.Manager()` explicitly per the cross-app stubs convention):

- `signal_visibility = models.JSONField(default=dict, blank=True)` — maps each signal key to a `SignalAudience` value; an absent signal falls back to its coded default. JSON so a future signal needs no migration.
- `HistoricalRecords(...)` — every audience change is attributable (§4).

**One ordered audience enum** (pin via `ENUM_NAME_OVERRIDES`):

```
class SignalAudience(models.TextChoices):
    TEAM           = "team",           "Team only"            # MEMBER+ on the project
    TEAM_SM        = "team_sm",        "Team + Scrum Master"  # adds the SM/coach lifecycle hat
    TEAM_SM_PM     = "team_sm_pm",     "Team + SM + PM"       # adds role >= ADMIN (the PM)
    PROGRAM_SHARED = "program_shared", "Shared to program rollup (opt-in)"  # only level the enterprise rollup may read
```

`PROGRAM_SHARED` is the **single opt-in level** that makes a signal eligible for the cross-team rollup (§3).

**Three signal keys + their defaults** (the defaults *are* the VoC posture):

| Signal key | Default | Why |
|---|---|---|
| `velocity` | `TEAM` | #553: **preserves today's behavior — every VIEWER+ project member reads the team's own velocity series** (ground truth: `ProjectVelocityView` is membership-only, no role floor). The sensitive direction is *upward*; the default exposes nothing to PM/PMO/cross-team automatically, while leaving the team's own read untouched. The team may opt *up* (TEAM_SM_PM / PROGRAM_SHARED) to share velocity wider, or the SM may ratchet *down* if a team wants velocity SM-only — both are explicit, team-owned moves. (Earlier drafts defaulted this to TEAM_SM_PM with a 'no regression — PM-readable' rationale; that was factually inverted — defaulting above TEAM would *suppress* the series for ordinary members who read it today, a downward regression on Morgan's surface. Corrected to TEAM.) |
| `throughput_rollup` | `TEAM` | #854: OFF — never exposed upward without explicit opt-in. |
| `pulse` | `TEAM` | #923 🔴: most private — team + coach only. |

All three default to `TEAM`. Velocity's `TEAM` default is the **regression-preserving** floor (no in-project member loses their current velocity read); throughput and pulse's `TEAM` default is the **never-leaked-upward** floor. The pulse can only become more private than velocity if a team raises velocity — by default they are equally team-private, and neither is exposed upward. There is no code path that defaults any signal above `TEAM`.

**SM one-click ratchet-down (Morgan's explicit ask).** `POST /api/v1/projects/{id}/signal-privacy/ratchet_down/` sets **every** signal to `TEAM` in one call (`role >= Role.ADMIN`, project member). Idempotent; writes one audited history entry per changed signal.

**Reconciling `RetroVisibility`.** `SprintRetro.team_visibility` stays as-is, gating a *single retro's free-text notes* (project breadth). The **pulse trend** (the #923 signal that could leak upward) is governed by `signal_visibility['pulse']` (management tier), NOT by `RetroVisibility`. No fourth switch.

### §2 — Server-side suppression gate

A single OSS service helper owns the decision:

```
def audience_can_read(policy, signal_key, requester_tier) -> bool
def requester_signal_tier(request, project_id) -> SignalAudience | below-team sentinel
```

`requester_signal_tier` derives the tier from `_membership_role(request, project_id)`:
- `None` (non-member — the only way an org/PMO principal arrives) → **below TEAM** → denied for every signal **regardless of role ordinal** (the back-door close; an Enterprise custom role above `OWNER` that is not a project member has no `ProjectMembership` row and cannot pass). This is the only requester denied velocity at the default (`velocity=TEAM`) audience.
- `>= Role.ADMIN` → PM tier (`TEAM_SM_PM`). The SM/coach hat maps to the team-lifecycle gate (`role >= Role.ADMIN`); the PO role (#496) maps here when it lands.
- `Role.MEMBER` / `Role.VIEWER` → `TEAM` tier.

The three read paths call the gate **before** assembling the gated numbers and **suppress** (not 403) when the tier is below the signal's configured audience:

1. **`velocity_summary` read** — when tier < `signal_visibility['velocity']`, the `sprints[]` series + rolling points / sparkline are omitted; the milestone-health % and schedule confidence remain. At the `TEAM` default, every project member passes (tier `TEAM` is not below audience `TEAM`), so the read is byte-for-byte unchanged from today; only a non-member is denied, and only a team's explicit opt *up* would suppress an in-project member.
2. **Milestone rollup payload** (`compute_milestone_rollup_payload`) — the velocity/throughput point cells suppressed when below `['velocity']` / `['throughput_rollup']`; the % completion stays.
3. **Pulse-trend read** (new #923 endpoint) — the per-sprint mood/energy series returned only when tier >= `signal_visibility['pulse']`; otherwise the trend is omitted **entirely** (a redacted pulse is no pulse — there is no safe aggregate fallback).

### §3 — Enterprise cross-team extension point (consumes opt-in only; non-consenting team excluded, not zero-filled)

Two OSS surfaces, both supply-only:

- **`get_shared_team_signals(project) -> dict | None`** (new `signal_privacy_services.py`). Returns a dict of *only* the signals whose configured audience == `PROGRAM_SHARED`; returns **`None`** when the project shared nothing. Because all three signals default to `TEAM`, a project that has changed nothing shares nothing — opt-in is strictly explicit. Invariant: **a non-consenting team is EXCLUDED (the consumer skips a `None`), never zero-filled** — a zero-fill would let a PMO infer non-sharing or dilute an aggregate, pressuring opt-in.
- **`team_signal_consent_changed = django.dispatch.Signal()`** (`projects/signals.py`) — emitted on every audience change. OSS only emits; Enterprise connects a receiver in `AppConfig.ready()` (the established `risk_changed` / `sprint_scope_changed` pattern; receiver I/O deferred with `transaction.on_commit()`).

**The resolver is supply-only — no auto-share path** (mirrors the ADR-0102 §3 / ADR-0101 `guardrail_policy_resolving` read-only invariant): there is no field, signal, or hook by which an external/enterprise actor can *set*, default, or upgrade a project's audience. The **only** writer of `signal_visibility` is the human-invoked, `role >= Role.ADMIN`, project-member-gated PATCH/ratchet endpoint.

**Coupling with the bridge forecast seam.** The companion Agile/Waterfall Bridge ADR fires a `milestone_forecast_recomputed` signal carrying a milestone confidence band. That band is a team signal and is cross-team-eligible **only** when the project's `signal_visibility['throughput_rollup']` (or `['velocity']` as configured) is `PROGRAM_SHARED`. Since both default to `TEAM`, the band does not flow cross-team until a team explicitly opts in. The bridge seam therefore composes with `get_shared_team_signals` rather than bypassing it — there is one consent boundary, not two.

### §4 — Consent change is audited (who flipped sharing on/off)

`ProjectSignalPrivacyPolicy` carries `HistoricalRecords`, so every audience change is captured with actor + timestamp. The PATCH/ratchet endpoints write `history_change_reason` (e.g. `"velocity audience: team -> program_shared"`) so the timeline classifies the change (ADR-0096/0098 pattern). The audit is **team-readable-first** — it follows the existing project history-endpoint RBAC, honoring the tier-2 sprint-sovereignty rule that team audits are team-readable before management-readable. The `team_signal_consent_changed` signal additionally lets an Enterprise immutable-audit receiver capture upward-share decisions, but the OSS history is the source of truth.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A: one `ProjectSignalPrivacyPolicy` singleton, one `SignalAudience` ladder, per-signal JSON map with distinct defaults (all `TEAM` — velocity regression-preserving, throughput/pulse never-leaked), suppress-gate in a shared service, supply-only consent-gated enterprise provider (chosen)** | Three controls on one mental model; the velocity `TEAM` default preserves today's any-member read (no regression) while still blocking upward exposure; per-signal defaults satisfy 'pulse strictest'; reuses the `ProjectGuardrailPolicy` idiom; back-door closed via `_membership_role`; opt-in stays team-owned; a future signal needs no migration; one consent boundary shared with the bridge seam | A second policy singleton on `Project`; the gate must be remembered in any *new* signal read path (mitigated by the single helper + a test) |
| A′: default velocity to `TEAM_SM_PM` | Symmetric upper-tier framing | Suppresses the velocity series for ordinary VIEWER+ members who read it today (ground truth: membership-only endpoint) — a downward regression on exactly Morgan's surface, and the 'no regression — PM-readable' rationale that justified it was factually inverted. Rejected for `TEAM`. |
| B: three independent fields on `Project` (#553's literal proposal) | Smallest diff | Three inconsistent switches — exactly what Morgan forbids; SM ratchet-down touches three unrelated fields; a fourth signal repeats the divergence |
| C: extend `RetroVisibility` to cover all three signals | Reuses a shipped enum | Wrong axis (project breadth, not tier); no `PROGRAM_SHARED` rung; overloading breaks retro free-text gating + sync payload. Rejected — reconcile, don't overload. |
| D: enterprise rollup zero-fills non-consenting teams | Cleaner cross-team math | Zero-fill lets a PMO infer non-sharing and pressures opt-in — Morgan 🔴. Rejected; non-consenting teams excluded. |
| E: a resolver that can *set* a default org audience | Org can enforce a baseline | Any external write path to `signal_visibility` is an automatic velocity→PMO pipeline by another name (Morgan 🔴). Rejected — supply/read-only. |

## Consequences

**Easier**: a team learns one privacy model and applies it to velocity, rollup, and pulse identically; the team keeps its current velocity read by default (no regression); the SM makes everything team-private in one click and can prove (audited) who changed sharing; the OSS/Enterprise privacy line is a named, supply-only, consent-gated extension point #140/#141/#142 register against; Marcus still sees milestone health + schedule confidence (never gated). The bridge forecast band shares this one consent boundary.

**Harder**: a second policy singleton joins `ProjectGuardrailPolicy` on `Project`; any *new* team-signal reader must route through `audience_can_read` or it re-leaks (mitigated by the single helper + a regression test); the two visibility axes (`RetroVisibility` breadth vs `SignalAudience` tier) must be kept distinct in UI and docs.

**Risks**: (1) forgotten gate on a future signal — mitigated by centralizing in `audience_can_read` + a test that the three known paths suppress. (2) drf-spectacular enum collision on `SignalAudience` — pin via `ENUM_NAME_OVERRIDES` in the same MR. (3) non-member tier mapping drift — `_membership_role(...) is None → below TEAM` is the entire back-door close; unit-tested with an org-principal-without-membership fixture (the 🔴 test). (4) the pulse-trend read must never fall back to a redacted aggregate — a below-tier requester gets *no* trend, asserted by test. (5) a velocity-default regression — guarded by a pytest asserting a plain MEMBER's `velocity_summary` read at the default policy is byte-for-byte identical to today (no series suppression at the `TEAM` default).

## Implementation Notes
- **P3M layer**: Programs and Projects / Operations (single-project, team-scoped). Cross-team rollup is Portfolios → Enterprise.
- **Affected packages**: api (`ProjectSignalPrivacyPolicy` singleton, `SignalAudience` enum, `signal_visibility` map, `audience_can_read`/`requester_signal_tier` gate, suppression in `velocity_summary` read/`compute_milestone_rollup_payload`/pulse-trend read, `get_shared_team_signals` provider, `team_signal_consent_changed` signal, ratchet/PATCH endpoints; pulse models for #923 — `TeamHealthPulse`/`PulseResponse` under the live retro board #851); web (one Signal Privacy settings panel, the SM ratchet control, the gated-state renders, the in-retro pulse poll + team-only trend). No scheduler change. Mobile: web-first in 0.3; the policy is `VersionedModel` (sync-ready for 0.4); pulse models defer sync like `SprintRetro`.
- **Migration required**: **yes** — `ProjectSignalPrivacyPolicy` singleton (+ its `HistoricalRecords` table) and the #923 pulse models. All additive; `signal_visibility` JSON default `{}` (no NOT-NULL-without-default hazard, and an empty map means every signal resolves to its coded `TEAM` default). Run `makemigrations` (never hand-write). Do not hard-code the projects-app counter. Land this MR FIRST of the three model-bearing MRs to keep the migration graph linear.
- **API changes**: yes — `ProjectSignalPrivacyPolicy` GET/PATCH (`role >= Role.ADMIN` to write, project member to read); `POST /projects/{id}/signal-privacy/ratchet_down/`; content suppression on velocity/rollup/pulse-trend reads (no behavior change at the `TEAM` default for in-project members); new pulse endpoints (#923). Regenerate OpenAPI **after merging origin/main**; add `ENUM_NAME_OVERRIDES` for `SignalAudience`.
- **OSS or Enterprise**: **OSS** — policy, gate, defaults, consent record, and `get_shared_team_signals` are OSS. The cross-team rollup (#140), coaching-maturity dashboard (#141), portfolio sprint-scope approval (#142) are Enterprise (1.0), registering against `get_shared_team_signals` + `team_signal_consent_changed`. OSS never imports `trueppm_enterprise`.
- **Coordinate with**: #553 (this ADR replaces its single-enum-on-`Project` proposal; the velocity default is `TEAM`, preserving today's read), #854 (the `throughput_rollup` signal + `PROGRAM_SHARED` opt-in is its implementation), #923 (pulse default `TEAM` + suppression satisfies its 🔴), #851 (the pulse lives in the live retro board), #496 (PO maps to the PM tier when it lands — see the PO backlog ADR for the facet), ADR-0078 (the `is_product_owner` facet the PO tier resolves through once shipped), ADR-0101/0102 (the singleton + external-inertness + `_membership_role` back-door-close patterns), and the **Agile/Waterfall Bridge ADR** (the forecast band shares this consent boundary; nothing flows upward until a team opts a signal to `PROGRAM_SHARED`).
- **Security & privacy (threat-model follow-up)**: warrant a `/threat-model` pass confirming (a) a non-member org principal is denied every signal regardless of role ordinal, (b) no write path to `signal_visibility` outside the gated team endpoint, (c) the provider returns `None` (omits) for non-consenting signals, (d) the velocity `TEAM` default preserves the current any-member read.
- **Testing** (three-layer, same MR): pytest — each signal's default audience (all `TEAM`); **a plain `MEMBER`'s `velocity_summary` read at the default policy is byte-for-byte unchanged from today — the velocity-regression guard**; **a non-member high-ordinal actor cannot read any signal (the 🔴 back-door test)**; after a team opts velocity *up* to `TEAM_SM_PM`, a below-tier (VIEWER/MEMBER) member gets the aggregate but not the gated detail; a below-`pulse`-tier member gets *no* trend; `get_shared_team_signals` returns `None`/omits for non-consented signals and the consented payload only at `PROGRAM_SHARED`; no non-endpoint code path writes `signal_visibility`; consent change writes `history_change_reason`; the ratchet sets all three to `TEAM` in one audited call. vitest — the unified settings panel state, the SM ratchet control, the gated empty-state renders. Playwright — golden path (SM opts velocity up to PM-and-program then ratchets down to team-only; pulse answered in-retro is team-visible; a PM-tier seat sees aggregate-only after a team raises and then ratchets) + one share path (opt a signal in to `PROGRAM_SHARED`).

### Durable Execution
1. **Broker-down**: policy PATCH/ratchet and pulse answers are **synchronous DB writes** — no durability gap. The only async side effect is the best-effort `team_signal_consent_changed` notification, deferred with `transaction.on_commit()`; a broker outage cannot lose the consent decision (the committed DB row), only delay the enterprise cache invalidation, which self-heals on the next rollup read.
2. **Drain task**: none new — the consent signal is a synchronous in-process dispatch; any Enterprise receiver's own I/O uses its own outbox/drain.
3. **Orphan window**: N/A — writes are synchronous and committed before the on-commit signal fires.
4. **Service layer**: all transitions go through `signal_privacy_services.py` (`set_signal_audience`, `ratchet_down_to_team`, `get_shared_team_signals`, `audience_can_read`, `requester_signal_tier`); no bare `.delay()`; the consent signal fires inside `transaction.on_commit()`.
5. **API response**: PATCH/ratchet return synchronous `200`; the consent signal is fire-and-forget. Reads return `200` with the suppressed payload.
6. **Outbox cleanup**: nothing new — synchronous dispatch; any Enterprise receiver owns its own retention.
7. **Idempotency**: setting an audience to its current value is a no-op (value guard, no history row); the ratchet is idempotent. `get_shared_team_signals` is a pure read.
8. **Dead-letter / failure**: a failed receiver never blocks or reverts the consent write (the DB row is durable); a dropped signal self-heals because the provider reads live DB state on the next rollup.

## Decisions pending your sign-off

This ADR is **Proposed**. The following choices encode a defensible default but are flagged for review at MR time:

1. **Velocity default tier = `TEAM`** (corrected from the cluster's original `TEAM_SM_PM` after the adversarial review found `ProjectVelocityView` is membership-only today — every VIEWER+ member already reads their team's velocity series). Under this ADR the team keeps its own velocity and the PM (ADMIN) **no longer reads it automatically** — the team must opt the signal up. Confirm this posture. The alternative (PM-by-default upward visibility, variant A′) is a real raise of the upward boundary and needs Morgan's explicit sign-off.
2. **Interim PO gate.** Until ADR-0078 / #496 land the `TeamMembership.is_product_owner` facet, the signal-tier mapping for the PO ships an interim `role >= Role.ADMIN`-only gate and wires the facet later. Confirm shipping the interim gate is acceptable.
