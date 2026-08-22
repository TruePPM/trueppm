"""Config-change notice — a change to the shared surface tells everyone on it (#2972).

The property under test throughout is the one the issue exists for: the notice
names **what changed and what it means for the recipient's work**, not that a
setting was saved. Several assertions therefore pin the *absence* of
configuration-speak as hard as they pin the presence of the consequence — a
future refactor that collapses the per-recipient body into one generic string
would keep every "a notification was created" assertion green.
"""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import (
    DEFAULT_PREFERENCES,
    Notification,
    NotificationChannel,
    NotificationEventType,
    NotificationPreference,
)
from trueppm_api.apps.projects.models import (
    BoardColumnConfig,
    Calendar,
    Methodology,
    Program,
    Project,
    Task,
)
from trueppm_api.apps.resources.models import Resource, TaskResource

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


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Atlas",
        start_date=date(2026, 1, 1),
        calendar=calendar,
        methodology=Methodology.AGILE,
    )


def member(project: Project, role: int, username: str) -> Any:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


def client_for(user: Any) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def task_for_assignee(project: Project, user: Any, *, name: str, **kwargs: Any) -> Task:
    """A task the user owns via the bare ``assignee`` FK (no TaskResource)."""
    return Task.objects.create(project=project, name=name, assignee=user, **kwargs)


def task_for_resource(project: Project, user: Any, *, name: str, **kwargs: Any) -> Task:
    """A task the user owns via a ``TaskResource`` assignment (no ``assignee``)."""
    task = Task.objects.create(project=project, name=name, **kwargs)
    resource = Resource.objects.create(name=f"res-{user.username}", user=user)
    TaskResource.objects.create(task=task, resource=resource, units=1)
    return task


def config_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/board-config/"


def inbox(user: Any) -> list[Notification]:
    return list(Notification.objects.filter(recipient=user, event_type=EVENT))


def only(user: Any) -> Notification:
    rows = inbox(user)
    assert len(rows) == 1, f"expected exactly one notice for {user.username}, got {len(rows)}"
    return rows[0]


# ---------------------------------------------------------------------------
# Preference wiring — the "enum member nothing dispatches" guard
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_the_event_has_default_preferences_on_both_channels() -> None:
    """Without both rows the dispatcher silently creates nothing.

    ``create_event_notifications_batch`` resolves an unknown ``(event, channel)``
    to ``False``, so an enum member added without its ``DEFAULT_PREFERENCES``
    entries is a control that persists, renders in the settings matrix, and is
    dispatched by nothing. This is the assertion that makes that unmissable.
    """
    rows = {(et, ch): enabled for et, ch, enabled in DEFAULT_PREFERENCES}
    assert rows[(NotificationEventType.PROJECT_CONFIG_CHANGED, NotificationChannel.IN_APP)] is True
    assert rows[(NotificationEventType.PROJECT_CONFIG_CHANGED, NotificationChannel.EMAIL)] is False


@pytest.mark.django_db
def test_the_event_is_categorized_as_a_project_event() -> None:
    from trueppm_api.apps.notifications.categories import CATEGORY_PROJECT, category_for

    assert category_for(EVENT) == CATEGORY_PROJECT


