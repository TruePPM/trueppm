"""Config-change notice outbox, worker, drain and cooldown (#3009, ADR-1174).

The rendering and cohort of a notice are pinned in ``test_config_change_notice``,
which runs every queued notice inline through the root conftest. This file pins what
that inline run deliberately hides: that the request writes a row and no notice, that
the row survives a broker outage and a lost worker, and that the cooldown collapses a
repeat of the latest notice without ever collapsing a different one.
"""

from __future__ import annotations

from datetime import date, timedelta
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import redis
from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import Notification, NotificationEventType
from trueppm_api.apps.projects import config_notice, tasks
from trueppm_api.apps.projects.models import (
    BoardColumnConfig,
    Calendar,
    ConfigNoticeRequest,
    ConfigNoticeRequestStatus,
    Methodology,
    Project,
    Task,
)

User = get_user_model()

CANONICAL = ["BACKLOG", "NOT_STARTED", "IN_PROGRESS", "REVIEW", "COMPLETE"]
EVENT = NotificationEventType.PROJECT_CONFIG_CHANGED.value


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def columns(
    *,
    lanes_by_status: dict[str, list[dict[str, Any]]] | None = None,
    hidden: set[str] | None = None,
) -> list[dict[str, Any]]:
    lanes_by_status = lanes_by_status or {}
    hidden = hidden or set()
    return [
        {
            "status": status,
            "label": status.title().replace("_", " "),
            "visible": status not in hidden,
            "color": None,
            "wip_limit": None,
            "age_threshold_days": None,
            "lanes": lanes_by_status.get(status, []),
        }
        for status in CANONICAL
    ]


def lane(key: str, label: str) -> dict[str, Any]:
    return {"key": key, "label": label, "wip_limit": None}


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


def make_project(calendar: Calendar, name: str = "Atlas") -> Project:
    return Project.objects.create(
        name=name,
        start_date=date(2026, 1, 1),
        calendar=calendar,
        methodology=Methodology.AGILE,
    )


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return make_project(calendar)


def member(project: Project, role: int, username: str) -> Any:
    user = User.objects.filter(username=username).first() or User.objects.create_user(
        username=username, password="pw"
    )
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


def with_work(project: Project, username: str) -> Any:
    """A Member who owns a task, so every board and surface notice reaches them."""
    user = member(project, Role.MEMBER, username)
    Task.objects.create(project=project, name=f"{username}-task", assignee=user)
    return user


def client_for(user: Any) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def put_board(actor: Any, project: Project, cols: list[dict[str, Any]], capture: Any) -> None:
    with capture(execute=True):
        resp = client_for(actor).put(
            f"/api/v1/projects/{project.pk}/board-config/", data={"columns": cols}, format="json"
        )
    assert resp.status_code == 200, resp.content


def switch_preset(actor: Any, project: Project, to: str, capture: Any) -> None:
    with capture(execute=True):
        resp = client_for(actor).patch(
            f"/api/v1/projects/{project.pk}/", data={"methodology": to}, format="json"
        )
    assert resp.status_code == 200, resp.content


def inbox(user: Any) -> list[Notification]:
    return list(Notification.objects.filter(recipient=user, event_type=EVENT))


def queued_lane_removal(project: Project, actor: Any) -> ConfigNoticeRequest:
    """Enqueue a lane-removal notice without dispatching it anywhere."""
    config_notice.notify_board_config_change(
        project,
        old_columns=columns(lanes_by_status={"REVIEW": [lane("qa", "QA")]}),
        new_columns=columns(),
        actor=actor,
    )
    return ConfigNoticeRequest.objects.get()


def age(
    row: ConfigNoticeRequest, *, requested: timedelta, claimed: timedelta | None = None
) -> None:
    """Move a row's clocks into the past; ``update()`` bypasses ``auto_now_add``."""
    now = timezone.now()
    fields: dict[str, Any] = {"requested_at": now - requested}
    if claimed is not None:
        fields["claimed_at"] = now - claimed
    ConfigNoticeRequest.objects.filter(pk=row.pk).update(**fields)


