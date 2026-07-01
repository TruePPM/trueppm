"""API tests for the projects app CRUD endpoints."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Dependency, Program, Project, Task


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

    def test_create_surfaces_dense_graph_rejection_as_400(
        self,
        client: APIClient,
        project: Project,
        task: Task,
        membership: ProjectMembership,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A summary→summary edge dense enough to trip the scheduler's
        MAX_EXPANDED_EDGES cap must surface as a clean 400, not a 500 (#357).

        The real cap (100k expanded edges) needs thousands of leaves to fire,
        which is too slow for a unit test, so we patch ``find_cycle`` to raise
        the engine's ``InvalidScheduleInput`` directly. The contract under test
        is the serializer's try/except → ValidationError translation, not the
        engine's counting logic (covered in the scheduler package's tests).
        """
        from trueppm_scheduler import InvalidScheduleInput

        t2 = Task.objects.create(project=project, name="Build", duration=3)

        def _raise(*_args: object, **_kwargs: object) -> None:
            raise InvalidScheduleInput(
                "Dependency graph is too dense to validate; simplify the structure."
            )

        monkeypatch.setattr("trueppm_api.apps.projects.serializers.find_cycle", _raise)

        r = client.post(
            "/api/v1/dependencies/",
            {"predecessor": str(task.pk), "successor": str(t2.pk), "dep_type": "FS"},
        )
        assert r.status_code == 400
        # Pathological-structure guard, not the cycle path: it's a plain
        # ValidationError, so there is no structured `cycle` payload.
        assert "cycle" not in r.data
        body = str(r.data).lower()
        assert "too dense" in body or "simplify" in body

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


