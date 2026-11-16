"""Keyset pagination on ``GET /api/v1/tasks/?pagination=keyset`` (#3381).

The Schedule numbers WBS siblings by their position in the array the server
returns, so the seek has to reproduce the default ``Task.Meta.ordering`` exactly,
cover every row exactly once, and stay stable when rows are inserted between two
page requests — the failure page-number pagination has and keyset does not.
"""

from __future__ import annotations

import base64
import json
import uuid
from datetime import date
from typing import Any
from urllib.parse import parse_qs, urlparse

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.projects.task_keyset import TaskCursor

TASKS_URL = "/api/v1/tasks/"


@pytest.fixture
def user(db: object) -> Any:
    return get_user_model().objects.create_user(
        username="keyset-tester", email="keyset@example.com", password="pw"
    )


@pytest.fixture
def client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Default")


def _project(calendar: Calendar, user: Any, name: str, *, member: bool = True) -> Project:
    project = Project.objects.create(name=name, start_date=date(2026, 1, 1), calendar=calendar)
    if member:
        ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    return project


@pytest.fixture
def project(calendar: Calendar, user: Any) -> Project:
    return _project(calendar, user, "Keyset Project")


def _task(project: Project, name: str, wbs: str | None) -> Task:
    task = Task.objects.create(project=project, name=name, wbs_path=wbs)
    if wbs is None:
        # save() assigns a path to a pathless row; force the NULL a corrupt or
        # pre-ltree row can still carry.
        Task.objects.filter(pk=task.pk).update(wbs_path=None)
    return task


def _walk(client: APIClient, params: dict[str, Any]) -> tuple[list[str], int]:
    """Follow keyset ``next`` links to the end; return the ids and the page count."""
    ids: list[str] = []
    query = {**params, "pagination": "keyset"}
    pages = 0
    while True:
        resp = client.get(TASKS_URL, query)
        assert resp.status_code == 200, resp.data
        pages += 1
        assert "count" not in resp.data
        assert resp.data["previous"] is None
        ids.extend(row["id"] for row in resp.data["results"])
        if resp.data["next"] is None:
            return ids, pages
        query = {k: v[0] for k, v in parse_qs(urlparse(resp.data["next"]).query).items()}
        assert query["pagination"] == "keyset"
        assert pages < 100, "walk did not terminate"


def _default_order(client: APIClient, params: dict[str, Any]) -> list[str]:
    resp = client.get(TASKS_URL, {**params, "page_size": 500})
    assert resp.status_code == 200, resp.data
    return [row["id"] for row in resp.data["results"]]


