"""GET /api/v1/projects/<pk>/schedule/bug-report-export/ (#4689).

Redaction is a trust boundary: the file is meant for a public issue, so the tests
assert that no project/task name, description, note, assignee or attachment string
survives anywhere in the response body.
"""

from __future__ import annotations

import json
from datetime import date
from typing import Any
from unittest import mock

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient
from trueppm_scheduler import Project as SchedProject
from trueppm_scheduler import SchedulerError

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.scheduling.bug_report import redact_engine_input
from trueppm_api.apps.scheduling.selfcheck import ALL_CHECKS, engine_version

User = get_user_model()

SECRETS = (
    "Project Nightingale",
    "Acquire Initech quietly",
    "Board must not learn of this",
    "Call legal before Friday",
    "jsmith-secret",
    "jsmith@initech.example",
    "Draft merger terms",
    "Confidential calendar",
)


@pytest.fixture(autouse=True)
def clear_cache() -> Any:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(
        name="Project Nightingale",
        start_date=date(2026, 3, 2),
        status_date=date(2026, 3, 2),
        calendar=Calendar.objects.create(name="Confidential calendar"),
    )


@pytest.fixture
def tasks(project: Project) -> list[Task]:
    assignee = User.objects.create_user(
        username="jsmith-secret", email="jsmith@initech.example", password="pw"
    )
    a = Task.objects.create(
        project=project,
        name="Acquire Initech quietly",
        notes="Call legal before Friday. Board must not learn of this",
        assignee=assignee,
        duration=3,
        optimistic_duration=2,
        most_likely_duration=3,
        pessimistic_duration=8,
    )
    b = Task.objects.create(project=project, name="Draft merger terms", duration=2)
    Dependency.objects.create(predecessor=a, successor=b, dep_type="FS", lag=0)
    return [a, b]


def _client(project: Project, role: str | None) -> APIClient:
    user = User.objects.create_user(username=f"u-{role}", password="pw")
    if role is not None:
        ProjectMembership.objects.create(project=project, user=user, role=role)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/schedule/bug-report-export/"


@pytest.mark.django_db
class TestExport:
    def test_scheduler_gets_redacted_engine_input_and_verdict(
        self, project: Project, tasks: list[Task]
    ) -> None:
        resp = _client(project, Role.SCHEDULER).get(url(project.pk))
        assert resp.status_code == 200, resp.content
        assert "attachment" in resp["Content-Disposition"]
        body = resp.json()
        assert body["format_version"] == 1
        assert body["engine_version"] == engine_version()
        verdict = body["verdict"]
        assert verdict["checks"] == dict.fromkeys(ALL_CHECKS, "pass")
        assert verdict["violations"] == []
        assert verdict["task_count"] == 2

        doc = body["engine_input"]
        assert doc["name"] == "redacted"
        assert sorted(t["name"] for t in doc["tasks"]) == ["task-1", "task-2"]
        # Ids stay, so a reporter can still point at "this task".
        assert {t["id"] for t in doc["tasks"]} == {str(t.pk) for t in tasks}
        # The schedule-shaping inputs survive redaction.
        three_point = next(t for t in doc["tasks"] if t["id"] == str(tasks[0].pk))
        assert three_point["pessimistic_duration"] is not None

    def test_no_sensitive_string_survives(self, project: Project, tasks: list[Task]) -> None:
        raw = _client(project, Role.OWNER).get(url(project.pk)).content.decode()
        for secret in SECRETS:
            assert secret not in raw, secret
        assert "jsmith" not in raw

    def test_the_export_loads_back_into_the_engine(
        self, project: Project, tasks: list[Task]
    ) -> None:
        from trueppm_scheduler import schedule

        body = _client(project, Role.SCHEDULER).get(url(project.pk)).json()
        loaded = SchedProject.from_json(json.dumps(body["engine_input"]))
        assert len(schedule(loaded).tasks) == 2

    @pytest.mark.parametrize("role", [None, Role.VIEWER, Role.MEMBER])
    def test_below_scheduler_is_refused(
        self, project: Project, tasks: list[Task], role: str | None
    ) -> None:
        resp = _client(project, role).get(url(project.pk))
        assert resp.status_code in (403, 404)

    def test_anonymous_is_refused(self, project: Project) -> None:
        assert APIClient().get(url(project.pk)).status_code in (401, 403)

    def test_trashed_project_is_404(self, project: Project, tasks: list[Task]) -> None:
        client = _client(project, Role.OWNER)
        project.is_deleted = True
        project.save(update_fields=["is_deleted"])
        assert client.get(url(project.pk)).status_code == 404

    def test_no_free_cpm_slot_is_503(self, project: Project, tasks: list[Task]) -> None:
        client = _client(project, Role.SCHEDULER)
        busy = mock.MagicMock()
        busy.return_value.__enter__.return_value = False
        # The view imports cpm_slot at call time, so the source module is the lookup.
        with mock.patch("trueppm_api.apps.scheduling.cpm_admission.cpm_slot", busy):
            resp = client.get(url(project.pk))
        assert resp.status_code == 503, resp.content
        assert resp.json()["code"] == "schedule_busy"

    def test_invalid_schedule_input_is_400(self, project: Project, tasks: list[Task]) -> None:
        client = _client(project, Role.SCHEDULER)
        with mock.patch(
            "trueppm_api.apps.scheduling.views._build_cpm_sched_inputs",
            side_effect=SchedulerError("bad input"),
        ):
            resp = client.get(url(project.pk))
        assert resp.status_code == 400, resp.content

    def test_archived_project_stays_exportable(self, project: Project, tasks: list[Task]) -> None:
        client = _client(project, Role.SCHEDULER)
        project.is_archived = True
        project.save(update_fields=["is_archived"])
        resp = client.get(url(project.pk))
        assert resp.status_code == 200, resp.content
        assert resp.json()["engine_input"]["tasks"]

    def test_above_the_envelope_skips_the_checks(
        self, project: Project, tasks: list[Task], settings: Any
    ) -> None:
        settings.SCHEDULER_SELFCHECK_MAX_TASKS = 1
        body = _client(project, Role.SCHEDULER).get(url(project.pk)).json()
        assert body["verdict"]["skipped_reason"] == "above_envelope"
        assert body["engine_input"]["tasks"]


def test_redaction_blanks_unknown_person_and_text_keys() -> None:
    doc = {
        "id": "p",
        "name": "Secret",
        "tasks": [{"id": "t", "name": "Secret task", "description": "x", "owners": ["bob"]}],
        "calendar": {"label": "Secret cal", "working_days": 31},
    }
    out = redact_engine_input(doc)
    assert out["name"] == "redacted"
    assert out["tasks"][0] == {"id": "t", "name": "task-1", "description": "", "owners": []}
    assert out["calendar"] == {"label": "", "working_days": 31}
    assert "Secret" not in json.dumps(out)
