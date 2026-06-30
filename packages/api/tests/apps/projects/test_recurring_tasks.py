"""Tests for recurring tasks — TaskRecurrenceRule, the lazy generator, and the
load-bearing CPM-exclusion invariant (#736, ADR-0090).

Layers covered:
  - Model validation: each frequency + end condition persists; clean() rejects
    the invalid conditional-field combinations.
  - Lazy generator (_generate_due_occurrences): bounded look-ahead per frequency,
    end conditions (NEVER/ON_DATE/AFTER_N), idempotency, inheritance toggles.
  - CPM exclusion (MANDATORY): a recurrence template and its generated occurrences
    never enter the scheduling-engine inputs (CPM + Task.committed).
  - API/RBAC: create/delete gating, recalc trigger, validation errors.
"""

from __future__ import annotations

from datetime import date, datetime, time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    RecurrenceEndType,
    Task,
    TaskAttachment,
    TaskRecurrenceFrequency,
    TaskRecurrenceRule,
)
from trueppm_api.apps.projects.services import _generate_due_occurrences
from trueppm_api.apps.projects.tasks import generate_recurring_occurrences

User = get_user_model()

# A fixed Monday so weekday math in the weekly tests is deterministic.
MONDAY = date(2026, 6, 1)  # 2026-06-01 is a Monday
NOON = datetime(2026, 6, 1, 12, 0)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=MONDAY, calendar=calendar)


@pytest.fixture
def template(project: Project) -> Task:
    """A task with a known anchor date used as the recurrence template."""
    return Task.objects.create(
        project=project, name="Daily standup", duration=1, planned_start=MONDAY
    )


def _make_rule(template: Task, **overrides: object) -> TaskRecurrenceRule:
    defaults: dict[str, object] = {
        "frequency": TaskRecurrenceFrequency.DAILY,
        "interval": 1,
        "end_type": RecurrenceEndType.NEVER,
        "time_of_day": time(9, 0),
    }
    defaults.update(overrides)
    rule = TaskRecurrenceRule.objects.create(task=template, **defaults)
    template.is_recurring = True
    template.save(update_fields=["is_recurring"])
    return rule


# ---------------------------------------------------------------------------
# Model validation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    "frequency",
    [
        TaskRecurrenceFrequency.DAILY,
        TaskRecurrenceFrequency.WEEKLY,
        TaskRecurrenceFrequency.MONTHLY,
        TaskRecurrenceFrequency.CUSTOM,
    ],
)
def test_rule_persists_each_frequency(template: Task, frequency: str) -> None:
    extra: dict[str, object] = {}
    if frequency == TaskRecurrenceFrequency.WEEKLY:
        extra["weekdays"] = 1  # Monday
    if frequency == TaskRecurrenceFrequency.MONTHLY:
        extra["day_of_month"] = 15
    rule = _make_rule(template, frequency=frequency, **extra)
    rule.full_clean()  # must not raise
    assert TaskRecurrenceRule.objects.get(pk=rule.pk).frequency == frequency


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("end_type", "extra"),
    [
        (RecurrenceEndType.NEVER, {}),
        (RecurrenceEndType.ON_DATE, {"end_date": date(2026, 12, 31)}),
        (RecurrenceEndType.AFTER_N, {"end_count": 10}),
    ],
)
def test_rule_persists_each_end_condition(template: Task, end_type: str, extra: dict) -> None:
    rule = _make_rule(template, end_type=end_type, **extra)
    rule.full_clean()
    assert TaskRecurrenceRule.objects.get(pk=rule.pk).end_type == end_type


@pytest.mark.django_db
def test_weekly_without_weekday_is_invalid(template: Task) -> None:
    from django.core.exceptions import ValidationError

    rule = _make_rule(template, frequency=TaskRecurrenceFrequency.WEEKLY, weekdays=0)
    with pytest.raises(ValidationError) as exc:
        rule.clean()
    assert "weekdays" in exc.value.message_dict


@pytest.mark.django_db
def test_monthly_without_day_of_month_is_invalid(template: Task) -> None:
    from django.core.exceptions import ValidationError

    rule = _make_rule(template, frequency=TaskRecurrenceFrequency.MONTHLY, day_of_month=None)
    with pytest.raises(ValidationError) as exc:
        rule.clean()
    assert "day_of_month" in exc.value.message_dict


@pytest.mark.django_db
def test_on_date_without_end_date_is_invalid(template: Task) -> None:
    from django.core.exceptions import ValidationError

    rule = _make_rule(template, end_type=RecurrenceEndType.ON_DATE, end_date=None)
    with pytest.raises(ValidationError) as exc:
        rule.clean()
    assert "end_date" in exc.value.message_dict


