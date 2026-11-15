"""Tests for the GET /tasks/ pagination count bypass (issue #2815).

``PageNumberPagination`` calls ``.count()`` on whatever queryset it is handed, and
``TaskViewSet.get_queryset()`` hands it the fully *annotated* queryset from
``annotate_tasks_queryset``. Counting that queryset forces Postgres to evaluate
every RawSQL/Exists/Subquery annotation for every row purely to arrive at a page
count — measured at ~80% of the request's DB time on a 4,000-task project.

``TaskListPagination``/``TaskViewSet._build_task_count_queryset`` count a separate,
unannotated queryset instead. Two things have to hold for that to be safe:

1. The count query must not carry the annotation SQL (this is what makes it cheap).
2. The count must still agree with ``results`` under every filter, including the
   ones that join to a to-many relation and can multiply a row
   (``_filter_tasks_by_labels``, ``_filter_tasks_mine``) and under the
   ``filter_backends`` that run *after* ``get_queryset()`` (``?search=``,
   ``?ordering=``).
"""

from __future__ import annotations

import secrets
from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    SCOPE_MCP_READ,
    ApiToken,
    Calendar,
    Label,
    LabelColor,
    Project,
    Task,
)
from trueppm_api.apps.resources.models import Resource, TaskResource

TASKS_URL = "/api/v1/tasks/"


@pytest.fixture
def user(db: object) -> object:
    User = get_user_model()
    return User.objects.create_user(
        username="count-tester", email="counttester@example.com", password="pw"
    )


@pytest.fixture
def auth_client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Default")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Pagination Count Project",
        start_date=date(2026, 1, 1),
        calendar=calendar,
    )


@pytest.fixture
def _membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


def _get_queries(ctx: CaptureQueriesContext) -> list[str]:
    return [q["sql"] for q in ctx.captured_queries]


@pytest.mark.django_db
class TestCountQuerySkipsAnnotations:
    """The count query must not carry the RawSQL/lquery annotation SQL."""

    def test_count_query_has_no_lquery_but_a_sibling_query_does(
        self, auth_client: APIClient, project: Project, _membership: ProjectMembership
    ) -> None:
        # `?labels=` (like `?mine=true`) sets `.distinct()` on the queryset
        # (`_filter_tasks_by_labels`), which is what makes Django's own count
        # machinery wrap the *entire annotated SELECT* — columns, RawSQL casts to
        # ::lquery and all — in `SELECT COUNT(*) FROM (...) subquery` in order to
        # count accurately post-DISTINCT. A plain unfiltered list never sets
        # `.distinct()` and so never hits this expensive path pre-fix; this
        # fixture is deliberately the fan-out case #2815 is about.
        label = Label.objects.create(project=project, name="Tag", color=LabelColor.TEAL)
        for i in range(3):
            task = Task.objects.create(project=project, name=f"Task {i}")
            task.labels.add(label)

        with CaptureQueriesContext(connection) as ctx:
            resp = auth_client.get(TASKS_URL, {"project": str(project.pk), "labels": str(label.pk)})
        assert resp.status_code == 200, resp.data

        queries = _get_queries(ctx)
        # `annotate_tasks_queryset` attaches several *internal* `Count(...)`
        # aggregates (predecessor_count, linked_risks_count, external_link_count)
        # as part of its Subquery annotations, so a bare `"COUNT(" in sql`
        # substring match would also hit the annotated results/page query and make
        # this assertion vacuous. The pagination COUNT is always the top-level
        # `SELECT COUNT(*) FROM (...) subquery` Django wraps the counted queryset
        # in — a `startswith` check distinguishes "the query IS a count" from "the
        # query merely contains a count somewhere inside it".
        count_queries = [
            sql for sql in queries if sql.strip().upper().startswith("SELECT COUNT(*)")
        ]
        assert count_queries, "expected at least one top-level COUNT query in the captured SQL"
        for sql in count_queries:
            assert "lquery" not in sql.lower(), (
                "pagination count query still carries the annotation SQL "
                "(is_summary/is_phase RawSQL casts to ::lquery) — the count is no "
                "longer bypassing annotate_tasks_queryset"
            )

        # Negative control: prove the "no lquery" assertion above is a meaningful
        # check, not vacuously true because nothing in this request ever emits
        # lquery at all. The results/page query IS built from the annotated
        # queryset and must still carry it.
        non_count_queries = [sql for sql in queries if sql not in count_queries]
        assert any("lquery" in sql.lower() for sql in non_count_queries), (
            "no captured query mentions lquery at all — the negative control is "
            "broken, so the assertion above could pass vacuously"
        )