@pytest.mark.django_db
class TestCrossProjectDependency:
    """ADR-0120 D1/D2/D5 — same-program cross-project dependency edges.

    D1: cross-project edges are valid when the two projects share a program;
    cross-PROGRAM (and program-less) edges stay 400. D2: consent gate —
    auto-accepted when the creator can schedule the successor, else pending +
    inert until a downstream Scheduler accepts. D5: a minimal card names the
    counterpart task across a project boundary.
    """

    def _program_pair(
        self,
        calendar: Calendar,
        user: object,
        *,
        pred_role: int | None,
        succ_role: int | None,
        same_program: bool = True,
    ) -> tuple[Task, Task, Program]:
        """Two projects (each with one task) in one program (unless
        ``same_program=False``), with ``user`` granted the given role on each."""
        program = Program.objects.create(name="GA Launch")
        succ_program = program if same_program else Program.objects.create(name="Other Program")
        p_pred = Project.objects.create(
            name="Security", start_date=date(2026, 3, 2), calendar=calendar, program=program
        )
        p_succ = Project.objects.create(
            name="Marketing", start_date=date(2026, 3, 2), calendar=calendar, program=succ_program
        )
        if pred_role is not None:
            ProjectMembership.objects.create(project=p_pred, user=user, role=pred_role)
        if succ_role is not None:
            ProjectMembership.objects.create(project=p_succ, user=user, role=succ_role)
        pred_task = Task.objects.create(project=p_pred, name="Sign-off", duration=3)
        succ_task = Task.objects.create(project=p_succ, name="Go-live", duration=2)
        return pred_task, succ_task, program

    @staticmethod
    def _scheduler_client_on(project: Project, *, username: str) -> APIClient:
        user = get_user_model().objects.create_user(username=username, password="pw")
        ProjectMembership.objects.create(project=project, user=user, role=Role.SCHEDULER)
        c = APIClient()
        c.force_authenticate(user=user)
        return c

    def _post_edge(self, client: APIClient, pred: Task, succ: Task) -> object:
        return client.post(
            "/api/v1/dependencies/",
            {"predecessor": str(pred.pk), "successor": str(succ.pk), "dep_type": "FS"},
        )

    # -- D1: validity -------------------------------------------------------

    def test_same_program_edge_auto_accepted_when_scheduler_both(
        self, client: APIClient, user: object, calendar: Calendar
    ) -> None:
        pred, succ, _ = self._program_pair(
            calendar, user, pred_role=Role.SCHEDULER, succ_role=Role.SCHEDULER
        )
        r = self._post_edge(client, pred, succ)
        assert r.status_code == 201, r.data
        assert r.data["pending_acceptance"] is False
        assert r.data["accepted_by"] is not None
        assert r.data["accepted_at"] is not None
        dep = Dependency.objects.get(pk=r.data["id"])
        assert dep.predecessor_id == pred.pk and dep.successor_id == succ.pk
        assert dep.accepted_by == user

    def test_cross_program_edge_rejected_400(
        self, client: APIClient, user: object, calendar: Calendar
    ) -> None:
        pred, succ, _ = self._program_pair(
            calendar, user, pred_role=Role.OWNER, succ_role=Role.OWNER, same_program=False
        )
        r = self._post_edge(client, pred, succ)
        assert r.status_code == 400
        assert "same program" in str(r.data).lower()

    # -- D2: consent --------------------------------------------------------

    def test_pending_when_scheduler_on_predecessor_only(
        self, client: APIClient, user: object, calendar: Calendar
    ) -> None:
        pred, succ, _ = self._program_pair(
            calendar, user, pred_role=Role.SCHEDULER, succ_role=Role.MEMBER
        )
        r = self._post_edge(client, pred, succ)
        assert r.status_code == 201, r.data
        assert r.data["pending_acceptance"] is True
        assert r.data["accepted_by"] is None

    def test_program_viewer_without_schedule_authority_403(
        self, client: APIClient, user: object, calendar: Calendar
    ) -> None:
        # Read access via program membership, but no Scheduler+ anywhere → 403.
        pred, succ, program = self._program_pair(calendar, user, pred_role=None, succ_role=None)
        ProgramMembership.objects.create(program=program, user=user, role=Role.VIEWER)
        r = self._post_edge(client, pred, succ)
        assert r.status_code == 403

    def test_accept_by_successor_scheduler(
        self, client: APIClient, user: object, calendar: Calendar
    ) -> None:
        pred, succ, _ = self._program_pair(
            calendar, user, pred_role=Role.SCHEDULER, succ_role=Role.MEMBER
        )
        dep_id = self._post_edge(client, pred, succ).data["id"]
        downstream = self._scheduler_client_on(succ.project, username="downstream")
        r = downstream.post(f"/api/v1/dependencies/{dep_id}/accept/")
        assert r.status_code == 200, r.data
        assert r.data["pending_acceptance"] is False
        assert r.data["accepted_by"] is not None
        assert Dependency.objects.get(pk=dep_id).pending_acceptance is False

    def test_accept_forbidden_without_successor_authority(
        self, client: APIClient, user: object, calendar: Calendar
    ) -> None:
        pred, succ, _ = self._program_pair(
            calendar, user, pred_role=Role.SCHEDULER, succ_role=Role.MEMBER
        )
        dep_id = self._post_edge(client, pred, succ).data["id"]
        # Creator holds Scheduler on the predecessor, only Member on the
        # successor → cannot self-accept their own pending edge.
        r = client.post(f"/api/v1/dependencies/{dep_id}/accept/")
        assert r.status_code == 403
        assert Dependency.objects.get(pk=dep_id).pending_acceptance is True

    def test_accept_non_pending_returns_400(
        self, client: APIClient, user: object, calendar: Calendar
    ) -> None:
        pred, succ, _ = self._program_pair(
            calendar, user, pred_role=Role.SCHEDULER, succ_role=Role.SCHEDULER
        )
        r = self._post_edge(client, pred, succ)
        assert r.data["pending_acceptance"] is False
        r2 = client.post(f"/api/v1/dependencies/{r.data['id']}/accept/")
        assert r2.status_code == 400

    def test_reject_soft_deletes_edge(
        self, client: APIClient, user: object, calendar: Calendar
    ) -> None:
        pred, succ, _ = self._program_pair(
            calendar, user, pred_role=Role.SCHEDULER, succ_role=Role.MEMBER
        )
        dep_id = self._post_edge(client, pred, succ).data["id"]
        downstream = self._scheduler_client_on(succ.project, username="downstream2")
        r = downstream.post(f"/api/v1/dependencies/{dep_id}/reject/")
        assert r.status_code == 200, r.data
        assert Dependency.objects.get(pk=dep_id).is_deleted is True

    # -- D1: program-scoped cycle detection ---------------------------------

    def test_cross_project_cycle_detected(
        self, client: APIClient, user: object, calendar: Calendar
    ) -> None:
        pred, succ, _ = self._program_pair(
            calendar, user, pred_role=Role.SCHEDULER, succ_role=Role.SCHEDULER
        )
        assert self._post_edge(client, pred, succ).status_code == 201
        # The reverse cross edge would close a program-spanning cycle.
        r = self._post_edge(client, succ, pred)
        assert r.status_code == 400
        assert r.data["detail"] == "cyclic_dependency"

    # -- D5: minimal visibility card ----------------------------------------

    def test_cross_project_edge_exposes_minimal_card(
        self, client: APIClient, user: object, calendar: Calendar
    ) -> None:
        pred, succ, _ = self._program_pair(
            calendar, user, pred_role=Role.SCHEDULER, succ_role=Role.SCHEDULER
        )
        card = self._post_edge(client, pred, succ).data["predecessor_card"]
        assert card is not None
        assert set(card.keys()) >= {
            "id",
            "title",
            "hex_id",
            "project_id",
            "project_name",
            "is_milestone",
            "early_start",
            "early_finish",
            "is_critical",
        }
        # Only scheduling facts — never description/assignee/points/status.
        assert "description" not in card and "assignee" not in card
        assert card["title"] == "Sign-off"
        assert card["project_name"] == "Security"

    def test_same_project_edge_has_no_card(
        self,
        client: APIClient,
        user: object,
        project: Project,
        membership: ProjectMembership,
    ) -> None:
        t1 = Task.objects.create(project=project, name="T1", duration=2)
        t2 = Task.objects.create(project=project, name="T2", duration=2)
        r = self._post_edge(client, t1, t2)
        assert r.status_code == 201, r.data
        assert r.data["predecessor_card"] is None
        assert r.data["successor_card"] is None
        assert r.data["pending_acceptance"] is False

    # -- D2: update-path consent (repoint cannot bypass the gate) ------------

    def test_repoint_into_cross_project_requires_consent(
        self, client: APIClient, user: object, calendar: Calendar
    ) -> None:
        # Scheduler on the predecessor project, only Member on the successor.
        pred, succ, _ = self._program_pair(
            calendar, user, pred_role=Role.SCHEDULER, succ_role=Role.MEMBER
        )
        # Start with an accepted same-project edge in the predecessor's project.
        sibling = Task.objects.create(project=pred.project, name="Sibling", duration=1)
        create = self._post_edge(client, pred, sibling)
        assert create.status_code == 201, create.data
        assert create.data["pending_acceptance"] is False
        dep_id = create.data["id"]
        # Repointing the successor cross-project must re-earn consent — it lands
        # pending (inert), never live, even though the patcher is the predecessor
        # scheduler. This is the update-path consent-bypass guard.
        r = client.patch(f"/api/v1/dependencies/{dep_id}/", {"successor": str(succ.pk)})
        assert r.status_code == 200, r.data
        assert r.data["pending_acceptance"] is True
        assert Dependency.objects.get(pk=dep_id).pending_acceptance is True

    def test_create_on_archived_project_rejected(
        self, client: APIClient, user: object, calendar: Calendar
    ) -> None:
        pred, succ, _ = self._program_pair(
            calendar, user, pred_role=Role.SCHEDULER, succ_role=Role.SCHEDULER
        )
        pred.project.is_archived = True
        pred.project.save(update_fields=["is_archived"])
        r = self._post_edge(client, pred, succ)
        assert r.status_code == 403


