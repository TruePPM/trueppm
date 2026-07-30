"""Tests for the user-scoped Program / ProgramMembership delta sync pull (#561).

Mirrors ``test_sync_pull.py`` (the project-scoped endpoint) — the two share the
delta protocol (cursor pagination, ``server_version`` watermark, tombstones); the
program endpoint differs only in scope (the caller's programs, no path param).
"""

from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, Role
from trueppm_api.apps.projects.models import Program

User = get_user_model()

URL = "/api/v1/sync/user/programs/"


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="prog_sync_user", password="pw")


@pytest.fixture
def program(db: object) -> Program:
    return Program.objects.create(name="Alpha", description="Program Alpha")


@pytest.fixture
def membership(program: Program, user: object) -> ProgramMembership:
    return ProgramMembership.objects.create(program=program, user=user, role=Role.ADMIN)


@pytest.fixture
def authed_client(user: object, membership: ProgramMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_requires_auth() -> None:
    assert APIClient().get(URL).status_code == 401


# ---------------------------------------------------------------------------
# Response structure
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_response_shape(authed_client: APIClient) -> None:
    body = authed_client.get(URL).json()
    assert set(body) == {"changes", "timestamp", "next_cursor", "has_more"}
    assert set(body["changes"]) == {"programs", "program_memberships"}
    for bucket in body["changes"].values():
        assert set(bucket) == {"created", "updated", "deleted"}
    assert body["has_more"] is False
    assert body["next_cursor"] is None


@pytest.mark.django_db
def test_returns_program_and_membership(
    authed_client: APIClient, program: Program, membership: ProgramMembership
) -> None:
    changes = authed_client.get(URL).json()["changes"]
    prog_ids = {row["id"] for row in changes["programs"]["updated"]}
    mem_ids = {row["id"] for row in changes["program_memberships"]["updated"]}
    assert str(program.pk) in prog_ids
    assert str(membership.pk) in mem_ids
    # Program payload carries the offline-list card fields.
    row = next(r for r in changes["programs"]["updated"] if r["id"] == str(program.pk))
    assert row["name"] == "Alpha"
    assert {"server_version", "methodology", "health", "target_date", "lead"} <= set(row)


@pytest.mark.django_db
def test_timestamp_is_high_water_mark(authed_client: APIClient, program: Program) -> None:
    body = authed_client.get(URL).json()
    assert body["timestamp"] >= program.server_version


# ---------------------------------------------------------------------------
# Scoping — only the caller's programs
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_excludes_programs_without_membership(authed_client: APIClient, program: Program) -> None:
    other = Program.objects.create(name="Bravo")
    # The caller has no membership on ``other`` — it must not appear.
    changes = authed_client.get(URL).json()["changes"]
    prog_ids = {row["id"] for row in changes["programs"]["updated"]}
    assert str(program.pk) in prog_ids
    assert str(other.pk) not in prog_ids


@pytest.mark.django_db
def test_returns_co_member_rows(
    authed_client: APIClient, program: Program, membership: ProgramMembership
) -> None:
    """Parity with project sync: all memberships of the caller's programs, not just own."""
    colleague = User.objects.create_user(username="colleague", password="pw")
    co = ProgramMembership.objects.create(program=program, user=colleague, role=Role.MEMBER)
    mem_ids = {
        row["id"]
        for row in authed_client.get(URL).json()["changes"]["program_memberships"]["updated"]
    }
    assert {str(membership.pk), str(co.pk)} <= mem_ids


@pytest.mark.django_db
def test_soft_deleted_membership_does_not_leak_other_programs(
    authed_client: APIClient, user: object, program: Program
) -> None:
    """A soft-deleted membership must not pull an otherwise-inaccessible program in."""
    other = Program.objects.create(name="Charlie")
    # Caller once had access to ``other`` but was removed (membership soft-deleted).
    removed = ProgramMembership.objects.create(program=other, user=user, role=Role.VIEWER)
    removed.soft_delete()
    changes = authed_client.get(URL).json()["changes"]
    prog_ids = {row["id"] for row in changes["programs"]["updated"]}
    assert str(other.pk) not in prog_ids


# ---------------------------------------------------------------------------
# Delta floor (`since`)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_since_filters_unchanged_rows(
    authed_client: APIClient, program: Program, membership: ProgramMembership
) -> None:
    first = authed_client.get(URL).json()
    hwm = first["timestamp"]
    # Nothing changed since the first pull — the delta is empty.
    delta = authed_client.get(f"{URL}?since={hwm}").json()
    assert delta["changes"]["programs"]["updated"] == []
    assert delta["changes"]["program_memberships"]["updated"] == []

    # Bump the program; it reappears above the floor.
    program.name = "Alpha Prime"
    program.save()
    delta2 = authed_client.get(f"{URL}?since={hwm}").json()
    prog_ids = {row["id"] for row in delta2["changes"]["programs"]["updated"]}
    assert str(program.pk) in prog_ids


@pytest.mark.django_db
def test_negative_since_rejected(authed_client: APIClient) -> None:
    assert authed_client.get(f"{URL}?since=-1").status_code == 400


@pytest.mark.django_db
def test_malformed_cursor_rejected(authed_client: APIClient) -> None:
    assert authed_client.get(f"{URL}?cursor=not-base64!!").status_code == 400


