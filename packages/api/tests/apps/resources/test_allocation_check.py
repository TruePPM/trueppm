"""Allocation conflict check: dry-run verdict, ceiling, accept-with-reason (#4806)."""

from __future__ import annotations

import datetime
import secrets
import time
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
    Task,
)
from trueppm_api.apps.resources import allocation_views
from trueppm_api.apps.resources.models import ProjectResource, Resource, TaskResource

User = get_user_model()

URL = "/api/v1/allocations/"
MON = datetime.date(2026, 6, 1)  # a Monday


def day(offset: int) -> str:
    return (MON + datetime.timedelta(days=offset)).isoformat()


@pytest.fixture
def world(db: Any) -> dict[str, Any]:
    cal = Calendar.objects.create(name="Std")
    booker = User.objects.create_user(username="rm", password="x")
    person_user = User.objects.create_user(username="aisha", password="x")
    mine = Project.objects.create(name="Mine", start_date=MON, calendar=cal)
    theirs = Project.objects.create(name="Secret", start_date=MON, calendar=cal)
    ProjectMembership.objects.create(user=booker, project=mine, role=Role.SCHEDULER)
    person = Resource.objects.create(name="Aisha", calendar=cal, user=person_user)
    # 60% on another project in weeks 2 and 3.
    ProjectResource.objects.create(
        project=theirs,
        resource=person,
        share_pct=60,
        share_start=MON + datetime.timedelta(days=7),
        share_end=MON + datetime.timedelta(days=20),
    )
    client = APIClient()
    client.force_authenticate(booker)
    return {
        "cal": cal,
        "booker": booker,
        "mine": mine,
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


def test_archived_project_is_refused(world: dict[str, Any]) -> None:
    Project.objects.filter(pk=world["mine"].pk).update(is_archived=True)
    assert save(world, share_pct=10).status_code == 403


def test_dry_run_names_breaking_week_and_writes_nothing(world: dict[str, Any]) -> None:
    response = dry(world)
    assert response.status_code == 200, response.data
    assert response.data["saved"] is False
    verdict = response.data["verdict"]
    assert verdict["fits"] is False
    assert verdict["ceiling_pct"] == 100.0
    assert verdict["peak_pct"] == 110.0
    assert verdict["first_breaking_week"]["week_start"] == day(7)
    # The other project is not the caller's, so it is counted but never named.
    assert [
        (c["kind"], c["project_name"], c["pct"])
        for c in verdict["first_breaking_week"]["contributions"]
    ] == [("this_change", "Mine", 50.0), ("other_work", None, 60.0)]
    assert "Secret" not in str(response.data)
    assert verdict["definitions"]["allocation.load_pct"]
    assert verdict["as_of"]
    assert mine_row(world) is None


def test_member_projects_are_named(world: dict[str, Any]) -> None:
    ProjectMembership.objects.create(
        user=world["booker"], project=world["theirs"], role=Role.VIEWER
    )
    lines = dry(world).data["verdict"]["first_breaking_week"]["contributions"]
    assert ("other_project", "Secret") in [(c["kind"], c["project_name"]) for c in lines]


def test_three_resolutions(world: dict[str, Any]) -> None:
    resolutions = dry(world).data["verdict"]["resolutions"]
    assert resolutions["shorten"] == {
        "available": True,
        "start": day(0),
        "end": day(6),
        "peak_pct": 50.0,
    }
    # The other booking ends in week 3, so the window can start in week 4.
    assert resolutions["move"] == {
        "available": True,
        "start": day(21),
        "end": day(39),
        "peak_pct": 50.0,
    }
    assert resolutions["accept"]["peak_pct"] == 110.0


def test_shorten_unavailable_when_first_week_breaks(world: dict[str, Any]) -> None:
    resolutions = dry(world, start=day(7)).data["verdict"]["resolutions"]
    assert resolutions["shorten"]["available"] is False


def test_over_ceiling_without_accept_saves_nothing(world: dict[str, Any]) -> None:
    response = save(world)
    assert response.status_code == 409
    assert response.data["code"] == "allocation_over_ceiling"
    assert response.data["verdict"]["fits"] is False
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
    assert row.overage_peak_pct == Decimal("110.0")
    assert row.overage_week == MON + datetime.timedelta(days=7)
    assert row.overage_accepted_by_id == world["booker"].pk
    note = Notification.objects.get(recipient=world["person"].user)
    assert note.event_type == "allocation.overage_accepted"
    assert "Launch week" in note.body
    # And re-checking the stored booking gives the same answer as before it was saved.
    again = dry(world).data["verdict"]
    again.pop("as_of")
    assert again == preview


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
    assert (data["overage_peak_pct"] is not None) is visible


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


def test_removing_a_missing_booking_does_not_roster(world: dict[str, Any]) -> None:
    assert save(world, share_pct=0).data["allocation_id"] is None
    assert mine_row(world) is None


def test_lower_ceiling_is_judged_against_itself(world: dict[str, Any]) -> None:
    Resource.objects.filter(pk=world["person"].pk).update(max_units=Decimal("0.60"))
    verdict = dry(world, share_pct=70, end=day(4)).data["verdict"]
    assert (verdict["fits"], verdict["ceiling_pct"], verdict["peak_pct"]) == (False, 60.0, 70.0)


def test_time_off_is_removed_from_capacity(world: dict[str, Any]) -> None:
    off = MON + datetime.timedelta(days=2)
    CalendarException.objects.create(calendar=world["cal"], exc_start=off, exc_end=off)
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


def test_task_units_count_once_inside_a_booking_and_assignee_never(
    world: dict[str, Any],
) -> None:
    def task(name: str, **kwargs: Any) -> Task:
        return Task.objects.create(
            project=world["mine"],
            name=name,
            duration=5,
            status="NOT_STARTED",
            early_start=MON,
            early_finish=MON + datetime.timedelta(days=4),
            **kwargs,
        )

    TaskResource.objects.create(task=task("a"), resource=world["person"], units=Decimal("0.40"))
    task("bare", assignee=world["person"].user)
    assert dry(world, share_pct=50, end=day(4)).data["verdict"]["peak_pct"] == 50.0
    assert dry(world, share_pct=30, end=day(4)).data["verdict"]["peak_pct"] == 40.0


def test_second_booking_sees_the_first(world: dict[str, Any]) -> None:
    other = Project.objects.create(name="Third", start_date=MON, calendar=world["cal"])
    ProjectMembership.objects.create(user=world["booker"], project=other, role=Role.SCHEDULER)
    assert save(world, share_pct=70, end=day(4)).status_code == 200
    assert save(world, project=str(other.pk), share_pct=70, end=day(4)).status_code == 409


def test_failed_check_holds_the_change(
    world: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(**_: Any) -> None:
        raise RuntimeError("db gone")

    monkeypatch.setattr(allocation_views, "build_verdict", boom)
    response = save(world, share_pct=10)
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

    other = Project.objects.create(name="Third", start_date=MON, calendar=world["cal"])
    ProjectMembership.objects.create(user=world["booker"], project=other, role=Role.SCHEDULER)

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
