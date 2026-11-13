"""#4854 — every reader that shows or exports ``wbs_path`` orders it numerically.

``ltree`` compares labels as text, so a level with ten or more siblings used to put
"10" and "11" ahead of "2" in the task list, the MS Project export and the public
share-link schedule. Each test seeds 12 siblings (plus a nested child) and asserts
the numeric order; the negative control proves a bare text ordering would fail it.
"""

from __future__ import annotations

import re
from datetime import date

import pytest
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.msproject.exporter import export_project_xml
from trueppm_api.apps.projects.models import Calendar, Project, ShareLink, Task
from trueppm_api.apps.projects.share_services import serialize_public_schedule

PATHS = [str(n) for n in range(1, 13)] + ["2.1", "2.10", "2.2"]
NUMERIC = ["1", "2", "2.1", "2.2", "2.10", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]


@pytest.fixture
def project(db: object) -> Project:
    project = Project.objects.create(
        name="Ordering", start_date=date(2026, 1, 1), calendar=Calendar.objects.create(name="Std")
    )
    for path in PATHS:
        task = Task.objects.create(project=project, name=f"T{path}", duration=1)
        Task.objects.filter(pk=task.pk).update(wbs_path=path)
    return project


def test_negative_control_text_order_is_wrong(project: Project) -> None:
    text_order = [
        str(p)
        for p in Task.objects.filter(project=project)
        .order_by("wbs_path")
        .values_list("wbs_path", flat=True)
    ]
    assert text_order != NUMERIC
    assert text_order.index("10") < text_order.index("2")


def test_default_model_ordering_is_numeric(project: Project) -> None:
    got = [str(p) for p in Task.objects.filter(project=project).values_list("wbs_path", flat=True)]
    assert got == NUMERIC


@pytest.mark.parametrize(("ordering", "reverse"), [("wbs_path", False), ("-wbs_path", True)])
def test_task_list_ordering_param_is_numeric(
    project: Project, ordering: str, reverse: bool
) -> None:
    from django.contrib.auth import get_user_model

    user = get_user_model().objects.create_user(username="su", password="pw", is_superuser=True)
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    client = APIClient()
    client.force_authenticate(user=user)
    res = client.get(f"/api/v1/tasks/?project={project.pk}&ordering={ordering}&page_size=50")
    assert res.status_code == 200
    got = [t["wbs_path"] for t in res.data["results"]]
    assert got == (NUMERIC[::-1] if reverse else NUMERIC)


def test_msproject_export_order_is_numeric(project: Project) -> None:
    xml = export_project_xml(str(project.pk)).decode()
    names = [n for n in re.findall(r"<Name>(T[\d.]+)</Name>", xml)]
    assert names == [f"T{p}" for p in NUMERIC]


def test_share_link_schedule_order_is_numeric(project: Project) -> None:
    link = ShareLink(project=project, show_milestone_dates=True, show_assignees=False)
    payload = serialize_public_schedule(link)
    assert [t["wbs_path"] for t in payload["tasks"]] == NUMERIC
