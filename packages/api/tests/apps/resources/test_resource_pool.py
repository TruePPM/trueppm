"""Tests for resource pool, skills, and project roster endpoints (#149, #150)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.resources.models import (
    ProjectResource,
    Resource,
    ResourceSkill,
    Skill,
    TaskResource,
    TaskSkillRequirement,
)

User = get_user_model()

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def scheduler_user(db: object) -> object:
    return User.objects.create_user(username="scheduler", password="pw")


@pytest.fixture
def viewer_user(db: object) -> object:
    return User.objects.create_user(username="viewer", password="pw")


@pytest.fixture
def scheduler_client(scheduler_user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=scheduler_user)
    return c


@pytest.fixture
def viewer_client(viewer_user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=viewer_user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard", hours_per_day=8.0)


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def scheduler_membership(scheduler_user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(
        project=project, user=scheduler_user, role=Role.SCHEDULER
    )


@pytest.fixture
def viewer_membership(viewer_user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=viewer_user, role=Role.VIEWER)


@pytest.fixture
def resource(db: object) -> Resource:
    return Resource.objects.create(
        name="Alice", email="alice@example.com", max_units=Decimal("1.0")
    )


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(
        project=project,
        name="Design",
        duration=5,
        early_start=date(2026, 4, 1),
        early_finish=date(2026, 4, 5),
    )


@pytest.fixture
def react_skill(db: object) -> Skill:
    return Skill.objects.create(name="React", normalized_name="react")


@pytest.fixture
def aws_skill(db: object) -> Skill:
    return Skill.objects.create(name="AWS", normalized_name="aws")


# ---------------------------------------------------------------------------
# Skill catalog tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSkillViewSet:
    def test_list_unauthenticated(self) -> None:
        c = APIClient()
        res = c.get("/api/v1/skills/")
        assert res.status_code == 401

    def test_list_authenticated(
        self,
        scheduler_client: APIClient,
        react_skill: Skill,
        scheduler_membership: ProjectMembership,
    ) -> None:
        res = scheduler_client.get("/api/v1/skills/")
        assert res.status_code == 200
        ids = [s["id"] for s in res.data["results"]]
        assert str(react_skill.pk) in ids

    def test_create_normalises_name(
        self,
        scheduler_client: APIClient,
        scheduler_membership: ProjectMembership,
    ) -> None:
        res = scheduler_client.post("/api/v1/skills/", {"name": "  TypeScript  "})
        assert res.status_code in (200, 201)
        assert res.data["normalized_name"] == "typescript"
        assert res.data["name"] == "TypeScript"

    def test_create_dedup_returns_existing(
        self,
        scheduler_client: APIClient,
        react_skill: Skill,
        scheduler_membership: ProjectMembership,
    ) -> None:
        """Creating a skill with same normalised name returns the existing row."""
        res = scheduler_client.post("/api/v1/skills/", {"name": "REACT"})
        assert res.status_code in (200, 201)
        assert res.data["id"] == str(react_skill.pk)

    def test_search(
        self,
        scheduler_client: APIClient,
        react_skill: Skill,
        aws_skill: Skill,
        scheduler_membership: ProjectMembership,
    ) -> None:
        res = scheduler_client.get("/api/v1/skills/?search=react")
        assert res.status_code == 200
        assert len(res.data["results"]) == 1
        assert res.data["results"][0]["name"] == "React"

    def test_create_rejected_for_user_without_scheduler_role(
        self, viewer_client: APIClient, viewer_user: object, project: Project
    ) -> None:
        """#254: a user without SCHEDULER+ on any project cannot write to the catalog."""
        ProjectMembership.objects.create(project=project, user=viewer_user, role=Role.VIEWER)
        res = viewer_client.post("/api/v1/skills/", {"name": "Kotlin"})
        assert res.status_code == 403

    def test_create_rejected_for_user_with_no_membership(self, viewer_client: APIClient) -> None:
        """#254: an authenticated user with no project membership cannot create skills."""
        res = viewer_client.post("/api/v1/skills/", {"name": "Kotlin"})
        assert res.status_code == 403


