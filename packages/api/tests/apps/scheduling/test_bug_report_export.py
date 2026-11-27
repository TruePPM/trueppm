"""GET /api/v1/projects/<pk>/schedule/bug-report-export/ (#4689).

Redaction is a trust boundary: the file is meant for a public issue, so the tests
assert that no project/task name, description, note, assignee or attachment string,
and none of the team's velocity inputs (ADR-0104), survives anywhere in the response
body, and that the exported input still schedules to the authoritative dates.
"""

from __future__ import annotations

import json
import re
import secrets
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
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    SCOPE_MCP_READ,
    ApiToken,
    Calendar,
    DeliveryMode,
    Dependency,
    Project,
    Sprint,
    SprintState,
    Task,
)
from trueppm_api.apps.scheduling import bug_report
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

    @pytest.mark.parametrize("kind", ["mcp_read", "project"])
    def test_api_tokens_get_401(self, project: Project, tasks: list[Task], kind: str) -> None:
        owner = User.objects.create_user(username="token-owner", password="pw")
        ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
        raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
        scope: dict[str, Any] = (
            {"owner": owner, "scopes": [SCOPE_MCP_READ]}
            if kind == "mcp_read"
            else {"project": project}
        )
        ApiToken.objects.create(
            name="t",
            token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
            token_hash=sha256_hex(raw),
            created_by=owner,
            **scope,
        )
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
        assert client.get(url(project.pk)).status_code == 401

    def test_calendar_hours_and_timezone_are_constants(
        self, project: Project, tasks: list[Task]
    ) -> None:
        from trueppm_scheduler import schedule

        from trueppm_api.apps.scheduling.views import _build_cpm_sched_inputs

        calendar = project.calendar
        assert calendar is not None
        calendar.hours_per_day = 6
        calendar.timezone = "Pacific/Auckland"
        calendar.save()
        project.refresh_from_db()
        armed = _build_cpm_sched_inputs(project, str(project.pk))[0]
        assert armed.calendar.timezone == "Pacific/Auckland"

        doc = _client(project, Role.SCHEDULER).get(url(project.pk)).json()["engine_input"]
        assert doc["calendar"]["hours_per_day"] == 8.0
        assert doc["calendar"]["timezone"] == "UTC"
        reproduced = schedule(SchedProject.from_json(json.dumps(doc)))
        dates = lambda r: {t.id: (t.early_start, t.early_finish) for t in r.tasks}  # noqa: E731
        assert dates(reproduced) == dates(schedule(armed))

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


def test_redaction_drops_unclassified_keys() -> None:
    doc = {
        "id": "p",
        "name": "Secret",
        "tasks": [{"id": "t", "name": "Secret task", "description": "x", "owners": ["bob"]}],
        "calendar": {"label": "Secret cal", "working_days": 31},
        "team_mood": [3, 4],
    }
    out = redact_engine_input(doc)
    assert out == {
        "id": "p",
        "name": "redacted",
        "tasks": [{"id": "t", "name": "task-1"}],
        "calendar": {"working_days": 31},
    }


def _keys(fields: Any) -> set[str]:
    return set(fields)


def test_every_engine_key_is_classified() -> None:
    """Fails when ``to_dict()`` grows a key the export tables do not classify.

    Each engine object is built with every optional field set, so its ``to_dict()``
    emits every key it can. An unclassified key is dropped from the export (fail
    closed), but it must be classified on purpose: add it to the table in
    ``bug_report.py`` as KEEP, LABEL or NULL after checking it against ADR-0104.
    """
    from datetime import timedelta

    from trueppm_scheduler import Calendar as SchedCalendar
    from trueppm_scheduler import DateRange
    from trueppm_scheduler import Dependency as SchedDependency
    from trueppm_scheduler import Task as SchedTask
    from trueppm_scheduler.models import DeliveryMode

    day = timedelta(days=1)
    task = SchedTask(
        id="t",
        name="t",
        duration=3 * day,
        planned_start=date(2026, 3, 2),
        planned_finish=date(2026, 3, 4),
        percent_complete=10.0,
        actual_start=date(2026, 3, 2),
        optimistic_duration=2 * day,
        most_likely_duration=3 * day,
        pessimistic_duration=5 * day,
        delivery_mode=DeliveryMode.SCRUM,
        story_points=5.0,
        calendar_id="c",
        live_day_end_on=date(2026, 3, 2),
        zero_remaining=True,
    )
    cal = SchedCalendar(exceptions=(DateRange(date(2026, 3, 9), date(2026, 3, 9)),))
    project = SchedProject(
        id="p",
        name="p",
        start_date=date(2026, 3, 2),
        tasks=[task, SchedTask(id="u", name="u", duration=day)],
        dependencies=[SchedDependency(predecessor_id="t", successor_id="u")],
        calendar=cal,
        velocity_samples=[1.0],
        sprint_length_days=10,
        status_date=date(2026, 3, 2),
        calendars={"c": cal},
    )
    doc = project.to_dict()
    assert set(doc) == _keys(bug_report.PROJECT_FIELDS)
    assert set(doc["tasks"][0]) == _keys(bug_report.TASK_FIELDS)
    assert set(doc["dependencies"][0]) == _keys(bug_report.DEPENDENCY_FIELDS)
    assert set(doc["calendar"]) == _keys(bug_report.CALENDAR_FIELDS)
    assert set(doc["calendars"]["c"]) == _keys(bug_report.CALENDAR_FIELDS)
    assert set(doc["calendar"]["exceptions"][0]) == _keys(bug_report.DATE_RANGE_FIELDS)


