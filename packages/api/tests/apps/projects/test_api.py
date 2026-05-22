"""API tests for the projects app CRUD endpoints."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task


@pytest.fixture
def user(db: object) -> object:
    User = get_user_model()
    return User.objects.create_user(username="testuser", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 3, 2), calendar=calendar)


@pytest.fixture
def membership(user: object, project: Project) -> ProjectMembership:
    """Grant the test user Owner access to the test project.

    Required for endpoints protected by ProjectScopedViewSet — without a
    ProjectMembership row the queryset is filtered to empty and the test user
    receives 404 on project-scoped resources.
    """
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="Design", duration=5)


@pytest.mark.django_db
class TestCalendarAPI:
    def test_list(self, client: APIClient, calendar: Calendar) -> None:
        r = client.get("/api/v1/calendars/")
        assert r.status_code == 200
        assert len(r.data["results"]) >= 1

    def test_create(self, client: APIClient, membership: ProjectMembership) -> None:
        # Requires IsOrgAdmin: user must have ADMIN+ role on at least one project.
        r = client.post("/api/v1/calendars/", {"name": "Custom", "working_days": 31})
        assert r.status_code == 201
        assert r.data["name"] == "Custom"

    def test_retrieve(self, client: APIClient, calendar: Calendar) -> None:
        r = client.get(f"/api/v1/calendars/{calendar.pk}/")
        assert r.status_code == 200
        assert r.data["name"] == "Standard"

    def test_update(
        self, client: APIClient, calendar: Calendar, membership: ProjectMembership
    ) -> None:
        # Requires IsOrgAdmin: user must have ADMIN+ role on at least one project.
        r = client.patch(f"/api/v1/calendars/{calendar.pk}/", {"hours_per_day": 9.0})
        assert r.status_code == 200
        assert r.data["hours_per_day"] == 9.0

    def test_delete(self, client: APIClient, membership: ProjectMembership) -> None:
        # Requires IsOrgAdmin: user must have ADMIN+ role on at least one project.
        # Use a fresh calendar not referenced by any project to avoid PROTECT errors.
        standalone = Calendar.objects.create(name="ToDelete")
        r = client.delete(f"/api/v1/calendars/{standalone.pk}/")
        assert r.status_code == 204


@pytest.mark.django_db
class TestProjectAPI:
    def test_list(self, client: APIClient, project: Project, membership: ProjectMembership) -> None:
        r = client.get("/api/v1/projects/")
        assert r.status_code == 200
        assert any(p["name"] == "Alpha" for p in r.data["results"])

    def test_create(self, client: APIClient, calendar: Calendar) -> None:
        r = client.post(
            "/api/v1/projects/",
            {"name": "Beta", "start_date": "2026-04-01", "calendar": str(calendar.pk)},
        )
        assert r.status_code == 201
        assert r.data["name"] == "Beta"

    def test_retrieve(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        r = client.get(f"/api/v1/projects/{project.pk}/")
        assert r.status_code == 200
        assert r.data["name"] == "Alpha"

    def test_search(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        r = client.get("/api/v1/projects/?search=Alpha")
        assert r.status_code == 200
        assert len(r.data["results"]) >= 1

    def test_server_version_read_only(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        r = client.patch(f"/api/v1/projects/{project.pk}/", {"server_version": 999})
        assert r.status_code == 200
        # server_version must not be overwritten by the client
        assert r.data["server_version"] != 999


@pytest.mark.django_db
class TestProjectGeneralFields:
    """PATCH coverage for the extended General-page fields (#520).

    Validates the six fields exposed on the General settings page —
    ``code``, ``health``, ``visibility``, ``timezone``, ``default_view``,
    and the existing ``calendar`` FK. Each field has its own happy-path and
    invalid-input case so a regression in validation surfaces as a single
    failing assertion.
    """

    def test_get_returns_all_extended_fields_with_defaults(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        r = client.get(f"/api/v1/projects/{project.pk}/")
        assert r.status_code == 200
        # Defaults from migration 0041: code empty, AUTO/WORKSPACE/SCHEDULE.
        assert r.data["code"] == ""
        assert r.data["health"] == "AUTO"
        assert r.data["visibility"] == "WORKSPACE"
        assert r.data["timezone"] == ""
        assert r.data["default_view"] == "SCHEDULE"

    def test_patch_persists_every_extended_field(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        r = client.patch(
            f"/api/v1/projects/{project.pk}/",
            {
                "code": "ATLAS-1",
                "health": "AT_RISK",
                "visibility": "PRIVATE",
                "timezone": "Europe/London",
                "default_view": "BOARD",
            },
            format="json",
        )
        assert r.status_code == 200, r.content
        project.refresh_from_db()
        assert project.code == "ATLAS-1"
        assert project.health == "AT_RISK"
        assert project.visibility == "PRIVATE"
        assert project.timezone == "Europe/London"
        assert project.default_view == "BOARD"

    @pytest.mark.parametrize(
        "code",
        ["", "A", "ATLAS", "ENG-2026", "AB1-CD2-EF3X"[:12], "0", "ABC-DEF-1234"],
    )
    def test_patch_code_accepts_valid_formats(
        self, client: APIClient, project: Project, membership: ProjectMembership, code: str
    ) -> None:
        r = client.patch(
            f"/api/v1/projects/{project.pk}/",
            {"code": code},
            format="json",
        )
        assert r.status_code == 200, r.content
        project.refresh_from_db()
        assert project.code == code

    @pytest.mark.parametrize(
        "code",
        [
            "ATLAS-2026-Q1",  # 13 chars — overlong
            "atlas",  # lowercase
            "-ATLAS",  # leading hyphen
            "ATLAS-",  # trailing hyphen
            "ATLAS!",  # disallowed punctuation
            "ATLAS 2",  # whitespace
            "-",  # hyphen-only
        ],
    )
    def test_patch_code_rejects_invalid_format(
        self, client: APIClient, project: Project, membership: ProjectMembership, code: str
    ) -> None:
        r = client.patch(
            f"/api/v1/projects/{project.pk}/",
            {"code": code},
            format="json",
        )
        assert r.status_code == 400
        assert "code" in r.data

    def test_patch_health_rejects_invalid_choice(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        r = client.patch(
            f"/api/v1/projects/{project.pk}/",
            {"health": "PURPLE"},
            format="json",
        )
        assert r.status_code == 400
        assert "health" in r.data

    def test_patch_visibility_rejects_invalid_choice(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        r = client.patch(
            f"/api/v1/projects/{project.pk}/",
            {"visibility": "EVERYWHERE"},
            format="json",
        )
        assert r.status_code == 400
        assert "visibility" in r.data

    def test_patch_default_view_rejects_invalid_choice(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        r = client.patch(
            f"/api/v1/projects/{project.pk}/",
            {"default_view": "PORTFOLIO"},
            format="json",
        )
        assert r.status_code == 400
        assert "default_view" in r.data

    def test_patch_clears_calendar_to_null(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        assert project.calendar_id is not None
        r = client.patch(
            f"/api/v1/projects/{project.pk}/",
            {"calendar": None},
            format="json",
        )
        assert r.status_code == 200, r.content
        project.refresh_from_db()
        assert project.calendar_id is None


@pytest.mark.django_db
class TestTaskAPI:
    def test_list_by_project(
        self,
        client: APIClient,
        task: Task,
        project: Project,
        membership: ProjectMembership,
    ) -> None:
        r = client.get(f"/api/v1/tasks/?project={project.pk}")
        assert r.status_code == 200
        assert any(t["name"] == "Design" for t in r.data["results"])

    def test_create(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        r = client.post(
            "/api/v1/tasks/",
            {"project": str(project.pk), "name": "Build", "duration": 3},
        )
        assert r.status_code == 201
        assert r.data["duration"] == 3

    def test_cpm_fields_read_only(
        self, client: APIClient, task: Task, membership: ProjectMembership
    ) -> None:
        r = client.patch(f"/api/v1/tasks/{task.pk}/", {"early_start": "2026-01-01"})
        assert r.status_code == 200
        # CPM fields are read-only; early_start should stay None
        assert r.data["early_start"] is None

    def test_filter_is_critical(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        Task.objects.create(project=project, name="Critical T", duration=1, is_critical=True)
        r = client.get(f"/api/v1/tasks/?project={project.pk}&is_critical=true")
        assert r.status_code == 200
        assert all(t["is_critical"] is True for t in r.data["results"])


@pytest.mark.django_db
class TestDependencyAPI:
    def test_create_fs(
        self,
        client: APIClient,
        project: Project,
        task: Task,
        membership: ProjectMembership,
    ) -> None:
        t2 = Task.objects.create(project=project, name="Build", duration=3)
        r = client.post(
            "/api/v1/dependencies/",
            {"predecessor": str(task.pk), "successor": str(t2.pk), "dep_type": "FS"},
        )
        assert r.status_code == 201
        assert r.data["dep_type"] == "FS"

    def test_filter_by_project(
        self,
        client: APIClient,
        project: Project,
        task: Task,
        membership: ProjectMembership,
    ) -> None:
        t2 = Task.objects.create(project=project, name="B", duration=2)
        Dependency.objects.create(predecessor=task, successor=t2)
        r = client.get(f"/api/v1/dependencies/?project={project.pk}")
        assert r.status_code == 200
        assert len(r.data["results"]) >= 1

    def test_cross_project_dependency_rejected(
        self,
        client: APIClient,
        user: object,
        project: Project,
        calendar: Calendar,
        task: Task,
        membership: ProjectMembership,
    ) -> None:
        # User is a member of both projects so both membership checks pass.
        # The same-project check then fires and returns 400.
        other_project = Project.objects.create(
            name="Other", start_date=date(2026, 4, 1), calendar=calendar
        )
        ProjectMembership.objects.create(project=other_project, user=user, role=Role.OWNER)
        other_task = Task.objects.create(project=other_project, name="X", duration=1)
        r = client.post(
            "/api/v1/dependencies/",
            {"predecessor": str(task.pk), "successor": str(other_task.pk), "dep_type": "FS"},
        )
        assert r.status_code == 400

    # ------------------------------------------------------------------
    # Cycle detection at create / update — see ADR-0055 and issue #356.
    # ------------------------------------------------------------------

    def test_create_rejects_self_loop(
        self,
        client: APIClient,
        project: Project,
        task: Task,
        membership: ProjectMembership,
    ) -> None:
        r = client.post(
            "/api/v1/dependencies/",
            {"predecessor": str(task.pk), "successor": str(task.pk), "dep_type": "FS"},
        )
        assert r.status_code == 400
        assert r.data["detail"] == "cyclic_dependency"
        assert isinstance(r.data["cycle"], list)
        assert len(r.data["cycle"]) >= 2
        # Every node carries the rich shape the frontend renders.
        for node in r.data["cycle"]:
            assert set(node.keys()) == {"id", "name", "hex_id"}
        assert all(node["id"] == str(task.pk) for node in r.data["cycle"])

    def test_create_rejects_2_cycle(
        self,
        client: APIClient,
        project: Project,
        task: Task,
        membership: ProjectMembership,
    ) -> None:
        t2 = Task.objects.create(project=project, name="Build", duration=3)
        Dependency.objects.create(predecessor=task, successor=t2)

        r = client.post(
            "/api/v1/dependencies/",
            {"predecessor": str(t2.pk), "successor": str(task.pk), "dep_type": "FS"},
        )
        assert r.status_code == 400
        assert r.data["detail"] == "cyclic_dependency"
        cycle_ids = {node["id"] for node in r.data["cycle"]}
        assert cycle_ids == {str(task.pk), str(t2.pk)}
        # Cycle path closes on its first node so the client can render
        # "A → B → A" unambiguously.
        assert r.data["cycle"][0]["id"] == r.data["cycle"][-1]["id"]

    def test_create_rejects_3_cycle(
        self,
        client: APIClient,
        project: Project,
        task: Task,
        membership: ProjectMembership,
    ) -> None:
        b = Task.objects.create(project=project, name="Build", duration=2)
        c = Task.objects.create(project=project, name="Verify", duration=1)
        Dependency.objects.create(predecessor=task, successor=b)
        Dependency.objects.create(predecessor=b, successor=c)

        r = client.post(
            "/api/v1/dependencies/",
            {"predecessor": str(c.pk), "successor": str(task.pk), "dep_type": "FS"},
        )
        assert r.status_code == 400
        cycle_ids = {node["id"] for node in r.data["cycle"]}
        assert cycle_ids == {str(task.pk), str(b.pk), str(c.pk)}

    def test_create_rejects_summary_logical_cycle(
        self,
        client: APIClient,
        project: Project,
        membership: ProjectMembership,
    ) -> None:
        # Summary "Eng" with a child leaf "Validate". A dep Validate → Eng is
        # an edge-level acyclic graph but a logical cycle on the leaf graph
        # because Eng waits for its leaves (Validate is one).
        eng = Task.objects.create(project=project, name="Eng", duration=0, wbs_path="1")
        validate = Task.objects.create(project=project, name="Validate", duration=2, wbs_path="1.1")

        r = client.post(
            "/api/v1/dependencies/",
            {"predecessor": str(validate.pk), "successor": str(eng.pk), "dep_type": "FS"},
        )
        assert r.status_code == 400
        assert r.data["detail"] == "cyclic_dependency"

    def test_create_succeeds_on_diamond(
        self,
        client: APIClient,
        project: Project,
        task: Task,
        membership: ProjectMembership,
    ) -> None:
        # A → B → D and A → C → D: classic diamond, acyclic.
        b = Task.objects.create(project=project, name="B", duration=1)
        c = Task.objects.create(project=project, name="C", duration=1)
        d = Task.objects.create(project=project, name="D", duration=1)
        Dependency.objects.create(predecessor=task, successor=b)
        Dependency.objects.create(predecessor=b, successor=d)
        Dependency.objects.create(predecessor=task, successor=c)

        r = client.post(
            "/api/v1/dependencies/",
            {"predecessor": str(c.pk), "successor": str(d.pk), "dep_type": "FS"},
        )
        assert r.status_code == 201

    def test_update_rejects_when_change_would_cycle(
        self,
        client: APIClient,
        project: Project,
        task: Task,
        membership: ProjectMembership,
    ) -> None:
        b = Task.objects.create(project=project, name="B", duration=1)
        c = Task.objects.create(project=project, name="C", duration=1)
        Dependency.objects.create(predecessor=task, successor=b)
        Dependency.objects.create(predecessor=b, successor=c)
        # Existing edge that we are mutating to point in a way that closes
        # a cycle: pre-existing C → (new task) becomes C → A.
        d = Task.objects.create(project=project, name="D", duration=1)
        edge = Dependency.objects.create(predecessor=c, successor=d)

        r = client.patch(
            f"/api/v1/dependencies/{edge.pk}/",
            {"successor": str(task.pk)},
        )
        assert r.status_code == 400
        assert r.data["detail"] == "cyclic_dependency"

    def test_create_does_not_persist_when_cycle_detected(
        self,
        client: APIClient,
        project: Project,
        task: Task,
        membership: ProjectMembership,
    ) -> None:
        t2 = Task.objects.create(project=project, name="Build", duration=3)
        Dependency.objects.create(predecessor=task, successor=t2)
        existing_count = Dependency.objects.filter(is_deleted=False).count()

        r = client.post(
            "/api/v1/dependencies/",
            {"predecessor": str(t2.pk), "successor": str(task.pk), "dep_type": "FS"},
        )
        assert r.status_code == 400
        # Validation runs before save; row count must be unchanged.
        assert Dependency.objects.filter(is_deleted=False).count() == existing_count

    def test_create_with_foreign_predecessor_returns_403_not_cycle_leak(
        self,
        client: APIClient,
        project: Project,
        task: Task,
        membership: ProjectMembership,
        calendar: Calendar,
    ) -> None:
        """RBAC guard: a Scheduler in project A cannot trigger cycle detection
        on project B (where they have no membership) and learn task names /
        short_ids via the structured 400 response. Validate-time membership
        check must short-circuit with 403 before any cycle query runs.
        """
        other_project = Project.objects.create(
            name="Other Project",
            start_date=date(2026, 4, 1),
            calendar=calendar,
        )
        foreign_a = Task.objects.create(project=other_project, name="Secret A", duration=1)
        foreign_b = Task.objects.create(project=other_project, name="Secret B", duration=1)
        # Plant a 2-cycle that WOULD fire cycle detection if it ran.
        Dependency.objects.create(predecessor=foreign_a, successor=foreign_b)

        r = client.post(
            "/api/v1/dependencies/",
            {
                "predecessor": str(foreign_b.pk),
                "successor": str(foreign_a.pk),
                "dep_type": "FS",
            },
        )
        assert r.status_code == 403
        # Crucially: the response must NOT include `cycle` or task names.
        assert "cycle" not in r.data
        body = str(r.data).lower()
        assert "secret a" not in body
        assert "secret b" not in body

    def test_update_to_same_endpoints_does_not_self_reject(
        self,
        client: APIClient,
        project: Project,
        task: Task,
        membership: ProjectMembership,
    ) -> None:
        # Editing a row to its own current values must not be flagged as a
        # cycle: the existing row is excluded from the proposed graph so the
        # only edge added back is the unchanged one.
        t2 = Task.objects.create(project=project, name="Build", duration=3)
        edge = Dependency.objects.create(predecessor=task, successor=t2)

        r = client.patch(
            f"/api/v1/dependencies/{edge.pk}/",
            {"lag": 1},
        )
        assert r.status_code == 200
        assert r.data["lag"] == 1

    # ------------------------------------------------------------------
    # Soft-deleted FK guard — #358
    # ------------------------------------------------------------------

    def test_create_with_soft_deleted_predecessor_returns_400(
        self,
        client: APIClient,
        project: Project,
        task: Task,
        membership: ProjectMembership,
    ) -> None:
        """DependencySerializer rejects a predecessor that has been soft-deleted."""
        t2 = Task.objects.create(project=project, name="Live", duration=2)
        task.is_deleted = True
        task.save(update_fields=["is_deleted"])

        r = client.post(
            "/api/v1/dependencies/",
            {"predecessor": str(task.pk), "successor": str(t2.pk), "dep_type": "FS"},
        )
        assert r.status_code == 400

    def test_create_with_soft_deleted_successor_returns_400(
        self,
        client: APIClient,
        project: Project,
        task: Task,
        membership: ProjectMembership,
    ) -> None:
        """DependencySerializer rejects a successor that has been soft-deleted."""
        t2 = Task.objects.create(project=project, name="Live", duration=2)
        t2.is_deleted = True
        t2.save(update_fields=["is_deleted"])

        r = client.post(
            "/api/v1/dependencies/",
            {"predecessor": str(task.pk), "successor": str(t2.pk), "dep_type": "FS"},
        )
        assert r.status_code == 400

    def test_patch_to_soft_deleted_task_returns_400(
        self,
        client: APIClient,
        project: Project,
        task: Task,
        membership: ProjectMembership,
    ) -> None:
        """PATCHing a dep to point at a soft-deleted task returns 400."""
        t2 = Task.objects.create(project=project, name="Live", duration=2)
        t3 = Task.objects.create(project=project, name="Deleted", duration=1)
        edge = Dependency.objects.create(predecessor=task, successor=t2)
        t3.is_deleted = True
        t3.save(update_fields=["is_deleted"])

        r = client.patch(
            f"/api/v1/dependencies/{edge.pk}/",
            {"successor": str(t3.pk)},
        )
        assert r.status_code == 400

    # ------------------------------------------------------------------
    # Membership check order — #359
    # ------------------------------------------------------------------

    def test_non_member_gets_403_regardless_of_project_pairing(
        self,
        client: APIClient,
        project: Project,
        task: Task,
        membership: ProjectMembership,
        calendar: Calendar,
    ) -> None:
        """Non-member submitting any foreign task UUID gets 403, not 400.

        Both same-project and cross-project foreign pairs must return 403 so
        callers cannot infer shared project membership from the error code.
        """
        other = Project.objects.create(name="Other", start_date=date(2026, 4, 1), calendar=calendar)
        foreign_a = Task.objects.create(project=other, name="FA", duration=1)
        foreign_b = Task.objects.create(project=other, name="FB", duration=1)

        # Both tasks in the same foreign project → must still return 403.
        r = client.post(
            "/api/v1/dependencies/",
            {"predecessor": str(foreign_a.pk), "successor": str(foreign_b.pk), "dep_type": "FS"},
        )
        assert r.status_code == 403

        # Cross-project pair: one foreign, one from member project → must return 403.
        r2 = client.post(
            "/api/v1/dependencies/",
            {"predecessor": str(foreign_a.pk), "successor": str(task.pk), "dep_type": "FS"},
        )
        assert r2.status_code == 403