def _exc_list_url(calendar: Calendar) -> str:
    return f"/api/v1/calendars/{calendar.pk}/exceptions/"


def _exc_detail_url(calendar: Calendar, exc: object) -> str:
    return f"/api/v1/calendars/{calendar.pk}/exceptions/{exc.pk}/"  # type: ignore[attr-defined]


@pytest.mark.django_db
class TestCalendarExceptionAPI:
    """Nested CRUD for /calendars/{id}/exceptions/ (#1079, ADR-0194).

    Reads are open to any authenticated user; writes require org admin
    (Project Manager+), mirroring CalendarViewSet. The ``membership`` fixture
    grants the test user the Owner role, which satisfies IsOrgAdmin.
    """

    def _make_exc(
        self, calendar: Calendar, start: date, end: date, description: str = ""
    ) -> object:
        from trueppm_api.apps.projects.models import CalendarException

        return CalendarException.objects.create(
            calendar=calendar, exc_start=start, exc_end=end, description=description
        )

    def test_list_empty(self, client: APIClient, calendar: Calendar) -> None:
        r = client.get(_exc_list_url(calendar))
        assert r.status_code == 200
        assert r.data["results"] == []

    def test_list_is_scoped_to_the_url_calendar(
        self, client: APIClient, calendar: Calendar
    ) -> None:
        other = Calendar.objects.create(name="Other")
        self._make_exc(calendar, date(2026, 12, 25), date(2026, 12, 25), "Mine")
        self._make_exc(other, date(2026, 1, 1), date(2026, 1, 1), "Theirs")
        r = client.get(_exc_list_url(calendar))
        assert r.status_code == 200
        descriptions = [e["description"] for e in r.data["results"]]
        assert descriptions == ["Mine"]

    def test_retrieve(self, client: APIClient, calendar: Calendar) -> None:
        exc = self._make_exc(calendar, date(2026, 7, 1), date(2026, 7, 3), "Shutdown")
        r = client.get(_exc_detail_url(calendar, exc))
        assert r.status_code == 200
        assert r.data["description"] == "Shutdown"
        assert r.data["exc_start"] == "2026-07-01"
        assert r.data["exc_end"] == "2026-07-03"

    def test_create_requires_org_admin(self, client: APIClient, calendar: Calendar) -> None:
        # Authenticated but with no ADMIN+ role anywhere → IsOrgAdmin denies.
        r = client.post(
            _exc_list_url(calendar),
            {"exc_start": "2026-12-25", "exc_end": "2026-12-26", "description": "Xmas"},
        )
        assert r.status_code == 403

    def test_create_as_org_admin(
        self, client: APIClient, calendar: Calendar, membership: ProjectMembership
    ) -> None:
        from trueppm_api.apps.projects.models import CalendarException

        r = client.post(
            _exc_list_url(calendar),
            {"exc_start": "2026-12-25", "exc_end": "2026-12-26", "description": "Xmas"},
        )
        assert r.status_code == 201, r.data
        assert r.data["description"] == "Xmas"
        assert CalendarException.objects.filter(calendar=calendar).count() == 1

    def test_create_binds_calendar_from_url_not_body(
        self, client: APIClient, calendar: Calendar, membership: ProjectMembership
    ) -> None:
        """A ``calendar`` in the body is ignored — the URL calendar always wins."""
        from trueppm_api.apps.projects.models import CalendarException

        other = Calendar.objects.create(name="Decoy")
        r = client.post(
            _exc_list_url(calendar),
            {"exc_start": "2026-12-25", "exc_end": "2026-12-25", "calendar": str(other.pk)},
        )
        assert r.status_code == 201, r.data
        exc = CalendarException.objects.get(pk=r.data["id"])
        assert exc.calendar_id == calendar.pk

    def test_create_rejects_end_before_start(
        self, client: APIClient, calendar: Calendar, membership: ProjectMembership
    ) -> None:
        r = client.post(
            _exc_list_url(calendar),
            {"exc_start": "2026-12-26", "exc_end": "2026-12-25"},
        )
        assert r.status_code == 400
        assert "exc_end" in r.data

    def test_create_allows_single_day_range(
        self, client: APIClient, calendar: Calendar, membership: ProjectMembership
    ) -> None:
        r = client.post(
            _exc_list_url(calendar),
            {"exc_start": "2026-12-25", "exc_end": "2026-12-25"},
        )
        assert r.status_code == 201, r.data

    def test_create_on_missing_calendar_404(
        self, client: APIClient, membership: ProjectMembership
    ) -> None:
        import uuid

        url = f"/api/v1/calendars/{uuid.uuid4()}/exceptions/"
        r = client.post(url, {"exc_start": "2026-12-25", "exc_end": "2026-12-26"})
        assert r.status_code == 404

    def test_update(
        self, client: APIClient, calendar: Calendar, membership: ProjectMembership
    ) -> None:
        exc = self._make_exc(calendar, date(2026, 7, 1), date(2026, 7, 3), "Old")
        r = client.patch(_exc_detail_url(calendar, exc), {"description": "New"})
        assert r.status_code == 200
        exc.refresh_from_db()
        assert exc.description == "New"

    def test_update_rejects_end_before_start(
        self, client: APIClient, calendar: Calendar, membership: ProjectMembership
    ) -> None:
        exc = self._make_exc(calendar, date(2026, 6, 1), date(2026, 6, 5))
        r = client.patch(_exc_detail_url(calendar, exc), {"exc_end": "2026-05-30"})
        assert r.status_code == 400
        assert "exc_end" in r.data

    def test_update_requires_org_admin(self, client: APIClient, calendar: Calendar) -> None:
        exc = self._make_exc(calendar, date(2026, 7, 1), date(2026, 7, 3), "Old")
        r = client.patch(_exc_detail_url(calendar, exc), {"description": "Hacked"})
        assert r.status_code == 403

    def test_delete(
        self, client: APIClient, calendar: Calendar, membership: ProjectMembership
    ) -> None:
        from trueppm_api.apps.projects.models import CalendarException

        exc = self._make_exc(calendar, date(2026, 7, 1), date(2026, 7, 3))
        r = client.delete(_exc_detail_url(calendar, exc))
        assert r.status_code == 204
        assert CalendarException.objects.filter(calendar=calendar).count() == 0

    def test_delete_requires_org_admin(self, client: APIClient, calendar: Calendar) -> None:
        exc = self._make_exc(calendar, date(2026, 7, 1), date(2026, 7, 3))
        r = client.delete(_exc_detail_url(calendar, exc))
        assert r.status_code == 403


