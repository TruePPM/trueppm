"""Template-divergence digest — the symmetric one (#2971, epic #2743).

The assertion that carries this feature is ``test_all_five_roles_read_the_same_body``.
Everything else here is arithmetic; that one is the requirement:

    A report about a team's decisions that the team cannot read is surveillance
    with better typography.

It is written as a byte-for-byte comparison across all five roles rather than five
independent 200 assertions on purpose. Five green 200s would still pass if someone
later added an audience branch that returned a narrower body to a Viewer — the
failure mode the issue is about is not a refusal, it is a *different report*.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    ProjectTemplate,
    Task,
    TaskSource,
    TemplateApplication,
    TemplateApplicationStatus,
    TemplateSource,
)
from trueppm_api.apps.projects.project_templates import materialize_structure
from trueppm_api.apps.projects.template_divergence import compute_template_divergence

User = get_user_model()

pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar() -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Atlas", start_date=date(2026, 4, 1), calendar=calendar)


def _structure(*names: str) -> dict[str, Any]:
    """A minimal frozen document — enough shape for the seeding path to run for real."""
    return {
        "version": 1,
        "methodology": "HYBRID",
        "carries": ["structure"],
        "tasks": [
            {
                "ref": f"t{i}",
                "name": name,
                "duration": 5,
                "wbs_path": str(i + 1),
                "parent": None,
                "is_milestone": False,
                "type": "waterfall",
            }
            for i, name in enumerate(names)
        ],
        "dependencies": [],
    }


@pytest.fixture
def template(calendar: Calendar) -> ProjectTemplate:
    return ProjectTemplate.objects.create(
        name="Delivery skeleton",
        version=3,
        source_kind=TemplateSource.WORKSPACE,
        structure=_structure("Discover", "Design", "Build", "Verify"),
        carries=["structure"],
    )


def _adopt(
    template: ProjectTemplate,
    project: Project,
    *,
    applied_by: Any = None,
) -> TemplateApplication:
    """Seed for real through ``materialize_structure``, then record the adoption.

    Deliberately not hand-stamped fixtures: ``seeded_at``/``source_kind`` are what the
    digest reads, and a test that sets them itself would pass even if the seeding path
    stopped writing them.
    """
    result = materialize_structure(template, project)
    return TemplateApplication.objects.create(
        template=template,
        template_name=template.name,
        template_version=template.version,
        project=project,
        applied_by=applied_by,
        status=TemplateApplicationStatus.SUCCESS,
        created_task_ids=list(result.task_ids),
    )


def _client_for(project: Project, role: int, username: str) -> APIClient:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/template-divergence/"


# ---------------------------------------------------------------------------
# The requirement
# ---------------------------------------------------------------------------


ALL_ROLES = [Role.VIEWER, Role.MEMBER, Role.SCHEDULER, Role.ADMIN, Role.OWNER]


def test_all_five_roles_read_the_same_body(project: Project, template: ProjectTemplate) -> None:
    """Every role on the project gets the digest, and gets the *identical* digest.

    This is the issue, not a coverage line. If a later change narrows the body for a
    Viewer — hides the adapted count, drops the template name — the five 200s would
    still be five 200s, and only this equality catches it.
    """
    _adopt(template, project)

    bodies = []
    for role in ALL_ROLES:
        client = _client_for(project, role, f"u{role}")
        response = client.get(_url(project))
        assert response.status_code == 200, f"role {role} was refused the digest"
        bodies.append(response.json())

    first = bodies[0]
    for role, body in zip(ALL_ROLES, bodies, strict=True):
        assert body == first, f"role {role} received a different report from role {ALL_ROLES[0]}"


def test_non_member_cannot_read_the_digest(project: Project, template: ProjectTemplate) -> None:
    """Symmetric among the team is not the same as public.

    The membership-scoped queryset resolves a non-member's request to nothing, so the
    refusal is a 404 rather than a 403 — the project's existence is not disclosed.
    """
    _adopt(template, project)
    outsider = User.objects.create_user(username="outsider", password="pw")
    client = APIClient()
    client.force_authenticate(user=outsider)

    assert client.get(_url(project)).status_code == 404


def test_anonymous_is_refused(project: Project, template: ProjectTemplate) -> None:
    _adopt(template, project)
    assert APIClient().get(_url(project)).status_code in (401, 403)


# ---------------------------------------------------------------------------
# The arithmetic
# ---------------------------------------------------------------------------


def test_freshly_adopted_project_is_all_unchanged(
    project: Project, template: ProjectTemplate
) -> None:
    _adopt(template, project)

    digest = compute_template_divergence(project)

    assert digest["adopted"] is True
    assert digest["template_name"] == "Delivery skeleton"
    assert digest["template_version"] == 3
    assert digest["template_available"] is True
    assert digest["seeded_row_count"] == 4
    assert digest["unchanged"] == 4
    assert digest["adapted"] == 0
    assert digest["removed"] == 0
    assert digest["added"] == 0


def test_counts_track_edits_deletions_and_additions(
    project: Project, template: ProjectTemplate
) -> None:
    """One row edited, one soft-deleted, one row typed by the team."""
    application = _adopt(template, project)
    seeded = list(Task.objects.filter(pk__in=application.created_task_ids).order_by("wbs_path"))
    assert len(seeded) == 4

    # A person renames a seeded row. save() stamps edited_at (ADR-0786 §4), which is
    # what moves it out of the untouched set — nothing in the test asserts the column
    # directly, because the digest's whole job is to read it the same way the sweep does.
    seeded[0].name = "Discovery (ours)"
    seeded[0].save()

    seeded[1].soft_delete()

    Task.objects.create(project=project, name="Security review", duration=3, wbs_path="9")

    digest = compute_template_divergence(project)

    assert digest["seeded_row_count"] == 4
    assert digest["unchanged"] == 2
    assert digest["adapted"] == 1
    assert digest["removed"] == 1
    assert digest["added"] == 1


def test_unchanged_matches_untouched_seeded_exactly(
    project: Project, template: ProjectTemplate
) -> None:
    """The digest's ``unchanged`` is ``untouched_seeded``, not a second filter.

    ADR-0786 §3 makes that manager THE definition, and the reason is that a copy which
    drifts by one clause silently deletes work somebody typed. Asserting equality
    against the manager (rather than against a hard-coded number) is what makes a
    future divergence between the two a failing test rather than a quiet disagreement.
    """
    application = _adopt(template, project)
    row = Task.objects.filter(pk__in=application.created_task_ids).order_by("wbs_path").first()
    assert row is not None
    row.name = "Touched"
    row.save()

    expected = (
        Task.objects.untouched_seeded(project, within=None)
        .filter(pk__in=application.created_task_ids)
        .count()
    )

    assert compute_template_divergence(project)["unchanged"] == expected == 3


def test_window_is_disabled_so_an_old_adoption_still_reports(
    project: Project, template: ProjectTemplate
) -> None:
    """A project adopted three months ago has diverged just as legibly as one adopted today.

    ``untouched_seeded``'s default seven-day window exists to bound a *delete* offer.
    Inheriting it here would report every long-lived project as 100% adapted, which is
    a false accusation rather than a stale number.
    """
    from datetime import timedelta

    from django.utils import timezone

    application = _adopt(template, project)
    Task.objects.filter(pk__in=application.created_task_ids).update(
        seeded_at=timezone.now() - timedelta(days=120)
    )

    digest = compute_template_divergence(project)

    assert digest["unchanged"] == 4
    assert digest["adapted"] == 0


# ---------------------------------------------------------------------------
# The edges the issue names
# ---------------------------------------------------------------------------


def test_project_with_no_template_application(project: Project) -> None:
    """ "Not created from a template" is an answer, not an error."""
    Task.objects.create(project=project, name="Hand-typed", duration=2, wbs_path="1")

    digest = compute_template_divergence(project)

    assert digest["adopted"] is False
    assert digest["application"] is None
    assert digest["application_count"] == 0
    assert digest["template"] is None
    assert digest["template_name"] == ""
    assert digest["template_available"] is False
    assert digest["seeded_row_count"] == 0
    assert digest["unchanged"] == digest["adapted"] == digest["removed"] == 0
    assert digest["added"] == 1


def test_no_application_reads_200_for_every_role(project: Project) -> None:
    for role in ALL_ROLES:
        client = _client_for(project, role, f"none{role}")
        response = client.get(_url(project))
        assert response.status_code == 200
        assert response.json()["adopted"] is False


def test_template_deleted_after_adoption_still_names_it(
    project: Project, template: ProjectTemplate
) -> None:
    """The denormalized name/version are why "this came from Delivery Skeleton v3" outlives v3.

    ``template`` FK is SET_NULL, so the link drops and nothing else does. A digest that
    went blank here would erase the only account a team has of where their plan came from.
    """
    _adopt(template, project)
    template.delete()

    digest = compute_template_divergence(project)

    assert digest["adopted"] is True
    assert digest["template"] is None
    assert digest["template_available"] is False
    assert digest["template_name"] == "Delivery skeleton"
    assert digest["template_version"] == 3
    assert digest["seeded_row_count"] == 4
    assert digest["unchanged"] == 4


def test_undone_application_is_not_counted(project: Project, template: ProjectTemplate) -> None:
    """An adoption that was reversed was not an adoption.

    Same rule as the gallery's usage count (#2909).
    """
    from django.utils import timezone

    application = _adopt(template, project)
    application.status = TemplateApplicationStatus.UNDONE
    application.undone_at = timezone.now()
    application.save(update_fields=["status", "undone_at"])

    digest = compute_template_divergence(project)

    assert digest["adopted"] is False
    assert digest["seeded_row_count"] == 0


def test_second_adoption_does_not_read_as_team_authored(
    project: Project, template: ProjectTemplate
) -> None:
    """Two applications union their row sets; the headline is the most recent.

    Counting only the latest application would report the first batch's rows under
    ``added`` — telling a team they typed forty rows a machine wrote.
    """
    _adopt(template, project)
    second = ProjectTemplate.objects.create(
        name="Compliance overlay",
        version=1,
        source_kind=TemplateSource.WORKSPACE,
        structure=_structure("Audit prep", "Sign-off"),
        carries=["structure"],
    )
    _adopt(second, project)

    digest = compute_template_divergence(project)

    assert digest["application_count"] == 2
    assert digest["template_name"] == "Compliance overlay"
    assert digest["seeded_row_count"] == 6
    assert digest["unchanged"] == 6
    assert digest["added"] == 0


def test_seeding_stamps_the_provenance_the_digest_reads(
    project: Project, template: ProjectTemplate
) -> None:
    """Guards the coupling: the digest is only correct because apply writes these columns."""
    application = _adopt(template, project)
    rows = Task.objects.filter(pk__in=application.created_task_ids)

    assert rows.count() == 4
    for row in rows:
        assert row.source_kind == TaskSource.TEMPLATE
        assert row.seeded_at is not None
        assert row.edited_at is None
        assert row.source_version == "3"


def test_digest_reports_who_adopted_and_when(project: Project, template: ProjectTemplate) -> None:
    user = User.objects.create_user(username="lead", password="pw")
    application = _adopt(template, project, applied_by=user)

    digest = compute_template_divergence(project)

    assert digest["applied_by_name"] == "lead"
    assert digest["applied_at"] is not None
    assert digest["application"] == str(application.pk)


def test_deleted_adopter_leaves_the_name_blank_not_fabricated(
    project: Project, template: ProjectTemplate
) -> None:
    user = User.objects.create_user(username="departed", password="pw")
    _adopt(template, project, applied_by=user)
    user.delete()

    assert compute_template_divergence(project)["applied_by_name"] == ""


def test_endpoint_body_matches_the_service(project: Project, template: ProjectTemplate) -> None:
    """The declared serializer keys are the keys the endpoint actually ships (api-docs)."""
    _adopt(template, project)
    client = _client_for(project, Role.MEMBER, "shape")

    body = client.get(_url(project)).json()

    assert set(body) == set(compute_template_divergence(project))