@pytest.mark.django_db
class TestCountAgreesUnderFanoutFilters:
    """`?labels=` and `?mine=true` join to-many relations and can multiply a row.

    Without collapsing the fan-out, the bypassed count would over-report: it would
    count one JOIN row per matching label/assignment instead of one per task.
    """

    def test_count_matches_results_for_task_with_multiple_matching_labels(
        self, auth_client: APIClient, project: Project, _membership: ProjectMembership
    ) -> None:
        label_a = Label.objects.create(project=project, name="Bug", color=LabelColor.ROSE)
        label_b = Label.objects.create(project=project, name="Urgent", color=LabelColor.AMBER)
        multi_label_task = Task.objects.create(project=project, name="Double-labeled")
        multi_label_task.labels.set([label_a, label_b])
        # A task that matches only one of the two requested labels, and a task that
        # matches neither — both exercise that the count isn't just "all tasks".
        single_label_task = Task.objects.create(project=project, name="Single-labeled")
        single_label_task.labels.set([label_a])
        Task.objects.create(project=project, name="Unlabeled")

        resp = auth_client.get(
            TASKS_URL,
            {"project": str(project.pk), "labels": f"{label_a.pk},{label_b.pk}"},
        )
        assert resp.status_code == 200, resp.data
        data = resp.json()

        # The label join can return the double-labeled task twice (once per
        # matching label edge) before `.distinct()`/pk-collapsing is applied.
        assert data["count"] == 2, (
            f"count over-reported the label join fan-out: got {data['count']}, "
            "expected 2 distinct tasks (multi-labeled counted once, not once per "
            "matching label edge)"
        )
        assert len(data["results"]) == data["count"]
        assert {t["name"] for t in data["results"]} == {"Double-labeled", "Single-labeled"}

    def test_count_matches_results_for_task_with_multiple_assignments_mine(
        self, auth_client: APIClient, user: object, project: Project, _membership: ProjectMembership
    ) -> None:
        resource_a = Resource.objects.create(name="Resource A", email="a@example.com", user=user)
        resource_b = Resource.objects.create(name="Resource B", email="b@example.com", user=user)
        double_assigned = Task.objects.create(project=project, name="Double-assigned")
        TaskResource.objects.create(task=double_assigned, resource=resource_a, units=0.5)
        TaskResource.objects.create(task=double_assigned, resource=resource_b, units=0.5)
        # Not assigned to the requesting user at all.
        other_resource = Resource.objects.create(name="Other", email="other@example.com")
        unassigned_to_me = Task.objects.create(project=project, name="Not mine")
        TaskResource.objects.create(task=unassigned_to_me, resource=other_resource, units=1.0)

        resp = auth_client.get(TASKS_URL, {"project": str(project.pk), "mine": "true"})
        assert resp.status_code == 200, resp.data
        data = resp.json()

        # The two-assignment task can appear twice via the `assignments__resource`
        # join before collapsing; the count must not double it.
        assert data["count"] == 1, (
            f"count over-reported the assignment join fan-out: got {data['count']}, "
            "expected 1 distinct task assigned to the requesting user"
        )
        assert len(data["results"]) == 1
        assert data["results"][0]["name"] == "Double-assigned"


@pytest.mark.django_db
class TestCountAgreesWithFilterBackends:
    """`SearchFilter`/`OrderingFilter` run on the annotated queryset, after
    `get_queryset()` — the count queryset has to go through the same backends or
    `count` and `results` disagree.
    """

    def test_count_matches_results_under_search(
        self, auth_client: APIClient, project: Project, _membership: ProjectMembership
    ) -> None:
        Task.objects.create(project=project, name="Foundation pour")
        Task.objects.create(project=project, name="Roof install")
        Task.objects.create(project=project, name="Framing")

        resp = auth_client.get(TASKS_URL, {"project": str(project.pk), "search": "foundation"})
        assert resp.status_code == 200, resp.data
        data = resp.json()
        assert data["count"] == 1
        assert len(data["results"]) == 1
        assert data["results"][0]["name"] == "Foundation pour"

    def test_count_matches_results_under_ordering(
        self, auth_client: APIClient, project: Project, _membership: ProjectMembership
    ) -> None:
        for i in range(4):
            Task.objects.create(project=project, name=f"Task {i}")

        resp = auth_client.get(
            TASKS_URL,
            {"project": str(project.pk), "ordering": "-name", "page_size": "2"},
        )
        assert resp.status_code == 200, resp.data
        data = resp.json()
        # 4 tasks total, page_size=2 -> count must reflect the full filtered set,
        # not just the 2 returned on this page.
        assert data["count"] == 4
        assert len(data["results"]) == 2
        assert data["next"] is not None


@pytest.mark.django_db
class TestCountAgreesUnderMcpAgentReadScoping:
    """An ``mcp:read`` token's count and results must agree on the agent-read filter (#2815).

    ``McpReadableViewMixin.get_queryset`` already applies ``_mcp_filter_queryset``, so
    the base queryset is scoped before ``_build_task_count_queryset`` runs. This test
    pins the end-to-end agreement under agent-read scoping: a project that opted out
    of agent reads contributes to neither ``count`` nor ``results``.
    """

    def test_count_excludes_opted_out_project_rows_for_an_mcp_token(
        self, user: object, project: Project, _membership: ProjectMembership, calendar: Calendar
    ) -> None:
        opted_out = Project.objects.create(
            name="Agent Opted Out", start_date=date(2026, 1, 1), calendar=calendar
        )
        ProjectMembership.objects.create(project=opted_out, user=user, role=Role.OWNER)
        opted_out.mcp_enabled = False
        opted_out.save(update_fields=["mcp_enabled"])
        for i in range(3):
            Task.objects.create(project=project, name=f"visible {i}")
        for i in range(2):
            Task.objects.create(project=opted_out, name=f"hidden {i}")

        raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
        ApiToken.objects.create(
            owner=user,
            name="agent",
            token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
            token_hash=sha256_hex(raw),
            created_by=user,
            scopes=[SCOPE_MCP_READ],
        )
        agent = APIClient()
        agent.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")

        resp = agent.get(TASKS_URL, {"page_size": "2"})
        assert resp.status_code == 200, resp.data
        data = resp.json()
        names = {t["name"] for t in data["results"]}
        # count covers the whole agent-visible set (3), not the page (2) and not
        # the member's full set (5); the page itself carries no hidden row.
        assert data["count"] == 3
        assert len(data["results"]) == 2
        assert not any(n.startswith("hidden") for n in names)

        # Same queryset, human session: the opt-out is an agent-read gate only.
        human = APIClient()
        human.force_authenticate(user=user)
        human_data = human.get(TASKS_URL, {"page_size": "2"}).json()
        assert human_data["count"] == 5
