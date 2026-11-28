"""Forecast-vs-actual capture and the calibration export contract (ADR-1511, #4747)."""

from __future__ import annotations

import json
from datetime import date, timedelta
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects import baselines
from trueppm_api.apps.projects.commit_moment import commit_project
from trueppm_api.apps.projects.forecast_calibration import (
    EXPORT_SCHEMA,
    EXPORT_SCHEMA_VERSION,
    export_records,
)
from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineDecisionKind,
    Calendar,
    ForecastCalibrationRecord,
    Project,
    ProjectLifecycle,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.seed import export_project, import_seed
from trueppm_api.apps.scheduling.models import MonteCarloRun

API = "/api/v1"

# The export's record keys are the contract (ADR-1511 §Export). A change here is
# a schema change and must bump EXPORT_SCHEMA_VERSION.
FORECAST_KEYS = {
    "record",
    "project_id",
    "capture_id",
    "baseline_id",
    "captured_at",
    "forecast_kind",
    "scope",
    "task_id",
    "is_milestone",
    "finished_at_capture",
    "duration",
    "optimistic_duration",
    "most_likely_duration",
    "pessimistic_duration",
    "estimate_status",
    "p50_at_day_start",
    "p80_at_day_start",
    "p95_at_day_start",
    "actual_start",
    "deterministic_finish",
    "deterministic_finish_at_day_start",
    "p50",
    "p80",
    "p95",
    "distribution_computed_at",
    "distribution_cpm_finish",
    "distribution_cpm_finish_at_day_start",
    "mc_iterations",
    "actual_finish",
    "outcome",
}


@pytest.fixture
def owner(db: object) -> object:
    return get_user_model().objects.create_user(username="fc-owner", password="pw")


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _task(project: Project, name: str, path: str, finish: date, **kw: object) -> Task:
    fields: dict[str, object] = {"duration": 5, "early_start": finish - timedelta(days=4)}
    fields.update(kw)
    return Task.objects.create(
        project=project, name=name, wbs_path=path, early_finish=finish, **fields
    )


def _project(owner: object, *, opted_in: bool) -> Project:
    p = Project.objects.create(
        name="Pad 39C",
        start_date=date(2026, 3, 2),
        calendar=Calendar.objects.create(name="Standard"),
        lifecycle=ProjectLifecycle.DRAFT,
        forecast_calibration_capture=opted_in,
    )
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    _task(p, "Permits", "1", date(2026, 3, 6))
    _task(p, "Survey", "2", date(2026, 3, 11))
    _task(
        p,
        "Handover",
        "3",
        date(2026, 3, 20),
        is_milestone=True,
        duration=0,
        early_start=date(2026, 3, 20),
    )
    return p


def _forecasts(project_ids: list[object] | None = None) -> list[dict[str, object]]:
    return [r for r in export_records(project_ids) if r["record"] == "forecast"]