@pytest.mark.django_db
class TestKeysetWalk:
    def test_walk_matches_the_default_order_exactly(
        self, client: APIClient, project: Project
    ) -> None:
        # Numeric-aware labels (1.2 < 1.10) are what WbsSortKey exists for; the
        # walk must agree with the page-number order the Schedule renders today.
        for wbs in ["1", "1.1", "1.2", "1.10", "2", "10", "3", "3.1", "1.3"]:
            _task(project, f"T{wbs}", wbs)
        params = {"project": str(project.pk), "page_size": 2}

        ids, pages = _walk(client, params)

        assert ids == _default_order(client, {"project": str(project.pk)})
        assert pages == 5
        assert len(set(ids)) == len(ids) == 9

    def test_exact_multiple_of_page_size_ends_without_an_empty_page(
        self, client: APIClient, project: Project
    ) -> None:
        for i in range(1, 5):
            _task(project, f"T{i}", str(i))
        ids, pages = _walk(client, {"project": str(project.pk), "page_size": 2})
        assert len(ids) == 4
        # page_size + 1 lookahead: the second page already knows it is the last.
        assert pages == 2

    def test_ties_on_wbs_and_name_are_broken_by_id(
        self, client: APIClient, calendar: Calendar, user: Any
    ) -> None:
        # The (project, wbs_path) exclusion constraint forbids a duplicate path
        # within one project, but an unscoped read spans projects, where identical
        # trees tie on both leading sort columns.
        created = []
        for i in range(3):
            proj = _project(calendar, user, f"Twin {i}")
            created += [_task(proj, "Same", "1"), _task(proj, "Same", "2")]

        ids, _ = _walk(client, {"page_size": 1})

        expected = [str(t.pk) for t in sorted(created, key=lambda t: (str(t.wbs_path), str(t.pk)))]
        assert ids == expected

    @pytest.mark.parametrize(("page_size", "expected_pages"), [(1, 4), (3, 2)])
    def test_null_wbs_path_rows_form_the_tail_across_a_page_boundary(
        self, client: APIClient, project: Project, page_size: int, expected_pages: int
    ) -> None:
        # page_size=1 enters the tail from a NULL cursor; page_size=3 straddles
        # the non-NULL -> NULL boundary inside one page (the top-up query).
        a = _task(project, "A", "1")
        b = _task(project, "B", "2")
        null_x = _task(project, "X", None)
        null_y = _task(project, "Y", None)

        ids, pages = _walk(client, {"project": str(project.pk), "page_size": page_size})

        assert ids == [str(a.pk), str(b.pk), str(null_x.pk), str(null_y.pk)]
        assert pages == expected_pages

    def test_only_member_projects_are_walked(
        self, client: APIClient, calendar: Calendar, user: Any, project: Project
    ) -> None:
        mine = _task(project, "Mine", "1")
        foreign = _project(calendar, user, "Not mine", member=False)
        _task(foreign, "Theirs", "1")

        ids, _ = _walk(client, {"page_size": 1})

        assert ids == [str(mine.pk)]

    def test_search_filter_composes_with_the_seek(
        self, client: APIClient, project: Project
    ) -> None:
        for i in range(1, 6):
            _task(project, f"alpha {i}" if i % 2 else f"beta {i}", str(i))
        ids, _ = _walk(client, {"project": str(project.pk), "search": "alpha", "page_size": 1})
        assert len(ids) == 3


@pytest.mark.django_db
class TestStableAcrossConcurrentWrites:
    def test_insert_before_the_cursor_neither_duplicates_nor_skips(
        self, client: APIClient, project: Project
    ) -> None:
        for i in range(2, 8):
            _task(project, f"T{i}", str(i))
        base = {"project": str(project.pk), "page_size": 3}

        first = client.get(TASKS_URL, {**base, "pagination": "keyset"})
        page1 = [row["id"] for row in first.data["results"]]
        # A collaborator adds a row that sorts before everything already served.
        _task(project, "T1", "1")
        nxt = {k: v[0] for k, v in parse_qs(urlparse(first.data["next"]).query).items()}
        page2 = [row["id"] for row in client.get(TASKS_URL, nxt).data["results"]]

        served = page1 + page2
        assert len(set(served)) == len(served) == 6
        original = set(
            Task.objects.filter(project=project).exclude(name="T1").values_list("pk", flat=True)
        )
        assert {str(pk) for pk in original} == set(served)

    def test_page_number_pagination_does_duplicate_under_the_same_insert(
        self, client: APIClient, project: Project
    ) -> None:
        # Negative control: proves the test above exercises a real hazard rather
        # than passing because nothing could have gone wrong.
        for i in range(2, 8):
            _task(project, f"T{i}", str(i))
        base = {"project": str(project.pk), "page_size": 3}

        page1 = [row["id"] for row in client.get(TASKS_URL, base).data["results"]]
        _task(project, "T1", "1")
        page2 = [row["id"] for row in client.get(TASKS_URL, {**base, "page": 2}).data["results"]]

        assert set(page1) & set(page2), "page-number walk no longer shifts on insert"

    def test_delete_of_the_cursor_row_does_not_lose_its_successors(
        self, client: APIClient, project: Project
    ) -> None:
        tasks = [_task(project, f"T{i}", str(i)) for i in range(1, 5)]
        first = client.get(
            TASKS_URL, {"project": str(project.pk), "page_size": 2, "pagination": "keyset"}
        )
        Task.objects.filter(pk=tasks[1].pk).update(is_deleted=True)
        nxt = {k: v[0] for k, v in parse_qs(urlparse(first.data["next"]).query).items()}
        page2 = [row["id"] for row in client.get(TASKS_URL, nxt).data["results"]]
        assert page2 == [str(tasks[2].pk), str(tasks[3].pk)]


