"""Driving-link write-back (#2095).

The recompute task marks each dependency whose relationship free float is zero —
the predecessor that actually controls the successor's early date — with
``is_driving=True`` so the schedule view can weight driving links above slack
ones. A merge point is the discriminating case: of two predecessors into one
successor, only the later-finishing one drives.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest

from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.projects.serializers import DependencySerializer
from trueppm_api.apps.scheduling.tasks import _run_schedule


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="StdDriving")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="DrivingProj",
        start_date=date(2026, 1, 5),  # Monday
        calendar=calendar,
    )


def _recompute(project: Project) -> None:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))


@pytest.mark.django_db
def test_merge_point_marks_only_the_constraining_predecessor_driving(project: Project) -> None:
    # A(5) → C and B(3) → C. A finishes later, so A→C drives C's start; B→C slacks.
    a = Task.objects.create(project=project, name="A", duration=5)
    b = Task.objects.create(project=project, name="B", duration=3)
    c = Task.objects.create(project=project, name="C", duration=2)
    ac = Dependency.objects.create(predecessor=a, successor=c, dep_type="FS")
    bc = Dependency.objects.create(predecessor=b, successor=c, dep_type="FS")

    _recompute(project)

    ac.refresh_from_db()
    bc.refresh_from_db()
    assert ac.is_driving is True, "A→C should drive C (it pins C's early start)"
    assert bc.is_driving is False, "B→C has slack — not driving"


@pytest.mark.django_db
def test_linear_chain_every_edge_is_driving(project: Project) -> None:
    a = Task.objects.create(project=project, name="A", duration=2)
    b = Task.objects.create(project=project, name="B", duration=2)
    ab = Dependency.objects.create(predecessor=a, successor=b, dep_type="FS")

    _recompute(project)

    ab.refresh_from_db()
    assert ab.is_driving is True


@pytest.mark.django_db
def test_driving_flag_flips_when_the_constraint_moves(project: Project) -> None:
    # Initially B(3) is the shorter arm; grow it past A(5) and the driving edge
    # must switch from A→C to B→C on the next recompute.
    a = Task.objects.create(project=project, name="A", duration=5)
    b = Task.objects.create(project=project, name="B", duration=3)
    c = Task.objects.create(project=project, name="C", duration=2)
    ac = Dependency.objects.create(predecessor=a, successor=c, dep_type="FS")
    bc = Dependency.objects.create(predecessor=b, successor=c, dep_type="FS")

    _recompute(project)
    ac.refresh_from_db()
    bc.refresh_from_db()
    assert ac.is_driving is True
    assert bc.is_driving is False

    Task.objects.filter(pk=b.pk).update(duration=9)
    _recompute(project)
    ac.refresh_from_db()
    bc.refresh_from_db()
    assert bc.is_driving is True, "B now finishes last — it drives C"
    assert ac.is_driving is False


@pytest.mark.django_db
def test_serializer_exposes_is_driving_read_only(project: Project) -> None:
    a = Task.objects.create(project=project, name="A", duration=2)
    b = Task.objects.create(project=project, name="B", duration=2)
    dep = Dependency.objects.create(predecessor=a, successor=b, dep_type="FS", is_driving=True)

    data = DependencySerializer(dep).data
    assert data["is_driving"] is True

    # Read-only: a client cannot set is_driving through the serializer.
    ser = DependencySerializer(
        dep, data={"predecessor": str(a.pk), "successor": str(b.pk), "is_driving": False}
    )
    assert ser.is_valid(), ser.errors
    assert "is_driving" not in ser.validated_data