@pytest.mark.django_db
def test_after_n_without_count_is_invalid(template: Task) -> None:
    from django.core.exceptions import ValidationError

    rule = _make_rule(template, end_type=RecurrenceEndType.AFTER_N, end_count=None)
    with pytest.raises(ValidationError) as exc:
        rule.clean()
    assert "end_count" in exc.value.message_dict


# ---------------------------------------------------------------------------
# Lazy generator — per-frequency cadence
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_daily_generates_within_horizon_not_eagerly(template: Task) -> None:
    """Daily recurrence materializes only the horizon window, never the full series."""
    rule = _make_rule(template, frequency=TaskRecurrenceFrequency.DAILY)
    created = _generate_due_occurrences(rule, horizon_days=14, now=NOON)
    # 2026-06-01 .. 2026-06-15 inclusive = 15 days.
    assert len(created) == 15
    assert all(o.is_recurring for o in created)
    assert all(o.recurrence_rule_id == rule.pk for o in created)
    # Not eager: a NEVER-ending daily rule must not have materialized hundreds of rows.
    assert TaskRecurrenceRule.objects.get(pk=rule.pk).generated_through == date(2026, 6, 15)


@pytest.mark.django_db
def test_weekly_only_generates_matching_weekdays(template: Task) -> None:
    # Monday (bit 1) + Wednesday (bit 4) = 5.
    rule = _make_rule(template, frequency=TaskRecurrenceFrequency.WEEKLY, weekdays=5)
    created = _generate_due_occurrences(rule, horizon_days=14, now=NOON)
    weekdays = {o.recurrence_occurrence_date.weekday() for o in created}
    assert weekdays <= {0, 2}  # only Mondays and Wednesdays
    assert created, "expected at least one weekly occurrence in a 14-day window"


@pytest.mark.django_db
def test_monthly_generates_on_day_of_month(template: Task) -> None:
    rule = _make_rule(template, frequency=TaskRecurrenceFrequency.MONTHLY, day_of_month=15)
    created = _generate_due_occurrences(rule, horizon_days=40, now=NOON)
    assert [o.recurrence_occurrence_date for o in created] == [date(2026, 6, 15)]


@pytest.mark.django_db
def test_monthly_clamps_day_to_month_length(template: Task) -> None:
    """day_of_month=31 fires on the last day of a 30-day month (June)."""
    rule = _make_rule(template, frequency=TaskRecurrenceFrequency.MONTHLY, day_of_month=31)
    created = _generate_due_occurrences(rule, horizon_days=40, now=NOON)
    assert date(2026, 6, 30) in {o.recurrence_occurrence_date for o in created}


@pytest.mark.django_db
def test_custom_interval_every_n_days(template: Task) -> None:
    rule = _make_rule(template, frequency=TaskRecurrenceFrequency.CUSTOM, interval=3)
    created = _generate_due_occurrences(rule, horizon_days=9, now=NOON)
    # Anchor 06-01, every 3 days within 06-01..06-10: 06-01, 06-04, 06-07, 06-10.
    assert [o.recurrence_occurrence_date for o in created] == [
        date(2026, 6, 1),
        date(2026, 6, 4),
        date(2026, 6, 7),
        date(2026, 6, 10),
    ]


# ---------------------------------------------------------------------------
# Lazy generator — end conditions
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_after_n_caps_total_occurrences(template: Task) -> None:
    rule = _make_rule(
        template,
        frequency=TaskRecurrenceFrequency.DAILY,
        end_type=RecurrenceEndType.AFTER_N,
        end_count=3,
    )
    first = _generate_due_occurrences(rule, horizon_days=14, now=NOON)
    assert len(first) == 3
    # A later sweep must not exceed the cap.
    second = _generate_due_occurrences(rule, horizon_days=14, now=datetime(2026, 6, 20, 12, 0))
    assert second == []
    assert rule.occurrences.count() == 3


@pytest.mark.django_db
def test_on_date_stops_at_end_date(template: Task) -> None:
    rule = _make_rule(
        template,
        frequency=TaskRecurrenceFrequency.DAILY,
        end_type=RecurrenceEndType.ON_DATE,
        end_date=date(2026, 6, 4),
    )
    created = _generate_due_occurrences(rule, horizon_days=30, now=NOON)
    dates = sorted(o.recurrence_occurrence_date for o in created)
    assert dates == [date(2026, 6, 1), date(2026, 6, 2), date(2026, 6, 3), date(2026, 6, 4)]


