"""Allocation conflict check: dry-run verdict, ceiling, accept-with-reason (#4806)."""

from __future__ import annotations

import datetime
import re
import secrets
import time
import uuid
from decimal import Decimal
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import Notification
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    ApiToken,
    Calendar,
    CalendarException,
    Project,
    ProjectLifecycle,
    Task,
)
from trueppm_api.apps.resources import allocation_views
from trueppm_api.apps.resources.models import ProjectResource, Resource, TaskResource

User = get_user_model()

URL = "/api/v1/allocations/"
MON = datetime.date(2026, 6, 1)  # a Monday


def day(offset: int) -> str:
    return (MON + datetime.timedelta(days=offset)).isoformat()


def date(offset: int) -> datetime.date:
    return MON + datetime.timedelta(days=offset)


@pytest.fixture
def world(db: Any) -> dict[str, Any]:
    cal = Calendar.objects.create(name="Std")
    booker = User.objects.create_user(username="rm", password="x")
    person_user = User.objects.create_user(username="aisha", password="x")
    mine = Project.objects.create(name="Mine", start_date=MON, calendar=cal)
    home = Project.objects.create(name="Home", start_date=MON, calendar=cal)
    theirs = Project.objects.create(name="Secret", start_date=MON, calendar=cal)
    ProjectMembership.objects.create(user=booker, project=mine, role=Role.SCHEDULER)
    ProjectMembership.objects.create(user=booker, project=home, role=Role.SCHEDULER)
    person = Resource.objects.create(name="Aisha", calendar=cal, user=person_user)
    # On a roster the booker schedules, so the booker may check her (ADR-1500 §7).
    ProjectResource.objects.create(project=home, resource=person)
    # 60% on a project the booker has no role on, in weeks 2 and 3.
    ProjectResource.objects.create(
        project=theirs, resource=person, share_pct=60, share_start=date(7), share_end=date(20)
    )
    client = APIClient()
    client.force_authenticate(booker)
    return {
        "cal": cal,
        "booker": booker,
        "mine": mine,
        "home": home,
        "theirs": theirs,
        "person": person,
        "client": client,
    }