def status_of(row: ConfigNoticeRequest) -> str:
    return ConfigNoticeRequest.objects.values_list("status", flat=True).get(pk=row.pk)


class FakeValkey:
    """Just enough of a Valkey client for the cooldown: MGET and a SET pipeline."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.expiry: dict[str, int | None] = {}

    def mget(self, keys: list[str]) -> list[str | None]:
        return [self.store.get(key) for key in keys]

    def pipeline(self, transaction: bool = True) -> FakePipeline:
        return FakePipeline(self)


class FakePipeline:
    def __init__(self, owner: FakeValkey) -> None:
        self.owner = owner
        self.ops: list[tuple[str, str, int | None]] = []

    def set(self, key: str, value: str, ex: int | None = None) -> FakePipeline:
        self.ops.append((key, value, ex))
        return self

    def execute(self) -> list[bool]:
        for key, value, ex in self.ops:
            self.owner.store[key] = value
            self.owner.expiry[key] = ex
        return [True] * len(self.ops)


@pytest.fixture
def cooldown(settings: Any, monkeypatch: pytest.MonkeyPatch) -> FakeValkey:
    """The shipped ten-minute cooldown, against an in-memory Valkey."""
    settings.TRUEPPM_CONFIG_NOTICE_COOLDOWN_SECONDS = 600
    fake = FakeValkey()
    monkeypatch.setattr("trueppm_api.core.valkey.client", lambda *args, **kwargs: fake)
    return fake


# ---------------------------------------------------------------------------
# The request writes a row, never a notice
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_the_write_queues_one_row_and_writes_no_notice_in_the_request(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """The acceptance criterion of #3009: rendering and inserts leave the request.

    ``delay`` is replaced by a bare stub here — overriding the conftest's inline run —
    so anything written before the worker runs was written by the request itself.
    """
    actor = member(project, Role.SCHEDULER, "sched")
    priya = with_work(project, "priya")
    BoardColumnConfig.objects.create(
        project=project, columns=columns(lanes_by_status={"REVIEW": [lane("qa", "QA")]})
    )

    with patch.object(
        tasks.emit_config_notice, "delay", return_value=SimpleNamespace(id="celery-1")
    ) as delay:
        put_board(actor, project, columns(), django_capture_on_commit_callbacks)

    row = ConfigNoticeRequest.objects.get()
    delay.assert_called_once_with(str(row.pk))
    assert row.kind == config_notice.KIND_BOARD
    assert row.status == ConfigNoticeRequestStatus.DISPATCHED
    assert row.celery_task_id == "celery-1"
    assert row.actor_id == actor.pk
    assert inbox(priya) == [], "the request thread must not write the notice"

    config_notice.run_config_notice_request(str(row.pk))

    assert len(inbox(priya)) == 1
    row.refresh_from_db()
    assert row.status == ConfigNoticeRequestStatus.DONE
    assert row.attempt_count == 1
    assert row.completed_at is not None


@pytest.mark.django_db
def test_a_rolled_back_write_leaves_no_row_and_dispatches_nothing(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """The row is atomic with the write it describes — the property ``.delay()`` lacks."""
    actor = member(project, Role.SCHEDULER, "sched")
    with (
        patch.object(tasks.emit_config_notice, "delay") as delay,
        django_capture_on_commit_callbacks(execute=True),
        pytest.raises(RuntimeError),
        transaction.atomic(),
    ):
        queued_lane_removal(project, actor)
        raise RuntimeError("the config write was refused")

    assert not ConfigNoticeRequest.objects.exists()
    delay.assert_not_called()


@pytest.mark.django_db
def test_a_change_that_moves_nothing_queues_nothing(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """A rename or reorder still costs the request no row at all."""
    actor = member(project, Role.SCHEDULER, "sched")
    put_board(actor, project, columns(), django_capture_on_commit_callbacks)
    assert not ConfigNoticeRequest.objects.exists()


@pytest.mark.django_db
def test_a_broker_outage_at_commit_leaves_the_row_for_the_drain(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """The durability hole a bare ``.delay()`` would have opened, closed.

    The write succeeds, the row stays pending, the drain leaves it alone inside the
    orphan window (its own dispatch may still be in flight), and sends it after.
    """
    actor = member(project, Role.SCHEDULER, "sched")
    priya = with_work(project, "priya")
    BoardColumnConfig.objects.create(
        project=project, columns=columns(lanes_by_status={"REVIEW": [lane("qa", "QA")]})
    )

    with patch.object(tasks.emit_config_notice, "delay", side_effect=OSError("broker down")):
        put_board(actor, project, columns(), django_capture_on_commit_callbacks)

    row = ConfigNoticeRequest.objects.get()
    assert row.status == ConfigNoticeRequestStatus.PENDING
    assert inbox(priya) == []

    with patch.object(tasks.emit_config_notice, "delay") as delay:
        tasks._do_config_notice_drain()
    delay.assert_not_called()

    age(row, requested=timedelta(minutes=6))
    with patch.object(
        tasks.emit_config_notice, "delay", return_value=SimpleNamespace(id="celery-2")
    ) as delay:
        tasks._do_config_notice_drain()
    delay.assert_called_once_with(str(row.pk))
    assert status_of(row) == ConfigNoticeRequestStatus.DISPATCHED

    config_notice.run_config_notice_request(str(row.pk))
    assert len(inbox(priya)) == 1


@pytest.mark.django_db
def test_a_second_delivery_of_the_same_row_is_a_no_op(project: Project) -> None:
    """At-least-once delivery must not become twice-delivered notices."""
    actor = member(project, Role.SCHEDULER, "sched")
    priya = with_work(project, "priya")
    task = Task.objects.get(assignee=priya)
    Task.objects.filter(pk=task.pk).update(board_lane="qa", status="REVIEW")

    with patch.object(tasks.emit_config_notice, "delay"):
        row = queued_lane_removal(project, actor)

    config_notice.run_config_notice_request(str(row.pk))
    config_notice.run_config_notice_request(str(row.pk))

    assert len(inbox(priya)) == 1
    row.refresh_from_db()
    assert row.attempt_count == 1


@pytest.mark.django_db
def test_the_drain_recovers_a_row_whose_worker_was_lost(project: Project) -> None:
    actor = member(project, Role.SCHEDULER, "sched")
    priya = with_work(project, "priya")
    with patch.object(tasks.emit_config_notice, "delay"):
        row = queued_lane_removal(project, actor)
    ConfigNoticeRequest.objects.filter(pk=row.pk).update(
        status=ConfigNoticeRequestStatus.RUNNING, attempt_count=1
    )
    age(row, requested=timedelta(minutes=12), claimed=timedelta(minutes=11))

    with patch.object(
        tasks.emit_config_notice, "delay", return_value=SimpleNamespace(id="celery-3")
    ) as delay:
        tasks._do_config_notice_drain()

    delay.assert_called_once_with(str(row.pk))
    assert status_of(row) == ConfigNoticeRequestStatus.DISPATCHED

    config_notice.run_config_notice_request(str(row.pk))
    assert len(inbox(priya)) == 1
    row.refresh_from_db()
    assert row.status == ConfigNoticeRequestStatus.DONE
    assert row.attempt_count == 2


@pytest.mark.django_db
def test_the_drain_leaves_a_live_worker_alone(project: Project) -> None:
    """A row claimed inside the recovery window is still running — never re-driven."""
    actor = member(project, Role.SCHEDULER, "sched")
    with patch.object(tasks.emit_config_notice, "delay"):
        row = queued_lane_removal(project, actor)
    ConfigNoticeRequest.objects.filter(pk=row.pk).update(
        status=ConfigNoticeRequestStatus.RUNNING, attempt_count=1
    )
    age(row, requested=timedelta(minutes=12), claimed=timedelta(minutes=2))

    with patch.object(tasks.emit_config_notice, "delay") as delay:
        tasks._do_config_notice_drain()

    delay.assert_not_called()
    assert status_of(row) == ConfigNoticeRequestStatus.RUNNING


@pytest.mark.django_db
def test_the_drain_abandons_a_row_that_spent_its_attempts(project: Project) -> None:
    actor = member(project, Role.SCHEDULER, "sched")
    with patch.object(tasks.emit_config_notice, "delay"):
        row = queued_lane_removal(project, actor)
    ConfigNoticeRequest.objects.filter(pk=row.pk).update(
        status=ConfigNoticeRequestStatus.RUNNING,
        attempt_count=config_notice.MAX_CONFIG_NOTICE_ATTEMPTS,
    )
    age(row, requested=timedelta(minutes=30), claimed=timedelta(minutes=11))

    with patch.object(tasks.emit_config_notice, "delay") as delay:
        tasks._do_config_notice_drain()

    delay.assert_not_called()
    row.refresh_from_db()
    assert row.status == ConfigNoticeRequestStatus.DEAD
    assert row.completed_at is not None


@pytest.mark.django_db
def test_an_unreadable_payload_retries_then_dies() -> None:
    """A structural failure goes back to the drain, and stops at the budget."""
    row = ConfigNoticeRequest.objects.create(kind=config_notice.KIND_BOARD, payload={"nope": 1})

    for attempt in range(1, config_notice.MAX_CONFIG_NOTICE_ATTEMPTS):
        config_notice.run_config_notice_request(str(row.pk))
        row.refresh_from_db()
        assert (row.status, row.attempt_count) == (ConfigNoticeRequestStatus.PENDING, attempt)

    config_notice.run_config_notice_request(str(row.pk))
    row.refresh_from_db()
    assert row.status == ConfigNoticeRequestStatus.DEAD
    assert row.attempt_count == config_notice.MAX_CONFIG_NOTICE_ATTEMPTS


@pytest.mark.django_db
def test_the_purge_deletes_only_old_finished_rows() -> None:
    def row(status: str, days_old: int) -> ConfigNoticeRequest:
        created = ConfigNoticeRequest.objects.create(
            kind=config_notice.KIND_BOARD, payload={}, status=status
        )
        age(created, requested=timedelta(days=days_old))
        return created

    old_done = row(ConfigNoticeRequestStatus.DONE, 8)
    old_dead = row(ConfigNoticeRequestStatus.DEAD, 8)
    recent_done = row(ConfigNoticeRequestStatus.DONE, 1)
    old_pending = row(ConfigNoticeRequestStatus.PENDING, 8)

    tasks._do_config_notice_purge()

    remaining = set(ConfigNoticeRequest.objects.values_list("pk", flat=True))
    assert remaining == {recent_done.pk, old_pending.pk}
    assert old_done.pk not in remaining
    assert old_dead.pk not in remaining


@pytest.mark.django_db
def test_a_queued_surface_notice_writes_exactly_what_the_direct_emit_did(
    calendar: Calendar, django_capture_on_commit_callbacks: Any
) -> None:
    """The JSON round trip through the outbox changes nothing a recipient reads.

    The expectation comes from calling the emitter directly with the in-memory
    changes, which is what the request thread did before #3009 — reading it back from
    the queued path would be a tautology.
    """
    actor = User.objects.create_user(username="dana", password="pw", first_name="Dana")
    changes = []
    for idx in range(3):
        proj = make_project(calendar, name=f"P{idx}")
        with_work(proj, f"member{idx}")
        member(proj, Role.SCHEDULER, f"sched{idx}")
        changes.append(
            config_notice.SurfaceChange(
                project_id=str(proj.pk),
                before=config_notice.ProjectSurfaceSnapshot(
                    methodology=Methodology.AGILE,
                    visibility={"reporting": True, "baselines": False, "monte_carlo": False},
                ),
                after=config_notice.ProjectSurfaceSnapshot(
                    methodology=Methodology.WATERFALL,
                    visibility={"reporting": True, "baselines": True, "monte_carlo": True},
                ),
            )
        )

    def written() -> set[tuple[Any, ...]]:
        return {
            (str(n.recipient_id), str(n.project_id), n.subject, n.body, n.email_pending)
            for n in Notification.objects.filter(event_type=EVENT)
        }

    config_notice._emit_surface_notifications(changes, actor.pk, config_notice._actor_name(actor))
    direct = written()
    Notification.objects.all().delete()

    with django_capture_on_commit_callbacks(execute=True):
        config_notice.notify_surface_changes(changes, actor=actor)

    assert written() == direct
    assert len(direct) == 6


@pytest.mark.django_db
def test_the_bulk_matrix_does_no_notice_work_in_the_request(
    calendar: Calendar, django_capture_on_commit_callbacks: Any
) -> None:
    """The perf-check HIGH from !2050: at 200 projects the emit held the response.

    The emitter is swapped for a sentinel for the duration of the request, so any
    call to it is the request doing notice work. The one queued row then produces
    every project's notice once the worker runs it.
    """
    from trueppm_api.apps.access.models import ProgramMembership
    from trueppm_api.apps.projects.models import Program
    from trueppm_api.apps.workspace.models import Workspace, WorkspaceMembership, WorkspaceRole

    admin = User.objects.create_user(username="progadmin", password="pw")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=admin, role=WorkspaceRole.ADMIN
    )
    program = Program.objects.create(name="Atlas Program")
    ProgramMembership.objects.create(program=program, user=admin, role=Role.OWNER)
    targets = []
    for idx in range(3):
        proj = Project.objects.create(
            name=f"Matrix {idx}",
            start_date=date(2026, 1, 1),
            calendar=calendar,
            program=program,
            methodology=Methodology.AGILE,
        )
        targets.append((proj, with_work(proj, f"matrix-member-{idx}")))

    with (
        patch.object(
            tasks.emit_config_notice, "delay", return_value=SimpleNamespace(id="celery-bulk")
        ) as delay,
        patch.object(config_notice, "_emit_surface_notifications") as emit,
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client_for(admin).post(
            f"/api/v1/programs/{program.pk}/bulk-project-fields/",
            {
                "ids": [str(proj.pk) for proj, _ in targets],
                "fields": {"methodology": Methodology.WATERFALL},
            },
            format="json",
        )

    assert resp.status_code == 200, resp.content
    emit.assert_not_called()
    assert not Notification.objects.filter(event_type=EVENT).exists()
    row = ConfigNoticeRequest.objects.get()
    delay.assert_called_once_with(str(row.pk))
    assert row.kind == config_notice.KIND_SURFACE
    assert {change["project_id"] for change in row.payload["changes"]} == {
        str(proj.pk) for proj, _ in targets
    }

    config_notice.run_config_notice_request(str(row.pk))

    for _, person in targets:
        assert len(inbox(person)) == 1


# ---------------------------------------------------------------------------
# Cooldown — a repeat of the latest notice collapses, nothing else does
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_hide_show_hide_by_the_same_person_notifies_once(
    project: Project, django_capture_on_commit_callbacks: Any, cooldown: FakeValkey
) -> None:
    """The cycle #3009 names. Showing a column notifies nobody, so the last notice
    sent still describes the board — the second hide has nothing new to say."""
    dana = member(project, Role.SCHEDULER, "dana")
    priya = with_work(project, "priya")

    put_board(dana, project, columns(hidden={"REVIEW"}), django_capture_on_commit_callbacks)
    put_board(dana, project, columns(), django_capture_on_commit_callbacks)
    put_board(dana, project, columns(hidden={"REVIEW"}), django_capture_on_commit_callbacks)

    assert len(inbox(priya)) == 1
    rows = list(ConfigNoticeRequest.objects.order_by("requested_at"))
    assert [r.status for r in rows] == [ConfigNoticeRequestStatus.DONE] * 2, (
        "a suppressed notice is still a finished row, not a stuck one"
    )
    assert set(cooldown.expiry.values()) == {600}


@pytest.mark.django_db
def test_the_same_change_by_someone_else_always_sends(
    project: Project, django_capture_on_commit_callbacks: Any, cooldown: FakeValkey
) -> None:
    dana = member(project, Role.SCHEDULER, "dana")
    sam = member(project, Role.SCHEDULER, "sam")
    priya = with_work(project, "priya")

    put_board(dana, project, columns(hidden={"REVIEW"}), django_capture_on_commit_callbacks)
    put_board(dana, project, columns(), django_capture_on_commit_callbacks)
    put_board(sam, project, columns(hidden={"REVIEW"}), django_capture_on_commit_callbacks)

    assert len(inbox(priya)) == 2


@pytest.mark.django_db
def test_a_different_change_by_the_same_person_always_sends(
    project: Project, django_capture_on_commit_callbacks: Any, cooldown: FakeValkey
) -> None:
    """The obvious dedupe on (project, event type) would have swallowed this one."""
    dana = member(project, Role.SCHEDULER, "dana")
    priya = with_work(project, "priya")

    put_board(dana, project, columns(hidden={"REVIEW"}), django_capture_on_commit_callbacks)
    put_board(dana, project, columns(), django_capture_on_commit_callbacks)
    put_board(dana, project, columns(hidden={"IN_PROGRESS"}), django_capture_on_commit_callbacks)

    assert len(inbox(priya)) == 2


@pytest.mark.django_db
def test_a_preset_flip_flop_never_leaves_a_stale_latest_notice(
    project: Project, django_capture_on_commit_callbacks: Any, cooldown: FakeValkey
) -> None:
    """Agile→Waterfall→Agile→Waterfall must send all three.

    A cooldown matching "any recent notice" would suppress the third flip because the
    first one matched it — leaving "This project now runs as Agile" as the recipient's
    latest word about a project that runs as Waterfall.
    """
    dana = member(project, Role.SCHEDULER, "dana")
    priya = with_work(project, "priya")

    for preset in (Methodology.WATERFALL, Methodology.AGILE, Methodology.WATERFALL):
        switch_preset(dana, project, preset, django_capture_on_commit_callbacks)

    subjects = [
        n.subject for n in Notification.objects.filter(recipient=priya).order_by("created_at")
    ]
    assert subjects == [
        "This project now runs as Waterfall",
        "This project now runs as Agile",
        "This project now runs as Waterfall",
    ]


@pytest.mark.django_db
def test_a_repeat_after_someone_elses_notice_sends(
    project: Project, django_capture_on_commit_callbacks: Any, cooldown: FakeValkey
) -> None:
    """The key is per project, not per actor: Sam's notice is now the latest word."""
    dana = member(project, Role.SCHEDULER, "dana")
    sam = member(project, Role.SCHEDULER, "sam")
    priya = with_work(project, "priya")

    switch_preset(dana, project, Methodology.WATERFALL, django_capture_on_commit_callbacks)
    switch_preset(sam, project, Methodology.AGILE, django_capture_on_commit_callbacks)
    switch_preset(dana, project, Methodology.WATERFALL, django_capture_on_commit_callbacks)

    assert len(inbox(priya)) == 3


