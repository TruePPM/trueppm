"""Tests for the declared external guardrail-policy seam (ADR-0101 §3, #3780).

The seam is the OSS write entrypoint trueppm-enterprise calls to install a
cross-program guardrail template. What is under test is the *contract*, not the
enforcement (that lives in ``test_guardrails.py``): input validation, the
sovereignty invariant that the seam never sets ``acknowledged_by_team``, the
acknowledgement reset on a content change (and the deliberate non-reset on an
idempotent re-push), and the owner-map restore on withdrawal.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.projects.guardrail_policy_source import (
    EXTERNAL_GUARDRAIL_POLICY_CONTRACT_VERSION,
    ExternalGuardrailPolicyError,
    apply_external_guardrail_policy,
    clear_external_guardrail_policy,
)
from trueppm_api.apps.projects.models import (
    GuardrailLevel,
    GuardrailPolicySource,
    Project,
    ProjectGuardrailPolicy,
)

User = get_user_model()

pytestmark = pytest.mark.django_db


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 1, 1))


# --------------------------------------------------------------------------- #
# Apply — happy path and lazy row creation.
# --------------------------------------------------------------------------- #


def test_apply_creates_the_row_when_none_exists(project: Project) -> None:
    # The policy row is lazily created on first GET, so the seam must not assume one.
    assert not ProjectGuardrailPolicy.objects.filter(project=project).exists()

    policy = apply_external_guardrail_policy(
        project,
        levels={"summary_in_sprint": GuardrailLevel.BLOCK},
        source_label="PMO",
    )

    assert policy.source == GuardrailPolicySource.EXTERNAL
    assert policy.source_label == "PMO"
    assert policy.levels == {"summary_in_sprint": "block"}
    assert policy.acknowledged_by_team is False


def test_apply_accepts_a_pk_as_well_as_an_instance(project: Project) -> None:
    policy = apply_external_guardrail_policy(
        str(project.pk),
        levels={"recurring_in_sprint": GuardrailLevel.WARN},
        source_label="PMO",
    )
    assert str(policy.project_id) == str(project.pk)


def test_apply_replaces_the_owner_level_map(project: Project) -> None:
    ProjectGuardrailPolicy.objects.create(
        project=project,
        levels={"recurring_in_sprint": GuardrailLevel.BLOCK},
        source=GuardrailPolicySource.OWNER,
    )

    policy = apply_external_guardrail_policy(
        project, levels={"summary_in_sprint": GuardrailLevel.BLOCK}, source_label="PMO"
    )

    # One `levels` column, one `source` — an external policy is a complete statement,
    # not an overlay. The owner map is recoverable via clear_ (tested below).
    assert policy.levels == {"summary_in_sprint": "block"}


def test_applied_block_is_inert_until_the_team_acknowledges(project: Project) -> None:
    # The seam feeds the model gate rather than bypassing it — the whole point.
    policy = apply_external_guardrail_policy(
        project, levels={"summary_in_sprint": GuardrailLevel.BLOCK}, source_label="PMO"
    )
    assert policy.effective_level("summary_in_sprint") == GuardrailLevel.WARN

    policy.acknowledged_by_team = True
    policy.save()
    assert policy.effective_level("summary_in_sprint") == GuardrailLevel.BLOCK


# --------------------------------------------------------------------------- #
# Sovereignty invariant — the seam never acknowledges on the team's behalf.
# --------------------------------------------------------------------------- #


def test_apply_never_sets_acknowledgement(project: Project) -> None:
    # The negative control for the bypass this seam exists to close: a direct ORM
    # save can set source=EXTERNAL and acknowledged_by_team=True together; the
    # declared path must offer no argument that does so.
    apply_external_guardrail_policy(
        project, levels={"summary_in_sprint": GuardrailLevel.BLOCK}, source_label="PMO"
    )
    policy = ProjectGuardrailPolicy.objects.get(project=project)
    assert policy.acknowledged_by_team is False
    assert policy.acknowledged_at is None


def test_apply_resets_acknowledgement_when_the_policy_changes(project: Project) -> None:
    apply_external_guardrail_policy(
        project, levels={"summary_in_sprint": GuardrailLevel.WARN}, source_label="PMO"
    )
    policy = ProjectGuardrailPolicy.objects.get(project=project)
    policy.acknowledged_by_team = True
    policy.save()

    # A team acknowledges a specific policy, not a slot — swapping warn for block
    # has to be acknowledged again.
    updated = apply_external_guardrail_policy(
        project, levels={"summary_in_sprint": GuardrailLevel.BLOCK}, source_label="PMO"
    )
    assert updated.acknowledged_by_team is False
    assert updated.effective_level("summary_in_sprint") == GuardrailLevel.WARN


def test_apply_resets_acknowledgement_when_only_the_label_changes(project: Project) -> None:
    apply_external_guardrail_policy(
        project, levels={"summary_in_sprint": GuardrailLevel.BLOCK}, source_label="PMO"
    )
    policy = ProjectGuardrailPolicy.objects.get(project=project)
    policy.acknowledged_by_team = True
    policy.save()

    # The banner names who set the policy; a different name is a different policy.
    updated = apply_external_guardrail_policy(
        project, levels={"summary_in_sprint": GuardrailLevel.BLOCK}, source_label="Group PMO"
    )
    assert updated.acknowledged_by_team is False


def test_idempotent_reapply_preserves_acknowledgement(project: Project) -> None:
    apply_external_guardrail_policy(
        project, levels={"summary_in_sprint": GuardrailLevel.BLOCK}, source_label="PMO"
    )
    policy = ProjectGuardrailPolicy.objects.get(project=project)
    policy.acknowledged_by_team = True
    policy.save()

    # An hourly sync job re-pushing an unchanged policy must not silently revoke the
    # team's decision every hour.
    updated = apply_external_guardrail_policy(
        project, levels={"summary_in_sprint": GuardrailLevel.BLOCK}, source_label="PMO"
    )
    assert updated.acknowledged_by_team is True
    assert updated.effective_level("summary_in_sprint") == GuardrailLevel.BLOCK


# --------------------------------------------------------------------------- #
# Validation — refuse, never coerce.
# --------------------------------------------------------------------------- #


def test_apply_rejects_an_unknown_rule_key(project: Project) -> None:
    with pytest.raises(ExternalGuardrailPolicyError, match="Unknown guardrail rule"):
        apply_external_guardrail_policy(
            project, levels={"not_a_rule": GuardrailLevel.BLOCK}, source_label="PMO"
        )
    assert not ProjectGuardrailPolicy.objects.filter(project=project).exists()


def test_apply_rejects_an_unknown_level(project: Project) -> None:
    # Escaped: `match` is a regex, so a bare `|` would make this assert "expected warn"
    # OR "block" and pass on half the message.
    with pytest.raises(ExternalGuardrailPolicyError, match=r"expected warn\|block"):
        apply_external_guardrail_policy(
            project, levels={"summary_in_sprint": "forbid"}, source_label="PMO"
        )


@pytest.mark.parametrize("label", ["", "   "])
def test_apply_rejects_a_blank_source_label(project: Project, label: str) -> None:
    # The banner's job is to name who set the policy; an anonymous external policy is
    # the exact failure mode it exists to prevent.
    with pytest.raises(ExternalGuardrailPolicyError, match="source_label is required"):
        apply_external_guardrail_policy(
            project, levels={"summary_in_sprint": GuardrailLevel.BLOCK}, source_label=label
        )


def test_apply_rejects_an_oversized_source_label(project: Project) -> None:
    with pytest.raises(ExternalGuardrailPolicyError, match="exceeds 255"):
        apply_external_guardrail_policy(project, levels={}, source_label="x" * 256)


def test_apply_trims_the_source_label(project: Project) -> None:
    policy = apply_external_guardrail_policy(project, levels={}, source_label="  PMO  ")
    assert policy.source_label == "PMO"


# --------------------------------------------------------------------------- #
# Clear — withdrawal restores the owner map.
# --------------------------------------------------------------------------- #


def test_clear_restores_the_last_owner_level_map(project: Project) -> None:
    ProjectGuardrailPolicy.objects.create(
        project=project,
        levels={"recurring_in_sprint": GuardrailLevel.BLOCK},
        source=GuardrailPolicySource.OWNER,
    )
    apply_external_guardrail_policy(
        project, levels={"summary_in_sprint": GuardrailLevel.BLOCK}, source_label="PMO"
    )

    restored = clear_external_guardrail_policy(project)

    assert restored is not None
    assert restored.source == GuardrailPolicySource.OWNER
    assert restored.source_label == ""
    assert restored.acknowledged_by_team is False
    assert restored.levels == {"recurring_in_sprint": "block"}


def test_clear_drops_a_stale_acknowledgement(project: Project) -> None:
    apply_external_guardrail_policy(
        project, levels={"summary_in_sprint": GuardrailLevel.BLOCK}, source_label="PMO"
    )
    policy = ProjectGuardrailPolicy.objects.get(project=project)
    policy.acknowledged_by_team = True
    policy.save()

    restored = clear_external_guardrail_policy(project)

    # An acknowledgement of a withdrawn policy means nothing.
    assert restored is not None
    assert restored.acknowledged_by_team is False
    assert restored.acknowledged_at is None


def test_clear_is_a_noop_on_an_owner_sourced_policy(project: Project) -> None:
    ProjectGuardrailPolicy.objects.create(
        project=project,
        levels={"summary_in_sprint": GuardrailLevel.BLOCK},
        source=GuardrailPolicySource.OWNER,
    )
    assert clear_external_guardrail_policy(project) is None
    policy = ProjectGuardrailPolicy.objects.get(project=project)
    assert policy.levels == {"summary_in_sprint": "block"}


def test_clear_is_a_noop_when_no_policy_row_exists(project: Project) -> None:
    # Replaying a withdrawal must be safe — Enterprise has no way to know whether the
    # project ever had a row.
    assert clear_external_guardrail_policy(project) is None
    assert not ProjectGuardrailPolicy.objects.filter(project=project).exists()


def test_contract_version_is_exported() -> None:
    # Enterprise may read this to refuse a contract it does not understand.
    assert EXTERNAL_GUARDRAIL_POLICY_CONTRACT_VERSION == 1
