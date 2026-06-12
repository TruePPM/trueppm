"""Sprint-close bridge digest — notify the PM cohort on a material forecast shift (#861).

When a closed sprint's reforecast materially moves a bound milestone's finish, the
project's PM cohort (role >= ADMIN) is pushed a schedule-language digest. The
digest carries dates + a confidence *label* only — never velocity points — and
uses velocity-band language (not P50/P80) because the reforecast basis is
``velocity_band`` (web-rule 166). No-op recomputes produce no notification.

These exercise ``notify_milestone_forecast_shift`` directly against real
ForecastSnapshot rows; the close-drain wiring is covered in test_sprint_close_drain.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import Notification, NotificationEventType
from trueppm_api.apps.projects.models import (
    Calendar,
    ForecastBasis,
    ForecastConfidence,
    ForecastSnapshot,
    Project,
    Sprint,
    SprintState,
    Task,
)
from trueppm_api.apps.projects.services import notify_milestone_forecast_shift

User = get_user_model()


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="FcProject", start_date=date(2026, 3, 1), calendar=cal)


@pytest.fixture
def people(project: Project) -> dict[str, Any]:
    admin = User.objects.create_user(username="fc_admin", password="pw")
    owner = User.objects.create_user(username="fc_owner", password="pw")
    member = User.objects.create_user(username="fc_member", password="pw")
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    return {"admin": admin, "owner": owner, "member": member}


@pytest.fixture
def milestone(project: Project) -> Task:
    return Task.objects.create(project=project, name="GA Launch", duration=0, is_milestone=True)


@pytest.fixture
def sprint(project: Project, milestone: Task) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="Sprint 4",
        start_date=date(2026, 6, 1),
        finish_date=date(2026, 6, 14),
        state=SprintState.ACTIVE,
        target_milestone=milestone,
    )


def _snap(project: Project, milestone: Task, **kw: Any) -> ForecastSnapshot:
    defaults: dict[str, Any] = dict(
        project=project,
        milestone=milestone,
        basis=ForecastBasis.VELOCITY_BAND,
        cpm_finish=date(2026, 8, 1),
        p50=date(2026, 8, 1),
        p80=date(2026, 8, 15),
        confidence=ForecastConfidence.MEDIUM,
        unmodeled_dependency=False,
    )
    defaults.update(kw)
    return ForecastSnapshot.objects.create(**defaults)


@pytest.mark.django_db
def test_material_shift_notifies_pm_cohort_dates_only(
    project: Project,
    people: dict[str, Any],
    milestone: Task,
    sprint: Sprint,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    _snap(project, milestone, p50=date(2026, 7, 20))  # prior
    new = _snap(project, milestone, p50=date(2026, 8, 1))  # the reforecast result

    with django_capture_on_commit_callbacks(execute=True):
        notify_milestone_forecast_shift(new, sprint, actor_id=None)

    # PM cohort (ADMIN + OWNER) notified; plain member is not.
    assert (
        Notification.objects.filter(
            recipient=people["admin"],
            event_type=NotificationEventType.MILESTONE_FORECAST_SHIFTED,
        ).count()
        == 1
    )
    assert (
        Notification.objects.filter(
            recipient=people["owner"],
            event_type=NotificationEventType.MILESTONE_FORECAST_SHIFTED,
        ).count()
        == 1
    )
    assert not Notification.objects.filter(recipient=people["member"]).exists()

    note = Notification.objects.filter(recipient=people["admin"]).first()
    assert note is not None
    body = note.body
    # Dates + velocity-band language; deep-links to the milestone.
    assert "2026-08-01" in body
    assert "likely finish" in body
    assert "medium confidence" in body
    assert "Velocity-based estimate" in body
    assert str(note.task_id) == str(milestone.pk)
    # Privacy: never percentile vocab (basis is velocity_band, rule 166) nor points.
    assert "P50" not in body and "P80" not in body
    assert "point" not in body.lower()


@pytest.mark.django_db
def test_no_op_recompute_does_not_notify(
    project: Project,
    people: dict[str, Any],
    milestone: Task,
    sprint: Sprint,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    _snap(project, milestone)  # prior
    new = _snap(project, milestone)  # identical p50/p80/cpm_finish/confidence

    with django_capture_on_commit_callbacks(execute=True):
        notify_milestone_forecast_shift(new, sprint, actor_id=None)

    assert not Notification.objects.exists()


@pytest.mark.django_db
def test_first_forecast_is_material(
    project: Project,
    people: dict[str, Any],
    milestone: Task,
    sprint: Sprint,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    new = _snap(project, milestone)  # no prior snapshot exists

    with django_capture_on_commit_callbacks(execute=True):
        notify_milestone_forecast_shift(new, sprint, actor_id=None)

    assert Notification.objects.filter(recipient=people["admin"]).count() == 1


@pytest.mark.django_db
def test_actor_excluded_from_digest(
    project: Project,
    people: dict[str, Any],
    milestone: Task,
    sprint: Sprint,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    new = _snap(project, milestone)

    # The owner closed the sprint — they already know, so they are excluded even
    # though their role is in the PM cohort.
    with django_capture_on_commit_callbacks(execute=True):
        notify_milestone_forecast_shift(new, sprint, actor_id=people["owner"].pk)

    assert not Notification.objects.filter(recipient=people["owner"]).exists()
    assert Notification.objects.filter(recipient=people["admin"]).count() == 1


@pytest.mark.django_db
def test_soft_removed_pm_not_notified(
    project: Project,
    people: dict[str, Any],
    milestone: Task,
    sprint: Sprint,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    new = _snap(project, milestone)
    # The admin was removed from the project. Removal is a soft delete that leaves
    # the membership row (with its role) intact, so the digest must not reach them.
    ProjectMembership.objects.filter(project=project, user=people["admin"]).update(is_deleted=True)
    with django_capture_on_commit_callbacks(execute=True):
        notify_milestone_forecast_shift(new, sprint, actor_id=None)

    assert not Notification.objects.filter(recipient=people["admin"]).exists()
    assert Notification.objects.filter(recipient=people["owner"]).count() == 1