# ---------------------------------------------------------------------------
# Resource skill (tagging) tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestResourceSkillViewSet:
    def test_create_skill_on_resource(
        self,
        scheduler_client: APIClient,
        resource: Resource,
        react_skill: Skill,
        scheduler_membership: ProjectMembership,
    ) -> None:
        res = scheduler_client.post(
            "/api/v1/resource-skills/",
            {"resource": str(resource.pk), "skill": str(react_skill.pk), "proficiency": 3},
        )
        assert res.status_code == 201
        assert res.data["proficiency"] == 3
        assert res.data["skill_name"] == "React"

    def test_list_by_resource(
        self,
        scheduler_client: APIClient,
        resource: Resource,
        react_skill: Skill,
        scheduler_membership: ProjectMembership,
    ) -> None:
        ResourceSkill.objects.create(resource=resource, skill=react_skill, proficiency=2)
        res = scheduler_client.get(f"/api/v1/resource-skills/?resource={resource.pk}")
        assert res.status_code == 200
        assert len(res.data["results"]) == 1

    def test_duplicate_returns_400(
        self,
        scheduler_client: APIClient,
        resource: Resource,
        react_skill: Skill,
        scheduler_membership: ProjectMembership,
    ) -> None:
        ResourceSkill.objects.create(resource=resource, skill=react_skill, proficiency=1)
        res = scheduler_client.post(
            "/api/v1/resource-skills/",
            {"resource": str(resource.pk), "skill": str(react_skill.pk), "proficiency": 2},
        )
        assert res.status_code == 400

    def test_update_proficiency(
        self,
        scheduler_client: APIClient,
        resource: Resource,
        react_skill: Skill,
        scheduler_membership: ProjectMembership,
    ) -> None:
        rs = ResourceSkill.objects.create(resource=resource, skill=react_skill, proficiency=1)
        res = scheduler_client.patch(f"/api/v1/resource-skills/{rs.pk}/", {"proficiency": 3})
        assert res.status_code == 200
        assert res.data["proficiency"] == 3

    def test_delete(
        self,
        scheduler_client: APIClient,
        resource: Resource,
        react_skill: Skill,
        scheduler_membership: ProjectMembership,
    ) -> None:
        rs = ResourceSkill.objects.create(resource=resource, skill=react_skill, proficiency=2)
        res = scheduler_client.delete(f"/api/v1/resource-skills/{rs.pk}/")
        assert res.status_code == 204
        assert not ResourceSkill.objects.filter(pk=rs.pk).exists()


