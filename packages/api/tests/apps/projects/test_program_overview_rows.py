"""The program overview rows and lead figure on ``GET /programs/{id}/rollup/`` (#4799).

Pins:

- ``kpis.p80_completion`` and the always-present ``forecast`` name WHICH projects have
  no forecast (``projects_without_forecast_ids``), so the partial-rollup line can name
  the project the program P80 leaves out;
- ``projects`` carries one row per contributing project with its own forecast, the
  P80 delta against its commitment, and the PM's latest posted status update, sorted
  by slip;
- program roles do not cascade: a project the caller is not a member of keeps only its
  id and name, and its status update narrative is never served;
- the row reads the newest of many updates (one DISTINCT ON query, not one per update).
"""

from __future__ import annotations

import datetime
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.projects import status_update_services
from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    Calendar,
    Methodology,
    Program,
    Project,
    RollupKpi,
    Task,
)
from trueppm_api.apps.scheduling.models import MonteCarloRun

User = get_user_model()


@pytest.fixture(autouse=True)
def _clear_cache() -> Any:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def pm(db: object) -> Any:
    return User.objects.create_user(username="pm", password="pw", first_name="Pat", last_name="M")


@pytest.fixture
def outsider(db: object) -> Any:
    return User.objects.create_user(username="outsider", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def program(pm: Any, outsider: Any) -> Program:
    program = create_program(
        name="Phase 2", description="", methodology=Methodology.HYBRID, created_by=pm
    )
    ProgramMembership.objects.create(program=program, user=outsider, role=Role.MEMBER)
    program.rollup_enabled_kpis = [RollupKpi.P80_COMPLETION.value]
    program.save(update_fields=["rollup_enabled_kpis"])
    return program


def _project(program: Program, calendar: Calendar, name: str, pm: Any) -> Project:
    project = Project.objects.create(
        name=name,
        start_date=datetime.date(2026, 1, 1),
        calendar=calendar,
        program=program,
        lead=pm,
    )
    ProjectMembership.objects.create(project=project, user=pm, role=Role.ADMIN)
    return project


def _baseline(project: Project, finish: datetime.date) -> None:
    task = Task.objects.create(project=project, name="end", duration=1, early_finish=finish)
    baseline = Baseline.objects.create(
        project=project, name="B", is_active=True, has_cpm_dates=True
    )
    BaselineTask.objects.create(
        baseline=baseline, task_id=task.pk, task_name="end", finish=finish, duration=1
    )


def _run(project: Project, p50: datetime.date, p80: datetime.date) -> None:
    MonteCarloRun.objects.create(project=project, n_simulations=100, p50=p50, p80=p80)


def _get(user: Any, program: Program) -> dict[str, Any]:
    client = APIClient()
    client.force_authenticate(user=user)
    resp = client.get(f"/api/v1/programs/{program.pk}/rollup/")
    assert resp.status_code == 200
    data: dict[str, Any] = resp.json()
    return data


@pytest.mark.django_db
def test_missing_forecast_is_named_by_id(pm: Any, program: Program, calendar: Calendar) -> None:
    with_run = _project(program, calendar, "Alpha", pm)
    without = _project(program, calendar, "Bravo", pm)
    _run(with_run, datetime.date(2027, 1, 10), datetime.date(2027, 1, 20))

    data = _get(pm, program)

    kpi = data["kpis"]["p80_completion"]
    assert kpi["projects_without_forecast"] == 1
    assert kpi["projects_without_forecast_ids"] == [str(without.pk)]
    assert data["forecast"]["projects_without_forecast_ids"] == [str(without.pk)]
    assert data["forecast"]["value"] == "2027-01-20"


@pytest.mark.django_db
def test_rows_carry_forecast_delta_and_latest_update_sorted_by_slip(
    pm: Any, program: Program, calendar: Calendar
) -> None:
    late = _project(program, calendar, "Late", pm)
    early = _project(program, calendar, "Early", pm)
    bare = _project(program, calendar, "Bare", pm)
    _baseline(late, datetime.date(2027, 1, 4))
    _baseline(early, datetime.date(2027, 3, 1))
    _run(late, datetime.date(2027, 1, 10), datetime.date(2027, 1, 20))
    _run(early, datetime.date(2027, 1, 10), datetime.date(2027, 1, 20))
    status_update_services.post_status_update(late, pm, rag="amber", narrative="old call")
    status_update_services.post_status_update(
        late, pm, rag="red", narrative="Vendor slipped two weeks\nDetails follow."
    )

    rows = _get(pm, program)["projects"]

    assert [r["name"] for r in rows] == ["Late", "Early", "Bare"]
    first = rows[0]
    assert first["accessible"] is True
    assert first["p50"] == "2027-01-10"
    assert first["p80"] == "2027-01-20"
    assert first["commitment_date"] == "2027-01-04"
    assert first["p80_delta_vs_commitment_days"] > 0
    assert first["lead_name"]
    update = first["latest_update"]
    assert update["seq"] == 2
    assert update["rag"] == "red"
    assert update["first_line"] == "Vendor slipped two weeks"
    assert update["computed_health"] in {"on_track", "at_risk", "critical"}
    assert rows[1]["p80_delta_vs_commitment_days"] < 0
    assert rows[1]["latest_update"] is None
    assert rows[2]["p80"] is None
    assert rows[2]["p80_delta_vs_commitment_reason"] == "no_commitment"
    assert str(bare.pk) == rows[2]["id"]


@pytest.mark.django_db
def test_rows_for_projects_the_caller_cannot_read_carry_only_the_name(
    pm: Any, outsider: Any, program: Program, calendar: Calendar
) -> None:
    project = _project(program, calendar, "Secret", pm)
    _run(project, datetime.date(2027, 1, 10), datetime.date(2027, 1, 20))
    status_update_services.post_status_update(project, pm, rag="red", narrative="Do not leak")

    rows = _get(outsider, program)["projects"]

    assert rows == [
        {
            "id": str(project.pk),
            "name": "Secret",
            "accessible": False,
            "schedule_health": None,
            "p50": None,
            "p80": None,
            "forecast_as_of": None,
            "commitment_date": None,
            "p80_delta_vs_commitment_days": None,
            "p80_delta_vs_commitment_reason": None,
            "lead_name": None,
            "latest_update": None,
        }
    ]


@pytest.mark.django_db
def test_latest_update_is_the_newest_of_many(pm: Any, program: Program, calendar: Calendar) -> None:
    project = _project(program, calendar, "Busy", pm)
    for n in range(5):
        status_update_services.post_status_update(project, pm, rag="green", narrative=f"n{n}")
    rows = _get(pm, program)["projects"]
    assert rows[0]["latest_update"]["seq"] == 5


@pytest.mark.django_db
def test_empty_program_has_no_rows(pm: Any, program: Program) -> None:
    data = _get(pm, program)
    assert data["projects"] == []
    assert data["forecast"]["projects_without_forecast_ids"] == []
    assert data["forecast"]["reason"] == "no_projects"
