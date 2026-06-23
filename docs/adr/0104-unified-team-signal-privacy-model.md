# ADR-0104: Unified Team-Signal Privacy Model + Enterprise Rollup Extension Point

> **Companion ADRs (0.3 agile-team architecture batch).** ADR-0104 = Unified Team-Signal Privacy Model · ADR-0105 = PO Product-Backlog Hierarchy & Scoring · ADR-0106 = Agile/Waterfall Bridge. Where this ADR refers to "the Privacy ADR", "the Backlog ADR", or "the Bridge ADR" it means 0104 / 0105 / 0106 respectively. **ADR-0104** is this document.

## Status
Proposed

> **Erratum (2026-06-06, reconciled in the #553 implementation MR).** The §2 reader
> gate is **`read iff tier <= audience`** (suppress when the requester's band is
> *above* the audience). An earlier draft of §2/§2.1 wrote "suppress when tier <
> audience", which would have left the PM reading velocity by default — contradicting
> Decision-1 and Morgan's hard-NO (the feature's reason for existing). §1's
> "no regression" is about *ordinary members*, not the PM; both §1 and Decision-1
> hold under `tier <= audience` (team reads its own signals; the PM is excluded until
> the team shares upward). The text below is corrected to match.

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
7. **The VoC-chosen UI is the ladder (Option A)** — a per-signal *ratchet within a team-set ceiling* (the matrix is retained only as a read-only "who sees what" lens). Its defining mechanic is a **ceiling**: the team authorizes how far a signal may be exposed, and day-to-day movement happens below that line. A single audience value per signal cannot represent this, and — crucially — leaves the PM able to raise exposure unilaterally; the model must carry a ceiling and gate raising it as a team-owned act (§1.1).

## Decision

### §1 — One model, one ladder, per-signal audience + ceiling

**New singleton `ProjectSignalPrivacyPolicy`** (`apps/projects`, OneToOne→`Project`, `get_or_create` lazily on first GET, PATCH-only — the `ProjectGuardrailPolicy` shape exactly; `VersionedModel` + `HistoricalRecords`; declare `objects = models.Manager()` explicitly per the cross-app stubs convention):