@pytest.mark.django_db
def test_generation_is_idempotent(template: Task) -> None:
    """Re-running over an already-materialized window creates no duplicates."""
    rule = _make_rule(template, frequency=TaskRecurrenceFrequency.DAILY)
    first = _generate_due_occurrences(rule, horizon_days=14, now=NOON)
    # Reset the cursor to force a full re-scan; the existence check is the backstop.
    TaskRecurrenceRule.objects.filter(pk=rule.pk).update(generated_through=None)
    rule.refresh_from_db()
    second = _generate_due_occurrences(rule, horizon_days=14, now=NOON)
    assert second == []
    assert rule.occurrences.count() == len(first)


# ---------------------------------------------------------------------------
# Lazy generator — inheritance toggles
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_inherit_assignee_true_copies_assignee(template: Task, user: object) -> None:
    template.assignee = user
    template.save(update_fields=["assignee"])
    rule = _make_rule(template, inherit_assignee=True)
    created = _generate_due_occurrences(rule, horizon_days=2, now=NOON)
    assert created and all(o.assignee_id == user.pk for o in created)


@pytest.mark.django_db
def test_inherit_assignee_false_leaves_unassigned(template: Task, user: object) -> None:
    template.assignee = user
    template.save(update_fields=["assignee"])
    rule = _make_rule(template, inherit_assignee=False)
    created = _generate_due_occurrences(rule, horizon_days=2, now=NOON)
    assert created and all(o.assignee_id is None for o in created)


@pytest.mark.django_db
def test_inherit_attachments_copies_attachment_rows(template: Task) -> None:
    TaskAttachment.objects.create(
        task=template, external_url="https://example.com/agenda", external_title="Agenda"
    )
    rule = _make_rule(template, inherit_attachments=True)
    created = _generate_due_occurrences(rule, horizon_days=1, now=NOON)
    assert created
    occ = created[0]
    copied = TaskAttachment.objects.filter(task=occ, is_deleted=False)
    assert copied.count() == 1
    assert copied.first().external_url == "https://example.com/agenda"


@pytest.mark.django_db
def test_occurrences_are_flat_not_wbs_nodes(template: Task) -> None:
    """Occurrences carry no wbs_path so they never enter summary rollups (ADR-0090)."""
    rule = _make_rule(template, frequency=TaskRecurrenceFrequency.DAILY)
    created = _generate_due_occurrences(rule, horizon_days=2, now=NOON)
    assert created and all(o.wbs_path is None for o in created)


# ---------------------------------------------------------------------------
# CPM-EXCLUSION INVARIANT — mandatory (#736 / ADR-0090)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_recurring_template_and_occurrences_excluded_from_cpm(
    project: Project, template: Task
) -> None:
    """The load-bearing invariant: a recurrence template and its generated
    occurrences MUST NOT receive CPM dates — they never enter the engine input set.
    """
    from trueppm_api.apps.scheduling.tasks import _run_schedule

    normal = Task.objects.create(project=project, name="real work", duration=3)
    rule = _make_rule(template, frequency=TaskRecurrenceFrequency.DAILY)
    occurrences = _generate_due_occurrences(rule, horizon_days=5, now=NOON)
    assert occurrences  # sanity: we actually generated some

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))

    normal.refresh_from_db()
    template.refresh_from_db()
    assert normal.early_start is not None, "a normal task must still be scheduled"
    assert template.early_start is None, "recurrence template leaked into CPM"
    for occ in occurrences:
        occ.refresh_from_db()
        assert occ.early_start is None, "generated occurrence leaked into CPM"


@pytest.mark.django_db
def test_cpm_drops_dependency_touching_a_recurring_task(project: Project, template: Task) -> None:
    """A dependency edge whose endpoint is a recurring task is dropped from the CPM
    feed so the engine never receives a dangling edge — and the recompute succeeds.
    """
    from trueppm_api.apps.projects.models import Dependency
    from trueppm_api.apps.scheduling.tasks import _run_schedule

    a = Task.objects.create(project=project, name="A", duration=2)
    _make_rule(template, frequency=TaskRecurrenceFrequency.DAILY)
    # Edge from a normal task to the recurring template — must be ignored by CPM.
    Dependency.objects.create(predecessor=a, successor=template, dep_type="FS")

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))  # must not raise

    a.refresh_from_db()
    template.refresh_from_db()
    assert a.early_start is not None
    assert template.early_start is None