@pytest.mark.django_db
class TestCapture:
    def test_commit_baseline_captures_every_committed_task_and_the_project(
        self, owner: object
    ) -> None:
        p = _project(owner, opted_in=True)
        commit_project(p, user=owner)

        rows = list(ForecastCalibrationRecord.objects.filter(project=p))
        assert len(rows) == 4  # one project row + three task rows
        assert {r.kind for r in rows} == {"baseline"}
        assert len({r.capture_id for r in rows}) == 1
        assert len({r.captured_at for r in rows}) == 1
        project_row = next(r for r in rows if r.scope == "project")
        assert project_row.task_id is None
        assert project_row.deterministic_finish == date(2026, 3, 20)
        assert project_row.baseline == Baseline.objects.get(project=p, is_active=True)
        by_task = {r.task_id: r for r in rows if r.scope == "task"}
        handover = Task.objects.get(project=p, name="Handover")
        assert by_task[handover.pk].is_milestone is True
        assert by_task[handover.pk].deterministic_finish == date(2026, 3, 20)
        # Per-task percentiles wait on the engine's per-task targets (#4135).
        assert all(r.p50 is None for r in by_task.values())

    def test_project_row_ignores_a_sub_minimum_pre_upgrade_run(self, owner: object) -> None:
        p = _project(owner, opted_in=True)
        MonteCarloRun.objects.create(
            project=p, p50=date(2026, 3, 23), p80=date(2026, 3, 25), n_simulations=50
        )
        commit_project(p, user=owner)
        row = ForecastCalibrationRecord.objects.get(project=p, scope="project")
        assert row.p80 is None
        assert row.mc_iterations is None

    def test_backlog_rows_are_not_captured(self, owner: object) -> None:
        p = _project(owner, opted_in=True)
        Task.objects.create(
            project=p, name="Idea", duration=1, wbs_path="4", status=TaskStatus.BACKLOG
        )
        commit_project(p, user=owner)
        task_rows = ForecastCalibrationRecord.objects.filter(project=p, scope="task")
        assert task_rows.count() == 3

    def test_project_row_copies_the_latest_monte_carlo_run(self, owner: object) -> None:
        p = _project(owner, opted_in=True)
        MonteCarloRun.objects.create(
            project=p,
            p50=date(2026, 3, 1),
            p80=date(2026, 3, 2),
            p95=date(2026, 3, 3),
            n_simulations=100,
        )
        latest = MonteCarloRun.objects.create(
            project=p,
            p50=date(2026, 3, 23),
            p80=date(2026, 3, 25),
            p95=date(2026, 3, 30),
            p50_at_day_start=True,
            p80_at_day_start=False,
            p95_at_day_start=True,
            cpm_finish=date(2026, 3, 18),
            cpm_finish_at_day_start=True,
            n_simulations=1000,
        )
        commit_project(p, user=owner)
        row = ForecastCalibrationRecord.objects.get(project=p, scope="project")
        assert (row.p50, row.p80, row.p95) == (
            date(2026, 3, 23),
            date(2026, 3, 25),
            date(2026, 3, 30),
        )
        assert row.mc_iterations == 1000
        [exported] = [r for r in _forecasts() if r["scope"] == "project"]
        flags = [exported[f"p{n}_at_day_start"] for n in (50, 80, 95)]
        assert flags == [True, False, True]
        # The run predates the plan here: its CPM finish differs from the row's.
        assert exported["distribution_cpm_finish"] == "2026-03-18"
        assert exported["distribution_cpm_finish_at_day_start"] is True
        assert exported["deterministic_finish"] == "2026-03-20"
        assert row.distribution_computed_at == latest.taken_at

    def test_taken_decision_capture_is_a_replan(self, owner: object) -> None:
        p = _project(owner, opted_in=True)
        commit_project(p, user=owner)
        baselines.decide(
            p,
            user=owner,
            data=baselines.DecisionInput(
                kind=BaselineDecisionKind.TAKEN,
                reason_code="approved_scope_change",
                reason="CO-7",
            ),
        )
        kinds = set(
            ForecastCalibrationRecord.objects.filter(project=p).values_list("kind", flat=True)
        )
        assert kinds == {"baseline", "replan"}

    def test_rest_named_capture_is_recorded_as_a_baseline(self, owner: object) -> None:
        p = _project(owner, opted_in=True)
        r = _client(owner).post(f"{API}/projects/{p.pk}/baselines/", {"name": "Q1"})
        assert r.status_code == 201, r.content
        assert ForecastCalibrationRecord.objects.filter(project=p, kind="baseline").count() == 4

    def test_estimate_is_frozen_at_capture_not_read_at_export(self, owner: object) -> None:
        p = _project(owner, opted_in=True)
        tasks = Task.objects.filter(project=p, name="Permits")
        tasks.update(
            optimistic_duration=3,
            most_likely_duration=5,
            pessimistic_duration=9,
            estimate_status="accepted",
        )
        commit_project(p, user=owner)
        tasks.update(
            duration=40,
            optimistic_duration=30,
            most_likely_duration=40,
            pessimistic_duration=50,
            estimate_status="pending",
            actual_start=date(2026, 3, 3),
        )
        [row] = [r for r in _forecasts() if r["task_id"] == str(tasks.get().pk)]
        assert row["duration"] == 5
        assert (
            row["optimistic_duration"],
            row["most_likely_duration"],
            row["pessimistic_duration"],
        ) == (3, 5, 9)
        assert row["estimate_status"] == "accepted"
        assert row["actual_start"] == "2026-03-03"
        [proj] = [r for r in _forecasts() if r["scope"] == "project"]
        assert (proj["duration"], proj["actual_start"]) == (None, None)

    def test_work_finished_before_capture_is_marked(self, owner: object) -> None:
        p = _project(owner, opted_in=True)
        Task.objects.filter(project=p, name="Permits").update(actual_finish=date(2026, 3, 5))
        commit_project(p, user=owner)
        permits = Task.objects.get(project=p, name="Permits")
        by_task = {r["task_id"]: r["finished_at_capture"] for r in _forecasts()}
        assert by_task.pop(str(permits.pk)) is True
        assert set(by_task.values()) == {False}  # other tasks and the project row

        Task.objects.filter(project=p).update(actual_finish=date(2026, 3, 24))
        baselines.capture(p, owner, "Baseline v2", source="decision")
        replan = [r for r in _forecasts() if r["forecast_kind"] == "replan"]
        assert len(replan) == 4
        assert all(r["finished_at_capture"] is True for r in replan)

    def test_rest_commit_captures(self, owner: object) -> None:
        p = _project(owner, opted_in=True)
        r = _client(owner).post(f"{API}/projects/{p.pk}/commit/")
        assert r.status_code in (200, 201), r.content
        assert ForecastCalibrationRecord.objects.filter(project=p, kind="baseline").count() == 4

    def test_opted_out_project_captures_nothing(self, owner: object) -> None:
        p = _project(owner, opted_in=False)
        commit_project(p, user=owner)
        baselines.capture(p, owner, "Baseline v2", source="decision")
        assert Baseline.objects.filter(project=p).count() == 2
        assert not ForecastCalibrationRecord.objects.filter(project=p).exists()

    def test_capture_failure_never_blocks_the_baseline(self, owner: object) -> None:
        p = _project(owner, opted_in=True)
        with patch(
            "trueppm_api.apps.projects.forecast_calibration._write_capture",
            side_effect=RuntimeError("boom"),
        ):
            commit_project(p, user=owner)
        assert Baseline.objects.filter(project=p, is_active=True).exists()
        assert not ForecastCalibrationRecord.objects.filter(project=p).exists()


