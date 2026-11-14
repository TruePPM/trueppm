"""The ``capacity`` signal is governed by ADR-0104 like pulse and flow_metrics (#2854).

``GET /sprints/{id}/capacity/`` served every assigned member's name plus committed and
available hours to any Viewer. It now resolves the per-member breakdown through the
signal-privacy gate; aggregate totals stay visible (suppress, don't 403).
"""

from __future__ import annotations

import ast
import inspect
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects import serializers as projects_serializers
from trueppm_api.apps.projects import signal_privacy_services as svc
from trueppm_api.apps.projects.models import (
    SIGNAL_DEFAULTS,
    Calendar,
    Project,
    SignalAudience,
    Sprint,
    SprintState,
    Task,
)
from trueppm_api.apps.resources.models import Resource, TaskResource

User = get_user_model()
pytestmark = pytest.mark.django_db


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Std", working_days=31, hours_per_day=8.0)
    return Project.objects.create(name="Cap", start_date=date(2026, 3, 2), calendar=cal)


@pytest.fixture
def sprint(project: Project) -> Sprint:
    sp = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 3, 2),
        finish_date=date(2026, 3, 13),
        state=SprintState.ACTIVE,
    )
    task = Task.objects.create(project=project, name="T", duration=5, sprint=sp, sprint_id=sp.pk)
    res = Resource.objects.create(name="Dana Private", max_units=Decimal("1.0"))
    TaskResource.objects.create(task=task, resource=res, units=Decimal("1.0"))
    return sp


def _client(project: Project, username: str, role: int) -> APIClient:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(sp: Sprint) -> str:
    return f"/api/v1/sprints/{sp.pk}/capacity/"


def test_capacity_default_is_strict_team_posture() -> None:
    assert SIGNAL_DEFAULTS["capacity"] == {
        "audience": SignalAudience.TEAM,
        "ceiling": SignalAudience.TEAM,
    }
    assert "capacity" in svc.SIGNAL_KEYS


@pytest.mark.parametrize("role", [Role.VIEWER, Role.MEMBER])
def test_team_band_reads_per_person_breakdown(project: Project, sprint: Sprint, role: int) -> None:
    resp = _client(project, f"t{role}", role).get(_url(sprint))
    assert resp.status_code == 200
    assert resp.data["capacity_suppressed"] is False
    assert [m["member_name"] for m in resp.data["members"]] == ["Dana Private"]


def test_pm_band_gets_aggregate_only_at_default(project: Project, sprint: Sprint) -> None:
    resp = _client(project, "pm", Role.ADMIN).get(_url(sprint))
    assert resp.status_code == 200
    assert resp.data["capacity_suppressed"] is True
    assert resp.data["members"] == []
    assert resp.data["totals"]["committed_hours"] > 0
    assert "Dana Private" not in resp.content.decode()


def test_pm_band_reads_after_team_raises_ceiling_and_audience(
    project: Project, sprint: Sprint
) -> None:
    policy = svc.get_or_create_policy(project)
    svc.raise_signal_ceiling(policy, "capacity", SignalAudience.TEAM_SM_PM)
    svc.set_signal_audience(policy, "capacity", SignalAudience.TEAM_SM_PM)
    resp = _client(project, "pm", Role.ADMIN).get(_url(sprint))
    assert resp.data["capacity_suppressed"] is False
    assert len(resp.data["members"]) == 1


def test_audience_cannot_exceed_ceiling_for_capacity(project: Project) -> None:
    policy = svc.get_or_create_policy(project)
    with pytest.raises(Exception) as exc:  # DRF ValidationError (400)
        svc.set_signal_audience(policy, "capacity", SignalAudience.TEAM_SM_PM)
    assert "ceiling" in str(exc.value).lower()


def test_non_member_is_denied(project: Project, sprint: Sprint) -> None:
    other = User.objects.create_user(username="stranger", password="pw")
    c = APIClient()
    c.force_authenticate(user=other)
    assert c.get(_url(sprint)).status_code == 404


def test_ratchet_down_covers_capacity(project: Project, sprint: Sprint) -> None:
    """Lowering the ceiling and the SM panic button both re-suppress the PM band."""
    policy = svc.get_or_create_policy(project)
    svc.raise_signal_ceiling(policy, "capacity", SignalAudience.TEAM_SM_PM)
    svc.set_signal_audience(policy, "capacity", SignalAudience.TEAM_SM_PM)
    pm = _client(project, "pm", Role.ADMIN)
    assert pm.get(_url(sprint)).data["capacity_suppressed"] is False

    # Ceiling ratcheted back to TEAM: the audience clamps down with it.
    svc.raise_signal_ceiling(policy, "capacity", SignalAudience.TEAM)
    policy.refresh_from_db()
    assert policy.ceiling_of("capacity") == SignalAudience.TEAM
    assert policy.audience_of("capacity") == SignalAudience.TEAM
    resp = pm.get(_url(sprint))
    assert resp.data["capacity_suppressed"] is True
    assert resp.data["members"] == []

    # Re-share, then the all-signals ratchet to TEAM suppresses it again.
    svc.raise_signal_ceiling(policy, "capacity", SignalAudience.TEAM_SM_PM)
    svc.set_signal_audience(policy, "capacity", SignalAudience.TEAM_SM_PM)
    assert pm.get(_url(sprint)).data["capacity_suppressed"] is False
    svc.ratchet_down_to_team(policy)
    policy.refresh_from_db()
    assert policy.audience_of("capacity") == SignalAudience.TEAM
    assert pm.get(_url(sprint)).data["capacity_suppressed"] is True


