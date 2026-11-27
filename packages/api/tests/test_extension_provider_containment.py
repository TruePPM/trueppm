"""A registered extension provider that raises never breaks the OSS path (#3866).

One test per seam. The fail direction is part of the contract: configuration locks
fall back to the OSS answer; the seams that decide exposure, upload permission,
disclosure or irreversible deletion resolve to the stricter value.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator
from datetime import date
from typing import Any

import pytest
from celery.exceptions import SoftTimeLimitExceeded
from django.contrib.auth import get_user_model
from django.db import connection, transaction
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.profiles import services as profile_services
from trueppm_api.apps.projects import (
    attachment_policy,
    calendar_settings,
    iteration_label,
    methodology,
    sharing_settings,
    signal_privacy_services,
    task_duration_settings,
)
from trueppm_api.apps.projects.models import (
    Calendar,
    Methodology,
    Project,
    SignalAudience,
    Task,
)
from trueppm_api.apps.scheduling import calendars, forecast_history_settings
from trueppm_api.apps.scheduling.models import MCAttributionAudience
from trueppm_api.apps.taskruns.models import TaskRun, TaskRunStatus
from trueppm_api.apps.workspace.models import TermOverridePolicy, Workspace
from trueppm_api.core.extension_providers import invoke_extension_provider


def _boom(*_args: object) -> Any:
    raise RuntimeError("enterprise bug")


@pytest.fixture
def raising() -> Iterator[Callable[[Callable[[Any], None]], None]]:
    """Register ``_boom`` against a seam and clear it afterwards."""
    registered: list[Callable[[Any], None]] = []

    def _register(register: Callable[[Any], None]) -> None:
        register(_boom)
        registered.append(register)

    yield _register
    for register in registered:
        register(None)


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 3, 2))


@pytest.mark.parametrize(
    ("register", "active"),
    [
        (
            calendar_settings.register_calendar_enforcement_provider,
            calendar_settings.calendar_enforcement_active,
        ),
        (
            methodology.register_methodology_enforcement_provider,
            methodology.methodology_enforcement_active,
        ),
        (
            iteration_label.register_terminology_enforcement_provider,
            iteration_label.terminology_enforcement_active,
        ),
        (
            task_duration_settings.register_duration_policy_enforcement_provider,
            task_duration_settings.duration_policy_enforcement_active,
        ),
        (
            sharing_settings.register_sharing_enforcement_provider,
            sharing_settings.sharing_enforcement_active,
        ),
        (
            attachment_policy.register_attachment_policy_enforcement_provider,
            attachment_policy.attachment_policy_enforcement_active,
        ),
        (
            forecast_history_settings.register_forecast_history_enforcement_provider,
            forecast_history_settings.forecast_history_enforcement_active,
        ),
    ],
)
def test_raising_enforcement_provider_is_logged_not_raised(
    raising: Any,
    caplog: pytest.LogCaptureFixture,
    register: Callable[[Any], None],
    active: Callable[[], bool],
) -> None:
    raising(register)
    with caplog.at_level(logging.ERROR):
        assert active() is False
    assert "provider raised" in caplog.text


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("register", "locked", "field"),
    [
        (
            calendar_settings.register_calendar_enforcement_provider,
            calendar_settings.calendar_override_locked,
            "calendar_override_policy",
        ),
        (
            methodology.register_methodology_enforcement_provider,
            methodology.methodology_override_locked,
            "methodology_override_policy",
        ),
    ],
)
def test_override_lock_fails_open(
    raising: Any,
    register: Callable[[Any], None],
    locked: Callable[[Workspace], bool],
    field: str,
) -> None:
    raising(register)
    workspace = Workspace.load()
    setattr(workspace, field, TermOverridePolicy.ENFORCE)
    assert locked(workspace) is False


def test_terminology_and_duration_keep_the_project_override(raising: Any, project: Project) -> None:
    raising(iteration_label.register_terminology_enforcement_provider)
    raising(task_duration_settings.register_duration_policy_enforcement_provider)
    workspace = Workspace.load()
    workspace.iteration_label = "Cycle"
    workspace.iteration_label_override_policy = TermOverridePolicy.ENFORCE
    workspace.task_duration_change_percent_override_policy = TermOverridePolicy.ENFORCE
    project.iteration_label = "Iteration"
    project.task_duration_change_percent_policy = "confirm"

    label = iteration_label.resolve_effective_iteration_label(project, workspace=workspace)
    duration = task_duration_settings.resolve_effective_duration_policy(
        project, workspace=workspace
    )

    assert label == "Iteration"
    assert duration == "confirm"


@pytest.mark.parametrize(
    ("ws_value", "own", "expected"),
    [(False, True, False), (True, False, False), (True, True, True), (True, None, True)],
)
def test_sharing_fails_closed(
    raising: Any, project: Project, ws_value: bool, own: bool | None, expected: bool
) -> None:
    raising(sharing_settings.register_sharing_enforcement_provider)
    workspace = Workspace.load()
    workspace.public_sharing = ws_value
    workspace.public_sharing_override_policy = TermOverridePolicy.ENFORCE
    project.public_sharing = own

    effective = sharing_settings.resolve_effective_sharing(
        project, "public_sharing", workspace=workspace
    )
    inherited = sharing_settings.resolve_inherited_sharing(
        project, "public_sharing", workspace=workspace
    )

    assert effective is expected
    assert inherited is ws_value


def test_attachment_policy_fails_closed(raising: Any, project: Project) -> None:
    raising(attachment_policy.register_attachment_policy_enforcement_provider)
    workspace = Workspace.load()
    workspace.attachments_override_policy = TermOverridePolicy.ENFORCE
    workspace.attachments_enabled = False
    workspace.allowed_attachment_types = ["application/pdf", "image/png"]
    project.attachments_enabled = True
    project.allowed_attachment_types = ["image/png", "text/csv"]

    assert attachment_policy.resolve_attachments_enabled(project, workspace=workspace) is False
    assert (
        attachment_policy.resolve_inherited_attachments_enabled(project, workspace=workspace)
        is False
    )
    assert attachment_policy.resolve_effective_attachment_types(project, workspace=workspace) == [
        "image/png"
    ]
    assert attachment_policy.resolve_inherited_attachment_types(project, workspace=workspace) == [
        "application/pdf",
        "image/png",
    ]


def test_forecast_history_unknown_lock_is_strict_per_key(raising: Any, project: Project) -> None:
    raising(forecast_history_settings.register_forecast_history_enforcement_provider)
    workspace = Workspace.load()
    workspace.mc_history_override_policy = TermOverridePolicy.ENFORCE
    workspace.mc_history_attribution_audience = MCAttributionAudience.ADMIN_OWNER
    workspace.mc_history_retention_cap = 200
    workspace.mc_history_enabled = True
    project.mc_history_attribution_audience = MCAttributionAudience.SCHEDULER_PLUS
    project.mc_history_retention_cap = 5
    project.mc_history_enabled = False

    def resolve(key: str) -> Any:
        return forecast_history_settings.resolve_effective_mc_history(
            project, key, workspace=workspace
        )

    # Disclosure: the stricter audience. Deletion: the larger cap. Config: fail open.
    assert resolve("mc_history_attribution_audience") == MCAttributionAudience.ADMIN_OWNER
    assert resolve("mc_history_retention_cap") == 200
    assert resolve("mc_history_enabled") is False

    project.mc_history_attribution_audience = MCAttributionAudience.NONE
    assert resolve("mc_history_attribution_audience") == MCAttributionAudience.NONE
    assert (
        forecast_history_settings.resolve_inherited_mc_history(
            project, "mc_history_retention_cap", workspace=workspace
        )
        == 200
    )


def test_default_posture_raising_leaves_oss_defaults(raising: Any, project: Project) -> None:
    raising(signal_privacy_services.register_default_posture_provider)
    policy = signal_privacy_services.get_or_create_policy(project)
    assert policy.signal_visibility == {}
    assert policy.ceiling_of("velocity") == SignalAudience.TEAM


def test_default_posture_non_mapping_is_ignored(project: Project) -> None:
    signal_privacy_services.register_default_posture_provider(lambda _p: ["nope"])  # type: ignore[arg-type,return-value]
    try:
        assert signal_privacy_services.get_or_create_policy(project).signal_visibility == {}
    finally:
        signal_privacy_services.register_default_posture_provider(None)


def test_raising_calendar_resolver_is_skipped(
    db: object, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    base = Calendar.objects.create(name="Base")
    project = Project.objects.create(name="P", start_date=date(2026, 3, 2), calendar=base)

    def _lazy_boom(_project: Project) -> Any:
        yield base
        raise RuntimeError("enterprise bug mid-iteration")

    monkeypatch.setattr(
        calendars, "_LAYER_RESOLVERS", [calendars.oss_project_layers, _boom, _lazy_boom]
    )
    with caplog.at_level(logging.ERROR):
        applied = calendars.resolve_applied_calendars(project)
        composed = calendars.compose_project_calendar(project)

    assert [c.id for c in applied] == [base.id]
    assert composed.working_days == base.working_days
    assert "calendar layer resolver provider raised" in caplog.text


def test_oss_calendar_resolver_failure_still_raises(
    project: Project, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Swallowing the base layer would silently schedule against the wrong calendar."""
    monkeypatch.setattr(calendars, "oss_project_layers", _boom)
    monkeypatch.setattr(calendars, "_LAYER_RESOLVERS", [_boom])
    with pytest.raises(RuntimeError):
        calendars.resolve_applied_calendars(project)