# ---------------------------------------------------------------------------
# Tombstones
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_soft_deleted_program_becomes_tombstone(
    authed_client: APIClient, program: Program, membership: ProgramMembership
) -> None:
    hwm = authed_client.get(URL).json()["timestamp"]
    program.soft_delete()
    changes = authed_client.get(f"{URL}?since={hwm}").json()["changes"]
    assert str(program.pk) in changes["programs"]["deleted"]
    assert str(program.pk) not in {r["id"] for r in changes["programs"]["updated"]}


@pytest.mark.django_db
def test_soft_deleted_co_member_becomes_tombstone(
    authed_client: APIClient, program: Program, membership: ProgramMembership
) -> None:
    colleague = User.objects.create_user(username="leaver", password="pw")
    co = ProgramMembership.objects.create(program=program, user=colleague, role=Role.MEMBER)
    hwm = authed_client.get(URL).json()["timestamp"]
    co.soft_delete()
    changes = authed_client.get(f"{URL}?since={hwm}").json()["changes"]
    assert str(co.pk) in changes["program_memberships"]["deleted"]


# ---------------------------------------------------------------------------
# Empty state
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_user_with_no_programs(db: object) -> None:
    loner = User.objects.create_user(username="loner", password="pw")
    c = APIClient()
    c.force_authenticate(user=loner)
    body = c.get(URL).json()
    assert body["changes"]["programs"]["updated"] == []
    assert body["changes"]["program_memberships"]["updated"] == []
    assert body["timestamp"] == 0
    assert body["has_more"] is False


# ---------------------------------------------------------------------------
# Pagination
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_pagination_paths_all_rows(user: object) -> None:
    """page_size smaller than the row count drains across pages without loss/dup."""
    progs = [Program.objects.create(name=f"P{i}") for i in range(5)]
    for p in progs:
        ProgramMembership.objects.create(program=p, user=user, role=Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=user)

    seen_programs: set[str] = set()
    seen_memberships: set[str] = set()
    cursor: str | None = None
    guard = 0
    while True:
        guard += 1
        assert guard < 50, "pagination did not terminate"
        q = f"{URL}?page_size=2" + (f"&cursor={cursor}" if cursor else "")
        body = c.get(q).json()
        seen_programs |= {r["id"] for r in body["changes"]["programs"]["updated"]}
        seen_memberships |= {r["id"] for r in body["changes"]["program_memberships"]["updated"]}
        if not body["has_more"]:
            break
        cursor = body["next_cursor"]
        assert cursor is not None

    assert seen_programs == {str(p.pk) for p in progs}
    assert len(seen_memberships) == 5


@pytest.mark.django_db
def test_timestamp_is_pinned_for_the_whole_paging_session(user: object) -> None:
    """`timestamp` is session state here too — it must not move mid-drain (#2568).

    The program slice pages the same cursor as the project slice, so it inherits
    the same defect: a mid-drain write to an already-drained collection would be
    filtered out by a checkpoint the session never drained to.
    """
    progs = [Program.objects.create(name=f"Q{i}") for i in range(5)]
    for p in progs:
        ProgramMembership.objects.create(program=p, user=user, role=Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=user)

    stamps: list[int] = []
    cursor: str | None = None
    guard = 0
    while True:
        guard += 1
        assert guard < 50, "pagination did not terminate"
        q = f"{URL}?page_size=2" + (f"&cursor={cursor}" if cursor else "")
        body = c.get(q).json()
        stamps.append(body["timestamp"])
        # Bump the sequence between pages; a per-request watermark would climb.
        progs[0].description = f"churn {guard}"
        progs[0].save()
        if not body["has_more"]:
            break
        cursor = body["next_cursor"]

    assert len(stamps) > 1, "fixture assumption: the delta spans multiple pages"
    assert len(set(stamps)) == 1, f"timestamp drifted across pages: {stamps}"


@pytest.mark.django_db
def test_continuation_page_issues_no_watermark_aggregates(user: object) -> None:
    """A continuation page must not re-run the watermark aggregates (#2568).

    ``UserProgramSyncView._watermark`` costs two ``Max(server_version)`` aggregates,
    the second scanning every membership of every accessible program. Reading the
    pinned value off the cursor removes both from continuation pages, turning
    O(pages x rows) repeated work into O(rows) paid once. Asserting on the absence
    of ``MAX(`` rather than a bare query count keeps the test aimed at that
    regression and immune to unrelated churn in the surrounding queries.
    """
    progs = [Program.objects.create(name=f"R{i}") for i in range(5)]
    for p in progs:
        ProgramMembership.objects.create(program=p, user=user, role=Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=user)

    first = c.get(f"{URL}?page_size=2").json()
    assert first["has_more"] is True, "fixture assumption: the delta spans multiple pages"

    with CaptureQueriesContext(connection) as ctx:
        c.get(f"{URL}?page_size=2&cursor={first['next_cursor']}")
    aggregates = [q["sql"] for q in ctx.captured_queries if "MAX(" in q["sql"].upper()]
    assert not aggregates, f"continuation page recomputed the watermark: {aggregates}"


@pytest.mark.django_db
def test_missing_uuid_route_is_not_shadowed() -> None:
    """The static /sync/user/programs/ route must not collide with the uuid pk route."""
    # A random uuid under /projects/<uuid>/sync/ 404s; /sync/user/programs/ must 401
    # (auth) rather than 404 — proving the new path resolves to its own view.
    assert APIClient().get(f"/api/v1/projects/{uuid.uuid4()}/sync/").status_code in (401, 404)
    assert APIClient().get(URL).status_code == 401