@pytest.mark.django_db(transaction=True)
def test_calendar_exception_create_enqueues_recalc_and_bumps_calendar(
    client: APIClient, calendar: Calendar, project: Project, membership: ProjectMembership
) -> None:
    """Creating an exception bumps the calendar and recalcs dependent projects."""
    from unittest.mock import patch

    from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestReason

    ScheduleRequest.objects.all().delete()
    before = calendar.server_version
    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_task.delay.return_value.id = "test-celery-task-id"
        r = client.post(
            _exc_list_url(calendar),
            {"exc_start": "2026-12-25", "exc_end": "2026-12-26", "description": "Xmas"},
        )
    assert r.status_code == 201, r.data
    calendar.refresh_from_db()
    assert calendar.server_version > before
    sr = ScheduleRequest.objects.get(project=project)
    assert sr.reason == ScheduleRequestReason.CALENDAR_CHANGE


@pytest.mark.django_db(transaction=True)
def test_calendar_exception_delete_enqueues_recalc(
    client: APIClient, calendar: Calendar, project: Project, membership: ProjectMembership
) -> None:
    """Deleting an exception also bumps the calendar and recalcs dependent projects."""
    from unittest.mock import patch

    from trueppm_api.apps.projects.models import CalendarException
    from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestReason

    exc = CalendarException.objects.create(
        calendar=calendar, exc_start=date(2026, 12, 25), exc_end=date(2026, 12, 26)
    )
    ScheduleRequest.objects.all().delete()
    before = calendar.server_version
    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_task.delay.return_value.id = "test-celery-task-id"
        r = client.delete(_exc_detail_url(calendar, exc))
    assert r.status_code == 204
    calendar.refresh_from_db()
    assert calendar.server_version > before
    sr = ScheduleRequest.objects.get(project=project)
    assert sr.reason == ScheduleRequestReason.CALENDAR_CHANGE