@pytest.mark.django_db
def test_a_repeat_after_the_window_expires_sends(
    project: Project, django_capture_on_commit_callbacks: Any, cooldown: FakeValkey
) -> None:
    dana = member(project, Role.SCHEDULER, "dana")
    priya = with_work(project, "priya")

    put_board(dana, project, columns(hidden={"REVIEW"}), django_capture_on_commit_callbacks)
    put_board(dana, project, columns(), django_capture_on_commit_callbacks)
    cooldown.store.clear()  # the TTL elapsed
    put_board(dana, project, columns(hidden={"REVIEW"}), django_capture_on_commit_callbacks)

    assert len(inbox(priya)) == 2


@pytest.mark.django_db
def test_a_re_driven_row_does_not_suppress_itself(project: Project, cooldown: FakeValkey) -> None:
    """A worker that dies mid-emit is re-run by the drain; its own cooldown key must
    not read as a repeat, or every chunk it had not written yet is lost."""
    dana = member(project, Role.SCHEDULER, "dana")
    priya = with_work(project, "priya")
    with patch.object(tasks.emit_config_notice, "delay"):
        row = queued_lane_removal(project, dana)

    config_notice.run_config_notice_request(str(row.pk))
    assert cooldown.store, "the first run must record the notice it sent"

    # The drain's recovery after a lost worker: the notice was never durably done.
    Notification.objects.all().delete()
    ConfigNoticeRequest.objects.filter(pk=row.pk).update(status=ConfigNoticeRequestStatus.PENDING)
    config_notice.run_config_notice_request(str(row.pk))

    assert len(inbox(priya)) == 1