- `signal_visibility = models.JSONField(default=dict, blank=True)` — maps each signal key to a **`{audience, ceiling}`** pair (both `SignalAudience`; invariant `audience <= ceiling`, enforced in the serializer + `set_signal_audience` service — a JSON map can't carry a per-key DB `CheckConstraint`). An absent signal — or an absent `ceiling` — falls back to its coded default (§1.1). JSON so a future signal needs no migration. *(The original single-value-per-signal shape is superseded by §1.1; see Alternatives F.)*
- `HistoricalRecords(...)` — every audience **and ceiling** change is attributable (§4).

**One ordered audience enum** (pin via `ENUM_NAME_OVERRIDES`):

```
class SignalAudience(models.TextChoices):
    TEAM           = "team",           "Team only"            # MEMBER+ on the project
    TEAM_SM        = "team_sm",        "Team + Scrum Master"  # adds the SM/coach lifecycle hat
    TEAM_SM_PM     = "team_sm_pm",     "Team + SM + PM"       # adds role >= ADMIN (the PM)
    PROGRAM_SHARED = "program_shared", "Shared to program rollup (opt-in)"  # only level the enterprise rollup may read
```

`PROGRAM_SHARED` is the **single opt-in level** that makes a signal eligible for the cross-team rollup (§3). The same enum is used **twice per signal**: as the **audience** (where the signal sits now) and as the **ceiling** (the furthest the team has authorized). §1.1 defines how each is moved.

**Three signal keys + their defaults** — both an **audience** (current) and a **ceiling** (team-authorized max); the defaults *are* the VoC posture:

| Signal key | Default audience | Default ceiling | Why |
|---|---|---|---|
| `velocity` | `TEAM` | `TEAM` | #553: the team (ordinary members + SM) keeps its existing read, but the **PM band is excluded by default** — defaulting the *audience* above TEAM would share the series up to the PM automatically (Morgan's hard-NO: no automatic velocity→PMO pipeline). Ceiling `TEAM` means velocity is **team-private by default but the team can raise the ceiling** — sharing up is explicit, team-owned, revocable (Morgan). Not the mock's permanent hard-lock; not a PM-raisable free opt-up (§1.1). |
| `throughput_rollup` | `TEAM` | `PROGRAM_SHARED` | #854: the per-project rollup opt-in *is* raising the audience to `PROGRAM_SHARED`; the ceiling already permits it, so the consent is a one-step team act rather than a ceiling-raise + audience-raise. |
| `pulse` | `TEAM` | `TEAM` | #923 🔴: most private; locked to team by default, team-raisable only. |

Every signal's **audience** defaults to `TEAM` — nothing is exposed upward by default. The **ceiling** encodes how far a signal *may* be taken: `TEAM` for the two most sensitive (velocity, pulse) so even raising is a deliberate team act, `PROGRAM_SHARED` for the rollup-consent signal whose entire purpose is opt-in. There is no code path that defaults any **audience** above `TEAM`.

**SM one-click ratchet-down (Morgan's explicit ask).** `POST /api/v1/projects/{id}/signal-privacy/ratchet-down/` sets **every** signal's audience to `TEAM` in one call (the facilitator-facet gate of §1.1; interim `role >= Role.ADMIN`, project member). Idempotent; writes one audited history entry per changed signal; never touches ceilings (it is the convenience form of the *set-audience* write in §1.1).

**Reconciling `RetroVisibility`.** `SprintRetro.team_visibility` stays as-is, gating a *single retro's free-text notes* (project breadth). The **pulse trend** (the #923 signal that could leak upward) is governed by `signal_visibility['pulse']` (management tier), NOT by `RetroVisibility`. No fourth switch.

### §1.1 — Per-signal ceiling and the raise/ratchet split (DA-07 ladder reconciliation)

The VoC-selected UI is **Option A — the ladder** (the matrix is retained only as a read-only "who sees what" lens — same data, the ceiling as the 🔒 column and the audience as the filled cells). The ladder's defining mechanic is a per-signal **ceiling**: the team authorizes how far a signal *may* be exposed, and day-to-day movement happens *below* that line. A single `SignalAudience` per signal cannot express this, and — more than a cosmetic gap — with `role >= Role.ADMIN` as the only writer it leaves **the PM able to raise a team's velocity to `PROGRAM_SHARED` unilaterally**, exposing it to the program rollup with no team act. That is the sprint-sovereignty hole the ceiling closes. The model therefore carries two values per signal and splits the write into two gates:

**Two values.** Each signal carries `audience` (where it sits now) and `ceiling` (the furthest the team has authorized), with the invariant `audience <= ceiling` enforced in the serializer and the `set_signal_audience` / `raise_signal_ceiling` services.

**Two writes, two gates:**

1. **Set audience within `[TEAM, ceiling]`** — the day-to-day move (tighten, or loosen up to the ceiling). Gated to the **Scrum-Master facilitator facet** (`TeamMembership.is_scrum_master`, ADR-0078 / #927); **interim `role >= Role.ADMIN`** until #927 lands in 0.3. Audited. `ratchet-down/` (§1) is its one-click "all audiences to `TEAM`" form.
2. **Raise the ceiling** — authorizing *wider* exposure. This is the **team-owned** act, not a facilitator/PM convenience. 0.3 ships it gated to the facilitator / `role >= Role.ADMIN`, **audited, emitted as a team-visible event, and anchored in the retro UI** ("set in retro"); the genuine team vote/ratification that replaces this interim gate is deferred to **0.4** (filed follow-up). **Lowering** a ceiling is always allowed (more private) and clamps `audience` down with it.

**Velocity & health resolution.** Their default `ceiling = TEAM` makes them team-only out of the box, but because a ceiling-raise is a team-owned act, a team that genuinely wants to publish its velocity still can — honoring Morgan's "sharing up is explicit, team-owned, revocable" rather than the mock's permanent hard-lock, while making a *PM-initiated* raise structurally impossible.

**The reader gate is unchanged.** `audience_can_read` (§2) consults only `audience`; `ceiling` bounds *writes*, never reads. `get_shared_team_signals` (§3) keys on `audience == PROGRAM_SHARED` (reachable only once the team raised the ceiling there). Rungs map 1:1 to the ladder: `TEAM`=Team-only, `TEAM_SM`=Scrum Master, `TEAM_SM_PM`=Project·PM, `PROGRAM_SHARED`=Org (= program/workspace scope, OSS — not portfolio).

### §2 — Server-side suppression gate

A single OSS service helper owns the decision:

```
def audience_can_read(policy, signal_key, requester_tier) -> bool
def requester_signal_tier(request, project_id) -> SignalAudience | below-team sentinel
```

`requester_signal_tier` derives the reader **band** from `_membership_role(request, project_id)`. The ladder measures management distance, and a signal is read iff the requester's band is **within** the audience (`tier <= audience`):
- `None` (non-member — the only way an org/PMO principal arrives) → **outside the ladder** → denied for every signal **regardless of role ordinal** (the back-door close; an Enterprise custom role above `OWNER` that is not a project member has no `ProjectMembership` row and cannot pass).
- `>= Role.ADMIN` → **PM / management band** (`TEAM_SM_PM`). This band is excluded from a signal until the team raises that signal's audience to include it. The PO role (#496) maps here when it lands.
- `Role.MEMBER` / `Role.VIEWER`, **and the Scrum Master**, → `TEAM` band. The team — including the SM, a team insider — is the ladder floor and therefore **always** reads its own signals (the SM facet grants the *write* gate, not a different read band).

The three read paths call the gate **before** assembling the gated numbers and **suppress** (not 403) when the requester's band is **outside** the signal's configured audience (`tier > audience`):

1. **`velocity_summary` read** — when `tier > signal_visibility['velocity']`, the `sprints[]` series + rolling points / sparkline are omitted; the milestone-health % and schedule confidence remain. At the `TEAM` default the team band passes (so every *ordinary member's* read is byte-for-byte unchanged from today — no regression), while the **PM band is suppressed — the PM does not read velocity automatically (Morgan's hard-NO)**. A team raising velocity's audience to `TEAM_SM_PM` is what *shares it up* to the PM; a non-member is always denied.
2. **Milestone rollup payload** (`compute_milestone_rollup_payload`) — the velocity/throughput point cells suppressed for the PM band until the team shares `['velocity']` / `['throughput_rollup']` up to it; the % completion stays.
3. **Pulse-trend read** (new #923 endpoint) — the per-sprint mood/energy series returned only when `tier <= signal_visibility['pulse']` (team band by default); for any band above the audience it is omitted **entirely** (a redacted pulse is no pulse — there is no safe aggregate fallback).

### §3 — Enterprise cross-team extension point (consumes opt-in only; non-consenting team excluded, not zero-filled)

Two OSS surfaces, both supply-only:

- **`get_shared_team_signals(project) -> dict | None`** (new `signal_privacy_services.py`). Returns a dict of *only* the signals whose configured audience == `PROGRAM_SHARED`; returns **`None`** when the project shared nothing. Because all three signals default to `TEAM`, a project that has changed nothing shares nothing — opt-in is strictly explicit. Invariant: **a non-consenting team is EXCLUDED (the consumer skips a `None`), never zero-filled** — a zero-fill would let a PMO infer non-sharing or dilute an aggregate, pressuring opt-in.
- **`team_signal_consent_changed = django.dispatch.Signal()`** (`projects/signals.py`) — emitted on every audience change. OSS only emits; Enterprise connects a receiver in `AppConfig.ready()` (the established `risk_changed` / `sprint_scope_changed` pattern; receiver I/O deferred with `transaction.on_commit()`).

**The resolver is supply-only — no auto-share path** (mirrors the ADR-0102 §3 / ADR-0101 `guardrail_policy_resolving` read-only invariant): there is no field, signal, or hook by which an external/enterprise actor can *set*, default, or upgrade a project's audience or ceiling. The **only** writers of `signal_visibility` are the two human-invoked, project-member-gated team endpoints of §1.1 — set-audience (facilitator facet; interim `role >= Role.ADMIN`) and raise-ceiling (team-owned; 0.3: facilitator / `role >= Role.ADMIN` + audit + team-visible event + retro-anchored). Neither value can be moved by any non-team principal.

**Coupling with the bridge forecast seam.** The companion Agile/Waterfall Bridge ADR fires a `milestone_forecast_recomputed` signal carrying a milestone confidence band. That band is a team signal and is cross-team-eligible **only** when the project's `signal_visibility['throughput_rollup']` (or `['velocity']` as configured) is `PROGRAM_SHARED`. Since both default to `TEAM`, the band does not flow cross-team until a team explicitly opts in. The bridge seam therefore composes with `get_shared_team_signals` rather than bypassing it — there is one consent boundary, not two.

### §4 — Consent change is audited (who flipped sharing on/off)

`ProjectSignalPrivacyPolicy` carries `HistoricalRecords`, so every audience **and ceiling** change is captured with actor + timestamp. The set-audience / raise-ceiling / ratchet endpoints write `history_change_reason` (e.g. `"velocity audience: team -> team_sm"`, `"velocity ceiling: team -> program_shared (team-owned raise)"`) so the timeline classifies the change (ADR-0096/0098 pattern); a ceiling raise is the audit row that matters most — it is the team's recorded decision to permit wider exposure. The audit is **team-readable-first** — it follows the existing project history-endpoint RBAC, honoring the tier-2 sprint-sovereignty rule that team audits are team-readable before management-readable. The `team_signal_consent_changed` signal additionally lets an Enterprise immutable-audit receiver capture upward-share decisions, but the OSS history is the source of truth.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A: one `ProjectSignalPrivacyPolicy` singleton, one `SignalAudience` ladder, per-signal JSON map with distinct defaults (all `TEAM` — velocity regression-preserving, throughput/pulse never-leaked), suppress-gate in a shared service, supply-only consent-gated enterprise provider (chosen)** | Three controls on one mental model; the velocity `TEAM` default preserves today's any-member read (no regression) while still blocking upward exposure; per-signal defaults satisfy 'pulse strictest'; reuses the `ProjectGuardrailPolicy` idiom; back-door closed via `_membership_role`; opt-in stays team-owned; a future signal needs no migration; one consent boundary shared with the bridge seam | A second policy singleton on `Project`; the gate must be remembered in any *new* signal read path (mitigated by the single helper + a test) |
| A′: default velocity to `TEAM_SM_PM` | Symmetric upper-tier framing | Suppresses the velocity series for ordinary VIEWER+ members who read it today (ground truth: membership-only endpoint) — a downward regression on exactly Morgan's surface, and the 'no regression — PM-readable' rationale that justified it was factually inverted. Rejected for `TEAM`. |
| B: three independent fields on `Project` (#553's literal proposal) | Smallest diff | Three inconsistent switches — exactly what Morgan forbids; SM ratchet-down touches three unrelated fields; a fourth signal repeats the divergence |
| C: extend `RetroVisibility` to cover all three signals | Reuses a shipped enum | Wrong axis (project breadth, not tier); no `PROGRAM_SHARED` rung; overloading breaks retro free-text gating + sync payload. Rejected — reconcile, don't overload. |
| D: enterprise rollup zero-fills non-consenting teams | Cleaner cross-team math | Zero-fill lets a PMO infer non-sharing and pressures opt-in — Morgan 🔴. Rejected; non-consenting teams excluded. |
| E: a resolver that can *set* a default org audience | Org can enforce a baseline | Any external write path to `signal_visibility` is an automatic velocity→PMO pipeline by another name (Morgan 🔴). Rejected — supply/read-only. |
| F: single `SignalAudience` per signal, no ceiling (this ADR's original shape) | Smallest model; one value to reason about | Its only writer is `role >= Role.ADMIN`, so **the PM can unilaterally raise team velocity to `PROGRAM_SHARED`** with no team act — the sprint-sovereignty hole. And the VoC-chosen ladder UI is built around a team ceiling this shape cannot represent. Superseded by §1.1 (per-signal `{audience, ceiling}` + raise/ratchet split). |

## Consequences

**Easier**: a team learns one privacy model and applies it to velocity, rollup, and pulse identically; the team keeps its current velocity read by default (no regression); the SM makes everything team-private in one click and can prove (audited) who changed sharing; raising a signal's exposure is a team-owned, audited **ceiling** change — a PM can never widen it unilaterally; the OSS/Enterprise privacy line is a named, supply-only, consent-gated extension point #140/#141/#142 register against; Marcus still sees milestone health + schedule confidence (never gated). The bridge forecast band shares this one consent boundary.

**Harder**: a second policy singleton joins `ProjectGuardrailPolicy` on `Project`; any *new* team-signal reader must route through `audience_can_read` or it re-leaks (mitigated by the single helper + a regression test); the two visibility axes (`RetroVisibility` breadth vs `SignalAudience` tier) must be kept distinct in UI and docs.

**Risks**: (1) forgotten gate on a future signal — mitigated by centralizing in `audience_can_read` + a test that the three known paths suppress. (2) drf-spectacular enum collision on `SignalAudience` — pin via `ENUM_NAME_OVERRIDES` in the same MR. (3) non-member tier mapping drift — `_membership_role(...) is None → below TEAM` is the entire back-door close; unit-tested with an org-principal-without-membership fixture (the 🔴 test). (4) the pulse-trend read must never fall back to a redacted aggregate — a below-tier requester gets *no* trend, asserted by test. (5) a velocity-default regression — guarded by a pytest asserting a plain MEMBER's `velocity_summary` read at the default policy is byte-for-byte identical to today (no series suppression at the `TEAM` default). (6) the `audience <= ceiling` invariant — enforced in the serializer + `set_signal_audience`/`raise_signal_ceiling` services (a JSON map cannot carry a per-key DB `CheckConstraint`), with tests that a set-audience above the ceiling is rejected (`400`), that the PM-tier cannot raise a ceiling outside the team-owned endpoint, and that lowering a ceiling clamps the audience down with it.

## Implementation Notes
- **P3M layer**: Programs and Projects / Operations (single-project, team-scoped). Cross-team rollup is Portfolios → Enterprise.
- **Affected packages**: api (`ProjectSignalPrivacyPolicy` singleton with per-signal `{audience, ceiling}`, `SignalAudience` enum, `audience_can_read`/`requester_signal_tier` gate, `set_signal_audience` / `raise_signal_ceiling` services + the `audience <= ceiling` invariant, suppression in `velocity_summary` read/`compute_milestone_rollup_payload`/pulse-trend read, `get_shared_team_signals` provider, `team_signal_consent_changed` signal, the set-audience / raise-ceiling / ratchet endpoints; pulse models for #923 — `TeamHealthPulse`/`PulseResponse` under the live retro board #851); web (the **ladder** Signal Privacy settings panel + the read-only matrix lens, the SM ratchet control, the ceiling/🔒 raise affordance, the gated-state renders, the in-retro pulse poll + team-only trend). No scheduler change. Mobile: web-first in 0.3; the policy is `VersionedModel` (sync-ready for 0.4); pulse models defer sync like `SprintRetro`.
- **Migration required**: **yes** — `ProjectSignalPrivacyPolicy` singleton (+ its `HistoricalRecords` table) and the #923 pulse models. All additive; `signal_visibility` JSON default `{}` (no NOT-NULL-without-default hazard; an empty map means every signal resolves to its coded `{audience: TEAM, ceiling: <per §1>}` default). Run `makemigrations` (never hand-write). Do not hard-code the projects-app counter. Land this MR FIRST of the three model-bearing MRs to keep the migration graph linear.
- **API changes**: yes — `ProjectSignalPrivacyPolicy` GET (project member) + two write paths per §1.1: **set-audience** PATCH (within `[TEAM, ceiling]`; facilitator facet, interim `role >= Role.ADMIN`) and **raise-ceiling** `POST /projects/{id}/signal-privacy/raise-ceiling/` (team-owned; 0.3 facilitator / `role >= Role.ADMIN` + audited + team-visible + retro-anchored; 0.4 → team vote); `POST .../ratchet-down/` (audiences → `TEAM`); content suppression on velocity/rollup/pulse-trend reads (no behavior change at the `TEAM` default for in-project members); new pulse endpoints (#923). Regenerate OpenAPI **after merging origin/main**; add `ENUM_NAME_OVERRIDES` for `SignalAudience`.
- **OSS or Enterprise**: **OSS** — policy, gate, defaults, consent record, and `get_shared_team_signals` are OSS. The cross-team rollup (#140), coaching-maturity dashboard (#141), portfolio sprint-scope approval (#142) are Enterprise (1.0), registering against `get_shared_team_signals` + `team_signal_consent_changed`. OSS never imports `trueppm_enterprise`.
- **Coordinate with**: #553 (this ADR replaces its single-enum-on-`Project` proposal; the velocity default is `TEAM`, preserving today's read), #854 (the `throughput_rollup` signal + `PROGRAM_SHARED` opt-in is its implementation), #923 (pulse default `TEAM` + suppression satisfies its 🔴), #851 (the pulse lives in the live retro board), **#927** (the Team-entity + `is_scrum_master`/`is_product_owner` facet axis, pulled into 0.3 — the set-audience and PO tier gates wire to its facets; the interim `role >= Role.ADMIN` gates here are the fallback only if #927 slips within 0.3), #496 (PO = `is_product_owner` facet, resolves to the PM tier), ADR-0078 (the facet design), ADR-0101/0102 (the singleton + external-inertness + `_membership_role` back-door-close patterns; ADR-0102's scope gate likewise migrates to the PO/facilitator facet), the **0.4 team-vote follow-up** (replaces the interim raise-ceiling gate), and the **Agile/Waterfall Bridge ADR** (the forecast band shares this consent boundary; nothing flows upward until a team raises a signal's ceiling to and sets its audience at `PROGRAM_SHARED`).
- **Security & privacy (threat-model follow-up)**: warrant a `/threat-model` pass confirming (a) a non-member org principal is denied every signal regardless of role ordinal, (b) no write path to `signal_visibility` outside the gated team endpoint, (c) the provider returns `None` (omits) for non-consenting signals, (d) the velocity `TEAM` default preserves the current any-member read.
- **Testing** (three-layer, same MR): pytest — each signal's default audience (all `TEAM`); **a plain `MEMBER`'s `velocity_summary` read at the default policy is byte-for-byte unchanged from today — the velocity-regression guard**; **a non-member high-ordinal actor cannot read any signal (the 🔴 back-door test)**; **the PM band does not read velocity at the default and after a team opts velocity *up* to `TEAM_SM_PM` the PM reads it (Morgan's hard-NO — team-private by default, shared upward explicitly), while ordinary members read throughout**; the PM band gets *no* pulse trend until the team shares the pulse up; `get_shared_team_signals` returns `None`/omits for non-consented signals and the consented payload only at `PROGRAM_SHARED`; no non-endpoint code path writes `signal_visibility`; consent change writes `history_change_reason`; the ratchet sets all three audiences to `TEAM` in one audited call. **Ceiling invariant (§1.1):** set-audience above `ceiling` is rejected `400`; the set-audience endpoint cannot move a ceiling; raise-ceiling is gated and audited with a team-visible event; lowering a ceiling clamps the audience down; a PM-tier seat (without the team-owned raise) can never push a signal's audience past its ceiling. vitest — the **ladder** panel state + the read-only matrix lens, the SM ratchet control, the ceiling/🔒 raise affordance, the gated empty-state renders. Playwright — golden path (facilitator raises velocity's ceiling in-retro, sets audience to PM, then ratchets to team-only; pulse answered in-retro is team-visible; a PM-tier seat sees aggregate-only) + one share path (team raises a signal's ceiling to and sets audience at `PROGRAM_SHARED`).

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

1. **Velocity default = `audience: TEAM`, `ceiling: TEAM`** — *resolved 2026-06-02.* Team-only by default and **raisable only by the team-owned ceiling act** (§1.1). The PM (ADMIN) no longer reads velocity automatically and **cannot unilaterally expose it** — closing the PM-raise hole that the original single-value shape (Alternative F) left open. This supersedes both the cluster's original `TEAM_SM_PM` default and the mock's permanent hard-lock; it honors Morgan's "sharing up is explicit, team-owned, revocable."
2. **Per-signal ceiling + raise/ratchet split (§1.1)** — *adopted 2026-06-02* to back the VoC-chosen ladder UI (Option A) and make upward exposure a team-owned, audited act. The two write gates: set-audience (facilitator facet) within `[TEAM, ceiling]`; raise-ceiling (team-owned). Confirm.
3. **Interim gates, retired by #927.** The set-audience and PO-tier gates ship an interim `role >= Role.ADMIN` mapping only until the `is_scrum_master`/`is_product_owner` facets land — now pulled into **0.3 as #927** (carved from #599). If #927 lands first, this ADR wires the facets directly and the interim gate is unused. Confirm the interim gate as the fallback if intra-0.3 sequencing slips.
4. **Team vote deferred to 0.4.** The 0.3 raise-ceiling gate (facilitator / `role >= Role.ADMIN` + audit + team-visible + retro-anchored) is replaced by a genuine team vote/ratification in 0.4 (filed follow-up). Confirm the 0.3 interim is acceptable. — *Resolved by Amendment A below (#930).*

---

## Amendment A — Team ratification flow for ceiling raises (#930, 0.4)

**Status**: Accepted (2026-06-21). Implements §1.1 decision 4 and the "0.4 team vote" deferral. Backend slice (propose/vote/ratify API + models); the web surface (pending-proposal indicator, in-retro vote affordance) is a tracked follow-up.

### A.1 — The single behavior change

The §1.1 raise-ceiling gate stops being single-actor. A request to set a signal's ceiling **higher on the ladder** (`signal_audience_rank(new) > current`) no longer applies immediately — it opens a **ratification proposal** and the raise takes effect **only when the team ratifies**. Everything else is unchanged and stays single-action, because tightening is never gated heavier than loosening:

- **Lowering** a ceiling (`rank(new) <= current`) — applies immediately via the existing `raise_signal_ceiling` (it already clamps the audience down). No proposal.
- **Set-audience** within `[TEAM, ceiling]` and **ratchet-down** — unchanged, immediate, facilitator/Admin.

The hole is closed **at the API layer in this slice**, with or without the web UI: the existing `POST .../signal-privacy/raise-ceiling/` returns **`202` + the open proposal** instead of applying, the moment a raise is requested. There is no window where a lone facilitator can still apply a raise.

### A.2 — Threshold (resolved)

Eligibility and the bar are computed **server-side at every tally** (so roster changes are reflected live):

- **Eligible voters** = non-deleted `TeamMembership` rows on the project's **default team** (`team__is_default=True`). This is the team roster (#927), **not** project membership — a non-team project-Admin/PM has no vote (Morgan: prevents vote-stuffing from outside the team). A project-Admin who *is* on the team votes as one member; SM/PO facets carry **no extra weight** (one member, one vote).
- **Threshold** = `floor(eligible / 2) + 1` — **strict majority** of the current roster. This yields: 1→1, 2→2, 3→2, 4→3, 5→3. For any team of **≥ 2** members the proposer's own approval (1) never meets the bar, so **a lone facilitator can never raise alone** — at least one *other* member must approve. A 1-member team is the degenerate case: there is no other member to consult, so the proposer's approval ratifies (the rule protects members' consent from a facilitator; with no other members there is nothing to protect). Not unanimity, not whole-roster, so one disengaged member can never deadlock a raise (Alex/Morgan).

### A.3 — Proposal lifecycle, voting, expiry (resolved)

- **Who proposes**: the existing raise-ceiling gate — facilitator (`is_scrum_master`) **or** `role >= Role.ADMIN` who is a team member. (Minimal change; keeping propose authority where it is avoids a second migration of who-can-write while the ratification itself is what makes it team-owned.) **Proposing is an implicit APPROVE** — the proposer's vote is auto-recorded on open.
- **Who votes**: any eligible team member (A.2). One vote per member (`unique(proposal, voter)`), changeable while the proposal is `OPEN` (upsert).
- **Tally on every vote** (and on open): `APPROVE >= threshold` → **RATIFIED**, apply the raise; else if `REJECT > eligible - threshold` (approval can no longer reach the bar) → **REJECTED**; else stays `OPEN`.
- **One open proposal per `(project, signal)`** — a partial unique constraint (`status = OPEN`). A second raise request for the same signal while one is open returns **`409`** (no superseding-proposal loop — see A.4). The proposer may **withdraw** their own open proposal (→ `REJECTED`, reason "withdrawn by proposer").
- **Expiry**: `expires_at = created_at + SIGNAL_CEILING_PROPOSAL_TTL` (default **72 h** — long enough for an async team, short enough to not stall the PM; Morgan/Sarah). Evaluated **lazily** — any read (GET), vote, or new-proposal attempt first transitions a past-due `OPEN` proposal to **EXPIRED**. An expired proposal **dies UNRATIFIED**: the ceiling is unchanged, the outcome is explicit in the record. **Silence is never consent** for *widening* exposure — there is no auto-apply-on-timeout (David's auto-ratify-on-silence is rejected for exactly this reason). Lazy evaluation needs no Celery/Beat (no async, no outbox).

### A.4 — Anti-gaming (resolved)

- **One-open-per-signal** + `409` removes the supersede loop.
- **Lower-then-raise clock reset**: applying a ceiling **lower** (immediate) while a raise proposal is `OPEN` for that signal **supersedes** it (→ `SUPERSEDED`, reason recorded) — the proposal was relative to the old baseline, so a fresh proposal + fresh vote is required. The transition is audited, so the lower→raise pattern is **visible in the record**, not a silent clock reset.
- **Apply re-resolves the baseline**: on ratification the raise is applied through the existing `raise_signal_ceiling` against the *current* resolved ceiling; if the team already raised it by other means it is a no-op (the existing value guard), never a surprise double-jump.

### A.5 — Rejected: a PMO/exec override that bypasses the vote

The VoC panel's Marcus/Janet 🔴 ask — an Admin/PMO/exec path that reads or raises the ceiling *without* the team vote — is **explicitly rejected**. It is the §2 back-door by another name: the entire model exists so the PM does **not** read velocity automatically (Morgan's hard-NO) and cannot widen exposure unilaterally. A management bypass would re-open precisely the hole §1.1 closed. Portfolio-layer governance (a cross-program approval workflow that *can* compel sharing) is an **Enterprise** concern and a different feature; the OSS team-ratification here is single-team, team-owned, and has no bypass. This is consistent with the boundary test — a team needs this to run its own program; it is not cross-program governance.

### A.6 — Data model, API, audit

- **`SignalCeilingRaiseProposal`** (plain `models.Model`, projects app — a server-side governance record, **not** offline-synced, mirroring `SprintScopeChange`/`TaskDurationChangeEvent`/`AuditEvent`; **no** `server_version`): `id` (UUID), `project` FK, `signal_key`, `from_ceiling`, `to_ceiling` (`SignalAudience`), `proposed_by` FK (SET_NULL), `status` (`OPEN/RATIFIED/REJECTED/EXPIRED/SUPERSEDED`, default `OPEN`), `created_at`, `expires_at`, `resolved_at` (null until it leaves OPEN). Partial unique `(project, signal_key) WHERE status=open`; index `(project, signal_key, status)`.
- **`SignalCeilingRaiseVote`** (plain `models.Model`): `id` (UUID), `proposal` FK (`related_name="votes"`, CASCADE), `voter` FK, `choice` (`APPROVE/REJECT`), `created_at`. `unique(proposal, voter)` — the `PulseResponse` one-vote-per-member template.
- **API**: `POST .../signal-privacy/raise-ceiling/` → `202` + proposal on a raise (or `200` + policy on a lower/no-op or immediate ratify of a solo team); `POST .../signal-privacy/ceiling-proposals/{id}/vote/` `{choice}` → `200` + proposal (may carry the now-applied policy when the vote ratifies); `GET .../signal-privacy/ceiling-proposals/` lists open + recent-resolved proposals with their votes (team-readable); `GET .../signal-privacy/` gains an `open_proposals` block per signal (`to_ceiling`, `approve_count`, `threshold`, `eligible_count`, `expires_at`, `your_vote`, `can_vote`) — Sarah's pending indicator. Both POSTs carry the `IdempotencyMixin` (`select_for_update` on the proposal makes the tally/apply idempotent; the vote is an upsert; ratify applies once via the `status==OPEN` guard).
- **Audit / team-readability**: the proposal + each vote ARE the audit record (Alex: team-readable, not just an admin log) — visible to every project member via the list endpoint. Applying the raise additionally writes the policy's `history_change_reason` and fires the existing `team_signal_consent_changed` on commit (the Enterprise seam). A new consumer-free `team_signal_ceiling_proposal_changed` signal fires on every status transition (open/ratify/reject/expire/supersede) on commit — same supply-only seam pattern, so Enterprise immutable-audit can observe proposal lifecycle. **No email/push** is wired (Priya's hard-NO on un-opted notification); the pending state is pull-only via GET. *(Superseded by **Amendment B** (#1275): a notifications-app receiver now consumes this signal to push an in-app inbox row to eligible voters — email stays opt-in OFF, preserving Priya's actual concern.)*

### A.7 — Durable Execution (amendment)

1. **Broker-down**: N/A — propose/vote/ratify are synchronous DB writes; ratification applies the ceiling in-request. The only async-ish side effects are the two best-effort `on_commit` signals (`team_signal_consent_changed`, `team_signal_ceiling_proposal_changed`), which only delay an Enterprise cache invalidation, never lose the committed decision.
2. **Drain task**: none — no `.delay()`.
3. **Orphan window**: N/A — writes commit before the on-commit signals fire; expiry is lazy on read/vote/propose (no background sweep, no orphan rows that change state).
4. **Service layer**: new `signal_privacy_services.py` functions — `propose_or_apply_ceiling_change` (routes raise→propose, lower→apply), `cast_ceiling_vote`, `_tally_and_maybe_apply`, `expire_stale_proposals`, `list_team_voters`.
5. **API response**: `202 {proposal}` when a raise is deferred to the vote; `200` on a lower, an immediate solo-team ratify, and on a vote.
6. **Outbox cleanup**: N/A — no outbox.
7. **Idempotency**: `select_for_update` on the proposal during vote/tally; vote is `update_or_create` (unique `proposal+voter`); the apply runs once behind the `status==OPEN`→`RATIFIED` guard, and `raise_signal_ceiling`'s value guard makes a re-apply a no-op.
8. **Dead-letter / failure**: synchronous; validation → `400`, conflict (no open proposal / already resolved / vote-by-non-member) → `409`/`403`. No async permanent-failure path.

### A.8 — Implementation notes (amendment)

- **Migration**: yes — `projects/0089` (two additive plain models). No change to `ProjectSignalPrivacyPolicy`.
- **OSS or Enterprise**: **OSS** — single-team, team-owned ratification (Programs/Projects layer). The cross-program approval-workflow variant is Enterprise and out of scope here.
- **Testing** (pytest, same MR): a raise opens a proposal and does **not** apply until ratified; a **lone facilitator cannot raise alone** on a ≥2-member team (proposer's auto-approve stays OPEN); a second approver ratifies and the ceiling applies + writes history; a **non-team project-Admin cannot vote** (`403`); votes are recorded and team-readable; a lower stays immediate and **supersedes** an open raise proposal; an expired proposal stays UNRATIFIED on the next read; a second open proposal for the same signal is `409`; **no PMO bypass exists**. (web vitest/Playwright land with the deferred web surface.)

## Amendment B — Notify eligible voters on proposal open / resolve (#1275, 0.3)

**Status**: Accepted (2026-06-23). Reverses the §A.6 "pull-only, no notification" posture for proposal *discovery*. Additive: no new model, endpoint, or migration; it only consumes the existing `team_signal_ceiling_proposal_changed` signal through the existing #639 / ADR-0085 fan-out rail.

### B.1 — Why this reverses §A.6 (the Priya reconciliation)

A VoC audit of the shipped #1260/#930 surface (2026-06-22, all four panel seats) found that "pull-only via GET" is the load-bearing weakness of the ratification design: the pending card lives three clicks deep at Settings → Signal privacy (desktop-only), so eligible voters who live on the board / Gantt / task drawer never discover an open proposal. The practical outcome is proposals expiring **EXPIRED-unratified because the team never saw them, not because the team said no** (Morgan, scored the surface 8/10: "the 72h window is meaningless if members only discover a proposal by navigating to Settings").

Priya's §A.6 hard-NO is preserved by reading it precisely: it was a hard-NO on **un-opted email/push noise**, not on a row in the user's own in-app inbox (a pull-adjacent surface the user already chooses to open). So:

- **In-app**: the proposal-lifecycle inbox row is created by default (matrix-overridable like every other #639 event — a user may still mute it).
- **Email**: stays **opt-in OFF** by default (`DEFAULT_PREFERENCES` email=False), exactly the §A.6 / ADR-0085 §1 posture. A user who has opted into email for this event type gets one; nobody is emailed without opting in.

### B.2 — The two events and their audiences (the no-management-bypass boundary holds)

- `signal.ceiling_proposal_opened` → every **eligible voter** (the §A.2 roster, `team_member_user_ids(project)` = non-deleted default-team membership), **excluding the proposer** (who already has the `202 + proposal` client confirmation — self-notify is noise).
- `signal.ceiling_proposal_resolved` → eligible voters **∪ the proposer** (ratified / rejected / expired). The proposer is the most interested party in the outcome (Sarah: "I sit there refreshing"); the union also covers a proposer who has since left the team learning their own proposal's fate.
- Recipients are **team voters only** — the same roster that may read/vote on the signal. A non-team project Admin/PM is never notified, so the notification rail cannot become the §A.5 management back-door (a PMO who can't vote also can't be told the team has an open governance item). The notification body carries only governance metadata the recipient can already see (which signal, the from→to ceiling, the deadline / outcome) — never the gated signal value.

### B.3 — Seam: a notifications-app receiver, not an inline projects-app call

The handler is a receiver in `notifications/receivers.py` connected to `team_signal_ceiling_proposal_changed` in `NotificationsConfig.ready()` — exactly the supply-only receiver extension point §3 / A.6 describes ("Enterprise connects a receiver in `AppConfig.ready()`"). It keeps the dependency one-way (`notifications` → `projects`; the `projects` app stays unaware of `notifications`, preserving the supply-only contract) and out of the proposal write path. The receiver maps `status` → event and fans out via the existing `create_event_notifications(...)` rail. `status == superseded` is **skipped**: it is the §A.4 lower-then-raise internal replacement, the replacement proposal emits its own `opened` notification to the team, and "superseded" is not in the issue's resolution set (it would read as confusing mechanics noise).

### B.4 — Durable Execution (amendment)

1. **Broker-down**: N/A — the in-app inbox row is a synchronous `bulk_create` and is durable the instant it commits. Email is the existing `email_pending` DB flag drained by the existing `drain_notification_emails` Beat task (ADR-0085) — broker-down only delays the email drain, never loses the row or the email intent.
2. **Drain task**: reuses `drain_notification_emails` (#639) verbatim — the rail already owns email delivery; this amendment only adds two `event_type` values it fans out under.
3. **Orphan window**: N/A — no outbox; the signal is already `transaction.on_commit`-deferred by `_emit_proposal_changed`, so the receiver runs post-commit and reads committed state.
4. **Service layer**: reuses `notifications/services.py::create_event_notifications`; new receiver `on_ceiling_proposal_changed` in `notifications/receivers.py`.
5. **API response**: N/A — the notification is a post-commit side effect of the existing `raise-ceiling` / `vote` endpoints (unchanged `202`/`200`); no new endpoint.
6. **Outbox cleanup**: N/A — no outbox; `Notification` rows keep their existing retention.
7. **Idempotency**: the signal fires **once per status transition** (the `status` change is guarded under `select_for_update`, §A.7), so the receiver runs at most once per `(proposal, terminal-status)`; no duplicate-suppression is required beyond that emit-once contract. (If the signal contract ever changed to fire per-vote, the receiver would need a per-emission guard — called out so it isn't silently broken.)
8. **Dead-letter / failure**: notification delivery is **best-effort** by design (#639) — the receiver runs in the triggering request's on-commit callback; if it raises, a notification is missed but the proposal state (the authoritative governance record) is unaffected. No DLQ.

### B.5 — Implementation notes (amendment)

- **Migration**: **no** — `NotificationEventType` / `NotificationPreference.event_type` are choiceless `CharField`s, so adding two event values is data-only (no schema, no openapi drift). Two `NotificationEventType` members + four `DEFAULT_PREFERENCES` rows (in-app True, email False).
- **Web**: `NotificationRow` deep-links the two event types to `/projects/:id/settings#signal-privacy` (the consolidated settings section, web-rule 195) instead of the board fallback — closing the discovery loop the VoC flagged.
- **OSS or Enterprise**: **OSS** — single-team, team-owned (Programs/Projects layer); no cross-program governance.
- **Testing** (pytest + vitest, same MR): opening notifies each eligible voter except the proposer (event=`opened`, in-app row created, `email_pending` follows preference); each terminal resolution (ratified / rejected / lazy-expiry) notifies voters ∪ proposer (event=`resolved`); **superseded notifies no one**; a **non-team project-Admin is never notified** (boundary); email defaults OFF and turns on only when the recipient opted in; the web row routes the two event types to the signal-privacy settings section.