# ---------------------------------------------------------------------------
# Project resource (roster) tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestProjectResourceViewSet:
    def test_add_to_roster_scheduler(
        self,
        scheduler_client: APIClient,
        project: Project,
        resource: Resource,
        scheduler_membership: ProjectMembership,
    ) -> None:
        res = scheduler_client.post(
            "/api/v1/project-resources/",
            {"project": str(project.pk), "resource": str(resource.pk)},
        )
        assert res.status_code == 201
        assert res.data["effective_max_units"] == "1.00"

    def test_add_to_roster_viewer_forbidden(
        self,
        viewer_client: APIClient,
        project: Project,
        resource: Resource,
        viewer_membership: ProjectMembership,
    ) -> None:
        res = viewer_client.post(
            "/api/v1/project-resources/",
            {"project": str(project.pk), "resource": str(resource.pk)},
        )
        assert res.status_code == 403

    def test_units_override(
        self,
        scheduler_client: APIClient,
        project: Project,
        resource: Resource,
        scheduler_membership: ProjectMembership,
    ) -> None:
        res = scheduler_client.post(
            "/api/v1/project-resources/",
            {
                "project": str(project.pk),
                "resource": str(resource.pk),
                "units_override": "0.50",
            },
        )
        assert res.status_code == 201
        assert res.data["effective_max_units"] == "0.50"

    def test_duplicate_returns_400(
        self,
        scheduler_client: APIClient,
        project: Project,
        resource: Resource,
        scheduler_membership: ProjectMembership,
    ) -> None:
        ProjectResource.objects.create(project=project, resource=resource)
        res = scheduler_client.post(
            "/api/v1/project-resources/",
            {"project": str(project.pk), "resource": str(resource.pk)},
        )
        assert res.status_code == 400

    def test_remove_no_assignments(
        self,
        scheduler_client: APIClient,
        project: Project,
        resource: Resource,
        scheduler_membership: ProjectMembership,
    ) -> None:
        pr = ProjectResource.objects.create(project=project, resource=resource)
        res = scheduler_client.delete(f"/api/v1/project-resources/{pr.pk}/")
        assert res.status_code == 200
        assert res.data["cascaded_assignment_count"] == 0

    def test_remove_with_assignments_requires_force(
        self,
        scheduler_client: APIClient,
        project: Project,
        resource: Resource,
        task: Task,
        scheduler_membership: ProjectMembership,
    ) -> None:
        pr = ProjectResource.objects.create(project=project, resource=resource)
        TaskResource.objects.create(task=task, resource=resource, units=Decimal("1.0"))
        res = scheduler_client.delete(f"/api/v1/project-resources/{pr.pk}/")
        assert res.status_code == 409
        assert res.data["code"] == "has_assignments"
        assert res.data["assignment_count"] == 1

    def test_remove_with_force_cascades(
        self,
        scheduler_client: APIClient,
        project: Project,
        resource: Resource,
        task: Task,
        scheduler_membership: ProjectMembership,
    ) -> None:
        pr = ProjectResource.objects.create(project=project, resource=resource)
        tr = TaskResource.objects.create(task=task, resource=resource, units=Decimal("1.0"))
        res = scheduler_client.delete(f"/api/v1/project-resources/{pr.pk}/?force=true")
        assert res.status_code == 200
        assert res.data["cascaded_assignment_count"] == 1
        assert not TaskResource.objects.filter(pk=tr.pk).exists()
        assert not ProjectResource.objects.filter(pk=pr.pk).exists()

    def test_list_scoped_to_member_projects(
        self,
        scheduler_client: APIClient,
        project: Project,
        resource: Resource,
        scheduler_membership: ProjectMembership,
    ) -> None:
        ProjectResource.objects.create(project=project, resource=resource)
        other_project = Project.objects.create(name="Other", start_date=date(2026, 1, 1))
        other_resource = Resource.objects.create(name="Dave", max_units=Decimal("1.0"))
        ProjectResource.objects.create(project=other_project, resource=other_resource)
        res = scheduler_client.get(f"/api/v1/project-resources/?project={project.pk}")
        assert res.status_code == 200
        assert len(res.data["results"]) == 1


# ---------------------------------------------------------------------------
# Task skill requirement tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskSkillRequirementViewSet:
    def test_create(
        self,
        scheduler_client: APIClient,
        task: Task,
        react_skill: Skill,
        scheduler_membership: ProjectMembership,
    ) -> None:
        res = scheduler_client.post(
            "/api/v1/task-skill-requirements/",
            {"task": str(task.pk), "skill": str(react_skill.pk), "min_proficiency": 2},
        )
        assert res.status_code == 201
        assert res.data["skill_name"] == "React"
        assert res.data["min_proficiency"] == 2

    def test_list_by_task(
        self,
        scheduler_client: APIClient,
        task: Task,
        react_skill: Skill,
        scheduler_membership: ProjectMembership,
    ) -> None:
        TaskSkillRequirement.objects.create(task=task, skill=react_skill, min_proficiency=1)
        res = scheduler_client.get(f"/api/v1/task-skill-requirements/?task={task.pk}")
        assert res.status_code == 200
        assert len(res.data["results"]) == 1

    def test_duplicate_returns_400(
        self,
        scheduler_client: APIClient,
        task: Task,
        react_skill: Skill,
        scheduler_membership: ProjectMembership,
    ) -> None:
        TaskSkillRequirement.objects.create(task=task, skill=react_skill, min_proficiency=1)
        res = scheduler_client.post(
            "/api/v1/task-skill-requirements/",
            {"task": str(task.pk), "skill": str(react_skill.pk), "min_proficiency": 2},
        )
        assert res.status_code == 400