@pytest.mark.django_db
def test_committed_manager_excludes_recurring_tasks(project: Project, template: Task) -> None:
    """Task.committed (Monte Carlo / capacity / PDF input) excludes recurring tasks."""
    normal = Task.objects.create(project=project, name="real", duration=1)
    rule = _make_rule(template, frequency=TaskRecurrenceFrequency.DAILY)
    _generate_due_occurrences(rule, horizon_days=3, now=NOON)

    committed_ids = {t.pk for t in Task.committed.filter(project=project)}
    assert normal.pk in committed_ids
    assert template.pk not in committed_ids
    assert not any(t.is_recurring for t in Task.committed.filter(project=project))


# ---------------------------------------------------------------------------
# Beat task wrapper — resilience
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_beat_task_isolates_per_rule_failures(project: Project, template: Task) -> None:
    """One malformed rule must not starve the rest of the sweep."""
    from trueppm_api.apps.projects.tasks import generate_recurring_occurrences

    good = _make_rule(template, frequency=TaskRecurrenceFrequency.DAILY)
    bad_task = Task.objects.create(project=project, name="bad", duration=1, planned_start=MONDAY)
    _make_rule(bad_task, frequency=TaskRecurrenceFrequency.DAILY)

    calls: list[object] = []

    def fake_generate(rule, **kwargs):  # type: ignore[no-untyped-def]
        calls.append(rule.pk)
        if rule.task_id == bad_task.pk:
            raise RuntimeError("boom")
        # Stand-in for a created occurrence: the sweep now reads .project_id/.id off
        # each returned task to group the post-commit broadcast (#1008), so a bare
        # object() no longer suffices.
        return [SimpleNamespace(project_id=str(project.pk), id="occ")]

    # Acquire the idempotent lock cleanly (truthy SET NX) so the body runs.
    mock_redis = MagicMock()
    mock_redis.set.return_value = True
    with (
        patch("trueppm_api.core.idempotent.redis_lib") as mock_redis_module,
        patch(
            "trueppm_api.apps.projects.services._generate_due_occurrences",
            side_effect=fake_generate,
        ),
    ):
        mock_redis_module.from_url.return_value = mock_redis
        generate_recurring_occurrences.run()  # must not raise despite the bad rule

    assert good.pk in calls
    assert len(calls) == 2  # both rules attempted; the failure was swallowed


# ---------------------------------------------------------------------------
# API / RBAC
# ---------------------------------------------------------------------------