@pytest.mark.django_db
class TestKeysetQueryShape:
    def test_no_count_and_no_offset_on_a_deep_page(
        self, client: APIClient, project: Project
    ) -> None:
        for i in range(1, 8):
            _task(project, f"T{i}", str(i))
        base = {"project": str(project.pk), "page_size": 2}
        first = client.get(TASKS_URL, {**base, "pagination": "keyset"})
        nxt = {k: v[0] for k, v in parse_qs(urlparse(first.data["next"]).query).items()}

        with CaptureQueriesContext(connection) as keyset_ctx:
            assert client.get(TASKS_URL, nxt).status_code == 200
        with CaptureQueriesContext(connection) as offset_ctx:
            assert client.get(TASKS_URL, {**base, "page": 2}).status_code == 200

        def is_count(sql: str) -> bool:
            return sql.strip().upper().startswith("SELECT COUNT(*)")

        def page_query(ctx: CaptureQueriesContext) -> str:
            # The page read is the one selecting from projects_task with a LIMIT
            # of page_size + lookahead (keyset) or page_size (offset) at the end.
            rows = [
                q["sql"]
                for q in ctx.captured_queries
                if 'FROM "projects_task"' in q["sql"] and not is_count(q["sql"])
            ]
            return max(rows, key=len)

        assert not any(is_count(q["sql"]) for q in keyset_ctx.captured_queries)
        assert any(is_count(q["sql"]) for q in offset_ctx.captured_queries)
        assert page_query(keyset_ctx).rstrip().endswith("LIMIT 3")
        assert " OFFSET " in page_query(offset_ctx)
        assert " OFFSET " not in page_query(keyset_ctx)
        # Keyset saves exactly the COUNT and adds nothing per page.
        assert len(keyset_ctx.captured_queries) == len(offset_ctx.captured_queries) - 1


def _forged(payload: dict[str, object]) -> str:
    raw = json.dumps(payload).encode()  # ensure_ascii escapes NUL as \\u0000
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


@pytest.mark.django_db
class TestKeysetRefusals:
    def test_ordering_cannot_be_combined_with_keyset(
        self, client: APIClient, project: Project
    ) -> None:
        resp = client.get(
            TASKS_URL, {"project": str(project.pk), "pagination": "keyset", "ordering": "name"}
        )
        assert resp.status_code == 400
        assert "ordering" in resp.data

    @pytest.mark.parametrize(
        "token",
        [
            "not base64 !!",
            "bm90IGpzb24",  # "not json"
            "WzEsMiwzXQ",  # a JSON list, not an object
            TaskCursor(key=("1",), name="x", id=uuid.uuid4()).encode()[:-4] + "AAAA",
            "eyJrIjoiMSIsIm4iOiJ4IiwiaSI6Im5vcGUifQ",  # k is a string, i is not a UUID
            "x" * 20_000,
            _forged({"k": None, "n": "a\u0000b", "i": str(uuid.uuid4())}),  # NUL in name
            _forged({"k": ["1", "a\u0000"], "n": "x", "i": str(uuid.uuid4())}),  # NUL in label
        ],
    )
    def test_malformed_cursor_is_a_400(
        self, client: APIClient, project: Project, token: str
    ) -> None:
        resp = client.get(
            TASKS_URL, {"project": str(project.pk), "pagination": "keyset", "cursor": token}
        )
        assert resp.status_code == 400, resp.data
        assert "cursor" in resp.data

    def test_without_the_opt_in_the_page_number_shape_is_unchanged(
        self, client: APIClient, project: Project
    ) -> None:
        _task(project, "T1", "1")
        resp = client.get(TASKS_URL, {"project": str(project.pk), "cursor": "ignored"})
        assert resp.status_code == 200
        assert resp.data["count"] == 1


def test_cursor_round_trips_including_a_null_key() -> None:
    for key in [("00000000000000000001", "abc"), None]:
        cursor = TaskCursor(key=key, name='Ünïcode, "quoted"', id=uuid.uuid4())
        assert TaskCursor.decode(cursor.encode()) == cursor