@pytest.mark.django_db
class TestActualJoin:
    def test_actual_finish_is_joined_at_export_not_copied(self, owner: object) -> None:
        p = _project(owner, opted_in=True)
        commit_project(p, user=owner)
        permits = Task.objects.get(project=p, name="Permits")

        [before] = [r for r in _forecasts() if r["task_id"] == str(permits.pk)]
        assert (before["actual_finish"], before["outcome"]) == (None, "open")

        Task.objects.filter(pk=permits.pk).update(actual_finish=date(2026, 3, 9))
        [after] = [r for r in _forecasts() if r["task_id"] == str(permits.pk)]
        assert (after["actual_finish"], after["outcome"]) == ("2026-03-09", "finished")
        # A corrected actual is what the next export reads.
        Task.objects.filter(pk=permits.pk).update(actual_finish=date(2026, 3, 10))
        [fixed] = [r for r in _forecasts() if r["task_id"] == str(permits.pk)]
        assert fixed["actual_finish"] == "2026-03-10"

    def test_project_actual_needs_every_committed_task_finished(self, owner: object) -> None:
        p = _project(owner, opted_in=True)
        commit_project(p, user=owner)
        tasks = Task.objects.filter(project=p)
        tasks.exclude(name="Handover").update(actual_finish=date(2026, 3, 12))
        [proj] = [r for r in _forecasts() if r["scope"] == "project"]
        assert (proj["actual_finish"], proj["outcome"]) == (None, "open")

        tasks.filter(name="Handover").update(actual_finish=date(2026, 3, 24))
        [proj] = [r for r in _forecasts() if r["scope"] == "project"]
        assert (proj["actual_finish"], proj["outcome"]) == ("2026-03-24", "finished")

    def test_deleted_task_keeps_its_forecast_with_outcome_deleted(self, owner: object) -> None:
        p = _project(owner, opted_in=True)
        commit_project(p, user=owner)
        survey = Task.objects.get(project=p, name="Survey")
        Task.objects.filter(pk=survey.pk).update(is_deleted=True)
        [row] = [r for r in _forecasts() if r["task_id"] == str(survey.pk)]
        assert row["outcome"] == "deleted"
        assert row["deterministic_finish"] == "2026-03-11"