@pytest.mark.django_db
def test_only_the_repeating_project_in_a_batch_is_suppressed(
    calendar: Calendar, django_capture_on_commit_callbacks: Any, cooldown: FakeValkey
) -> None:
    """The bulk matrix sends one row for many projects; the cooldown is per project."""
    dana = User.objects.create_user(username="dana", password="pw")
    repeat = make_project(calendar, "Repeat")
    fresh = make_project(calendar, "Fresh")
    repeat_member = with_work(repeat, "r-member")
    fresh_member = with_work(fresh, "f-member")

    def change(proj: Project, to: str) -> Any:
        keys = dict.fromkeys(config_notice.ENFORCED_SURFACE_KEYS, True)
        return config_notice.SurfaceChange(
            project_id=str(proj.pk),
            before=config_notice.ProjectSurfaceSnapshot(
                methodology=Methodology.AGILE, visibility=keys
            ),
            after=config_notice.ProjectSurfaceSnapshot(methodology=to, visibility=keys),
        )

    with django_capture_on_commit_callbacks(execute=True):
        config_notice.notify_surface_changes(
            [change(repeat, Methodology.WATERFALL), change(fresh, Methodology.WATERFALL)],
            actor=dana,
        )
    with django_capture_on_commit_callbacks(execute=True):
        config_notice.notify_surface_changes(
            [change(repeat, Methodology.WATERFALL), change(fresh, Methodology.HYBRID)], actor=dana
        )

    assert len(inbox(repeat_member)) == 1
    assert len(inbox(fresh_member)) == 2