def _velocity_history(project: Project) -> None:
    """Three closed sprints with distinctive completed-points values."""
    rows = [
        (1729, date(2026, 1, 5), date(2026, 1, 16)),
        (2357, date(2026, 1, 19), date(2026, 1, 30)),
        (3163, date(2026, 2, 2), date(2026, 2, 13)),
    ]
    for i, (cp, start, finish) in enumerate(rows, start=1):
        Sprint.objects.create(
            project=project,
            name=f"Sprint {i}",
            state=SprintState.COMPLETED,
            start_date=start,
            finish_date=finish,
            committed_points=3200,
            completed_points=cp,
        )


@pytest.mark.django_db
class TestTeamVelocityIsNotExported:
    """ADR-0104: velocity is team-private; the PM band (Admin+) can be refused it."""

    @pytest.fixture
    def agile(self, project: Project) -> list[Task]:
        _velocity_history(project)
        done = Task.objects.create(
            project=project,
            name="Story done",
            duration=2,
            story_points=13,
            delivery_mode=DeliveryMode.SCRUM,
            percent_complete=100,
            actual_start=date(2026, 3, 2),
            actual_finish=date(2026, 3, 3),
        )
        doing = Task.objects.create(
            project=project,
            name="Story doing",
            duration=4,
            story_points=8,
            delivery_mode=DeliveryMode.SCRUM,
            percent_complete=50,
            actual_start=date(2026, 3, 4),
        )
        later = Task.objects.create(
            project=project, name="Waterfall", duration=5, planned_start=date(2026, 3, 16)
        )
        Dependency.objects.create(predecessor=done, successor=doing, dep_type="FS", lag=0)
        Dependency.objects.create(predecessor=doing, successor=later, dep_type="SS", lag=1)
        return [done, doing, later]

    @pytest.mark.parametrize("role", [Role.SCHEDULER, Role.ADMIN, Role.OWNER])
    def test_no_velocity_input_in_the_response(
        self, project: Project, agile: list[Task], role: str
    ) -> None:
        from trueppm_api.apps.scheduling.views import _build_cpm_sched_inputs

        # Arm the fixture: the engine input really does carry the team's velocity.
        armed = _build_cpm_sched_inputs(project, str(project.pk))[0]
        assert armed.velocity_samples and armed.sprint_length_days
        assert any(t.story_points for t in armed.tasks)

        resp = _client(project, role).get(url(project.pk))
        assert resp.status_code == 200, resp.content
        raw = resp.content.decode()
        for sample in (1729, 2357, 3163):
            # As a JSON number (``1729.0``); a UUID never contains a dot.
            assert not re.search(rf"(?<![0-9a-f-]){sample}(\.0)?(?![0-9a-f-])", raw), sample
        doc = resp.json()["engine_input"]
        assert doc["velocity_samples"] is None
        assert doc["sprint_length_days"] is None
        assert all(t["story_points"] is None for t in doc["tasks"])
        assert all(t["delivery_mode"] is None for t in doc["tasks"])

    def test_the_export_schedules_to_the_same_dates(
        self, project: Project, agile: list[Task]
    ) -> None:
        from trueppm_scheduler import schedule

        from trueppm_api.apps.scheduling.views import _build_cpm_sched_inputs

        authoritative = schedule(_build_cpm_sched_inputs(project, str(project.pk))[0])
        body = _client(project, Role.SCHEDULER).get(url(project.pk)).json()
        reproduced = schedule(SchedProject.from_json(json.dumps(body["engine_input"])))

        def dates(result: Any) -> dict[str, tuple[Any, ...]]:
            return {
                t.id: (
                    t.early_start,
                    t.early_finish,
                    t.late_start,
                    t.late_finish,
                    t.total_float,
                    t.free_float,
                    t.is_critical,
                    t.scheduled_start,
                    t.milestone_at_day_end,
                )
                for t in result.tasks
            }

        assert dates(reproduced) == dates(authoritative)
        assert reproduced.critical_path == authoritative.critical_path