# ---------------------------------------------------------------------------
# Skill-fit annotation on resource list
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSkillFitAnnotation:
    def test_exact_fit(
        self,
        scheduler_client: APIClient,
        resource: Resource,
        task: Task,
        react_skill: Skill,
        scheduler_membership: ProjectMembership,
    ) -> None:
        ResourceSkill.objects.create(resource=resource, skill=react_skill, proficiency=3)
        TaskSkillRequirement.objects.create(task=task, skill=react_skill, min_proficiency=2)
        res = scheduler_client.get(f"/api/v1/resources/?task={task.pk}")
        assert res.status_code == 200
        row = next(r for r in res.data["results"] if r["id"] == str(resource.pk))
        assert row["skill_fit"] == "exact"
        assert row["missing_skills"] == []

    def test_partial_fit(
        self,
        scheduler_client: APIClient,
        resource: Resource,
        task: Task,
        react_skill: Skill,
        aws_skill: Skill,
        scheduler_membership: ProjectMembership,
    ) -> None:
        ResourceSkill.objects.create(resource=resource, skill=react_skill, proficiency=3)
        TaskSkillRequirement.objects.create(task=task, skill=react_skill, min_proficiency=2)
        TaskSkillRequirement.objects.create(task=task, skill=aws_skill, min_proficiency=1)
        res = scheduler_client.get(f"/api/v1/resources/?task={task.pk}")
        assert res.status_code == 200
        row = next(r for r in res.data["results"] if r["id"] == str(resource.pk))
        assert row["skill_fit"] == "partial"
        assert any(m["skill_name"] == "AWS" for m in row["missing_skills"])

    def test_missing_fit(
        self,
        scheduler_client: APIClient,
        resource: Resource,
        task: Task,
        react_skill: Skill,
        scheduler_membership: ProjectMembership,
    ) -> None:
        TaskSkillRequirement.objects.create(task=task, skill=react_skill, min_proficiency=1)
        res = scheduler_client.get(f"/api/v1/resources/?task={task.pk}")
        assert res.status_code == 200
        row = next(r for r in res.data["results"] if r["id"] == str(resource.pk))
        assert row["skill_fit"] == "missing"

    def test_no_requirements_no_annotation(
        self,
        scheduler_client: APIClient,
        resource: Resource,
        task: Task,
        scheduler_membership: ProjectMembership,
    ) -> None:
        """Without ?task= param, no skill_fit annotation is added."""
        res = scheduler_client.get("/api/v1/resources/")
        assert res.status_code == 200
        row = next(r for r in res.data["results"] if r["id"] == str(resource.pk))
        assert "skill_fit" not in row

    def test_results_sorted_exact_first(
        self,
        scheduler_client: APIClient,
        resource: Resource,
        task: Task,
        react_skill: Skill,
        scheduler_membership: ProjectMembership,
    ) -> None:
        Resource.objects.create(name="Zara", max_units=Decimal("1.0"))
        ResourceSkill.objects.create(resource=resource, skill=react_skill, proficiency=2)
        TaskSkillRequirement.objects.create(task=task, skill=react_skill, min_proficiency=1)
        res = scheduler_client.get(f"/api/v1/resources/?task={task.pk}")
        assert res.status_code == 200
        fits = [r["skill_fit"] for r in res.data["results"]]
        # exact should appear before missing
        assert fits.index("exact") < fits.index("missing")