def _client_for(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.mark.django_db(transaction=True)
def test_create_rule_requires_scheduler_role(project: Project, template: Task) -> None:
    member = User.objects.create_user(username="member", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    resp = _client_for(member).post(
        "/api/v1/recurrence-rules/",
        {"task": str(template.pk), "frequency": "DAILY", "end_type": "NEVER"},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db(transaction=True)
def test_scheduler_can_create_rule_and_template_leaves_cpm(
    project: Project, template: Task
) -> None:
    sched = User.objects.create_user(username="sched", password="pw")
    ProjectMembership.objects.create(project=project, user=sched, role=Role.SCHEDULER)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_task.delay = MagicMock(return_value=MagicMock(id="celery-id"))
        resp = _client_for(sched).post(
            "/api/v1/recurrence-rules/",
            {"task": str(template.pk), "frequency": "DAILY", "end_type": "NEVER"},
            format="json",
        )
    assert resp.status_code == 201, resp.content
    template.refresh_from_db()
    assert template.is_recurring is True


@pytest.mark.django_db(transaction=True)
def test_delete_rule_returns_template_to_cpm(project: Project, template: Task) -> None:
    sched = User.objects.create_user(username="sched2", password="pw")
    ProjectMembership.objects.create(project=project, user=sched, role=Role.SCHEDULER)
    rule = _make_rule(template, frequency=TaskRecurrenceFrequency.DAILY)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_task.delay = MagicMock(return_value=MagicMock(id="celery-id"))
        resp = _client_for(sched).delete(f"/api/v1/recurrence-rules/{rule.pk}/")
    assert resp.status_code == 204
    template.refresh_from_db()
    assert template.is_recurring is False


@pytest.mark.django_db
def test_member_can_read_rules(project: Project, template: Task) -> None:
    viewer = User.objects.create_user(username="viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
    _make_rule(template, frequency=TaskRecurrenceFrequency.DAILY)
    resp = _client_for(viewer).get(f"/api/v1/recurrence-rules/?project={project.pk}")
    assert resp.status_code == 200
    data = resp.data
    items = data["results"] if isinstance(data, dict) and "results" in data else data
    assert len(items) >= 1


@pytest.mark.django_db(transaction=True)
def test_weekly_rule_without_weekday_rejected_by_api(project: Project, template: Task) -> None:
    sched = User.objects.create_user(username="sched3", password="pw")
    ProjectMembership.objects.create(project=project, user=sched, role=Role.SCHEDULER)
    resp = _client_for(sched).post(
        "/api/v1/recurrence-rules/",
        {"task": str(template.pk), "frequency": "WEEKLY", "weekdays": 0, "end_type": "NEVER"},
        format="json",
    )
    assert resp.status_code == 400
    assert "weekdays" in resp.data


# ---------------------------------------------------------------------------
# Real-time broadcast on occurrence generation (#1008)
# ---------------------------------------------------------------------------

_BROADCAST = "trueppm_api.apps.sync.broadcast.broadcast_board_event"


@pytest.mark.django_db
def test_generation_broadcasts_bulk_event_per_project(
    project: Project,
    template: Task,
    calendar: Calendar,
    django_capture_on_commit_callbacks: object,
) -> None:
    """New occurrences must live-update open boards: one ``tasks_bulk_mutated`` event
    per project, carrying exactly that project's created occurrence ids (#1008).

    Anchors are in the past; the generator never back-fills (cursor = max(anchor,
    today)), so it materializes from today forward regardless of the literal date.
    """
    today = timezone.now().date()
    rule_a = _make_rule(
        template,
        frequency=TaskRecurrenceFrequency.DAILY,
        end_type=RecurrenceEndType.AFTER_N,
        end_count=2,
    )

    project_b = Project.objects.create(name="P2", start_date=today, calendar=calendar)
    template_b = Task.objects.create(
        project=project_b, name="Other standup", duration=1, planned_start=today
    )
    rule_b = _make_rule(
        template_b,
        frequency=TaskRecurrenceFrequency.DAILY,
        end_type=RecurrenceEndType.AFTER_N,
        end_count=2,
    )

    # Acquire the idempotent lock cleanly (truthy SET NX) so the body runs without a
    # real Valkey — the host test stack does not publish 6379 (mirrors
    # test_beat_task_isolates_per_rule_failures).
    mock_redis = MagicMock()
    mock_redis.set.return_value = True
    with (
        patch("trueppm_api.core.idempotent.redis_lib") as mock_redis_module,
        patch(_BROADCAST) as mock_bcast,
        django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
    ):
        mock_redis_module.from_url.return_value = mock_redis
        generate_recurring_occurrences.run()

    # One bulk event per project — no per-task spam.
    assert mock_bcast.call_count == 2
    by_project: dict[str, set[str]] = {}
    for call in mock_bcast.call_args_list:
        pid, event_type, payload = call.args
        assert event_type == "tasks_bulk_mutated"
        by_project[pid] = set(payload["task_ids"])

    occ_a = {str(t.id) for t in Task.objects.filter(recurrence_rule=rule_a)}
    occ_b = {str(t.id) for t in Task.objects.filter(recurrence_rule=rule_b)}
    assert occ_a and occ_b  # both rules actually generated something
    assert by_project == {str(project.pk): occ_a, str(project_b.pk): occ_b}


@pytest.mark.django_db
def test_no_new_occurrences_does_not_broadcast(
    template: Task, django_capture_on_commit_callbacks: object
) -> None:
    """A sweep that materializes nothing new (idempotent re-run after the end
    condition is met) must stay silent — no empty or spurious broadcast (#1008)."""
    _make_rule(
        template,
        frequency=TaskRecurrenceFrequency.DAILY,
        end_type=RecurrenceEndType.AFTER_N,
        end_count=2,
    )
    # Acquire the idempotent lock cleanly so the body runs without a real Valkey.
    mock_redis = MagicMock()
    mock_redis.set.return_value = True

    # First sweep materializes the 2 occurrences.
    with (
        patch("trueppm_api.core.idempotent.redis_lib") as mock_redis_module,
        patch(_BROADCAST),
        django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
    ):
        mock_redis_module.from_url.return_value = mock_redis
        generate_recurring_occurrences.run()

    # Second sweep finds nothing due (AFTER_N count reached) → no broadcast.
    with (
        patch("trueppm_api.core.idempotent.redis_lib") as mock_redis_module,
        patch(_BROADCAST) as mock_bcast,
        django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
    ):
        mock_redis_module.from_url.return_value = mock_redis
        generate_recurring_occurrences.run()
    mock_bcast.assert_not_called()