@pytest.mark.django_db
class TestExport:
    def test_shape_header_and_no_personal_fields(self, owner: object) -> None:
        p = _project(owner, opted_in=True)
        commit_project(p, user=owner)
        out = list(export_records())
        header = out[0]
        assert header["record"] == "header"
        assert header["schema"] == EXPORT_SCHEMA
        assert header["version"] == EXPORT_SCHEMA_VERSION == 1
        assert header["project_count"] == 1
        assert len(out) == 5
        baseline = Baseline.objects.get(project=p)
        for rec in out[1:]:
            assert set(rec) == FORECAST_KEYS
            assert rec["baseline_id"] == str(baseline.pk)
        # No user, name or free text anywhere in the export (ADR-0104 aggregate-only).
        blob = json.dumps(out)
        for needle in ("Permits", "Survey", "Pad 39C", "fc-owner"):
            assert needle not in blob

    def test_withdrawn_consent_excludes_the_project_and_keeps_rows(self, owner: object) -> None:
        p = _project(owner, opted_in=True)
        commit_project(p, user=owner)
        Project.objects.filter(pk=p.pk).update(forecast_calibration_capture=False)
        assert _forecasts() == []
        assert ForecastCalibrationRecord.objects.filter(project=p).count() == 4

    def test_trashed_project_is_not_exported(self, owner: object) -> None:
        p = _project(owner, opted_in=True)
        commit_project(p, user=owner)
        p.soft_delete()
        [header, *rows] = list(export_records())
        assert header["project_count"] == 0 and rows == []
        assert _forecasts([p.pk]) == []
        assert ForecastCalibrationRecord.objects.filter(project=p).exists()

    def test_rows_name_the_baseline_whose_calendar_applies(self, owner: object) -> None:
        p = _project(owner, opted_in=True)
        commit_project(p, user=owner)
        baseline = Baseline.objects.get(project=p)
        assert {r["baseline_id"] for r in _forecasts()} == {str(baseline.pk)}
        # A soft delete (the product's delete) keeps the row and its calendar.
        baseline.soft_delete()
        assert {r["baseline_id"] for r in _forecasts()} == {str(baseline.pk)}
        Baseline.objects.filter(pk=baseline.pk).delete()
        assert {r["baseline_id"] for r in _forecasts()} == {None}

    def test_project_filter(self, owner: object) -> None:
        a = _project(owner, opted_in=True)
        b = _project(owner, opted_in=True)
        commit_project(a, user=owner)
        commit_project(b, user=owner)
        assert {r["project_id"] for r in _forecasts([b.pk])} == {str(b.pk)}

    def test_command_writes_json_lines(self, owner: object, tmp_path: Path) -> None:
        p = _project(owner, opted_in=True)
        commit_project(p, user=owner)
        stdout = StringIO()
        call_command("export_forecast_calibration", stdout=stdout)
        lines = [json.loads(line) for line in stdout.getvalue().splitlines()]
        assert lines[0]["schema"] == EXPORT_SCHEMA
        assert len(lines) == 5

        target = tmp_path / "cal.jsonl"
        call_command("export_forecast_calibration", "--output", str(target), stderr=StringIO())
        assert len(target.read_text().splitlines()) == 5

    def test_command_rejects_a_non_uuid_project(self, db: object) -> None:
        with pytest.raises(CommandError):
            call_command("export_forecast_calibration", "--project", "nope")


