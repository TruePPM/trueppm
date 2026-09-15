"""Declared OSS entrypoint for an externally-sourced guardrail policy (ADR-0101 §3).

# unconsumed: no OSS caller by design — this is the write half of the OSS↔Enterprise
# guardrail seam. trueppm-enterprise#200 is the consumer (cross-program guardrail
# templates); until it ships, ``GuardrailPolicySource.EXTERNAL`` is unreachable in a
# community install and the OSS banner on ProjectGuardrailsPage never renders.

**Direction: push, not pull.** Every other single-provider hook in this tree is a
*pull* — OSS asks "is enforcement active?" and Enterprise answers
(``sharing_settings``, ``methodology``, ``attachment_policy``, …). Guardrails are the
other way round: Enterprise *owns* the policy content and OSS stores and enforces it.
Pulling would put a cross-repo call on the task-write validation path (every task
write reads the policy), and would make the policy unreadable offline, over MCP, or
with Enterprise down. So the seam is a function Enterprise calls when its org template
changes, and the row on disk stays the single source of truth for enforcement.

**Why a declared entrypoint at all** (#3780). Before this module, Enterprise's only
route was a bare ORM save on ``ProjectGuardrailPolicy``. That contract was implicit:
no declared shape, no validation, no version, and nothing any boundary gate could
enumerate. Worse, ``ProjectGuardrailPolicy``'s own docstring claimed the
sprint-sovereignty gate "cannot be bypassed by a caller that reaches the model
directly" — which was never true of a direct writer, because one ``save()`` can set
``source = EXTERNAL`` and ``acknowledged_by_team = True`` together and the
acknowledgement gate evaporates.

Be honest about what this module buys: it cannot *stop* a direct ORM write, because
nothing in Python can. What it removes is the silence. The supported path validates
its input, refuses to touch the acknowledgement flag, and resets a stale
acknowledgement when the policy's content changes — so "Enterprise imposed a block the
team never acknowledged" is now a deviation from a written contract rather than the
only way to do it.

ADR-0101 originally named this seam a ``guardrail_policy_resolving`` Django signal.
That signal was never implemented; see the ADR's amendment note for why a signal is the
wrong carrier for a value (multiple receivers, no single answer, and
``dispatch_extension_signal`` deliberately swallows receiver errors).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from uuid import UUID

from django.db import transaction

from trueppm_api.apps.projects.models import (
    GuardrailLevel,
    GuardrailPolicySource,
    GuardrailRule,
    ProjectGuardrailPolicy,
)

if TYPE_CHECKING:
    from collections.abc import Mapping

    from trueppm_api.apps.projects.models import Project

#: Bumped when the shape of :func:`apply_external_guardrail_policy` changes in a way an
#: Enterprise build must react to. Enterprise may read it to refuse to register against
#: a contract it does not understand; OSS never branches on it.
EXTERNAL_GUARDRAIL_POLICY_CONTRACT_VERSION = 1

#: The model column, and therefore the ceiling this seam validates against.
_MAX_SOURCE_LABEL_LENGTH = 255


class ExternalGuardrailPolicyError(ValueError):
    """Raised when an external policy is malformed.

    A distinct type (rather than a bare ``ValueError``) so an Enterprise caller can
    catch exactly this and surface it on its own admin surface. Raising — rather than
    coercing a bad value to something plausible — is deliberate: a silently repaired
    org policy is a policy nobody can reason about.
    """


def _coerce_project_id(project: Project | UUID | str) -> str:
    """Accept a ``Project``, a pk, or a pk string, and return the pk as a string."""
    pk = getattr(project, "pk", project)
    return str(pk)


def _validate_levels(levels: Mapping[str, str]) -> dict[str, str]:
    """Return ``levels`` as a plain dict, or raise if any key or value is unknown.

    Mirrors ``ProjectGuardrailPolicySerializer.validate_levels`` — the API path and
    this seam must not disagree about what a legal policy is, or the same map would be
    accepted from one side and rejected from the other.
    """
    valid_rules = {rule.value for rule in GuardrailRule}
    valid_levels = {level.value for level in GuardrailLevel}
    cleaned: dict[str, str] = {}
    for rule, level in levels.items():
        if rule not in valid_rules:
            raise ExternalGuardrailPolicyError(f"Unknown guardrail rule: {rule!r}.")
        if level not in valid_levels:
            raise ExternalGuardrailPolicyError(
                f"Invalid level {level!r} for {rule!r} (expected warn|block)."
            )
        cleaned[rule] = level
    return cleaned


def _validate_source_label(source_label: str) -> str:
    """Return the trimmed label, or raise if it is blank or over the column width.

    A blank label is refused rather than defaulted because the OSS banner's whole job
    is to *name* who set the policy (ADR-0101 §3 sprint sovereignty) — an anonymous
    external policy is the failure mode the banner exists to prevent.
    """
    label = (source_label or "").strip()
    if not label:
        raise ExternalGuardrailPolicyError(
            "source_label is required — the team-facing banner has to name who set the policy."
        )
    if len(label) > _MAX_SOURCE_LABEL_LENGTH:
        raise ExternalGuardrailPolicyError(
            f"source_label exceeds {_MAX_SOURCE_LABEL_LENGTH} characters."
        )
    return label


def _last_owner_levels(policy: ProjectGuardrailPolicy) -> dict[str, str]:
    """Best-effort recovery of the project's own level map from history.

    An external policy *replaces* the project's map (the model holds one ``levels``
    column and one ``source``), so withdrawing one would otherwise silently discard
    what the Owner had configured. ``HistoricalRecords`` already stores every prior
    state, so the withdrawal reads the most recent OWNER-sourced revision back.
    Falls back to ``{}`` (all-WARN, the documented default) when history has been
    pruned — losing a level map is bad, but leaving the team locked under a policy
    whose source has been withdrawn is worse.
    """
    record = (
        policy.history.filter(source=GuardrailPolicySource.OWNER).order_by("-history_date").first()
    )
    if record is None:
        return {}
    levels: Any = record.levels
    return dict(levels) if isinstance(levels, dict) else {}


@transaction.atomic
def apply_external_guardrail_policy(
    project: Project | UUID | str,
    *,
    levels: Mapping[str, str],
    source_label: str,
) -> ProjectGuardrailPolicy:
    """Install an externally-sourced guardrail policy on ``project``.

    This is the **only** supported way for code outside OSS to set
    ``GuardrailPolicySource.EXTERNAL``. It validates the level map against the same
    rules the REST path uses, records who supplied it, and replaces the project's own
    map (the row carries one ``levels`` column and one ``source``;
    :func:`clear_external_guardrail_policy` restores the previous owner map).

    **It never sets ``acknowledged_by_team``.** That flag is the sprint-sovereignty
    gate: an EXTERNAL composition block is inert until the *team* acknowledges it
    through the project's own API. A caller that sets it from outside has not used
    this entrypoint — it has reached around it.

    Acknowledgement is *reset* when the policy's content changes (levels or label), on
    the principle that a team acknowledges a specific policy rather than a slot: an org
    that swaps WARN for BLOCK must be acknowledged again. An idempotent re-push of an
    identical policy leaves the acknowledgement alone, so an hourly sync job does not
    silently revoke the team's decision every hour.

    Args:
        project: The project, its pk, or the pk as a string.
        levels: ``{rule_key: "warn"|"block"}``. Keys must be :class:`GuardrailRule`
            values; rules omitted from the map enforce as WARN.
        source_label: Team-facing name of whoever set the policy, shown in the OSS
            banner. Required and non-blank.

    Returns:
        The saved :class:`ProjectGuardrailPolicy` row.

    Raises:
        ExternalGuardrailPolicyError: If a rule key, a level, or the label is invalid.

    Note:
        Broadcasts ``guardrail_policy_updated`` on commit (#3810), same shape and
        same event as the PATCH view (#3773), but only when the policy's content
        actually changed — an idempotent re-push from an hourly sync job must not
        spam every open settings page with a no-op refetch signal.
    """
    cleaned_levels = _validate_levels(levels)
    label = _validate_source_label(source_label)
    project_id = _coerce_project_id(project)

    policy, _ = ProjectGuardrailPolicy.objects.select_for_update().get_or_create(
        project_id=project_id
    )
    content_changed = (
        policy.source != GuardrailPolicySource.EXTERNAL
        or dict(policy.levels) != cleaned_levels
        or policy.source_label != label
    )
    policy.levels = cleaned_levels
    policy.source = GuardrailPolicySource.EXTERNAL
    policy.source_label = label
    if content_changed:
        policy.acknowledged_by_team = False
        policy.acknowledged_at = None
    policy._change_reason = f"external policy applied by {label}"  # type: ignore[attr-defined]
    policy.save()

    if content_changed:
        # Snapshot to plain strings before the closure (broadcast-check H-1) — the
        # policy instance must not be captured live.
        policy_id = str(policy.id)
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "guardrail_policy_updated", {"id": policy_id})
        )
    return policy


@transaction.atomic
def clear_external_guardrail_policy(
    project: Project | UUID | str,
) -> ProjectGuardrailPolicy | None:
    """Withdraw an external policy, returning the project to owner-sourced guardrails.

    The counterpart to :func:`apply_external_guardrail_policy` — without it, an
    Enterprise build whose org template stops applying to a project would have no way
    back except the bare ORM save this seam exists to replace.

    Restores the most recent owner-sourced level map from history (see
    :func:`_last_owner_levels`) and clears the acknowledgement, because an
    acknowledgement of a withdrawn policy means nothing.

    Args:
        project: The project, its pk, or the pk as a string.

    Returns:
        The updated row, or ``None`` when the project has no policy row or its policy
        was never external (both are no-ops, so a withdrawal is safe to replay).

    Note:
        Broadcasts ``guardrail_policy_updated`` on commit (#3810) — same event
        :func:`apply_external_guardrail_policy` emits — but only on the real
        withdrawal path; a replayed no-op never reaches this far.
    """
    project_id = _coerce_project_id(project)
    policy = (
        ProjectGuardrailPolicy.objects.select_for_update().filter(project_id=project_id).first()
    )
    if policy is None or policy.source != GuardrailPolicySource.EXTERNAL:
        return None
    policy.levels = _last_owner_levels(policy)
    policy.source = GuardrailPolicySource.OWNER
    policy.source_label = ""
    policy.acknowledged_by_team = False
    policy.acknowledged_at = None
    policy._change_reason = "external policy withdrawn"  # type: ignore[attr-defined]
    policy.save()

    # Snapshot to plain strings before the closure (broadcast-check H-1) — the
    # policy instance must not be captured live.
    policy_id = str(policy.id)
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    transaction.on_commit(
        lambda: broadcast_board_event(project_id, "guardrail_policy_updated", {"id": policy_id})
    )
    return policy
