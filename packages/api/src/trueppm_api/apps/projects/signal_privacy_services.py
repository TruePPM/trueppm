"""Team-signal privacy service layer (ADR-0104 §2–§4).

Every read-suppression decision and every policy write goes through here so the
gate lives in exactly one place (ADR-0104 risk #1: a forgotten gate on a future
signal). The model exposes no bare field write — `set_signal_audience` and
`raise_signal_ceiling` are the *only* writers of `signal_visibility`, which is the
sprint-sovereignty contract: a non-team principal can never move a project's
audience or ceiling.

**Reader-gate direction (security-critical).** The audience ladder measures how far
*up* (toward management) a signal has been shared. A requester reads a signal's
gated detail iff their reader band is **within** the audience — ``tier <= audience``
(suppress when ``tier > audience``). The team band (TEAM — ordinary members,
viewers, and the Scrum Master) is the floor, so the team **always** reads its own
signals (ordinary members' read is never regressed); the PM band (TEAM_SM_PM) is
excluded until the team raises a signal's audience to include it; a non-member is
outside the ladder and never reads. This delivers ADR-0104's core guarantee
(velocity/pulse are team-private by default, the PM does not read them automatically
— Morgan's hard-NO) while keeping every ordinary member's existing read intact.

This reconciles ADR-0104's internal tension: §1's "no regression" is about *ordinary
members*, and Decision-1's "the PM no longer reads velocity automatically" is the
intent — both hold under ``tier <= audience``. §2's earlier "suppress when tier <
audience" wording (which would have left the PM reading velocity by default) was the
inverted statement and is corrected here and in the ADR.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from django.conf import settings as django_settings
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.access.permissions import _membership_role
from trueppm_api.apps.projects.models import (
    SIGNAL_DEFAULTS,
    CeilingRaiseStatus,
    CeilingVoteChoice,
    ProjectSignalPrivacyPolicy,
    SignalAudience,
    SignalCeilingRaiseProposal,
    SignalCeilingRaiseVote,
    signal_audience_rank,
)

if TYPE_CHECKING:
    from rest_framework.request import Request

    from trueppm_api.apps.projects.models import Project

# The signal keys this policy governs — the iteration set for ratchet / sharing.
SIGNAL_KEYS = tuple(SIGNAL_DEFAULTS.keys())


# ---------------------------------------------------------------------------
# Default-posture seam — neutral OSS extension point (ADR-0029 slot; ADR-0104 §1)
# ---------------------------------------------------------------------------
#
# When a project's policy is first created, its initial signal_visibility is
# seeded from a registered provider. The OSS core registers NO provider, so the
# community edition always falls back to the coded SIGNAL_DEFAULTS (all-TEAM,
# unchanged behavior). trueppm-enterprise registers a provider in its
# AppConfig.ready() to supply an org-governance default posture (which may open
# signals) — see trueppm-enterprise#143. This is the integrations-registry idiom
# (ADR-0049): OSS ships the neutral hook, Enterprise supplies the value; OSS never
# imports enterprise. The seam runs ONLY at creation, so it can never reach down
# and reopen a team's already-set ceiling (the G1 team-override guarantee holds
# structurally — there is no override to clobber at create time).
_DEFAULT_POSTURE_PROVIDER: Callable[[Project], dict[str, dict[str, str]]] | None = None


def register_default_posture_provider(
    provider: Callable[[Project], dict[str, dict[str, str]]] | None,
) -> None:
    """Register (or clear) the initial-posture provider. Enterprise calls this."""
    global _DEFAULT_POSTURE_PROVIDER
    _DEFAULT_POSTURE_PROVIDER = provider


def _seed_initial_visibility(policy: ProjectSignalPrivacyPolicy, project: Project) -> None:
    """Seed a freshly-created policy from the registered provider, if any.

    Each provided ``{audience, ceiling}`` is clamped to the ladder and to the
    ``audience <= ceiling`` invariant before it is stored, so a misconfigured
    provider can never persist an inconsistent posture. No-op (coded defaults) when
    no provider is registered — the OSS path.
    """
    if _DEFAULT_POSTURE_PROVIDER is None:
        return
    seed = _DEFAULT_POSTURE_PROVIDER(project) or {}
    cleaned: dict[str, dict[str, str]] = {}
    for signal_key, pair in seed.items():
        if signal_key not in SIGNAL_DEFAULTS or not isinstance(pair, dict):
            continue
        default = SIGNAL_DEFAULTS[signal_key]
        ceiling = pair.get("ceiling", default["ceiling"])
        audience = pair.get("audience", default["audience"])
        if ceiling not in SignalAudience.values or audience not in SignalAudience.values:
            continue
        # Enforce audience <= ceiling at the seam too (defense in depth).
        if signal_audience_rank(audience) > signal_audience_rank(ceiling):
            audience = ceiling
        cleaned[signal_key] = {"audience": audience, "ceiling": ceiling}
    if cleaned:
        policy.signal_visibility = cleaned
        policy._change_reason = "initial org-default posture"  # type: ignore[attr-defined]
        policy.save(update_fields=["signal_visibility"])


def get_or_create_policy(project: Project) -> ProjectSignalPrivacyPolicy:
    """Get-or-create a project's privacy policy, seeding new rows via the seam.

    The single entry point every read/write path uses to obtain the policy, so the
    default-posture seam runs exactly once (at creation) and nowhere else.
    """
    policy, created = ProjectSignalPrivacyPolicy.objects.get_or_create(project=project)
    if created:
        _seed_initial_visibility(policy, project)
    return policy


# ---------------------------------------------------------------------------
# Reader tier + the suppression gate (§2)
# ---------------------------------------------------------------------------


def requester_signal_tier(request: Request, project_id: Any) -> str | None:
    """Resolve a requester's reader band on the ladder, or None for a non-member.

    The ladder measures **management distance**: ``TEAM`` is the team itself
    (ordinary members, viewers, and the Scrum Master — all team insiders who always
    read their own team's signals), and ``TEAM_SM_PM`` is the PM/management band.
    A signal is read iff the requester's band is *within* the signal's audience
    (``tier <= audience``, see :func:`audience_can_read`), so the team always reads
    its own signals while the PM is excluded until the team shares upward.

    ``None`` (non-member — the only way an org/PMO principal arrives) is below the
    ladder and is denied every signal regardless of role ordinal: an Enterprise
    custom role above OWNER that is not a project member has no ``ProjectMembership``
    row, so it never passes (the back-door close, ADR-0104 §2). The Scrum-Master
    facet (ADR-0078 / #927) does **not** raise the *read* band — the SM is a team
    insider who reads as TEAM; the facet grants the *write* gate instead.
    """
    role = _membership_role(request, project_id)
    if role is None:
        return None
    if role >= Role.ADMIN:
        return SignalAudience.TEAM_SM_PM  # the PM / management band
    return SignalAudience.TEAM  # ordinary members, viewers, and the SM are the team


def audience_can_read(
    policy: ProjectSignalPrivacyPolicy, signal_key: str, requester_tier: str | None
) -> bool:
    """Whether a requester at ``requester_tier`` may read ``signal_key``'s gated detail.

    Read iff the requester's band is **within** the signal's audience on the ladder
    (``tier <= audience``) — the team (TEAM) always reads its own signals; the PM
    (TEAM_SM_PM) reads only once the team has shared the signal up to its band; the
    program rollup reads only at PROGRAM_SHARED. Raising the audience *widens* who
    can see a signal (shares upward); it never hides it from the team. A non-member
    (``requester_tier is None``) is outside the ladder and never reads.
    """
    if requester_tier is None:
        return False
    return signal_audience_rank(requester_tier) <= signal_audience_rank(
        policy.audience_of(signal_key)
    )


def can_read_signal(request: Request, project_id: Any, signal_key: str) -> bool:
    """Convenience: resolve the requester's tier and apply the gate in one call.

    Read-only: a read path must never *create* a policy (that would be a write on a
    GET, and would run the default-posture seam off a read request). When no policy
    row exists yet the signal resolves to its coded default audience (TEAM), which
    is exactly what an unseeded ``get_or_create`` would have produced.
    """
    tier = requester_signal_tier(request, project_id)
    if tier is None:
        return False
    policy = ProjectSignalPrivacyPolicy.objects.filter(project_id=project_id).first()
    audience = (
        policy.audience_of(signal_key)
        if policy is not None
        else SIGNAL_DEFAULTS.get(signal_key, {"audience": SignalAudience.TEAM})["audience"]
    )
    return signal_audience_rank(tier) <= signal_audience_rank(audience)


# Velocity_summary fields that are team-private detail (the series + the
# point-based rolling/forecast numbers). Suppressed for a below-tier reader; the
# task-count rollups and the keys themselves are retained so existing clients keep
# a stable shape (ADR-0104 §2.1 — suppress, don't 403).
_VELOCITY_GATED_FIELDS = (
    "rolling_avg_points",
    "rolling_stdev_points",
    "forecast_range_low",
    "forecast_range_high",
    "team_velocity_per_day",
)


def suppress_velocity_summary(summary: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of a velocity_summary with the team-private detail stripped.

    Empties the per-sprint ``sprints`` series, nulls the point-based rolling/forecast
    numbers, and sets ``velocity_suppressed=True`` so the client can render the
    gated empty-state. The milestone-health % and schedule confidence (computed
    elsewhere) are never touched.
    """
    # excluded_count (ADR-0113) is zeroed alongside the emptied series: it is an
    # organisational fact ("this team flagged N setup sprints") that the ADR-0104
    # privacy boundary excludes from a below-audience reader, and a non-zero count
    # over an empty sprints[] would be incoherent anyway.
    redacted = {**summary, "sprints": [], "excluded_count": 0, "velocity_suppressed": True}
    for field in _VELOCITY_GATED_FIELDS:
        if field in redacted:
            redacted[field] = None
    return redacted


# flow_metrics arrays that are team-private historical performance detail
# (cycle/lead distributions, the CFD series, the weekly throughput series).
# Emptied for a below-tier reader; the keys themselves and the aggregate-only
# data_integrity block are retained so existing clients keep a stable shape
# (ADR-0130 D4 / ADR-0104 §2.1 — suppress, don't 403). data_integrity is NOT
# stripped: it is aggregate-only advisory data (no per-person rows) and carries
# no team-performance signal on its own.
_FLOW_METRICS_GATED_ARRAYS = ("cfd", "throughput")


def suppress_flow_metrics(payload: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of a flow_metrics payload with the team-private detail stripped.

    Empties the cycle/lead-time distributions, the CFD series, and the weekly
    throughput series, and sets ``flow_metrics_suppressed=True`` so the client can
    render the gated empty-state (ADR-0130 D4). Models
    :func:`suppress_velocity_summary`.

    The ``data_integrity`` counts are zeroed too: ``bulk_moved_count`` /
    ``backdated_count`` are derived from the same completed-task replay as the
    throughput series, so a non-zero count reveals a floor on completions in the
    window and partially reconstructs the very signal being suppressed. This mirrors
    ADR-0104's treatment of ``excluded_count`` on velocity suppression. The block is
    kept in the shape (zeroed) so the response contract survives suppression.
    """
    redacted = {
        **payload,
        "cycle_time": {"p50": None, "p80": None, "p95": None},
        "lead_time": {"p50": None, "p80": None, "p95": None},
        "data_integrity": {
            "bulk_moved_count": 0,
            "backdated_count": 0,
            "missing_transition_count": 0,
        },
        "flow_metrics_suppressed": True,
    }
    for field in _FLOW_METRICS_GATED_ARRAYS:
        if field in redacted:
            redacted[field] = []
    return redacted


# ---------------------------------------------------------------------------
# Writes — two gates (§1.1). Audience within [TEAM, ceiling]; ceiling team-owned.
# ---------------------------------------------------------------------------


def _validate_signal_key(signal_key: str) -> None:
    if signal_key not in SIGNAL_DEFAULTS:
        raise ValidationError({"signal": f"Unknown signal '{signal_key}'."})


def _emit_consent_changed(
    project_id: Any, signal_key: str, change: str, old: str, new: str
) -> None:
    """Fire the supply-only extension-point signal on commit (ADR-0104 §3)."""
    from trueppm_api.apps.projects.signals import team_signal_consent_changed

    transaction.on_commit(
        lambda: team_signal_consent_changed.send(
            sender=ProjectSignalPrivacyPolicy,
            project_id=str(project_id),
            signal_key=signal_key,
            change=change,
            old=old,
            new=new,
        )
    )


def set_signal_audience(
    policy: ProjectSignalPrivacyPolicy,
    signal_key: str,
    new_audience: str,
    *,
    actor: Any = None,
) -> ProjectSignalPrivacyPolicy:
    """Move a signal's *audience* within ``[TEAM, ceiling]`` — the day-to-day write.

    This is the facilitator's dial. It is the **only** path that touches an
    audience, and it **refuses to touch a ceiling** (ADR-0104 §1.1 + threat-model
    🔴-1: a generic field PATCH that could write ``ceiling`` reopens the unilateral
    PM-raise hole). Rejects an audience above the team-authorized ceiling with 400.
    Idempotent: setting the current value writes no history row.
    """
    _validate_signal_key(signal_key)
    if new_audience not in SignalAudience.values:
        raise ValidationError({"audience": f"Invalid audience '{new_audience}'."})

    resolved = policy.resolved(signal_key)
    old_audience = resolved["audience"]
    ceiling = resolved["ceiling"]
    if signal_audience_rank(new_audience) > signal_audience_rank(ceiling):
        raise ValidationError(
            {
                "audience": (
                    f"Audience '{new_audience}' exceeds the team-authorized ceiling "
                    f"'{ceiling}'. Raise the ceiling first (a team decision)."
                )
            }
        )
    if new_audience == old_audience:
        return policy  # no-op — no history row (ADR-0104 §DE idempotency)

    entry = dict(policy.signal_visibility.get(signal_key, {}))
    entry["audience"] = new_audience
    policy.signal_visibility = {**policy.signal_visibility, signal_key: entry}
    policy._change_reason = f"{signal_key} audience: {old_audience} -> {new_audience}"  # type: ignore[attr-defined]
    policy.save()
    _emit_consent_changed(policy.project_id, signal_key, "audience", old_audience, new_audience)
    return policy


def raise_signal_ceiling(
    policy: ProjectSignalPrivacyPolicy,
    signal_key: str,
    new_ceiling: str,
    *,
    actor: Any = None,
) -> ProjectSignalPrivacyPolicy:
    """Set a signal's *ceiling* — authorizing wider exposure (the team-owned act).

    Raising a ceiling authorizes the facilitator to later move the audience that far;
    it never moves the audience itself. **Lowering** a ceiling is always allowed
    (more private) and clamps the audience down with it (ADR-0104 §1.1). Audited and
    emitted as a team-visible consent event.
    """
    _validate_signal_key(signal_key)
    if new_ceiling not in SignalAudience.values:
        raise ValidationError({"ceiling": f"Invalid ceiling '{new_ceiling}'."})

    resolved = policy.resolved(signal_key)
    old_ceiling = resolved["ceiling"]
    audience = resolved["audience"]
    if new_ceiling == old_ceiling:
        return policy

    entry = dict(policy.signal_visibility.get(signal_key, {}))
    entry["ceiling"] = new_ceiling
    # Lowering the ceiling below the current audience clamps the audience down with
    # it — the signal can never sit above what the team now authorizes.
    clamped = audience
    if signal_audience_rank(new_ceiling) < signal_audience_rank(audience):
        clamped = new_ceiling
        entry["audience"] = clamped
    policy.signal_visibility = {**policy.signal_visibility, signal_key: entry}

    direction = (
        "raise"
        if signal_audience_rank(new_ceiling) > signal_audience_rank(old_ceiling)
        else "lower"
    )
    reason = f"{signal_key} ceiling: {old_ceiling} -> {new_ceiling} (team-owned {direction})"
    policy._change_reason = reason  # type: ignore[attr-defined]
    policy.save()
    _emit_consent_changed(policy.project_id, signal_key, "ceiling", old_ceiling, new_ceiling)
    if clamped != audience:
        _emit_consent_changed(policy.project_id, signal_key, "audience", audience, clamped)
    return policy


def ratchet_down_to_team(
    policy: ProjectSignalPrivacyPolicy, *, actor: Any = None
) -> ProjectSignalPrivacyPolicy:
    """Set every signal's audience to TEAM in one call — the SM panic button (§1).

    Never touches ceilings (it is the convenience form of set-audience). Idempotent;
    writes one audited history entry only for signals that actually changed.
    """
    changed = False
    new_map = dict(policy.signal_visibility)
    reasons: list[str] = []
    moves: list[tuple[str, str]] = []
    for signal_key in SIGNAL_KEYS:
        old_audience = policy.audience_of(signal_key)
        if old_audience == SignalAudience.TEAM:
            continue
        entry = dict(new_map.get(signal_key, {}))
        entry["audience"] = SignalAudience.TEAM
        new_map[signal_key] = entry
        reasons.append(f"{signal_key} audience: {old_audience} -> team")
        moves.append((signal_key, old_audience))
        changed = True
    if not changed:
        return policy
    policy.signal_visibility = new_map
    policy._change_reason = "ratchet to team-only: " + "; ".join(reasons)  # type: ignore[attr-defined]
    policy.save()
    for signal_key, old_audience in moves:
        _emit_consent_changed(
            policy.project_id, signal_key, "audience", old_audience, SignalAudience.TEAM
        )
    return policy


# ---------------------------------------------------------------------------
# Enterprise extension point — supply-only, opt-in only (§3)
# ---------------------------------------------------------------------------


def get_shared_team_signals(project: Project) -> dict[str, str] | None:
    """Return the signals a project has opted into the program rollup, or None.

    Returns ``{signal_key: audience}`` for *only* the signals whose audience is
    ``PROGRAM_SHARED`` (reachable only after a team raised the ceiling there and set
    the audience there). Returns **None** when the project shared nothing — the
    consumer skips a ``None`` rather than zero-filling, so a non-consenting team is
    excluded from the aggregate, never inferred as a zero (ADR-0104 §3, Alternative
    D rejected). Pure read; no side effects.
    """
    policy = get_or_create_policy(project)
    shared = {
        signal_key: policy.audience_of(signal_key)
        for signal_key in SIGNAL_KEYS
        if policy.audience_of(signal_key) == SignalAudience.PROGRAM_SHARED
    }
    return shared or None


def velocity_shared_externally(project: Project) -> bool:
    """Whether velocity may travel to an *external* webhook consumer (ADR-0147).

    A webhook recipient has no ``ProjectMembership`` and therefore no ladder tier —
    the reader gate would deny it every signal, which would suppress velocity for
    *every* webhook and defeat the legitimate "relay our cadence to our own
    dashboard" use case. Instead an external consumer is mapped to the single
    explicit outward-share rung: velocity (``completed_points`` / ``completed_task_count``
    on ``sprint.closed``) leaves the team boundary **iff** the team has raised the
    ``velocity`` signal's audience to ``PROGRAM_SHARED`` — the one rung reachable only
    by a deliberate, team-owned ceiling+audience raise. This is the same authority
    ``get_shared_team_signals`` consults, kept here so the webhook gate and the rollup
    gate can never drift. Pure read; uses the resolved default (TEAM) when no policy
    row exists, so the default suppresses.
    """
    policy = ProjectSignalPrivacyPolicy.objects.filter(project=project).first()
    audience = (
        policy.audience_of("velocity")
        if policy is not None
        else SIGNAL_DEFAULTS["velocity"]["audience"]
    )
    return audience == SignalAudience.PROGRAM_SHARED


# ---------------------------------------------------------------------------
# Ceiling-raise ratification (ADR-0104 Amendment A, #930)
# ---------------------------------------------------------------------------
#
# Raising a ceiling authorizes *wider* upward exposure of a team signal, so it is the
# team-owned act (ADR-0104 §1.1). It no longer applies immediately: a raise opens a
# ratification proposal and the ceiling is applied only when a strict majority of the
# current team roster approves. A lone facilitator can never widen exposure alone.
# Lowering a ceiling and set-audience moves stay immediate single actions — tightening
# is never gated heavier than loosening. Silence is never consent: an unratified
# proposal expires with the ceiling unchanged (no auto-apply-on-timeout). There is no
# management bypass — that would reopen the §2 back-door this whole model closes.


class CeilingProposalConflict(Exception):
    """A ceiling-proposal action conflicts with the proposal's current state.

    A plain ``Exception`` (not an ``APIException``) so the view maps it to a structured
    ``409 {code, detail}`` — mirroring ADR-0102's ``ScopeAcceptForbidden`` → structured
    response pattern rather than DRF's default ``400`` for a ``ValidationError``.
    """

    def __init__(self, code: str, detail: str) -> None:
        self.code = code
        self.detail = detail
        super().__init__(detail)


def _is_real_user(actor: Any) -> bool:
    """Whether ``actor`` is an authenticated user (not None / AnonymousUser)."""
    return actor is not None and bool(getattr(actor, "is_authenticated", False))


def _ceiling_proposal_ttl() -> timedelta:
    """The OPEN-proposal lifetime (default 72h, settings-overridable; Amendment A.3).

    Clamped to >= 1 hour so a misconfigured ``SIGNAL_CEILING_PROPOSAL_TTL_HOURS`` of 0
    or negative can never mint a proposal that expires before anyone can vote on it.
    """
    hours = getattr(django_settings, "SIGNAL_CEILING_PROPOSAL_TTL_HOURS", 72)
    return timedelta(hours=max(1, int(hours)))


def ratification_threshold(eligible_count: int) -> int:
    """Strict majority of the current roster — ``floor(n/2) + 1`` (Amendment A.2).

    Yields 1->1, 2->2, 3->2, 4->3, 5->3. For any team of >=2 members the proposer's
    own approval (1) never meets the bar, so a lone facilitator can never raise alone;
    a 1-member team's sole member ratifies (there is no other member to consult). Not
    unanimity and not whole-roster, so one disengaged member can never deadlock a raise.
    """
    if eligible_count <= 0:
        return 1
    return eligible_count // 2 + 1


def _team_voter_ids(project_id: Any) -> set[Any]:
    """The eligible-voter set: user ids on the project's default team (Amendment A.2)."""
    from trueppm_api.apps.teams.services import team_member_user_ids

    return team_member_user_ids(project_id)


def _emit_proposal_changed(proposal: SignalCeilingRaiseProposal) -> None:
    """Fire the supply-only proposal-lifecycle signal on commit (Amendment A.6)."""
    from trueppm_api.apps.projects.signals import team_signal_ceiling_proposal_changed

    project_id = str(proposal.project_id)
    signal_key = proposal.signal_key
    proposal_id = str(proposal.id)
    status = proposal.status
    transaction.on_commit(
        lambda: team_signal_ceiling_proposal_changed.send(
            sender=SignalCeilingRaiseProposal,
            project_id=project_id,
            signal_key=signal_key,
            proposal_id=proposal_id,
            status=status,
        )
    )


def _resolve_proposal(
    proposal: SignalCeilingRaiseProposal, new_status: str
) -> SignalCeilingRaiseProposal:
    """Move an OPEN proposal to a terminal state; apply the raise only on RATIFIED.

    RATIFIED re-resolves the *current* ceiling and applies via ``raise_signal_ceiling``
    only when ``to_ceiling`` is still strictly higher — so a team that already raised
    the ceiling by other means never gets a surprise double-jump, and a ratification can
    never *lower* a ceiling (Amendment A.4). Every terminal state emits the lifecycle
    signal on commit. Must be called under a row lock on ``proposal``.
    """
    proposal.status = new_status
    proposal.resolved_at = timezone.now()
    proposal.save(update_fields=["status", "resolved_at"])
    if new_status == CeilingRaiseStatus.RATIFIED:
        policy = get_or_create_policy(proposal.project)
        current = policy.ceiling_of(proposal.signal_key)
        if signal_audience_rank(proposal.to_ceiling) > signal_audience_rank(current):
            raise_signal_ceiling(
                policy, proposal.signal_key, proposal.to_ceiling, actor=proposal.proposed_by
            )
    _emit_proposal_changed(proposal)
    return proposal


def _count_current_votes(
    proposal: SignalCeilingRaiseProposal, voter_ids: set[Any]
) -> tuple[int, int]:
    """(approve, reject) counts restricted to *current* eligible members.

    A member who has left the team no longer sways the tally, so the numbers always
    reconcile with the roster the threshold is computed against.
    """
    approve = 0
    reject = 0
    for vote in proposal.votes.all():
        if vote.voter_id not in voter_ids:
            continue
        if vote.choice == CeilingVoteChoice.APPROVE:
            approve += 1
        elif vote.choice == CeilingVoteChoice.REJECT:
            reject += 1
    return approve, reject


def _tally_and_maybe_apply(proposal: SignalCeilingRaiseProposal) -> SignalCeilingRaiseProposal:
    """Recompute the outcome from current votes + roster; resolve when decided.

    Call under ``select_for_update`` on the proposal. Idempotent: a no-op once the
    proposal has left OPEN. Expiry is evaluated first (lazy, Amendment A.3).
    """
    if proposal.status != CeilingRaiseStatus.OPEN:
        return proposal
    if timezone.now() >= proposal.expires_at:
        return _resolve_proposal(proposal, CeilingRaiseStatus.EXPIRED)
    voter_ids = _team_voter_ids(proposal.project_id)
    eligible = len(voter_ids)
    threshold = ratification_threshold(eligible)
    approve, reject = _count_current_votes(proposal, voter_ids)
    if approve >= threshold:
        return _resolve_proposal(proposal, CeilingRaiseStatus.RATIFIED)
    # Approval can no longer reach the bar (even every remaining member voting yes
    # falls short) — reject early rather than wait out the timeout. Guarded on a
    # non-empty roster: with no eligible voters yet the proposal stays OPEN (it will
    # expire) rather than auto-rejecting on a vacuous "unreachable" check.
    if eligible > 0 and reject > eligible - threshold:
        return _resolve_proposal(proposal, CeilingRaiseStatus.REJECTED)
    return proposal


def expire_stale_proposals(project_id: Any, signal_key: str | None = None) -> None:
    """Lazily expire past-due OPEN proposals (Amendment A.3) — no Celery/Beat.

    Called on the write paths before the one-open-per-signal check, so a stale OPEN
    row never blocks a fresh proposal. An expired proposal dies UNRATIFIED.
    """
    with transaction.atomic():
        stale = SignalCeilingRaiseProposal.objects.select_for_update().filter(
            project_id=project_id,
            status=CeilingRaiseStatus.OPEN,
            expires_at__lte=timezone.now(),
        )
        if signal_key is not None:
            stale = stale.filter(signal_key=signal_key)
        for proposal in stale:
            _resolve_proposal(proposal, CeilingRaiseStatus.EXPIRED)


def _supersede_open_proposals(project_id: Any, signal_key: str) -> None:
    """Supersede any OPEN raise proposal for a signal whose ceiling is being lowered.

    A lower moves the baseline the proposal was relative to, so the pending raise is no
    longer valid — it is SUPERSEDED (audited), forcing a fresh proposal + vote rather
    than letting a stale ratification apply an unexpected jump. This is the audit
    surface for the lower-then-raise pattern (Amendment A.4).
    """
    with transaction.atomic():
        for proposal in SignalCeilingRaiseProposal.objects.select_for_update().filter(
            project_id=project_id,
            signal_key=signal_key,
            status=CeilingRaiseStatus.OPEN,
        ):
            _resolve_proposal(proposal, CeilingRaiseStatus.SUPERSEDED)


def propose_or_apply_ceiling_change(
    policy: ProjectSignalPrivacyPolicy,
    signal_key: str,
    new_ceiling: str,
    *,
    actor: Any,
) -> SignalCeilingRaiseProposal | None:
    """Route a ceiling change: a RAISE opens a ratification proposal; a LOWER applies now.

    Returns the proposal on a raise (OPEN, or already RATIFIED when a solo team's sole
    member is the proposer), or ``None`` on a lower / no-op (applied immediately via
    ``raise_signal_ceiling``). The policy is unchanged until ratification, so the caller
    re-reads it after this returns.
    """
    _validate_signal_key(signal_key)
    if new_ceiling not in SignalAudience.values:
        raise ValidationError({"ceiling": f"Invalid ceiling '{new_ceiling}'."})
    current = policy.ceiling_of(signal_key)
    if signal_audience_rank(new_ceiling) <= signal_audience_rank(current):
        # Lower or no-op: immediate single action. A lower supersedes any open raise
        # proposal for this signal (its baseline just moved).
        if signal_audience_rank(new_ceiling) < signal_audience_rank(current):
            _supersede_open_proposals(policy.project_id, signal_key)
        raise_signal_ceiling(policy, signal_key, new_ceiling, actor=actor)
        return None
    # Raise — the team-owned act: open a ratification proposal.
    project_id = policy.project_id
    with transaction.atomic():
        expire_stale_proposals(project_id, signal_key)
        existing = (
            SignalCeilingRaiseProposal.objects.select_for_update()
            .filter(
                project_id=project_id,
                signal_key=signal_key,
                status=CeilingRaiseStatus.OPEN,
            )
            .first()
        )
        if existing is not None:
            raise CeilingProposalConflict(
                "proposal_already_open",
                "A ceiling-raise proposal is already open for this signal.",
            )
        proposal = SignalCeilingRaiseProposal.objects.create(
            project_id=project_id,
            signal_key=signal_key,
            from_ceiling=current,
            to_ceiling=new_ceiling,
            proposed_by=actor if _is_real_user(actor) else None,
            expires_at=timezone.now() + _ceiling_proposal_ttl(),
        )
        # Proposing is an implicit APPROVE — but only when the proposer is a team
        # member (a non-team project Admin may kick off the team's vote without
        # casting one). A solo-team proposer thereby ratifies immediately.
        voter_ids = _team_voter_ids(project_id)
        if _is_real_user(actor) and actor.pk in voter_ids:
            SignalCeilingRaiseVote.objects.create(
                proposal=proposal, voter=actor, choice=CeilingVoteChoice.APPROVE
            )
        _emit_proposal_changed(proposal)  # opened
        proposal = _tally_and_maybe_apply(proposal)
    return proposal


def cast_ceiling_vote(proposal_id: Any, voter: Any, choice: str) -> SignalCeilingRaiseProposal:
    """Record (or change) a team member's vote and re-tally under a row lock.

    Idempotent: the vote is an upsert (``unique(proposal, voter)``) and the apply runs
    once behind the OPEN->RATIFIED status guard. Raises ``CeilingProposalConflict`` when
    the proposal is no longer open (including a lazy expiry evaluated under the lock).
    """
    if choice not in CeilingVoteChoice.values:
        raise ValidationError({"choice": f"Invalid choice '{choice}'."})
    with transaction.atomic():
        try:
            proposal = SignalCeilingRaiseProposal.objects.select_for_update().get(pk=proposal_id)
        except SignalCeilingRaiseProposal.DoesNotExist:
            raise CeilingProposalConflict("not_found", "Proposal not found.") from None
        if proposal.status == CeilingRaiseStatus.OPEN and timezone.now() >= proposal.expires_at:
            _resolve_proposal(proposal, CeilingRaiseStatus.EXPIRED)
        if proposal.status != CeilingRaiseStatus.OPEN:
            raise CeilingProposalConflict(
                "proposal_closed", "This proposal is no longer open for voting."
            )
        SignalCeilingRaiseVote.objects.update_or_create(
            proposal=proposal, voter=voter, defaults={"choice": choice}
        )
        return _tally_and_maybe_apply(proposal)


def withdraw_ceiling_proposal(proposal_id: Any, actor: Any) -> SignalCeilingRaiseProposal:
    """Withdraw an OPEN proposal (the proposer's cancel), recorded as REJECTED.

    Frees the signal for a fresh proposal without waiting out the TTL. The caller
    enforces that ``actor`` is the proposer or a facilitator/Admin.
    """
    with transaction.atomic():
        try:
            proposal = SignalCeilingRaiseProposal.objects.select_for_update().get(pk=proposal_id)
        except SignalCeilingRaiseProposal.DoesNotExist:
            raise CeilingProposalConflict("not_found", "Proposal not found.") from None
        if proposal.status != CeilingRaiseStatus.OPEN:
            raise CeilingProposalConflict("proposal_closed", "This proposal is no longer open.")
        return _resolve_proposal(proposal, CeilingRaiseStatus.REJECTED)


def live_open_proposals(project_id: Any) -> dict[str, SignalCeilingRaiseProposal]:
    """Return ``{signal_key: live OPEN proposal}`` for the project, in ONE query.

    A read helper for the GET surface: it does NOT persist an expiry (reads stay
    side-effect-free) — a past-due OPEN row is treated as absent and is GC'd to
    EXPIRED on the next write path. Votes are prefetched so the caller's per-proposal
    tally/serialize do not re-query (the partial-unique constraint bounds the result
    to at most one OPEN row per signal). The eligible roster should be fetched once by
    the caller and threaded into ``proposal_tally``/serialization.
    """
    now = timezone.now()
    result: dict[str, SignalCeilingRaiseProposal] = {}
    for proposal in (
        SignalCeilingRaiseProposal.objects.filter(
            project_id=project_id, status=CeilingRaiseStatus.OPEN
        )
        .prefetch_related("votes")
        .order_by("-created_at")
    ):
        if proposal.expires_at > now and proposal.signal_key not in result:
            result[proposal.signal_key] = proposal
    return result


def proposal_tally(
    proposal: SignalCeilingRaiseProposal, voter_ids: set[Any] | None = None
) -> dict[str, int]:
    """Current approve/reject/eligible/threshold counts for a proposal (read).

    Pass ``voter_ids`` (the precomputed roster, identical across a project's proposals)
    to avoid one roster query per proposal when serializing a list.
    """
    if voter_ids is None:
        voter_ids = _team_voter_ids(proposal.project_id)
    eligible = len(voter_ids)
    approve, reject = _count_current_votes(proposal, voter_ids)
    return {
        "approve_count": approve,
        "reject_count": reject,
        "eligible_count": eligible,
        "threshold": ratification_threshold(eligible),
    }