@pytest.mark.django_db
class TestConsentDoesNotTravel:
    def test_settings_template_does_not_copy_the_opt_in(self, owner: object) -> None:
        source = _project(owner, opted_in=True)
        r = _client(owner).post(
            f"{API}/projects/",
            {
                "name": "From template",
                "start_date": "2026-04-06",
                "copy_settings_from": str(source.pk),
            },
            format="json",
        )
        assert r.status_code == 201, r.content
        assert Project.objects.get(pk=r.data["id"]).forecast_calibration_capture is False

    def test_seed_export_import_does_not_carry_the_opt_in(self, owner: object) -> None:
        source = _project(owner, opted_in=True)
        doc = export_project(source)
        assert "forecast_calibration_capture" not in json.dumps(doc)
        program = import_seed(doc, owner=owner)
        [copy] = Project.objects.filter(program=program)
        assert copy.pk != source.pk
        assert copy.forecast_calibration_capture is False


@pytest.mark.django_db
class TestPurgeInteraction:
    def test_forecast_and_mc_purges_leave_calibration_rows(self, owner: object) -> None:
        from trueppm_api.apps.scheduling.tasks import (
            _do_monte_carlo_run_purge,
            _do_prune_forecast_snapshots,
        )

        p = _project(owner, opted_in=True)
        Project.objects.filter(pk=p.pk).update(mc_history_retention_cap=5)
        for _ in range(60):
            MonteCarloRun.objects.create(project=p, p50=date(2026, 3, 23), n_simulations=100)
        commit_project(p, user=owner)
        before = ForecastCalibrationRecord.objects.filter(project=p).count()

        _do_monte_carlo_run_purge()
        _do_prune_forecast_snapshots()

        assert MonteCarloRun.objects.filter(project=p).count() < 60
        rows = ForecastCalibrationRecord.objects.filter(project=p)
        assert rows.count() == before
        # The percentiles were copied, so the purged run does not take them away.
        assert rows.get(scope="project").p50 == date(2026, 3, 23)

    def test_deleting_the_baseline_keeps_the_forecast(self, owner: object) -> None:
        p = _project(owner, opted_in=True)
        commit_project(p, user=owner)
        Baseline.objects.filter(project=p).delete()
        rows = ForecastCalibrationRecord.objects.filter(project=p)
        assert rows.count() == 4
        assert all(r.baseline_id is None for r in rows)


@pytest.mark.django_db
class TestConsentSetting:
    def _patch(self, project: Project, role: int, value: bool) -> int:
        u = get_user_model().objects.create_user(username=f"fc-{role}", password="pw")
        ProjectMembership.objects.create(project=project, user=u, role=role)
        r = _client(u).patch(
            f"{API}/projects/{project.pk}/",
            {"forecast_calibration_capture": value},
            format="json",
        )
        return r.status_code

    def test_off_by_default(self, db: object) -> None:
        p = Project.objects.create(name="Fresh", start_date=date(2026, 3, 2))
        assert p.forecast_calibration_capture is False

    def test_admin_can_opt_in_and_the_flip_is_audited(self, owner: object) -> None:
        p = _project(owner, opted_in=False)
        assert self._patch(p, Role.ADMIN, True) == 200
        p.refresh_from_db()
        assert p.forecast_calibration_capture is True
        history = p.history.order_by("-history_date").first()
        assert history is not None and history.forecast_calibration_capture is True

    @pytest.mark.parametrize("role", [Role.SCHEDULER, Role.MEMBER, Role.VIEWER])
    def test_below_admin_cannot_opt_in(self, owner: object, role: int) -> None:
        p = _project(owner, opted_in=False)
        assert self._patch(p, role, True) in (400, 403)
        p.refresh_from_db()
        assert p.forecast_calibration_capture is False