# ---------------------------------------------------------------------------
# Skill mismatch warning on task-resource assignment
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSkillMismatchWarning:
    def test_no_warning_when_no_requirements(
        self,
        scheduler_client: APIClient,
        project: Project,
        task: Task,
        resource: Resource,
        scheduler_membership: ProjectMembership,
    ) -> None:
        with (
            __import__("unittest.mock", fromlist=["patch"]).patch(
                "trueppm_api.apps.resources.views._enqueue_recalculate"
            ),
            __import__("unittest.mock", fromlist=["patch"]).patch(
                "trueppm_api.apps.sync.broadcast.broadcast_board_event"
            ),
        ):
            res = scheduler_client.post(
                "/api/v1/task-resources/",
                {"task": str(task.pk), "resource": str(resource.pk), "units": "1.0"},
            )
        assert res.status_code == 201
        codes = [w["code"] for w in res.data["warnings"]]
        assert "skill_mismatch" not in codes

    def test_skill_mismatch_warning_present(
        self,
        scheduler_client: APIClient,
        project: Project,
        task: Task,
        resource: Resource,
        react_skill: Skill,
        scheduler_membership: ProjectMembership,
    ) -> None:
        # Task requires React (Intermediate); resource has no skills tagged.
        TaskSkillRequirement.objects.create(task=task, skill=react_skill, min_proficiency=2)
        with (
            __import__("unittest.mock", fromlist=["patch"]).patch(
                "trueppm_api.apps.resources.views._enqueue_recalculate"
            ),
            __import__("unittest.mock", fromlist=["patch"]).patch(
                "trueppm_api.apps.sync.broadcast.broadcast_board_event"
            ),
        ):
            res = scheduler_client.post(
                "/api/v1/task-resources/",
                {"task": str(task.pk), "resource": str(resource.pk), "units": "1.0"},
            )
        assert res.status_code == 201
        codes = [w["code"] for w in res.data["warnings"]]
        assert "skill_mismatch" in codes
        mismatch = next(w for w in res.data["warnings"] if w["code"] == "skill_mismatch")
        assert any(m["skill_name"] == "React" for m in mismatch["missing_skills"])

    def test_no_warning_when_skills_match(
        self,
        scheduler_client: APIClient,
        project: Project,
        task: Task,
        resource: Resource,
        react_skill: Skill,
        scheduler_membership: ProjectMembership,
    ) -> None:
        TaskSkillRequirement.objects.create(task=task, skill=react_skill, min_proficiency=2)
        ResourceSkill.objects.create(resource=resource, skill=react_skill, proficiency=3)
        with (
            __import__("unittest.mock", fromlist=["patch"]).patch(
                "trueppm_api.apps.resources.views._enqueue_recalculate"
            ),
            __import__("unittest.mock", fromlist=["patch"]).patch(
                "trueppm_api.apps.sync.broadcast.broadcast_board_event"
            ),
        ):
            res = scheduler_client.post(
                "/api/v1/task-resources/",
                {"task": str(task.pk), "resource": str(resource.pk), "units": "1.0"},
            )
        assert res.status_code == 201
        codes = [w["code"] for w in res.data["warnings"]]
        assert "skill_mismatch" not in codes


# ---------------------------------------------------------------------------
# Self-service profile read (resource skills via email match)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSelfServiceProfile:
    def test_can_list_own_skills_by_email(
        self,
        react_skill: Skill,
    ) -> None:
        """Any authenticated user can read their own resource's skills list."""
        own_user = User.objects.create_user(
            username="self_alice", email="alice@example.com", password="pw"
        )
        own_resource = Resource.objects.create(
            name="Alice", email="alice@example.com", max_units=Decimal("1.0")
        )
        ResourceSkill.objects.create(resource=own_resource, skill=react_skill, proficiency=2)
        client = APIClient()
        client.force_authenticate(user=own_user)
        res = client.get(f"/api/v1/resource-skills/?resource={own_resource.pk}")
        assert res.status_code == 200
        assert len(res.data["results"]) == 1


# ---------------------------------------------------------------------------
# exclude_project filter
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestExcludeProjectFilter:
    def test_excludes_resources_already_in_roster(
        self,
        scheduler_client: APIClient,
        project: Project,
        resource: Resource,
        scheduler_membership: ProjectMembership,
    ) -> None:
        ProjectResource.objects.create(project=project, resource=resource)
        res = scheduler_client.get(f"/api/v1/resources/?exclude_project={project.pk}")
        assert res.status_code == 200
        ids = [r["id"] for r in res.data["results"]]
        assert str(resource.pk) not in ids
