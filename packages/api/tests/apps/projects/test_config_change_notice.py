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
from django.db import connection
from django.test.utils import CaptureQueriesContext
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
from trueppm_api.apps.teams.models import Team, TeamMembership

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


def default_team(project: Project) -> Team:
    """The project's default team — the only team the ADR-0078 facets are read from."""
    team, _ = Team.objects.get_or_create(
        project=project, is_default=True, defaults={"name": "Default Team", "short_id": "T01"}
    )
    return team


def facet_member(
    project: Project,
    role: int,
    username: str,
    *,
    scrum_master: bool = False,
    product_owner: bool = False,
) -> Any:
    """A project member who also holds a facet on the default team.

    ``role`` is deliberately independent of the facet: the cohort #3291 is about is
    the people seated *below* the write gate who nonetheless own the surface, which
    is how a Product Owner is normally seated. A fixture that only ever pairs a
    facet with ADMIN cannot see the bug.
    """
    user = member(project, role, username)
    TeamMembership.objects.create(
        team=default_team(project),
        user=user,
        is_scrum_master=scrum_master,
        is_product_owner=product_owner,
    )
    return user


def switch_preset(actor: Any, project: Project, to: str = Methodology.WATERFALL) -> Any:
    return client_for(actor).patch(
        f"/api/v1/projects/{project.pk}/", data={"methodology": to}, format="json"
    )


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