# --- activate: the over-capacity warnings carry the same per-person data ------------


@pytest.fixture
def planned_over_capacity_sprint(project: Project) -> Sprint:
    """A PLANNED sprint whose one member is committed well past their available hours."""
    sp = Sprint.objects.create(
        project=project,
        name="S2",
        start_date=date(2026, 3, 2),
        finish_date=date(2026, 3, 6),
        state=SprintState.PLANNED,
    )
    res = Resource.objects.create(name="Dana Private", max_units=Decimal("1.0"))
    for i in range(3):
        task = Task.objects.create(
            project=project, name=f"T{i}", duration=5, sprint=sp, sprint_id=sp.pk
        )
        TaskResource.objects.create(task=task, resource=res, units=Decimal("1.0"))
    return sp


def _activate(client: APIClient, sp: Sprint) -> dict:
    resp = client.post(f"/api/v1/sprints/{sp.pk}/activate/")
    assert resp.status_code == 200, resp.content
    return resp.json()


def test_pm_band_activate_warnings_carry_no_names_or_hours(
    project: Project, planned_over_capacity_sprint: Sprint
) -> None:
    body = _activate(_client(project, "pm", Role.ADMIN), planned_over_capacity_sprint)
    assert body["warnings"] == [{"type": "over_capacity", "detail_suppressed": True}]
    raw = str(body["warnings"])
    for leaked in ("Dana Private", "member_id", "member_name", "committed_hours"):
        assert leaked not in raw


def test_team_band_activate_warnings_keep_member_detail(
    project: Project, planned_over_capacity_sprint: Sprint
) -> None:
    body = _activate(_client(project, "sched", Role.SCHEDULER), planned_over_capacity_sprint)
    assert len(body["warnings"]) == 1
    warning = body["warnings"][0]
    assert warning["member_name"] == "Dana Private"
    assert warning["committed_hours"] > warning["available_hours"]
    assert "detail_suppressed" not in warning


def test_pm_band_activate_reads_detail_once_shared(
    project: Project, planned_over_capacity_sprint: Sprint
) -> None:
    policy = svc.get_or_create_policy(project)
    svc.raise_signal_ceiling(policy, "capacity", SignalAudience.TEAM_SM_PM)
    svc.set_signal_audience(policy, "capacity", SignalAudience.TEAM_SM_PM)
    body = _activate(_client(project, "pm", Role.ADMIN), planned_over_capacity_sprint)
    assert body["warnings"][0]["member_name"] == "Dana Private"


# --- completeness: a per-person metric cannot ship ungated ------------------------

_PER_PERSON_FIELDS = {"member_id", "member_name"}


def _declared_field_names(cls: type) -> set[str]:
    return set(getattr(cls, "_declared_fields", {}))


def test_every_per_person_serializer_is_registered_to_a_governed_signal() -> None:
    """A serializer declaring ``member_id``/``member_name`` carries a per-person metric.

    It must be listed in ``PER_PERSON_METRIC_SERIALIZERS`` against a signal that is in
    ``SIGNAL_DEFAULTS`` — so adding a sixth per-person surface fails here until its
    author registers it (and therefore decides its privacy posture). The registry is
    checked both ways so it cannot rot into a list of nonexistent classes.
    """
    found = {
        name
        for name, cls in inspect.getmembers(projects_serializers, inspect.isclass)
        if cls.__module__ == projects_serializers.__name__
        and _declared_field_names(cls) & _PER_PERSON_FIELDS
    }
    registered = set(svc.PER_PERSON_METRIC_SERIALIZERS)
    assert found == registered, (
        f"per-person serializers not registered: {found - registered}; "
        f"registered but absent/not per-person: {registered - found}"
    )
    for signal_key in svc.PER_PERSON_METRIC_SERIALIZERS.values():
        assert signal_key in SIGNAL_DEFAULTS


def test_registered_signal_is_enforced_in_a_read_path() -> None:
    """Each registered signal key must appear in a ``can_read_signal`` call in the source.

    Its limit: this proves the key is read through the gate *somewhere* in
    ``views``/``services``/``signal_privacy_services``, not that every endpoint which
    serializes the registered class does so. The per-endpoint proof is the request
    tests above (``/capacity/`` and ``activate``).
    """
    import trueppm_api.apps.projects as pkg

    root = inspect.getfile(pkg).rsplit("/", 1)[0]
    mods = ("views", "signal_privacy_services", "services")
    text = "".join(Path(f"{root}/{mod}.py").read_text() for mod in mods)
    tree = ast.parse(text)
    gated: set[str] = set()
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and getattr(node.func, "id", getattr(node.func, "attr", "")) == "can_read_signal"
            and node.args
            and isinstance(node.args[-1], ast.Constant)
        ):
            gated.add(node.args[-1].value)
    for signal_key in set(svc.PER_PERSON_METRIC_SERIALIZERS.values()):
        assert signal_key in gated
