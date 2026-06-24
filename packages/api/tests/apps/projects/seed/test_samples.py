"""Tests for the bundled sample loader (#375) and the Atlas fixture (#620).

The service tests double as a DB import smoke test for the committed Atlas seed:
if the 3-project fixture imports cleanly with cross-project dependencies, the
gate ("a fresh install can load the hybrid-large project") holds.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.projects.models import Dependency, Program, Project, Task
from trueppm_api.apps.projects.seed.samples import SAMPLES, UnknownSampleError, load_sample

pytestmark = pytest.mark.django_db

User = get_user_model()


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="demo-owner", email="o@example.com")


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# --- service ---------------------------------------------------------------


def test_load_atlas_creates_three_sample_projects(owner: Any) -> None:
    program = load_sample("atlas-platform-launch", owner=owner, create_users=True)

    assert program.code == "atlas-platform-launch"
    projects = Project.objects.filter(program=program)
    assert projects.count() == 3
    assert all(p.is_sample for p in projects)  # every project flagged demo data

    # methodology mix present
    assert set(projects.values_list("methodology", flat=True)) == {"AGILE", "WATERFALL", "HYBRID"}

    # personas created (create_users=True), with namespaced usernames so a real
    # account named "alex" is never reused for the demo persona
    assert User.objects.filter(username="atlas-alex").exists()
    assert not User.objects.filter(username="alex").exists()

    # cross-project dependency wired (Platform Core gates Migration build)
    assert Dependency.objects.filter(
        predecessor__project__methodology="AGILE",
        successor__project__methodology="WATERFALL",
    ).exists()

    # three-point estimates imported on the waterfall stream
    assert Task.objects.filter(
        project__methodology="WATERFALL", optimistic_duration__isnull=False
    ).exists()


def test_load_sample_is_idempotent(owner: Any) -> None:
    load_sample("atlas-platform-launch", owner=owner, create_users=True)
    load_sample("atlas-platform-launch", owner=owner, create_users=True)
    assert Program.objects.filter(code="atlas-platform-launch", is_deleted=False).count() == 1


def test_unknown_sample_raises(owner: Any) -> None:
    with pytest.raises(UnknownSampleError):
        load_sample("does-not-exist", owner=owner)


@pytest.mark.parametrize("key", sorted(SAMPLES))
def test_every_bundled_sample_imports(owner: Any, key: str) -> None:
    # Each committed fixture validates and imports cleanly into a real DB.
    program = load_sample(key, owner=owner, create_users=True)
    projects = Project.objects.filter(program=program)
    assert projects.exists()
    assert all(p.is_sample for p in projects)


def test_samples_endpoint_lists_all(owner: Any) -> None:
    resp = _client(owner).get("/api/v1/programs/samples/")
    assert resp.status_code == 200
    keys = {s["key"] for s in resp.data}
    assert keys == set(SAMPLES)
    assert all({"key", "title", "description"} <= set(s) for s in resp.data)


def test_samples_endpoint_requires_auth() -> None:
    resp = APIClient().get("/api/v1/programs/samples/")
    assert resp.status_code in (401, 403)


def test_management_command_loads_sample(owner: Any) -> None:
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])
    call_command("load_sample_project")
    assert Program.objects.filter(code="atlas-platform-launch", is_deleted=False).exists()


# --- endpoints -------------------------------------------------------------


def test_load_sample_endpoint_requires_auth() -> None:
    resp = APIClient().post("/api/v1/programs/load-sample/", {}, format="json")
    assert resp.status_code in (401, 403)


def test_load_sample_endpoint_creates_program(owner: Any) -> None:
    resp = _client(owner).post("/api/v1/programs/load-sample/", {}, format="json")
    assert resp.status_code == 201, resp.content
    # The response is now a {program, landing_project_id, sample_key} envelope (#1054).
    assert resp.data["sample_key"] == "atlas-platform-launch"
    assert resp.data["program"]["code"] == "atlas-platform-launch"
    assert resp.data["program"]["is_sample"] is True


def test_load_sample_unknown_key_rejected(owner: Any) -> None:
    resp = _client(owner).post("/api/v1/programs/load-sample/", {"sample": "nope"}, format="json")
    assert resp.status_code == 400


def test_remove_sample_endpoint_owner_tears_down(owner: Any) -> None:
    program = load_sample("atlas-platform-launch", owner=owner, create_users=True)
    resp = _client(owner).post(f"/api/v1/programs/{program.pk}/remove-sample/")
    assert resp.status_code == 204
    assert not Program.objects.filter(pk=program.pk, is_deleted=False).exists()
    assert not Project.objects.filter(program_id=program.pk).exists()


def test_remove_sample_non_owner_denied(owner: Any) -> None:
    program = load_sample("atlas-platform-launch", owner=owner, create_users=True)
    stranger = User.objects.create_user(username="stranger", password="pw")
    resp = _client(stranger).post(f"/api/v1/programs/{program.pk}/remove-sample/")
    assert resp.status_code in (403, 404)
    assert Program.objects.filter(pk=program.pk, is_deleted=False).exists()


def test_remove_sample_non_owner_member_denied(owner: Any) -> None:
    # An ADMIN member (not OWNER) must not be able to tear down the program.
    from trueppm_api.apps.access.models import ProgramMembership

    program = load_sample("atlas-platform-launch", owner=owner, create_users=True)
    admin = User.objects.create_user(username="prog-admin", password="pw")
    ProgramMembership.objects.create(program=program, user=admin, role=Role.ADMIN)
    resp = _client(admin).post(f"/api/v1/programs/{program.pk}/remove-sample/")
    assert resp.status_code in (403, 404)
    assert Program.objects.filter(pk=program.pk, is_deleted=False).exists()


def test_remove_sample_refuses_non_sample_program(owner: Any) -> None:
    from trueppm_api.apps.access.services import create_program

    program = create_program(name="Real", description="", methodology="HYBRID", created_by=owner)
    # grant owner membership already done by create_program; mark caller OWNER
    assert program.memberships.filter(user=owner, role=Role.OWNER).exists()
    resp = _client(owner).post(f"/api/v1/programs/{program.pk}/remove-sample/")
    assert resp.status_code == 400
    assert Program.objects.filter(pk=program.pk, is_deleted=False).exists()