def test_every_event_type_has_a_default_on_every_channel() -> None:
    """The universal form of the assertion above.

    Pinning only this branch's own member would leave the *next* one to rediscover
    the same silence — an event with no ``DEFAULT_PREFERENCES`` row dispatches
    nothing, and nothing anywhere else in the suite notices. ``_EVENT_TYPE_CATEGORY``
    already has a loop like this (``test_snooze_category``); the defaults table did
    not.
    """
    rows = {(et, ch) for et, ch, _ in DEFAULT_PREFERENCES}
    missing = [
        (event_type, channel)
        for event_type in NotificationEventType.values
        for channel in NotificationChannel.values
        if (event_type, channel) not in rows
    ]
    assert missing == [], f"event types with no DEFAULT_PREFERENCES row: {missing}"


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
def test_two_lanes_removed_from_different_columns_name_each_destination(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """Each removed lane sends its cards to ITS OWN column's first lane.

    Borrowing one destination for the whole notice is worse than saying nothing:
    the recipient goes to the named lane, does not find their work, and stops
    believing the next notice. Both destinations must appear, each attached to
    the lane it belongs to.
    """
    actor = member(project, Role.SCHEDULER, "sched")
    priya = member(project, Role.MEMBER, "priya")
    task_for_assignee(project, priya, name="A", status="IN_PROGRESS", board_lane="spike")
    task_for_assignee(project, priya, name="B", status="REVIEW", board_lane="qa")

    BoardColumnConfig.objects.create(
        project=project,
        columns=columns(
            lanes_by_status={
                "IN_PROGRESS": [lane("dev", "Dev"), lane("spike", "Spike")],
                "REVIEW": [lane("signoff", "Sign-off"), lane("qa", "QA")],
            }
        ),
    )
    with django_capture_on_commit_callbacks(execute=True):
        client_for(actor).put(
            config_url(project),
            data={
                "columns": columns(
                    lanes_by_status={
                        "IN_PROGRESS": [lane("dev", "Dev")],
                        "REVIEW": [lane("signoff", "Sign-off")],
                    }
                )
            },
            format="json",
        )

    body = only(priya).body
    # Each lane names ITS OWN destination — the Spike cards land in Dev, the QA
    # cards in Sign-off, and neither destination is borrowed for the other.
    assert "“Spike” from In Progress (cards move to “Dev”)" in body
    assert "“QA” from Review (cards move to “Sign-off”)" in body
    assert "2 of those items are yours." in body
    # The single-lane phrasing must not leak into the multi-lane case: it would
    # attribute every moved item to one destination, which is the defect.
    assert "the first lane of that column" not in body


@pytest.mark.django_db
def test_a_single_item_reads_as_one_item(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """Verb agreement on a count of one.

    ``_plural`` inflects the noun; the surrounding clause has to agree with it, or
    a feature whose entire premise is copy quality ships "Your 1 item ... now show".
    """
    actor = member(project, Role.SCHEDULER, "sched")
    priya = member(project, Role.MEMBER, "priya")
    task_for_assignee(project, priya, name="P0", status="REVIEW", board_lane="qa")

    BoardColumnConfig.objects.create(
        project=project,
        columns=columns(lanes_by_status={"REVIEW": [lane("review", "Review"), lane("qa", "QA")]}),
    )
    with django_capture_on_commit_callbacks(execute=True):
        client_for(actor).put(
            config_url(project),
            data={"columns": columns(lanes_by_status={"REVIEW": [lane("review", "Review")]})},
            format="json",
        )

    assert "Your 1 item in there now shows in “Review”" in only(priya).body


@pytest.mark.django_db
def test_a_lane_and_a_column_changing_together_get_one_combined_notice(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    actor = member(project, Role.SCHEDULER, "sched")
    priya = member(project, Role.MEMBER, "priya")
    task_for_assignee(project, priya, name="A", status="REVIEW", board_lane="qa")
    task_for_assignee(project, priya, name="B", status="NOT_STARTED")

    BoardColumnConfig.objects.create(
        project=project,
        columns=columns(lanes_by_status={"REVIEW": [lane("review", "Review"), lane("qa", "QA")]}),
    )
    with django_capture_on_commit_callbacks(execute=True):
        client_for(actor).put(
            config_url(project),
            data={
                "columns": columns(
                    lanes_by_status={"REVIEW": [lane("review", "Review")]},
                    hidden={"NOT_STARTED"},
                )
            },
            format="json",
        )

    row = only(priya)
    assert row.subject == "Your board was reconfigured — 2 items affected"
    assert "removed the “QA” lane" in row.body
    assert "hid the “Not Started” column" in row.body


@pytest.mark.django_db
def test_a_first_ever_board_config_diffs_against_the_shipped_defaults(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """No ``BoardColumnConfig`` row exists until someone saves one.

    The PUT then diffs against ``_DEFAULT_COLUMNS`` — all five columns visible,
    no lanes — so a first-ever save that hides a column is a real change and
    notifies, while a first-ever save that only renames does not.
    """
    actor = member(project, Role.SCHEDULER, "sched")
    priya = member(project, Role.MEMBER, "priya")
    task_for_assignee(project, priya, name="P0", status="REVIEW")
    assert not BoardColumnConfig.objects.filter(project=project).exists()

    with django_capture_on_commit_callbacks(execute=True):
        resp = client_for(actor).put(
            config_url(project), data={"columns": columns(hidden={"REVIEW"})}, format="json"
        )
    assert resp.status_code == 200
    assert "hid the “Review” column" in only(priya).body


@pytest.mark.django_db
def test_a_project_with_no_assignees_notifies_nobody_and_does_not_raise(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """The short-circuit before the membership query. A brand-new project has a
    board to configure and nobody holding work on it yet."""
    actor = member(project, Role.SCHEDULER, "sched")
    bystander = member(project, Role.MEMBER, "bystander")
    assert Task.objects.filter(project=project).count() == 0

    BoardColumnConfig.objects.create(
        project=project, columns=columns(lanes_by_status={"REVIEW": [lane("qa", "QA")]})
    )
    with django_capture_on_commit_callbacks(execute=True):
        resp = client_for(actor).put(
            config_url(project), data={"columns": columns()}, format="json"
        )
    assert resp.status_code == 200
    assert inbox(bystander) == []
    assert Notification.objects.filter(event_type=EVENT).count() == 0


@pytest.mark.django_db
def test_a_failing_emit_never_reverts_the_config_write(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """The stated contract: a notification failure must not undo an accepted write.

    Both emitters swallow and log, which means a future signature drift fails
    silently in production with only a log line — so the swallow itself is worth
    an assertion rather than an assumption.
    """
    actor = member(project, Role.SCHEDULER, "sched")
    priya = member(project, Role.MEMBER, "priya")
    task_for_assignee(project, priya, name="P0", status="REVIEW", board_lane="qa")

    BoardColumnConfig.objects.create(
        project=project, columns=columns(lanes_by_status={"REVIEW": [lane("qa", "QA")]})
    )
    with (
        patch(
            "trueppm_api.apps.notifications.services.create_event_notifications_batch",
            side_effect=RuntimeError("boom"),
        ),
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client_for(actor).put(
            config_url(project), data={"columns": columns()}, format="json"
        )

    assert resp.status_code == 200
    # The config write survived, and no half-written notice was left behind.
    saved = BoardColumnConfig.objects.get(project=project)
    assert all(not col["lanes"] for col in saved.columns)
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
    # The override IS the deliberate act here, so it carries the attribution —
    # unlike the preset case, where the surfaces fall out of the preset and
    # naming the actor on each one would credit them with a choice they never made.
    assert "pm hid Time tracking in this project." in row.body
    assert row.subject == "The views in this project changed"


@pytest.mark.django_db
def test_the_reverse_preset_switch_says_which_views_went_away(
    calendar: Calendar, django_capture_on_commit_callbacks: Any
) -> None:
    """WATERFALL → AGILE is the alarming direction — Baselines and Monte Carlo
    disappear — and it is the branch the forward-direction test never renders."""
    waterfall = Project.objects.create(
        name="Waterfall",
        start_date=date(2026, 1, 1),
        calendar=calendar,
        methodology=Methodology.WATERFALL,
    )
    actor = member(waterfall, Role.ADMIN, "pm")
    priya = member(waterfall, Role.MEMBER, "priya")
    task_for_assignee(waterfall, priya, name="P0")

    with django_capture_on_commit_callbacks(execute=True):
        resp = client_for(actor).patch(
            f"/api/v1/projects/{waterfall.pk}/",
            data={"methodology": Methodology.AGILE},
            format="json",
        )
    assert resp.status_code == 200

    row = only(priya)
    assert "from Waterfall to Agile" in row.body
    assert "Baselines and Monte Carlo are no longer shown here." in row.body
    assert "Your 1 item keeps its status, dates and assignments" in row.body


@pytest.mark.django_db
def test_turning_a_view_back_on_is_also_worth_saying(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """A restored view moves the surface too, and the notice names who did it."""
    project.show_baselines = False
    project.save(update_fields=["show_baselines"])
    actor = member(project, Role.ADMIN, "pm")
    priya = member(project, Role.MEMBER, "priya")
    task_for_assignee(project, priya, name="P0")

    with django_capture_on_commit_callbacks(execute=True):
        resp = client_for(actor).patch(
            f"/api/v1/projects/{project.pk}/", data={"show_baselines": True}, format="json"
        )
    assert resp.status_code == 200
    assert "pm turned Baselines back on in this project." in only(priya).body


@pytest.mark.django_db
def test_a_recipient_with_nothing_of_their_own_is_told_plainly(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """A member who holds work elsewhere in the project but owns none of it right
    now still gets the notice — the views moved for them too — with an honest
    "nothing you own moved" rather than a silently omitted clause."""
    actor = member(project, Role.ADMIN, "pm")
    sam = member(project, Role.MEMBER, "sam")
    task_for_assignee(project, sam, name="S0")
    # Someone else's item makes sam a recipient candidate while owning nothing.
    other = member(project, Role.MEMBER, "other")
    task_for_assignee(project, other, name="O0")
    Task.objects.filter(name="S0").update(assignee=None)

    with django_capture_on_commit_callbacks(execute=True):
        client_for(actor).patch(
            f"/api/v1/projects/{project.pk}/", data={"show_time_tracking": False}, format="json"
        )

    assert inbox(sam) == []
    assert "Nothing you own moved." not in only(other).body


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
# Surface recipients — the people who own the surface, not just the assignees
# (#3291, the same class as #2897 at a new sink)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("scrum_master", "product_owner", "who"),
    [
        pytest.param(False, True, "product owner", id="product-owner"),
        pytest.param(True, False, "scrum master", id="scrum-master"),
    ],
)
def test_a_facet_holder_with_no_assigned_task_gets_the_surface_notice(
    project: Project,
    django_capture_on_commit_callbacks: Any,
    scrum_master: bool,
    product_owner: bool,
    who: str,
) -> None:
    """The people the flip re-shapes hardest held none of the work it moved.

    A Product Owner authors and prioritizes the backlog and is frequently assigned
    none of it; a Scrum Master facilitates and is neither an assignee nor a booked
    resource. Both are expected to explain the flip to everyone else, and the
    assigned-only cohort was the only notification that existed — so they found
    out at sprint planning, or by going looking for a tab.
    """
    actor = member(project, Role.ADMIN, "pm")
    holder = facet_member(
        project, Role.MEMBER, "holder", scrum_master=scrum_master, product_owner=product_owner
    )
    # Someone ELSE's task, so the assigned cohort is non-empty and the union path is
    # genuinely exercised. On an empty project `assigned_recipient_ids` short-circuits,
    # which would make the premise below true for the wrong reason.
    task_for_assignee(project, member(project, Role.MEMBER, "other"), name="O0")
    assert not Task.objects.filter(project=project, assignee=holder).exists()

    with django_capture_on_commit_callbacks(execute=True):
        assert switch_preset(actor, project).status_code == 200

    row = only(holder)
    assert "from Agile to Waterfall" in row.body, f"the {who} was not told what changed"
    assert row.subject == "This project now runs as Waterfall"


@pytest.mark.django_db
@pytest.mark.parametrize(
    "role",
    [
        pytest.param(Role.SCHEDULER, id="scheduler"),
        pytest.param(Role.ADMIN, id="admin"),
        pytest.param(Role.OWNER, id="owner"),
    ],
)
def test_a_scheduler_or_above_with_no_assigned_task_gets_the_surface_notice(
    project: Project, django_capture_on_commit_callbacks: Any, role: int
) -> None:
    """Anyone who could have made this flip is told when somebody else makes it.

    ``role >= SCHEDULER`` is the board-config write gate, and a PM who owns the
    plan routinely assigns none of it to themselves — so the person accountable
    for the schedule was structurally outside the only notice about it.
    """
    actor = member(project, Role.OWNER, "actor")
    lead = member(project, role, f"lead{role}")
    task_for_assignee(project, member(project, Role.MEMBER, "other"), name="O0")
    assert not Task.objects.filter(project=project, assignee=lead).exists()

    with django_capture_on_commit_callbacks(execute=True):
        assert switch_preset(actor, project).status_code == 200

    assert "from Agile to Waterfall" in only(lead).body
    assert inbox(actor) == [], "the person who made the change is never told about it"


@pytest.mark.django_db
def test_the_actor_is_excluded_even_when_they_qualify_on_every_cohort(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """The actor exclusion has to survive the widening, and it nearly did not.

    Before #3291 the actor could only enter the surface cohort by being assigned,
    so ``assigned_recipient_ids``' own discard did the work. The Scheduler+ arm now
    re-adds them on *every* flip — the actor of a ``perform_update`` surface change
    is Scheduler+ essentially by definition — so the union's trailing ``discard``
    is the only thing left stopping a self-notification. Every other test in this
    section asserts on the recipient, so deleting that one line would leave the
    whole suite green while every PM notified themselves about their own click.
    """
    actor = facet_member(project, Role.ADMIN, "pm", product_owner=True, scrum_master=True)
    task_for_assignee(project, actor, name="A0")
    witness = member(project, Role.MEMBER, "witness")
    task_for_assignee(project, witness, name="W0")

    with django_capture_on_commit_callbacks(execute=True):
        assert switch_preset(actor, project).status_code == 200

    assert inbox(actor) == [], "the actor qualifies three ways and must still be excluded"
    assert len(inbox(witness)) == 1, "the notice did fire — the assertion above is not vacuous"


@pytest.mark.django_db
def test_the_body_is_coherent_for_a_recipient_who_owns_nothing(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """The zero-count clause is now the normal case, not an edge case.

    Every recipient added by the widened cohort may own nothing, so the ownership
    clause has to degrade to a sentence rather than be omitted — an omitted clause
    reads as an unstated many, and this whole module exists to refuse a notice the
    reader has to decode.
    """
    actor = member(project, Role.ADMIN, "pm")
    po = facet_member(project, Role.MEMBER, "po", product_owner=True)

    with django_capture_on_commit_callbacks(execute=True):
        assert switch_preset(actor, project).status_code == 200

    body = only(po).body
    assert body.endswith("Nothing you own moved.")
    assert "Your 0 items" not in body


@pytest.mark.django_db
@pytest.mark.parametrize(
    "role",
    [pytest.param(Role.VIEWER, id="viewer"), pytest.param(Role.MEMBER, id="member")],
)
def test_a_bystander_below_the_gate_with_no_work_is_still_not_notified(
    project: Project, django_capture_on_commit_callbacks: Any, role: int
) -> None:
    """The widening is bounded — it is not "notify the whole membership".

    A Viewer or Member holding no work and no facet has no surface of their own
    that the flip re-shapes, and a notice to them is the noise that gets the
    channel muted, which costs the signal this module exists to carry.
    """
    actor = member(project, Role.ADMIN, "pm")
    bystander = member(project, role, f"bystander{role}")

    with django_capture_on_commit_callbacks(execute=True):
        assert switch_preset(actor, project).status_code == 200

    assert inbox(bystander) == []


@pytest.mark.django_db
def test_a_facet_holder_whose_membership_was_revoked_is_not_notified(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """The privacy floor has to survive the widening, and the facet half needs it.

    The ADR-0078 §F mirror only ever *creates* team rows, so soft-deleting a
    ``ProjectMembership`` leaves the ``TeamMembership`` live with its facet flags
    intact. Unioning the facet cohort without re-intersecting live membership
    would widen who keeps being told a project's internal structure after losing
    access — a dead link and a scope leak (ADR-0104's back-door close).
    """
    actor = member(project, Role.ADMIN, "pm")
    gone = facet_member(project, Role.MEMBER, "ex-po", product_owner=True)
    ProjectMembership.objects.filter(project=project, user=gone).update(is_deleted=True)
    assert TeamMembership.objects.filter(user=gone, is_deleted=False).exists()

    with django_capture_on_commit_callbacks(execute=True):
        assert switch_preset(actor, project).status_code == 200

    assert inbox(gone) == []


@pytest.mark.django_db
def test_someone_who_qualifies_three_ways_is_notified_exactly_once(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """A set union rather than list concatenation is what makes this hold.

    A Scheduler who holds the PO facet and owns a task qualifies on all three
    cohorts; concatenating them would send the same person three inbox rows.
    """
    actor = member(project, Role.ADMIN, "pm")
    triple = facet_member(project, Role.SCHEDULER, "triple", product_owner=True)
    task_for_assignee(project, triple, name="T0")

    with django_capture_on_commit_callbacks(execute=True):
        assert switch_preset(actor, project).status_code == 200

    row = only(triple)
    assert "Your 1 item keeps its status, dates and assignments" in row.body


@pytest.mark.django_db
def test_the_board_lane_notice_audience_is_unchanged(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """The board notice stays assigned-only — its audience is genuinely correct.

    A lane going away moves *cards*. A Product Owner or a Scheduler with no card
    on the board has had nothing moved out from under them, so widening this sink
    too would be the over-eager trigger the module's first property forbids. Both
    sinks share ``PROJECT_CONFIG_CHANGED``, which is exactly how one could be
    widened by accident.
    """
    actor = member(project, Role.ADMIN, "pm")
    po = facet_member(project, Role.MEMBER, "po", product_owner=True)
    lead = member(project, Role.SCHEDULER, "lead")
    assigned = member(project, Role.MEMBER, "assigned")
    task_for_assignee(project, assigned, name="A0", status="REVIEW", board_lane="qa")

    BoardColumnConfig.objects.create(
        project=project, columns=columns(lanes_by_status={"REVIEW": [lane("qa", "QA")]})
    )
    with django_capture_on_commit_callbacks(execute=True):
        resp = client_for(actor).put(
            config_url(project), data={"columns": columns()}, format="json"
        )
    assert resp.status_code == 200

    assert len(inbox(assigned)) == 1
    assert inbox(po) == [], "the board notice must not be widened to non-assignees"
    assert inbox(lead) == []


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.VIEWER, Role.MEMBER, Role.SCHEDULER, Role.ADMIN])
@pytest.mark.parametrize(
    ("scrum_master", "product_owner"),
    [(False, False), (True, False), (False, True), (True, True)],
)
@pytest.mark.parametrize("holds_work", [False, True])
def test_notified_set_covers_surface_owner_set(
    project: Project,
    django_capture_on_commit_callbacks: Any,
    role: int,
    scrum_master: bool,
    product_owner: bool,
    holds_work: bool,
) -> None:
    """Across the whole role x facet x assignment matrix: owns the surface => notified.

    The anti-drift pin, in the shape of ``test_notified_set_covers_authorized_set``
    (#2897). That one had a separate code predicate to compare against — the scope
    gate — and this cohort has none, so the predicate is written out here
    deliberately rather than read back from the implementation. Reading it from
    ``surface_recipient_ids`` would make the test a tautology that stays green
    through exactly the regression it exists to catch.

    The converse (notified => owns the surface) is asserted separately and
    narrowly by the bystander test above; here, owning-without-notice is the
    defect, and it is the one that recurred twice.
    """
    actor = member(project, Role.OWNER, "actor")
    subject = facet_member(
        project, role, "subject", scrum_master=scrum_master, product_owner=product_owner
    )
    if holds_work:
        task_for_assignee(project, subject, name="S0")

    owns_surface = role >= Role.SCHEDULER or scrum_master or product_owner or holds_work

    with django_capture_on_commit_callbacks(execute=True):
        assert switch_preset(actor, project).status_code == 200

    notified = Notification.objects.filter(recipient=subject, event_type=EVENT).exists()

    assert not (owns_surface and not notified), (
        f"role={role} scrum_master={scrum_master} product_owner={product_owner} "
        f"holds_work={holds_work} works on this surface and was never told it changed"
    )


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
def test_the_bulk_matrix_reaches_surface_owners_too(
    calendar: Calendar, django_capture_on_commit_callbacks: Any
) -> None:
    """The widened cohort has to hold at BOTH call sites, not just the settings page.

    ``perform_update`` and the program bulk matrix are two entry points into one
    emit, and #2972 already shipped a fix that reached only one route once. A PO
    whose project is flipped from the program matrix is the same person with the
    same missing notice.
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
    po = facet_member(target, Role.MEMBER, "po", product_owner=True)

    with django_capture_on_commit_callbacks(execute=True):
        resp = client_for(admin).post(
            f"/api/v1/programs/{program.pk}/bulk-project-fields/",
            {"ids": [str(target.pk)], "fields": {"methodology": Methodology.WATERFALL}},
            format="json",
        )
    assert resp.status_code == 200, resp.content

    assert "from Agile to Waterfall" in only(po).body


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


# ---------------------------------------------------------------------------
# The emit's cost — bounded, not per-project (#3335)
# ---------------------------------------------------------------------------

#: Queries `_emit_surface_notifications` issues per CHUNK, for any chunk size.
#:
#: Eight reads — four for the cohort (membership scan, the two assignment reads,
#: the facet join) and two for the grouped counts, plus the preference scan and
#: the DND scan — then `ceil(rows / NOTIFICATION_BULK_BATCH_SIZE)` inserts, which
#: is one for every cohort these tests build. Every read is `project_id IN (...)`,
#: so within a chunk the count does not move with the project count: if a future
#: change puts a read back inside the per-project loop, the 12-project assertion
#: below fails while the 2-project one still passes.
#:
#: Across chunks it steps rather than staying flat — that is what chunking means,
#: and `test_the_emit_cost_steps_per_chunk_and_never_per_project` pins the step so
#: the property is asserted rather than assumed. A max-size apply is
#: `ceil(200 / SURFACE_EMIT_CHUNK_SIZE) = 4` chunks, so ~36 queries against the
#: ~1,800 the per-project emit issued.
SURFACE_EMIT_QUERIES = 9


def surface_snapshot(methodology: str) -> Any:
    """A snapshot with every leaf surface shown, so only the preset differs.

    Built by hand rather than through ``capture_project_surface`` so the fixture
    costs no queries of its own — these tests are counting the emit, and a
    workspace read inside the measured block would be noise attributed to it.
    """
    from trueppm_api.apps.projects.config_notice import ProjectSurfaceSnapshot

    return ProjectSurfaceSnapshot(
        methodology=methodology,
        visibility={
            "reporting": True,
            "time_tracking": True,
            "baselines": True,
            "monte_carlo": True,
        },
    )


def surface_change(project: Project, *, to: str = Methodology.WATERFALL) -> Any:
    from trueppm_api.apps.projects.config_notice import SurfaceChange

    return SurfaceChange(
        project_id=str(project.pk),
        before=surface_snapshot(Methodology.AGILE),
        after=surface_snapshot(to),
    )


def cohort_project(calendar: Calendar, idx: int) -> tuple[Project, Any, Any]:
    """A project shaped so every arm of the cohort has something to find.

    A PO seated below the write gate (facet arm), a Scheduler with no work
    (role arm), and a task the PO owns (assignment arm + a non-zero count) — so a
    batched read that silently drops one arm changes the recipients, not just the
    query count.
    """
    project = Project.objects.create(
        name=f"Batch {idx}",
        start_date=date(2026, 1, 1),
        calendar=calendar,
        methodology=Methodology.AGILE,
    )
    po = facet_member(project, Role.MEMBER, f"po{idx}", product_owner=True)
    sched = member(project, Role.SCHEDULER, f"sched{idx}")
    task_for_assignee(project, po, name=f"T{idx}")
    return project, po, sched


def emit(changes: list[Any]) -> None:
    from trueppm_api.apps.projects.config_notice import _emit_surface_notifications

    _emit_surface_notifications(changes, None, "Dana")


@pytest.mark.django_db
def test_the_surface_emit_cost_does_not_scale_with_the_batch(
    calendar: Calendar, django_assert_num_queries: Any
) -> None:
    """The acceptance criterion of #3335, asserted at two materially different sizes.

    A guard run at one batch size, or at two similar ones, proves nothing — the
    per-project emit this replaces would pass any single-size assertion that was
    calibrated against it. Two and twelve is a six-fold difference: before the
    hoist the second block cost ~9x12 queries against ~9x2 for the first, so the
    two assertions could not both hold, and the shared constant is what makes a
    regression fail loudly rather than drift.

    Both sizes sit inside one ``SURFACE_EMIT_CHUNK_SIZE`` chunk, deliberately:
    this test isolates the property that the cost does not move **per project**.
    The orthogonal property — that it steps once per chunk and no faster — is
    pinned separately below, so neither assertion can quietly stand in for the
    other.
    """
    small = [cohort_project(calendar, i) for i in range(2)]
    large = [cohort_project(calendar, i) for i in range(100, 112)]
    assert len(large) == 6 * len(small), "the two batch sizes must differ materially"

    with django_assert_num_queries(SURFACE_EMIT_QUERIES):
        emit([surface_change(project) for project, _, _ in small])
    with django_assert_num_queries(SURFACE_EMIT_QUERIES):
        emit([surface_change(project) for project, _, _ in large])

    # Not vacuous: the bounded count is bounded because the reads are grouped,
    # not because the emit quietly did nothing.
    assert Notification.objects.filter(event_type=EVENT).count() == 2 * (2 + 12)
    for _, po, sched in small + large:
        assert len(inbox(po)) == 1
        assert len(inbox(sched)) == 1


@pytest.mark.django_db
def test_the_emit_cost_steps_per_chunk_and_never_per_project(
    calendar: Calendar, django_assert_num_queries: Any, monkeypatch: Any
) -> None:
    """The chunk boundary is the ONLY thing that adds queries.

    Batching alone would be flat for any batch size; chunking trades a little of
    that for a bounded ``rows`` list and a bounded failure blast radius, which
    means the cost steps. That step is a real property of the emit, so it is
    asserted here rather than left as a comment somebody has to trust — and it is
    asserted as ``chunks x SURFACE_EMIT_QUERIES``, which is what distinguishes
    "one pass per chunk" from "one pass per project" at the same six projects.

    The chunk size is shrunk rather than the project count grown: at the shipped
    fifty this would need 150 projects to see two boundaries, and the property has
    nothing to do with how large the constant happens to be.
    """
    from trueppm_api.apps.projects import config_notice

    projects = [cohort_project(calendar, 200 + i) for i in range(6)]
    changes = [surface_change(project) for project, _, _ in projects]

    monkeypatch.setattr(config_notice, "SURFACE_EMIT_CHUNK_SIZE", 2)
    with django_assert_num_queries(3 * SURFACE_EMIT_QUERIES):
        emit(changes)

    # Every project still notified — a step count is only meaningful if the work
    # actually happened in those passes.
    for _, po, sched in projects:
        assert len(inbox(po)) == 1
        assert len(inbox(sched)) == 1


@pytest.mark.django_db
def test_chunking_changes_the_cost_and_not_the_output(calendar: Calendar, monkeypatch: Any) -> None:
    """A chunk boundary must be invisible in what gets written.

    Chunking splits the reads, so a recipient resolved in one pass and rendered
    in another is exactly the kind of seam that drops or duplicates rows. Pinned
    as equality between a single-chunk run and a one-project-per-chunk run over
    the same changes.
    """
    from trueppm_api.apps.projects import config_notice

    projects = [cohort_project(calendar, 300 + i) for i in range(5)]
    changes = [surface_change(project) for project, _, _ in projects]

    def written() -> set[tuple[Any, ...]]:
        return {
            (str(n.recipient_id), str(n.project_id), n.subject, n.body, n.email_pending)
            for n in Notification.objects.filter(event_type=EVENT)
        }

    emit(changes)
    one_chunk = written()
    Notification.objects.all().delete()

    monkeypatch.setattr(config_notice, "SURFACE_EMIT_CHUNK_SIZE", 1)
    emit(changes)
    many_chunks = written()

    assert one_chunk == many_chunks
    assert len(one_chunk) == 2 * len(projects)


@pytest.mark.django_db
def test_a_failed_chunk_does_not_drop_the_other_chunks(
    calendar: Calendar, monkeypatch: Any
) -> None:
    """The blast-radius bound chunking exists to buy.

    The hoist put the reads and the insert under one ``try``, so before chunking a
    single failed read lost every project in the apply. This asserts the narrower
    contract that replaced it: a chunk whose write fails costs that chunk and
    nothing else.
    """
    from trueppm_api.apps.notifications import services as notification_services
    from trueppm_api.apps.projects import config_notice

    projects = [cohort_project(calendar, 400 + i) for i in range(4)]
    changes = [surface_change(project) for project, _, _ in projects]

    real = notification_services.create_event_notifications_multi_project
    calls = {"n": 0}

    def fail_second(**kwargs: Any) -> int:
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("boom")
        return int(real(**kwargs))

    monkeypatch.setattr(config_notice, "SURFACE_EMIT_CHUNK_SIZE", 2)
    monkeypatch.setattr(
        notification_services, "create_event_notifications_multi_project", fail_second
    )
    emit(changes)

    assert calls["n"] == 2, "both chunks must be attempted"
    for _, po, sched in projects[:2]:
        assert len(inbox(po)) == 1
        assert len(inbox(sched)) == 1
    for _, po, sched in projects[2:]:
        assert inbox(po) == []
        assert inbox(sched) == []


@pytest.mark.django_db
def test_one_project_whose_render_fails_does_not_drop_the_others(calendar: Calendar) -> None:
    """Per-project failure isolation, which the hoist must not spend.

    Moving every read above the loop leaves the loop rendering only — so the
    per-project ``try`` now guards exactly the step that can still fail per
    project, and a batch where one project's copy blows up must still deliver
    every other project's notices rather than losing the whole apply.
    """
    from trueppm_api.apps.projects import config_notice

    bad, bad_po, _ = cohort_project(calendar, 1)
    good, good_po, good_sched = cohort_project(calendar, 2)
    real_subject = config_notice._surface_subject

    def explode(before: Any, after: Any) -> str:
        if after.methodology == Methodology.HYBRID:
            raise RuntimeError("boom")
        return real_subject(before, after)

    with patch.object(config_notice, "_surface_subject", side_effect=explode):
        emit([surface_change(bad, to=Methodology.HYBRID), surface_change(good)])

    assert inbox(bad_po) == []
    assert len(inbox(good_po)) == 1
    assert len(inbox(good_sched)) == 1
    assert "from Agile to Waterfall" in only(good_po).body


@pytest.mark.django_db
def test_a_batched_emit_writes_exactly_what_separate_emits_would(calendar: Calendar) -> None:
    """The refactor is behavior-preserving — same recipients, same bodies.

    #3335 is a cost fix, not a cohort change, so the pin is an equality against
    the pre-batch shape rather than a re-statement of the new one: the batch is
    run once, its rows are frozen, and the identical changes are then emitted one
    project at a time. Reading the expectation from the batched path itself would
    be a tautology; running the one-project path is running the code the previous
    implementation ran, since ``surface_recipient_ids`` still resolves the cohort
    for a batch of one.
    """
    plain, plain_po, _ = cohort_project(calendar, 1)

    booked = Project.objects.create(
        name="Booked",
        start_date=date(2026, 1, 1),
        calendar=calendar,
        methodology=Methodology.AGILE,
    )
    booked_user = member(booked, Role.MEMBER, "booked-member")
    task_for_resource(booked, booked_user, name="B0")

    # Nobody assigned anything: the whole cohort is the facet arm, which is the
    # shape #3291 widened and the one a batched read is most likely to lose.
    empty = Project.objects.create(
        name="Empty",
        start_date=date(2026, 1, 1),
        calendar=calendar,
        methodology=Methodology.AGILE,
    )
    empty_sm = facet_member(empty, Role.VIEWER, "empty-sm", scrum_master=True)

    changes = [surface_change(p) for p in (plain, booked, empty)]

    def written() -> set[tuple[Any, ...]]:
        return {
            (str(n.recipient_id), str(n.project_id), n.subject, n.body, n.email_pending)
            for n in Notification.objects.filter(event_type=EVENT)
        }

    emit(changes)
    batched = written()
    Notification.objects.all().delete()
    for change in changes:
        emit([change])
    separate = written()

    assert batched == separate
    # Non-vacuous: all three projects contributed, including the facet-only one.
    assert {str(plain_po.pk), str(booked_user.pk), str(empty_sm.pk)} <= {row[0] for row in batched}
    assert {str(plain.pk), str(booked.pk), str(empty.pk)} == {row[1] for row in batched}


@pytest.mark.django_db
def test_the_fan_out_insert_is_chunked_by_the_declared_batch_size(
    calendar: Calendar, django_assert_num_queries: Any, monkeypatch: Any
) -> None:
    """``bulk_create`` is bounded, so a batch that spans many projects cannot
    silently exceed Postgres's bind-parameter ceiling.

    Asserted as chunking rather than as "the kwarg was passed": ``Notification``
    has 18 columns, so an unbounded insert raises somewhere past ~3,600 rows and
    the emit's ``except Exception`` swallows it whole, dropping every notice with
    only a log line. The batch size is shrunk here so the behavior is observable
    without materializing thousands of rows.
    """
    from trueppm_api.apps.notifications import services as notification_services

    project = Project.objects.create(name="Fan out", start_date=date(2026, 1, 1), calendar=calendar)
    recipients = [member(project, Role.MEMBER, f"fan{i}") for i in range(5)]
    rows = [(u.pk, project.pk, "Subject", "Body", None) for u in recipients]

    monkeypatch.setattr(notification_services, "NOTIFICATION_BULK_BATCH_SIZE", 2)
    # 1 preference scan + 1 DND scan + ceil(5 / 2) inserts.
    with django_assert_num_queries(2 + 3):
        created = notification_services.create_event_notifications_multi_project(
            event_type=EVENT, rows=rows
        )
    assert created == 5
    assert Notification.objects.filter(event_type=EVENT).count() == 5


@pytest.mark.django_db
def test_the_assignment_read_actually_de_duplicates_in_the_database() -> None:
    """``Task.Meta.ordering`` must not be allowed to defeat the ``distinct()``.

    Asserted against the compiled SQL, because nothing else can see it. A
    ``distinct()`` with no ``distinct_fields`` promotes every ORDER BY column into
    the SELECT list, and ``Task.Meta.ordering`` is ``["wbs_path", "name"]`` — so
    without ``order_by()`` the statement is ``SELECT DISTINCT project_id,
    assignee_id, wbs_path, name``. ``projects_task`` has an ``ExclusionConstraint``
    on ``(project, wbs_path)`` over live rows, making that tuple unique among
    exactly the rows scanned, so the DISTINCT matches nothing and Postgres streams
    one row per task to build a set of a few dozen user ids.

    The returned value is identical either way — the caller builds a ``set`` — so
    every behavioral assertion in this file passes with the bug present. That is
    how it survived on main, and it is why this pin reads the query rather than
    the result.
    """
    import uuid

    from trueppm_api.apps.projects.config_notice import _assigned_candidates_by_project

    with CaptureQueriesContext(connection) as ctx:
        _assigned_candidates_by_project([uuid.uuid4()])

    assignee_arm = next(q["sql"] for q in ctx.captured_queries if "assignee_id" in q["sql"])
    assert "wbs_path" not in assignee_arm, (
        "Task.Meta.ordering leaked into the DISTINCT — it now returns one row per "
        f"task instead of one per (project, assignee):\n{assignee_arm}"
    )
    assert "ORDER BY" not in assignee_arm.upper()