def body(world: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    return {
        "project": str(world["mine"].pk),
        "resource": str(world["person"].pk),
        "share_pct": 50,
        "start": day(0),
        "end": day(18),  # Friday of week 3
        **overrides,
    }


def dry(world: dict[str, Any], **overrides: Any) -> Any:
    return world["client"].post(f"{URL}?dry_run=1", body(world, **overrides), format="json")


def save(world: dict[str, Any], **overrides: Any) -> Any:
    return world["client"].post(URL, body(world, **overrides), format="json")


def mine_row(world: dict[str, Any]) -> ProjectResource | None:
    return ProjectResource.objects.filter(project=world["mine"], resource=world["person"]).first()


def task_on(
    project: Project, resource: Resource, units: str, first: int, last: int, name: str = "t"
) -> Task:
    task = Task.objects.create(
        project=project,
        name=name,
        duration=last - first + 1,
        status="NOT_STARTED",
        early_start=date(first),
        early_finish=date(last),
    )
    TaskResource.objects.create(task=task, resource=resource, units=Decimal(units))
    return task


def side_project(world: dict[str, Any], role: int = Role.SCHEDULER) -> Project:
    side = Project.objects.create(name="Side", start_date=MON, calendar=world["cal"])
    ProjectMembership.objects.create(user=world["booker"], project=side, role=role)
    return side


def assert_parts_sum(verdict: dict[str, Any]) -> None:
    """Every breaking week with a shown load: its parts add up to it."""
    week = verdict["first_breaking_week"]
    assert week is not None
    assert week["load_pct"] is not None
    total = sum(c["pct"] for c in week["contributions"])
    assert round(total, 1) == week["load_pct"], week


#: Keys whose values are identifiers or timestamps, not figures: their digits are noise.
_NOT_FIGURES = ("id", "_by", "_at", "as_of")


def numbers(value: Any) -> set[float]:
    """Every figure anywhere in a JSON body, numbers written into text included.

    Dates are skipped (a number touching a ``-`` is part of one), as are ids and
    timestamps, whose digits would make an absence check flaky.
    """
    if isinstance(value, bool):
        return set()
    if isinstance(value, int | float):
        return {float(value)}
    if isinstance(value, str):
        return {float(n) for n in re.findall(r"(?<![\w.-])\d+(?:\.\d+)?(?![\w-])", value)}
    if isinstance(value, dict):
        kept = [v for k, v in value.items() if not str(k).endswith(_NOT_FIGURES)]
        return set().union(*(numbers(v) for v in kept)) if kept else set()
    if isinstance(value, list):
        return set().union(*(numbers(v) for v in value)) if value else set()
    return set()


# ── who may check whom ───────────────────────────────────────────────────


@pytest.mark.parametrize("role", [None, Role.VIEWER, Role.MEMBER])
@pytest.mark.parametrize("query", ["", "?dry_run=1"])
def test_below_scheduler_is_refused(world: dict[str, Any], role: int | None, query: str) -> None:
    user = User.objects.create_user(username="other", password="x")
    if role is not None:
        ProjectMembership.objects.create(user=user, project=world["mine"], role=role)
    client = APIClient()
    client.force_authenticate(user)
    response = client.post(URL + query, body(world, share_pct=10), format="json")
    assert response.status_code == 403
    assert mine_row(world) is None


@pytest.mark.parametrize("role", [Role.SCHEDULER, Role.ADMIN, Role.OWNER])
def test_scheduler_and_above_may_book(world: dict[str, Any], role: int) -> None:
    ProjectMembership.objects.filter(user=world["booker"]).update(role=role)
    assert save(world, share_pct=10).status_code == 200
    row = mine_row(world)
    assert row is not None and row.share_pct == 10


@pytest.mark.parametrize("case", ["no_roster", "member_only", "draft_roster"])
@pytest.mark.parametrize("query", ["", "?dry_run=1"])
def test_person_off_every_schedulable_roster_is_indistinguishable_from_none(
    world: dict[str, Any], case: str, query: str
) -> None:
    """The check reaches only people on a roster the caller schedules, as people-load does."""
    if case == "no_roster":
        ProjectResource.objects.filter(project=world["home"]).delete()
    elif case == "member_only":
        # On a roster, but of a project where the caller is only a Member.
        ProjectResource.objects.filter(project=world["home"]).delete()
        ProjectMembership.objects.create(
            user=world["booker"], project=world["theirs"], role=Role.MEMBER
        )
    else:
        Project.objects.filter(pk=world["home"].pk).update(lifecycle=ProjectLifecycle.DRAFT)
    client = world["client"]
    hidden = client.post(URL + query, body(world, share_pct=10), format="json")
    missing = client.post(
        URL + query, body(world, share_pct=10, resource=str(uuid.uuid4())), format="json"
    )
    assert hidden.status_code == missing.status_code == 400
    assert hidden.data == missing.data
    assert mine_row(world) is None


def test_anonymous_and_agent_tokens_are_refused(world: dict[str, Any]) -> None:
    assert APIClient().post(URL, body(world), format="json").status_code == 401
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    ApiToken.objects.create(
        owner=world["booker"],
        created_by=world["booker"],
        name="agent",
        scopes=["mcp:read"],
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
    )
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    # The view does not opt in to agent tokens, so authentication itself refuses one.
    assert client.post(f"{URL}?dry_run=1", body(world), format="json").status_code == 401


def test_malformed_dry_run_is_a_field_keyed_400(world: dict[str, Any]) -> None:
    # A bare BooleanField's ValidationError serialized as a top-level array, which
    # the declared 400 does not admit (#5093). Keyed by the query parameter now.
    resp = world["client"].post(f"{URL}?dry_run=bogus", body(world), format="json")
    assert resp.status_code == 400
    assert isinstance(resp.data, dict)
    assert set(resp.data) == {"dry_run"}
    assert isinstance(resp.data["dry_run"], list) and resp.data["dry_run"]
    assert mine_row(world) is None


def test_archived_project_is_refused(world: dict[str, Any]) -> None:
    Project.objects.filter(pk=world["mine"].pk).update(is_archived=True)
    assert save(world, share_pct=10).status_code == 403


# ── what the caller may read ─────────────────────────────────────────────


def test_dry_run_names_breaking_week_and_writes_nothing(world: dict[str, Any]) -> None:
    response = dry(world)
    assert response.status_code == 200, response.data
    assert response.data["saved"] is False
    verdict = response.data["verdict"]
    assert verdict["fits"] is False
    assert verdict["ceiling_pct"] == 100.0
    # Week 2 includes the hidden project, so no figure that contains it is shown.
    assert (verdict["peak_pct"], verdict["peak_reason"]) == (None, "withheld")
    week = verdict["first_breaking_week"]
    assert (week["week_start"], week["load_pct"], week["reason"]) == (day(7), None, "withheld")
    assert [(c["kind"], c["project_name"], c["pct"]) for c in week["contributions"]] == [
        ("this_change", "Mine", 50.0),
        ("other_work", None, None),
    ]
    assert [(w["load_pct"], w["over"], w["breaks"]) for w in verdict["weeks"]] == [
        (50.0, False, False),
        (None, True, True),
        (None, True, True),
    ]
    assert "Secret" not in str(response.data)
    assert verdict["definitions"]["allocation.load_pct"]
    assert verdict["as_of"]
    assert mine_row(world) is None


@pytest.mark.parametrize(
    ("role", "readable"),
    [
        (Role.VIEWER, False),
        (Role.MEMBER, False),
        # Admin passes the role gate, but the ``capacity`` signal defaults to the
        # team band (ADR-0104), which an Admin is outside of.
        (Role.ADMIN, False),
        (Role.SCHEDULER, True),
    ],
)
def test_other_projects_are_shown_only_where_load_is_readable(
    world: dict[str, Any], role: int, readable: bool
) -> None:
    ProjectMembership.objects.create(user=world["booker"], project=world["theirs"], role=role)
    verdict = dry(world).data["verdict"]
    lines = verdict["first_breaking_week"]["contributions"]
    if readable:
        assert ("other_project", "Secret", 60.0) in [
            (c["kind"], c["project_name"], c["pct"]) for c in lines
        ]
        assert verdict["peak_pct"] == 110.0
        assert_parts_sum(verdict)
    else:
        assert "Secret" not in str(verdict)
        assert verdict["peak_pct"] is None
        assert {60.0, 110.0}.isdisjoint(numbers(verdict))


@pytest.mark.parametrize("hidden_pct", [55, 60, 75])
def test_each_response_omits_the_hidden_percentage(world: dict[str, Any], hidden_pct: int) -> None:
    """Per response only: no field carries the hidden figure when the verdicts agree.

    This is not a non-disclosure proof. Fits / does-not-fit depends on hidden load,
    so it can be inferred across repeated checks (ADR-1500, Consequences).
    """
    ProjectResource.objects.filter(project=world["theirs"]).update(share_pct=hidden_pct)

    def strip(data: dict[str, Any]) -> dict[str, Any]:
        verdict = dict(data["verdict"])
        verdict.pop("as_of")
        return {**data, "verdict": verdict}

    reference = {
        "dry": strip(dry(world).data),
        "refused": strip(save(world).data),
    }
    accepted = save(world, accept_overage=True, reason="Launch week")
    assert accepted.status_code == 200
    row = world["client"].get(f"/api/v1/project-resources/?project={world['mine'].pk}").data
    note = Notification.objects.get(recipient=world["person"].user)
    observed = {
        **reference,
        "accepted": strip(accepted.data) | {"allocation_id": None},
        "row": {k: v for k, v in row["results"][0].items() if k.startswith(("share", "overage"))}
        | {"overage_accepted_at": None},
        "note": (note.subject, note.body),
    }
    for value in (hidden_pct, 50 + hidden_pct):
        assert float(value) not in numbers(observed), value
    # Pin the whole observable shape to the 60% world.
    ProjectResource.objects.filter(project=world["mine"]).delete()
    Notification.objects.all().delete()
    ProjectResource.objects.filter(project=world["theirs"]).update(share_pct=60)
    assert strip(dry(world).data) == observed["dry"]
    assert strip(save(world).data) == observed["refused"]


def test_own_project_tasks_are_withheld_when_its_capacity_is_not_shared(
    world: dict[str, Any],
) -> None:
    ProjectMembership.objects.filter(user=world["booker"], project=world["mine"]).update(
        role=Role.ADMIN
    )
    task_on(world["mine"], world["person"], "0.80", 0, 4)
    verdict = dry(world, share_pct=30, end=day(4)).data["verdict"]
    assert verdict["fits"] is True
    assert verdict["weeks"][0]["load_pct"] is None
    assert 80.0 not in numbers(verdict)


def test_draft_projects_do_not_count_and_archived_projects_do(world: dict[str, Any]) -> None:
    Project.objects.filter(pk=world["theirs"].pk).update(lifecycle=ProjectLifecycle.DRAFT)
    draft = dry(world).data["verdict"]
    assert (draft["fits"], draft["peak_pct"]) == (True, 50.0)
    Project.objects.filter(pk=world["theirs"].pk).update(
        lifecycle=ProjectLifecycle.ACTIVE, is_archived=True
    )
    assert dry(world).data["verdict"]["fits"] is False


# ── the judgment ─────────────────────────────────────────────────────────


def test_three_resolutions(world: dict[str, Any]) -> None:
    resolutions = dry(world).data["verdict"]["resolutions"]
    assert resolutions["shorten"] == {
        "available": True,
        "start": day(0),
        "end": day(6),
        "peak_pct": 50.0,
        "peak_reason": None,
    }
    # The other booking ends in week 3, so the window can start in week 4.
    assert resolutions["move"] == {
        "available": True,
        "start": day(21),
        "end": day(39),
        "peak_pct": 50.0,
        "peak_reason": None,
    }
    # Accepting keeps the hidden weeks, so its peak is not shown.
    assert (resolutions["accept"]["peak_pct"], resolutions["accept"]["peak_reason"]) == (
        None,
        "withheld",
    )


def test_resolution_peaks_are_shown_when_everything_is_readable(world: dict[str, Any]) -> None:
    ProjectMembership.objects.create(
        user=world["booker"], project=world["theirs"], role=Role.SCHEDULER
    )
    verdict = dry(world).data["verdict"]
    assert verdict["resolutions"]["accept"]["peak_pct"] == 110.0
    assert_parts_sum(verdict)


def test_shorten_unavailable_when_first_week_breaks(world: dict[str, Any]) -> None:
    resolutions = dry(world, start=day(7)).data["verdict"]["resolutions"]
    assert resolutions["shorten"]["available"] is False


def test_days_outside_the_window_are_not_judged(world: dict[str, Any]) -> None:
    """Audit repro: 120% on Monday only, then a 10% Wed-Fri booking, fits."""
    side = side_project(world)
    task_on(side, world["person"], "1.20", 0, 0)
    verdict = dry(world, share_pct=10, start=day(2), end=day(4)).data["verdict"]
    assert (verdict["fits"], verdict["peak_pct"]) == (True, 10.0)
    assert verdict["weeks"] == [
        {"week_start": day(0), "load_pct": 10.0, "reason": None, "over": False, "breaks": False}
    ]
    assert save(world, share_pct=10, start=day(2), end=day(4)).status_code == 200


def test_hidden_load_outside_the_window_is_not_judged(world: dict[str, Any]) -> None:
    task_on(world["theirs"], world["person"], "1.20", 0, 0)
    verdict = dry(world, share_pct=10, start=day(2), end=day(4)).data["verdict"]
    assert verdict["fits"] is True
    assert save(world, share_pct=10, start=day(2), end=day(4)).status_code == 200


def test_a_week_already_over_that_this_change_does_not_raise_is_not_refused(
    world: dict[str, Any],
) -> None:
    side = side_project(world)
    task_on(side, world["person"], "1.20", 2, 4)
    # This project already draws 50% there through a task; a 30% booking is inside it.
    task_on(world["mine"], world["person"], "0.50", 2, 4, name="own")
    verdict = dry(world, share_pct=30, start=day(2), end=day(4)).data["verdict"]
    assert verdict["fits"] is True
    assert [(w["load_pct"], w["over"], w["breaks"]) for w in verdict["weeks"]] == [
        (170.0, True, False)
    ]
    assert save(world, share_pct=30, start=day(2), end=day(4)).status_code == 200
    # Adding to that peak does break it, and the parts add up.
    raised = dry(world, share_pct=60, start=day(2), end=day(4)).data["verdict"]
    assert raised["fits"] is False
    assert raised["first_breaking_week"]["load_pct"] == 180.0
    assert_parts_sum(raised)


def test_lowering_a_booking_while_still_over_is_not_refused(world: dict[str, Any]) -> None:
    assert save(world, accept_overage=True, reason="Launch week").status_code == 200
    verdict = dry(world, share_pct=45).data["verdict"]
    assert verdict["fits"] is True
    assert [(w["over"], w["breaks"]) for w in verdict["weeks"]] == [
        (False, False),
        (True, False),
        (True, False),
    ]
    assert save(world, share_pct=45).status_code == 200
    row = mine_row(world)
    assert row is not None
    # Still over, so the accepted overage stays on record.
    assert (row.share_pct, row.overage_reason) == (45, "Launch week")


def test_over_ceiling_without_accept_saves_nothing(world: dict[str, Any]) -> None:
    response = save(world)
    assert response.status_code == 409
    assert response.data["code"] == "allocation_over_ceiling"
    assert response.data["verdict"]["fits"] is False
    assert response.data["verdict"]["peak_pct"] is None
    assert mine_row(world) is None


@pytest.mark.parametrize("reason", [None, "", "   "])
def test_bare_accept_is_refused(world: dict[str, Any], reason: str | None) -> None:
    extra: dict[str, Any] = {"accept_overage": True}
    if reason is not None:
        extra["reason"] = reason
    response = save(world, **extra)
    assert response.status_code == 400
    assert "reason" in response.data
    assert mine_row(world) is None


def test_accept_with_reason_records_and_notifies_and_matches_dry_run(
    world: dict[str, Any],
) -> None:
    preview = dry(world).data["verdict"]
    response = save(world, accept_overage=True, reason="Launch week")
    assert response.status_code == 200, response.data
    saved = response.data["verdict"]
    # Acceptance criterion: the dry run equals what the save judged.
    preview.pop("as_of")
    saved.pop("as_of")
    assert preview == saved

    row = mine_row(world)
    assert row is not None
    assert response.data["allocation_id"] == str(row.pk)
    assert (row.share_pct, row.overage_reason) == (50, "Launch week")
    assert row.overage_week == date(7)
    assert row.overage_accepted_by_id == world["booker"].pk
    note = Notification.objects.get(recipient=world["person"].user)
    # Aisha is rostered but not a member: the notice must survive the #3510
    # redaction, so it is account-scoped and does not name the project.
    assert note.project_id is None
    assert "Mine" not in note.subject
    assert note.event_type == "allocation.overage_accepted"
    assert "Launch week" in note.body
    assert "over your ceiling of 100.0%" in note.body
    # Re-checking the stored booking: the same weeks are over, and none breaks,
    # because the booking is already there.
    again = dry(world).data["verdict"]
    assert again["fits"] is True
    assert [w["over"] for w in again["weeks"]] == [w["over"] for w in preview["weeks"]]


@pytest.mark.parametrize("hidden", [True, False])
def test_dry_run_equals_save_with_tasks_and_time_off(world: dict[str, Any], hidden: bool) -> None:
    side = side_project(world)
    task_on(side, world["person"], "0.30", 7, 11)
    CalendarException.objects.create(calendar=world["cal"], exc_start=date(9), exc_end=date(9))
    if not hidden:
        ProjectResource.objects.filter(project=world["theirs"]).update(share_pct=None)
        task_on(side, world["person"], "0.40", 14, 18, name="later")
    preview = dry(world, share_pct=60).data["verdict"]
    assert preview["fits"] is False
    if not hidden:
        assert_parts_sum(preview)
        kinds = [c["kind"] for c in preview["first_breaking_week"]["contributions"]]
        assert kinds == ["this_change", "other_project", "time_off"]
    response = save(world, share_pct=60, accept_overage=True, reason="Peak")
    assert response.status_code == 200, response.data
    saved = response.data["verdict"]
    preview.pop("as_of")
    saved.pop("as_of")
    assert preview == saved


@pytest.mark.parametrize(
    ("role", "visible"), [(Role.VIEWER, False), (Role.MEMBER, False), (Role.SCHEDULER, True)]
)
def test_overage_record_is_withheld_below_scheduler(
    world: dict[str, Any], role: int, visible: bool
) -> None:
    save(world, accept_overage=True, reason="Launch week")
    reader = User.objects.create_user(username="reader", password="x")
    ProjectMembership.objects.create(user=reader, project=world["mine"], role=role)
    client = APIClient()
    client.force_authenticate(reader)
    listing = client.get(f"/api/v1/project-resources/?project={world['mine'].pk}").data
    data = listing["results"][0]
    assert data["share_pct"] == 50
    assert data["overage_reason"] == ("Launch week" if visible else "")
    assert (data["overage_week"] is not None) is visible
    assert "overage_peak_pct" not in data


def test_member_is_told_which_project_and_the_inbox_shows_it(world: dict[str, Any]) -> None:
    ProjectMembership.objects.create(
        user=world["person"].user, project=world["mine"], role=Role.MEMBER
    )
    save(world, accept_overage=True, reason="Launch week")
    client = APIClient()
    client.force_authenticate(world["person"].user)
    row = client.get("/api/v1/me/notifications/").data["results"][0]
    assert row["subject"] == "You are booked over capacity on Mine"


def test_non_member_notice_is_readable_in_the_inbox(world: dict[str, Any]) -> None:
    save(world, accept_overage=True, reason="Launch week")
    client = APIClient()
    client.force_authenticate(world["person"].user)
    row = client.get("/api/v1/me/notifications/").data["results"][0]
    assert "Launch week" in row["body"]


def test_a_replayed_accepted_save_notifies_once(world: dict[str, Any]) -> None:
    payload = body(world, share_pct=100, accept_overage=True, reason="Release week")
    headers = {"HTTP_IDEMPOTENCY_KEY": str(uuid.uuid4())}

    first = world["client"].post(URL, payload, format="json", **headers)
    again = world["client"].post(URL, payload, format="json", **headers)

    assert first.status_code == again.status_code == 200
    assert again["Idempotent-Replay"] == "true"
    assert again.json() == first.json()
    assert Notification.objects.filter(recipient=world["person"].user).count() == 1


def test_a_later_fitting_save_clears_the_overage(world: dict[str, Any]) -> None:
    save(world, accept_overage=True, reason="Launch week")
    assert save(world, share_pct=20).status_code == 200
    row = mine_row(world)
    assert row is not None
    assert (row.share_pct, row.overage_reason, row.overage_accepted_by_id) == (20, "", None)


def test_removing_a_booking_is_never_refused(world: dict[str, Any]) -> None:
    save(world, accept_overage=True, reason="x")
    assert save(world, share_pct=0).status_code == 200
    row = mine_row(world)
    assert row is not None and row.share_pct is None and row.share_start is None
    assert row.overage_reason == ""


def test_removing_a_missing_booking_does_not_roster(world: dict[str, Any]) -> None:
    assert save(world, share_pct=0).data["allocation_id"] is None
    assert mine_row(world) is None


def test_lower_ceiling_is_judged_against_itself(world: dict[str, Any]) -> None:
    Resource.objects.filter(pk=world["person"].pk).update(max_units=Decimal("0.60"))
    verdict = dry(world, share_pct=70, end=day(4)).data["verdict"]
    assert (verdict["fits"], verdict["ceiling_pct"], verdict["peak_pct"]) == (False, 60.0, 70.0)
    assert_parts_sum(verdict)


def test_time_off_is_removed_from_capacity(world: dict[str, Any]) -> None:
    CalendarException.objects.create(calendar=world["cal"], exc_start=date(2), exc_end=date(2))
    # 80% fills the ceiling exactly once one day in five (20%) is gone.
    assert dry(world, share_pct=80, end=day(4)).data["verdict"]["fits"] is True
    verdict = dry(world, share_pct=90, end=day(4)).data["verdict"]
    assert verdict["peak_pct"] == 110.0
    assert verdict["first_breaking_week"]["contributions"][-1] == {
        "kind": "time_off",
        "project_id": None,
        "project_name": None,
        "pct": 20.0,
    }
    assert_parts_sum(verdict)


def test_time_off_outside_the_window_is_not_charged(world: dict[str, Any]) -> None:
    CalendarException.objects.create(calendar=world["cal"], exc_start=date(0), exc_end=date(0))
    verdict = dry(world, share_pct=100, start=day(2), end=day(4)).data["verdict"]
    assert (verdict["fits"], verdict["peak_pct"]) == (True, 100.0)


def test_task_units_count_once_inside_a_booking_and_assignee_never(
    world: dict[str, Any],
) -> None:
    task_on(world["mine"], world["person"], "0.40", 0, 4, name="a")
    Task.objects.create(
        project=world["mine"],
        name="bare",
        duration=5,
        status="NOT_STARTED",
        early_start=MON,
        early_finish=date(4),
        assignee=world["person"].user,
    )
    assert dry(world, share_pct=50, end=day(4)).data["verdict"]["peak_pct"] == 50.0
    assert dry(world, share_pct=30, end=day(4)).data["verdict"]["peak_pct"] == 40.0


def test_second_booking_sees_the_first(world: dict[str, Any]) -> None:
    other = side_project(world)
    assert save(world, share_pct=70, end=day(4)).status_code == 200
    refused = save(world, project=str(other.pk), share_pct=70, end=day(4))
    assert refused.status_code == 409
    assert_parts_sum(refused.data["verdict"])


def test_failed_check_holds_the_change(
    world: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(**_: Any) -> None:
        raise RuntimeError("db gone")

    monkeypatch.setattr(allocation_views, "build_verdict", boom)
    response = save(world, share_pct=10)
    assert response.status_code == 503
    assert response.data["code"] == "allocation_check_unavailable"
    assert response.data["detail"]
    assert mine_row(world) is None


@pytest.mark.parametrize("failing", ["_scope", "after_write"])
def test_failure_anywhere_in_check_and_save_is_503_and_saves_nothing(
    world: dict[str, Any], monkeypatch: pytest.MonkeyPatch, failing: str
) -> None:
    def boom(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("boom")

    if failing == "_scope":
        monkeypatch.setattr(allocation_views.AllocationView, "_scope", boom)
    else:
        # Raises inside ``_save`` after the booking row is written: it must roll back.
        monkeypatch.setattr(allocation_views, "create_event_notifications", boom)
    response = save(world, accept_overage=True, reason="Launch week")
    assert response.status_code == 503
    assert response.data["code"] == "allocation_check_unavailable"
    assert mine_row(world) is None


@pytest.mark.parametrize(
    "overrides",
    [{"end": day(-1)}, {"end": day(800)}, {"share_pct": 500}, {"start": "0001-01-01"}],
)
def test_bad_windows_are_refused(world: dict[str, Any], overrides: dict[str, Any]) -> None:
    assert dry(world, **overrides).status_code == 400


def test_roster_serializer_cannot_write_the_booking(world: dict[str, Any]) -> None:
    row = ProjectResource.objects.create(project=world["mine"], resource=world["person"])
    response = world["client"].patch(
        f"/api/v1/project-resources/{row.pk}/", {"share_pct": 300}, format="json"
    )
    assert response.status_code == 200
    assert response.data["share_pct"] is None


@pytest.mark.django_db(transaction=True)
def test_concurrent_saves_cannot_jointly_exceed_the_ceiling(
    world: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    from concurrent.futures import ThreadPoolExecutor

    from django.db import connection

    real = allocation_views.build_verdict

    def slow(**kwargs: Any) -> dict[str, Any]:
        # Hold the gap between reading the load and writing the booking open, so
        # that without the row lock both requests would read an empty week.
        verdict = real(**kwargs)
        time.sleep(0.5)
        return verdict

    monkeypatch.setattr(allocation_views, "build_verdict", slow)

    other = side_project(world)

    def book(project: Project) -> int:
        client = APIClient()
        client.force_authenticate(world["booker"])
        try:
            return client.post(
                URL,
                body(world, project=str(project.pk), share_pct=70, end=day(4)),
                format="json",
            ).status_code
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = sorted(pool.map(book, [world["mine"], other]))
    assert statuses == [200, 409]