@pytest.mark.django_db
def test_a_valkey_error_sends_the_notice(
    project: Project, django_capture_on_commit_callbacks: Any, cooldown: FakeValkey
) -> None:
    """Fail open: the cooldown only removes noise and must never lose a notice."""
    dana = member(project, Role.SCHEDULER, "dana")
    priya = with_work(project, "priya")
    cooldown.mget = MagicMock(side_effect=redis.ConnectionError("valkey down"))  # type: ignore[method-assign]

    put_board(dana, project, columns(hidden={"REVIEW"}), django_capture_on_commit_callbacks)
    put_board(dana, project, columns(), django_capture_on_commit_callbacks)
    put_board(dana, project, columns(hidden={"REVIEW"}), django_capture_on_commit_callbacks)

    assert len(inbox(priya)) == 2


@pytest.mark.django_db
def test_a_zero_window_disables_the_cooldown(
    project: Project,
    django_capture_on_commit_callbacks: Any,
    cooldown: FakeValkey,
    settings: Any,
) -> None:
    settings.TRUEPPM_CONFIG_NOTICE_COOLDOWN_SECONDS = 0
    dana = member(project, Role.SCHEDULER, "dana")
    priya = with_work(project, "priya")

    put_board(dana, project, columns(hidden={"REVIEW"}), django_capture_on_commit_callbacks)
    put_board(dana, project, columns(), django_capture_on_commit_callbacks)
    put_board(dana, project, columns(hidden={"REVIEW"}), django_capture_on_commit_callbacks)

    assert len(inbox(priya)) == 2
    assert cooldown.store == {}


@pytest.mark.django_db
def test_a_change_with_no_actor_is_never_suppressed(
    project: Project, django_capture_on_commit_callbacks: Any, cooldown: FakeValkey
) -> None:
    """Nothing to key on, and a system write is not the repeatable human cycle."""
    priya = with_work(project, "priya")
    for _ in range(2):
        with django_capture_on_commit_callbacks(execute=True):
            config_notice.notify_board_config_change(
                project,
                old_columns=columns(),
                new_columns=columns(hidden={"REVIEW"}),
                actor=None,
            )

    assert len(inbox(priya)) == 2
    assert cooldown.store == {}