@pytest.mark.django_db(transaction=True)
def test_provider_database_error_does_not_poison_the_write() -> None:
    """The savepoint: a provider's failed query leaves the OSS transaction usable."""

    def _bad_query() -> bool:
        with connection.cursor() as cursor:
            cursor.execute("SELECT * FROM no_such_table_3866")
        return True

    with transaction.atomic():
        assert invoke_extension_provider(_bad_query, hook="t", fallback=False) is False
        Calendar.objects.create(name="after")

    assert Calendar.objects.filter(name="after").exists()


def test_task_time_limit_is_not_swallowed() -> None:
    def _timeout() -> bool:
        raise SoftTimeLimitExceeded()

    with pytest.raises(SoftTimeLimitExceeded):
        invoke_extension_provider(_timeout, hook="t", fallback=False)


@pytest.mark.parametrize("module", [sharing_settings, attachment_policy, forecast_history_settings])
def test_provider_returning_none_is_inactive_not_unknown(
    module: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``None`` is an answer ("no lock"); only a raise takes the fail-closed path."""
    monkeypatch.setattr(module, "_ENFORCEMENT_PROVIDER", lambda: None)
    assert module._provider_state() is False


def test_provider_returning_none_resolves_like_suggest(
    project: Project, monkeypatch: pytest.MonkeyPatch
) -> None:
    for module in (sharing_settings, attachment_policy, forecast_history_settings):
        monkeypatch.setattr(module, "_ENFORCEMENT_PROVIDER", lambda: None)
    workspace = Workspace.load()
    workspace.public_sharing = False
    workspace.public_sharing_override_policy = TermOverridePolicy.ENFORCE
    workspace.attachments_enabled = False
    workspace.attachments_override_policy = TermOverridePolicy.ENFORCE
    workspace.mc_history_retention_cap = 200
    workspace.mc_history_override_policy = TermOverridePolicy.ENFORCE
    project.public_sharing = True
    project.attachments_enabled = True
    project.mc_history_retention_cap = 5

    assert (
        sharing_settings.resolve_effective_sharing(project, "public_sharing", workspace=workspace)
        is True
    )
    assert attachment_policy.resolve_attachments_enabled(project, workspace=workspace) is True
    assert (
        forecast_history_settings.resolve_effective_mc_history(
            project, "mc_history_retention_cap", workspace=workspace
        )
        == 5
    )


def _admin_client(project: Project) -> APIClient:
    user = get_user_model().objects.create_user(
        username="admin_3866", password="pw", is_superuser=True
    )
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    client = APIClient(raise_request_exception=False)
    client.force_authenticate(user=user)
    return client


def test_methodology_patch_survives_a_raising_provider(
    raising: Any, project: Project, caplog: pytest.LogCaptureFixture
) -> None:
    """The write path, not only the resolver: the lock is asked inside validation."""
    workspace = Workspace.load()
    workspace.methodology_override_policy = TermOverridePolicy.ENFORCE
    workspace.save()
    client = _admin_client(project)
    raising(methodology.register_methodology_enforcement_provider)
    value = next(m for m in Methodology.values if m != project.methodology)

    with caplog.at_level(logging.ERROR):
        resp = client.patch(
            f"/api/v1/projects/{project.pk}/", {"methodology": value}, format="json"
        )

    assert resp.status_code == 200, resp.content
    project.refresh_from_db()
    assert project.methodology == value
    assert "methodology enforcement provider raised" in caplog.text


@pytest.mark.parametrize("target", ["project", "workspace"])
def test_calendar_assignment_survives_a_raising_provider(
    raising: Any, project: Project, target: str, caplog: pytest.LogCaptureFixture
) -> None:
    """Both assignment writes: the project override and the workspace fan-out in views."""
    calendar = Calendar.objects.create(name="Assigned")
    workspace = Workspace.load()
    workspace.calendar_override_policy = TermOverridePolicy.ENFORCE
    workspace.save()
    client = _admin_client(project)
    raising(calendar_settings.register_calendar_enforcement_provider)
    url = f"/api/v1/projects/{project.pk}/" if target == "project" else "/api/v1/workspace/"

    with caplog.at_level(logging.ERROR):
        resp = client.patch(url, {"calendar": str(calendar.pk)}, format="json")

    assert resp.status_code == 200, resp.content
    assert str(resp.data["calendar"]) == str(calendar.pk)
    assert "calendar enforcement provider raised" in caplog.text


@pytest.mark.django_db(transaction=True)
def test_cpm_recalculation_completes_with_a_raising_calendar_resolver(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule
    from trueppm_api.apps.sync import broadcast

    project = Project.objects.create(
        name="Recalc",
        start_date=date(2026, 3, 2),
        status_date=date(2026, 3, 2),
        calendar=Calendar.objects.create(name="Base"),
    )
    task = Task.objects.create(project=project, name="T", duration=3, wbs_path="1")
    events: list[str] = []
    monkeypatch.setattr(
        broadcast,
        "broadcast_board_event",
        lambda *args, **kwargs: events.append(str(kwargs.get("event_type", args[1:2]))),
    )
    monkeypatch.setattr(calendars, "_LAYER_RESOLVERS", [calendars.oss_project_layers, _boom])

    with caplog.at_level(logging.ERROR):
        result = recalculate_schedule.apply(args=[str(project.pk)])

    assert result.successful(), result.traceback
    task.refresh_from_db()
    project.refresh_from_db()
    assert task.early_finish == date(2026, 3, 4)
    assert project.recalculated_at is not None
    run = TaskRun.objects.get(project_id=project.pk)
    assert run.status == TaskRunStatus.SUCCESS
    assert events, "the broadcast spy saw nothing, so the next line would prove nothing"
    assert not any("cpm_error" in event for event in events)
    assert "calendar layer resolver provider raised" in caplog.text


def test_raising_portfolio_provider_denies_access_and_me_still_answers(
    settings: Any, project: Project, caplog: pytest.LogCaptureFixture
) -> None:
    settings.TRUEPPM_EDITION = "enterprise"
    client = _admin_client(project)
    user = get_user_model().objects.get(username="admin_3866")
    profile_services.register_portfolio_access_provider(_boom, _boom)
    try:
        with caplog.at_level(logging.ERROR):
            assert profile_services.has_portfolio_access(user) is False
            assert profile_services._portfolio_path(user) is None
            resp = client.get("/api/v1/auth/me/")
    finally:
        profile_services._portfolio_access_provider = None
        profile_services._portfolio_path_provider = None

    assert resp.status_code == 200, resp.content
    assert "portfolio access provider raised" in caplog.text