@pytest.mark.django_db
def test_a_recipient_who_muted_the_type_gets_nothing(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """The preference is read, not merely stored."""
    actor = member(project, Role.SCHEDULER, "sched")
    muted = member(project, Role.MEMBER, "muted")
    task_for_assignee(project, muted, name="Card", board_lane="qa")
    NotificationPreference.objects.create(
        user=muted, event_type=EVENT, channel=NotificationChannel.IN_APP, enabled=False
    )

    BoardColumnConfig.objects.create(
        project=project, columns=columns(lanes_by_status={"REVIEW": [lane("qa", "QA")]})
    )
    with django_capture_on_commit_callbacks(execute=True):
        resp = client_for(actor).put(
            config_url(project), data={"columns": columns()}, format="json"
        )
    assert resp.status_code == 200
    assert inbox(muted) == []


# ---------------------------------------------------------------------------
# Trigger 1 — a lane is removed
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_removing_a_lane_tells_every_assignee_how_much_of_their_work_moved(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """The headline case. Each recipient's count is their OWN, not the total."""
    actor = member(project, Role.SCHEDULER, "sched")
    priya = member(project, Role.MEMBER, "priya")
    sam = member(project, Role.MEMBER, "sam")

    for i in range(3):
        task_for_assignee(project, priya, name=f"P{i}", status="REVIEW", board_lane="qa")
    task_for_resource(project, sam, name="S0", status="REVIEW", board_lane="qa")

    BoardColumnConfig.objects.create(
        project=project,
        columns=columns(lanes_by_status={"REVIEW": [lane("review", "Review"), lane("qa", "QA")]}),
    )
    with django_capture_on_commit_callbacks(execute=True):
        resp = client_for(actor).put(
            config_url(project),
            data={"columns": columns(lanes_by_status={"REVIEW": [lane("review", "Review")]})},
            format="json",
        )
    assert resp.status_code == 200

    priya_row = only(priya)
    assert "“QA”" in priya_row.body
    assert "Your 3 items" in priya_row.body
    # It names the destination the board will actually resolve an orphaned key to
    # — the column's FIRST lane — not merely that the lane is gone.
    assert "“Review”" in priya_row.body
    assert "3 items moved" in priya_row.subject

    sam_row = only(sam)
    assert "Your 1 item" in sam_row.body

    # The person who clicked is not told about their own click.
    assert inbox(actor) == []


@pytest.mark.django_db
def test_the_notice_names_the_consequence_and_never_the_setting(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """ "Board configuration updated" is the notification this issue refuses.

    Pinned as an explicit negative because every other assertion in this file
    would stay green if the body regressed to naming the write.
    """
    actor = member(project, Role.SCHEDULER, "sched")
    priya = member(project, Role.MEMBER, "priya")
    task_for_assignee(project, priya, name="P0", status="REVIEW", board_lane="qa")

    BoardColumnConfig.objects.create(
        project=project, columns=columns(lanes_by_status={"REVIEW": [lane("qa", "QA")]})
    )
    with django_capture_on_commit_callbacks(execute=True):
        client_for(actor).put(config_url(project), data={"columns": columns()}, format="json")

    row = only(priya)
    text = f"{row.subject} {row.body}".lower()
    for banned in ("configuration updated", "settings were saved", "setting was saved"):
        assert banned not in text
    # It says what happened to their work, in their words.
    assert "your 1 item" in text
    assert "moved" in text or "now show" in text


@pytest.mark.django_db
def test_a_recipient_with_nothing_in_the_lane_is_told_so_plainly(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """Zero is information. The surface changed for them too, so they are told —
    and the body says the count honestly rather than omitting the clause, which
    would make "no items" read like an unstated many."""
    actor = member(project, Role.SCHEDULER, "sched")
    bystander = member(project, Role.MEMBER, "bystander")
    task_for_assignee(project, bystander, name="B0", status="NOT_STARTED")

    BoardColumnConfig.objects.create(
        project=project, columns=columns(lanes_by_status={"REVIEW": [lane("qa", "QA")]})
    )
    with django_capture_on_commit_callbacks(execute=True):
        client_for(actor).put(config_url(project), data={"columns": columns()}, format="json")

    assert "None of your items were in it." in only(bystander).body


@pytest.mark.django_db
def test_a_non_assignee_member_is_not_notified(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """Recipients are everyone ASSIGNED, not the whole membership."""
    actor = member(project, Role.SCHEDULER, "sched")
    assigned = member(project, Role.MEMBER, "assigned")
    unassigned = member(project, Role.VIEWER, "unassigned")
    task_for_assignee(project, assigned, name="A0", status="REVIEW", board_lane="qa")

    BoardColumnConfig.objects.create(
        project=project, columns=columns(lanes_by_status={"REVIEW": [lane("qa", "QA")]})
    )
    with django_capture_on_commit_callbacks(execute=True):
        client_for(actor).put(config_url(project), data={"columns": columns()}, format="json")

    assert len(inbox(assigned)) == 1
    assert inbox(unassigned) == []


@pytest.mark.django_db
def test_a_removed_member_who_still_holds_work_is_not_notified(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """Membership removal is a soft delete. Naming a project's internal structure
    to someone who can no longer open it is a dead link and a scope leak."""
    actor = member(project, Role.SCHEDULER, "sched")
    gone = member(project, Role.MEMBER, "gone")
    task_for_assignee(project, gone, name="G0", status="REVIEW", board_lane="qa")
    ProjectMembership.objects.filter(project=project, user=gone).update(is_deleted=True)

    BoardColumnConfig.objects.create(
        project=project, columns=columns(lanes_by_status={"REVIEW": [lane("qa", "QA")]})
    )
    with django_capture_on_commit_callbacks(execute=True):
        client_for(actor).put(config_url(project), data={"columns": columns()}, format="json")

    assert inbox(gone) == []


@pytest.mark.django_db
@pytest.mark.parametrize(
    "change",
    [
        pytest.param("rename", id="renaming-a-lane"),
        pytest.param("add", id="adding-a-lane"),
        pytest.param("wip", id="changing-a-wip-limit"),
    ],
)
def test_a_change_that_moves_no_work_notifies_nobody(
    project: Project, django_capture_on_commit_callbacks: Any, change: str
) -> None:
    """The trigger is the consequence, not the write.

    A notice on every PUT is noise, and noise gets muted — which costs the signal
    the feature exists to carry.
    """
    actor = member(project, Role.SCHEDULER, "sched")
    priya = member(project, Role.MEMBER, "priya")
    task_for_assignee(project, priya, name="P0", status="REVIEW", board_lane="qa")

    before = columns(lanes_by_status={"REVIEW": [lane("qa", "QA")]})
    BoardColumnConfig.objects.create(project=project, columns=before)

    if change == "rename":
        after = columns(lanes_by_status={"REVIEW": [lane("qa", "Quality")]})
    elif change == "add":
        after = columns(lanes_by_status={"REVIEW": [lane("qa", "QA"), lane("uat", "UAT")]})
    else:
        after = columns(lanes_by_status={"REVIEW": [{"key": "qa", "label": "QA", "wip_limit": 4}]})

    with django_capture_on_commit_callbacks(execute=True):
        resp = client_for(actor).put(config_url(project), data={"columns": after}, format="json")
    assert resp.status_code == 200
    assert inbox(priya) == []


@pytest.mark.django_db
def test_hiding_a_column_says_the_work_is_still_there(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """Hiding a column does not move a card — it removes it from where people
    look. The notice has to say both halves or it reads as data loss."""
    actor = member(project, Role.SCHEDULER, "sched")
    priya = member(project, Role.MEMBER, "priya")
    task_for_assignee(project, priya, name="P0", status="REVIEW")
    task_for_assignee(project, priya, name="P1", status="REVIEW")

    BoardColumnConfig.objects.create(project=project, columns=columns())
    with django_capture_on_commit_callbacks(execute=True):
        client_for(actor).put(
            config_url(project), data={"columns": columns(hidden={"REVIEW"})}, format="json"
        )

    row = only(priya)
    assert "hid the “Review” column" in row.body
    assert "keep their status and dates" in row.body
    assert "Your 2 items" in row.body


# ---------------------------------------------------------------------------
# Trigger 2 — the methodology preset is switched
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_switching_the_preset_names_both_presets_and_the_views_that_moved(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """AGILE → WATERFALL turns Baselines and Monte Carlo back on
    (``METHODOLOGY_SURFACE_DEFAULTS``). The notice states the preset change AND
    the surfaces whose effective visibility actually flipped — every clause
    grounded in a value the server computed, so it cannot over-claim."""
    actor = member(project, Role.ADMIN, "pm")
    priya = member(project, Role.MEMBER, "priya")
    task_for_assignee(project, priya, name="P0")
    task_for_assignee(project, priya, name="P1")

    with django_capture_on_commit_callbacks(execute=True):
        resp = client_for(actor).patch(
            f"/api/v1/projects/{project.pk}/",
            data={"methodology": Methodology.WATERFALL},
            format="json",
        )
    assert resp.status_code == 200

    row = only(priya)
    assert "from Agile to Waterfall" in row.body
    assert "Baselines and Monte Carlo" in row.body
    assert "are now shown" in row.body
    assert "Your 2 items keep their status, dates and assignments" in row.body
    assert row.subject == "This project now runs as Waterfall"


@pytest.mark.django_db
def test_hiding_a_view_names_the_view_and_leaves_the_work_alone(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    actor = member(project, Role.ADMIN, "pm")
    priya = member(project, Role.MEMBER, "priya")
    task_for_resource(project, priya, name="P0")

    with django_capture_on_commit_callbacks(execute=True):
        resp = client_for(actor).patch(
            f"/api/v1/projects/{project.pk}/", data={"show_time_tracking": False}, format="json"
        )
    assert resp.status_code == 200

    row = only(priya)
    assert "Time tracking is no longer shown here." in row.body
    assert row.subject == "The views in this project changed"


@pytest.mark.django_db
def test_an_unrelated_project_edit_notifies_nobody(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    actor = member(project, Role.ADMIN, "pm")
    priya = member(project, Role.MEMBER, "priya")
    task_for_assignee(project, priya, name="P0")

    with django_capture_on_commit_callbacks(execute=True):
        resp = client_for(actor).patch(
            f"/api/v1/projects/{project.pk}/", data={"name": "Atlas II"}, format="json"
        )
    assert resp.status_code == 200
    assert inbox(priya) == []


@pytest.mark.django_db
def test_an_override_that_matches_the_resolved_value_notifies_nobody(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """Effective visibility, not the raw column: writing an explicit ``True``
    over a default that already resolved ``True`` moves nothing on screen."""
    actor = member(project, Role.ADMIN, "pm")
    priya = member(project, Role.MEMBER, "priya")
    task_for_assignee(project, priya, name="P0")

    with django_capture_on_commit_callbacks(execute=True):
        resp = client_for(actor).patch(
            f"/api/v1/projects/{project.pk}/", data={"show_reporting": True}, format="json"
        )
    assert resp.status_code == 200
    assert inbox(priya) == []


# ---------------------------------------------------------------------------
# RBAC — all five roles
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("role", "expected"),
    [
        pytest.param(Role.VIEWER, 403, id="viewer-refused"),
        pytest.param(Role.MEMBER, 403, id="member-refused"),
        pytest.param(Role.SCHEDULER, 200, id="scheduler-allowed"),
        pytest.param(Role.ADMIN, 200, id="admin-allowed"),
        pytest.param(Role.OWNER, 200, id="owner-allowed"),
    ],
)
def test_board_config_write_gate_is_unchanged_and_a_refusal_notifies_nobody(
    project: Project, django_capture_on_commit_callbacks: Any, role: int, expected: int
) -> None:
    """Two properties in one test, deliberately.

    The gate stays Scheduler+ — adding a notification must not widen who may
    re-shape a board. And a REFUSED config change notifies nobody: under
    ``ATOMIC_REQUESTS`` DRF's handler calls ``set_rollback()`` for every
    ``APIException``, discarding the transaction and its ``on_commit`` callbacks,
    so a notice on a refusal path would be silently dropped anyway. Asserting it
    here means the notice can never migrate onto that path unnoticed.
    """
    actor = member(project, role, f"role{role}")
    priya = member(project, Role.MEMBER, "priya")
    task_for_assignee(project, priya, name="P0", status="REVIEW", board_lane="qa")

    BoardColumnConfig.objects.create(
        project=project, columns=columns(lanes_by_status={"REVIEW": [lane("qa", "QA")]})
    )
    with django_capture_on_commit_callbacks(execute=True):
        resp = client_for(actor).put(
            config_url(project), data={"columns": columns()}, format="json"
        )
    assert resp.status_code == expected

    if expected == 200:
        assert len(inbox(priya)) == 1
    else:
        assert inbox(priya) == [], "a refused config change must notify nobody"


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("role", "expected"),
    [
        pytest.param(Role.VIEWER, 403, id="viewer-refused"),
        pytest.param(Role.MEMBER, 403, id="member-refused"),
        pytest.param(Role.SCHEDULER, 200, id="scheduler-allowed"),
        pytest.param(Role.ADMIN, 200, id="admin-allowed"),
        pytest.param(Role.OWNER, 200, id="owner-allowed"),
    ],
)
def test_preset_switch_gate_is_unchanged_and_a_refusal_notifies_nobody(
    project: Project, django_capture_on_commit_callbacks: Any, role: int, expected: int
) -> None:
    actor = member(project, role, f"role{role}")
    priya = member(project, Role.MEMBER, "priya")
    task_for_assignee(project, priya, name="P0")

    with django_capture_on_commit_callbacks(execute=True):
        resp = client_for(actor).patch(
            f"/api/v1/projects/{project.pk}/",
            data={"methodology": Methodology.WATERFALL},
            format="json",
        )
    assert resp.status_code == expected

    if expected == 200:
        assert len(inbox(priya)) == 1
    else:
        assert inbox(priya) == [], "a refused preset switch must notify nobody"


@pytest.mark.django_db
def test_a_scheduler_refused_the_admin_only_view_toggle_notifies_nobody(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """``show_*`` is Admin+ (it is not in ``_SCHEDULER_WRITABLE_FIELDS``). The
    refusal is a 400 from the serializer rather than a 403 from the gate, which
    is a different code path to the one above and so gets its own assertion."""
    actor = member(project, Role.SCHEDULER, "sched")
    priya = member(project, Role.MEMBER, "priya")
    task_for_assignee(project, priya, name="P0")

    with django_capture_on_commit_callbacks(execute=True):
        resp = client_for(actor).patch(
            f"/api/v1/projects/{project.pk}/", data={"show_baselines": False}, format="json"
        )
    assert resp.status_code == 400
    assert inbox(priya) == []


# ---------------------------------------------------------------------------
# Recipient resolution — the union, and why it is the union
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_a_bare_assignee_is_a_recipient(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """``notify_amend`` uses ``TaskResource`` alone because it is talking about
    committed load. This notice is about the SURFACE, and a bare assignee looks
    at the same board — so the recipient set is the union. Using ``TaskResource``
    alone would tell nobody in a Jira-imported or template-seeded project, which
    write assignees and no assignments."""
    actor = member(project, Role.SCHEDULER, "sched")
    bare = member(project, Role.MEMBER, "bare")
    task_for_assignee(project, bare, name="B0", status="REVIEW", board_lane="qa")

    BoardColumnConfig.objects.create(
        project=project, columns=columns(lanes_by_status={"REVIEW": [lane("qa", "QA")]})
    )
    with django_capture_on_commit_callbacks(execute=True):
        client_for(actor).put(config_url(project), data={"columns": columns()}, format="json")

    assert "Your 1 item" in only(bare).body


@pytest.mark.django_db
def test_a_resource_booking_on_an_UNASSIGNED_task_still_counts(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """The de-dupe must not eat the null-assignee row.

    ``_counts_by_user`` de-duplicates by excluding resource bookings where the
    booked user is already the task's assignee. ``Task.assignee`` is nullable, and
    a comparison against NULL is NULL — so a de-dupe written carelessly drops
    every booking on an *unassigned* task, which is precisely the MS Project
    import shape (``TaskResource`` written, ``assignee`` not). The recipient would
    then be told "Nothing you own moved", which is the false claim this module
    exists to avoid. Pinned on the surface path, whose filter is unbounded.
    """
    actor = member(project, Role.ADMIN, "pm")
    sam = member(project, Role.MEMBER, "sam")
    task_for_resource(project, sam, name="S0")
    task_for_resource(project, sam, name="S1")
    assert Task.objects.filter(project=project, assignee__isnull=True).count() == 2

    with django_capture_on_commit_callbacks(execute=True):
        client_for(actor).patch(
            f"/api/v1/projects/{project.pk}/",
            data={"methodology": Methodology.WATERFALL},
            format="json",
        )

    body = only(sam).body
    assert "Your 2 items keep their status" in body
    assert "Nothing you own moved." not in body


@pytest.mark.django_db
def test_one_task_counts_once_for_someone_who_is_both_assignee_and_resource(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    actor = member(project, Role.SCHEDULER, "sched")
    both = member(project, Role.MEMBER, "both")
    task = task_for_assignee(project, both, name="T0", status="REVIEW", board_lane="qa")
    resource = Resource.objects.create(name="res-both", user=both)
    TaskResource.objects.create(task=task, resource=resource, units=1)

    BoardColumnConfig.objects.create(
        project=project, columns=columns(lanes_by_status={"REVIEW": [lane("qa", "QA")]})
    )
    with django_capture_on_commit_callbacks(execute=True):
        client_for(actor).put(config_url(project), data={"columns": columns()}, format="json")

    assert "Your 1 item" in only(both).body


# ---------------------------------------------------------------------------
# The bulk settings matrix — the OTHER way a preset gets switched
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_the_program_settings_matrix_notifies_and_broadcasts(
    calendar: Calendar, django_capture_on_commit_callbacks: Any
) -> None:
    """A preset switched from the program matrix reaches the team the same way.

    Wiring only the project settings page would leave this route re-shaping a
    team's workspace in silence — the same gap the issue was filed for, one
    endpoint over. The broadcast matters as much as the notice: without it an open
    client keeps rendering the old surface, so the inbox row describes a change
    the screen has not made.
    """
    from trueppm_api.apps.access.models import ProgramMembership
    from trueppm_api.apps.workspace.models import Workspace, WorkspaceMembership, WorkspaceRole

    admin = User.objects.create_user(username="progadmin", password="pw")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=admin, role=WorkspaceRole.ADMIN
    )
    program = Program.objects.create(name="Atlas Program")
    ProgramMembership.objects.create(program=program, user=admin, role=Role.OWNER)

    target = Project.objects.create(
        name="In matrix",
        start_date=date(2026, 1, 1),
        calendar=calendar,
        program=program,
        methodology=Methodology.AGILE,
    )
    priya = member(target, Role.MEMBER, "priya")
    task_for_assignee(target, priya, name="P0")

    broadcasts: list[tuple[Any, ...]] = []
    with (
        patch(
            "trueppm_api.apps.sync.broadcast.broadcast_board_event",
            side_effect=lambda *a, **kw: broadcasts.append(a),
        ),
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client_for(admin).post(
            f"/api/v1/programs/{program.pk}/bulk-project-fields/",
            {"ids": [str(target.pk)], "fields": {"methodology": Methodology.WATERFALL}},
            format="json",
        )
    assert resp.status_code == 200, resp.content

    row = only(priya)
    assert "from Agile to Waterfall" in row.body
    assert (str(target.pk), "project_updated", {"id": str(target.pk)}) in broadcasts


@pytest.mark.django_db
def test_a_bulk_edit_that_moves_no_surface_stays_silent(
    calendar: Calendar, django_capture_on_commit_callbacks: Any
) -> None:
    """``iteration_label`` is a label, not a surface. Neither the notice nor the
    new broadcast may fire for it — a bulk write is exactly where an
    over-eager trigger turns into 200 notices nobody needed."""
    from trueppm_api.apps.access.models import ProgramMembership
    from trueppm_api.apps.workspace.models import Workspace, WorkspaceMembership, WorkspaceRole

    admin = User.objects.create_user(username="progadmin", password="pw")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=admin, role=WorkspaceRole.ADMIN
    )
    program = Program.objects.create(name="Atlas Program")
    ProgramMembership.objects.create(program=program, user=admin, role=Role.OWNER)
    target = Project.objects.create(
        name="In matrix",
        start_date=date(2026, 1, 1),
        calendar=calendar,
        program=program,
        methodology=Methodology.AGILE,
    )
    priya = member(target, Role.MEMBER, "priya")
    task_for_assignee(target, priya, name="P0")

    broadcasts: list[tuple[Any, ...]] = []
    with (
        patch(
            "trueppm_api.apps.sync.broadcast.broadcast_board_event",
            side_effect=lambda *a, **kw: broadcasts.append(a),
        ),
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client_for(admin).post(
            f"/api/v1/programs/{program.pk}/bulk-project-fields/",
            {"ids": [str(target.pk)], "fields": {"iteration_label": "PI"}},
            format="json",
        )
    assert resp.status_code == 200, resp.content
    assert inbox(priya) == []
    assert broadcasts == []


# ---------------------------------------------------------------------------
# The pure diff — the discrimination that keeps this from being "a setting saved"
# ---------------------------------------------------------------------------


def test_diff_reports_a_removed_lane_and_its_destination() -> None:
    from trueppm_api.apps.projects.config_notice import diff_board_config

    before = columns(lanes_by_status={"REVIEW": [lane("review", "Review"), lane("qa", "QA")]})
    after = columns(lanes_by_status={"REVIEW": [lane("review", "Review")]})
    removed, hidden = diff_board_config(before, after)

    assert [r.key for r in removed] == ["qa"]
    assert removed[0].label == "QA"
    assert removed[0].destination == "Review"
    assert hidden == []


def test_diff_falls_back_to_the_column_itself_when_no_lane_survives() -> None:
    """Deleting the last lane leaves one implicit lane — the column. The notice
    must name that, not a lane label that no longer exists."""
    from trueppm_api.apps.projects.config_notice import diff_board_config

    before = columns(lanes_by_status={"REVIEW": [lane("qa", "QA")]})
    removed, _ = diff_board_config(before, columns())
    assert removed[0].destination == "Review"


def test_diff_is_silent_on_a_reorder() -> None:
    from trueppm_api.apps.projects.config_notice import diff_board_config

    before = columns(lanes_by_status={"REVIEW": [lane("review", "Review"), lane("qa", "QA")]})
    after = columns(lanes_by_status={"REVIEW": [lane("qa", "QA"), lane("review", "Review")]})
    assert diff_board_config(before, after) == ([], [])


def test_diff_is_silent_on_un_hiding_a_column() -> None:
    from trueppm_api.apps.projects.config_notice import diff_board_config

    before = columns(hidden={"REVIEW"})
    removed, hidden = diff_board_config(before, columns())
    assert (removed, hidden) == ([], [])
