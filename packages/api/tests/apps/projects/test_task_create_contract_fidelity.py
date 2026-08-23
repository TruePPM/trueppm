"""The task write contract says what it does, and reports what it did not do.

Two defects of one class — the create path honors keys the published schema never
mentions, and discards keys it does not honor without saying so:

* #2898 — ``parent_id`` and ``is_subtask`` are read off raw ``request.data`` on POST
  (they are read-only on ``TaskSerializer`` for the ADR-0743 / #2585 RBAC reason), so
  they were honored on create, absent from ``TaskRequest`` entirely, and a silent
  no-op on PATCH. The ``is_subtask`` parse — ``str(raw).lower() in ("true", "1")`` —
  also read ``"yes"`` and ``1.0`` as *false*, quietly creating a structural WBS node
  where the caller asked for a checklist subtask.
* #2899 — a ``predecessors`` key in the body is dropped by DRF's default
  silent-ignore and returns 201/200, so a migration tool moving dependency-bearing
  tasks out of Jira or MS Project believes every edge landed.

The published schema is part of the contract under test: the request component must
carry the placement keys and the response component must carry ``warnings``, or the
behavior below is undiscoverable to the integrator it exists for.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()

_OPENAPI = Path(__file__).resolve().parents[5] / "docs" / "api" / "openapi.json"


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def project(owner: Any) -> Project:
    cal = Calendar.objects.create(name="Standard")
    p = Project.objects.create(name="Apollo", start_date=date(2026, 1, 1), calendar=cal)
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


@pytest.fixture
def client(owner: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


@pytest.fixture
def parent(project: Project) -> Task:
    return Task.objects.create(project=project, name="Mobilization", wbs_path="1", duration=5)


def _create(client: APIClient, project: Project, **body: Any) -> Any:
    payload: dict[str, Any] = {"project": str(project.pk), "name": "T", "duration": 3}
    payload.update(body)
    return client.post("/api/v1/tasks/", payload, format="json")


def _warning_rules(resp: Any) -> list[str]:
    return [w["rule"] for w in resp.data.get("warnings", [])]


def _dropped_detail(resp: Any) -> str:
    return next(w["detail"] for w in resp.data["warnings"] if w["rule"] == "dropped_fields")


# ---------------------------------------------------------------------------
# #2898 — the create contract is published
# ---------------------------------------------------------------------------


def test_create_request_schema_declares_both_placement_keys() -> None:
    """The whole #2898 defect: honored on POST, absent from the request component."""
    schema = json.loads(_OPENAPI.read_text())
    create_op = schema["paths"]["/api/v1/tasks/"]["post"]
    ref = create_op["requestBody"]["content"]["application/json"]["schema"]["$ref"]
    component = schema["components"]["schemas"][ref.rsplit("/", 1)[-1]]

    assert "parent_id" in component["properties"]
    assert "is_subtask" in component["properties"]
    # Both are inputs, not echoes: a readOnly declaration is what made the create
    # mechanism undiscoverable in the first place.
    assert component["properties"]["parent_id"]["writeOnly"] is True
    assert component["properties"]["is_subtask"]["writeOnly"] is True
    # Neither may be required — the vast majority of creates are root-level tasks.
    assert "parent_id" not in component.get("required", [])
    assert "is_subtask" not in component.get("required", [])


@pytest.mark.parametrize("method", ["put", "patch"])
def test_write_response_schema_declares_optional_warnings(method: str) -> None:
    """``warnings`` is returned by every task write and must be declared, but not required.

    Required-but-absent is the declared-vs-actual drift the API fuzz job exists to
    catch (#2515) — warnings are absent on the common clean write.
    """
    schema = json.loads(_OPENAPI.read_text())
    op = schema["paths"]["/api/v1/tasks/{id}/"][method]
    ref = op["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]
    component = schema["components"]["schemas"][ref.rsplit("/", 1)[-1]]

    assert "warnings" in component["properties"]
    assert "warnings" not in component.get("required", [])


@pytest.mark.django_db
def test_parent_id_still_places_the_task(client: APIClient, project: Project, parent: Task) -> None:
    """Regression guard: declaring the key in the schema must not change what it does."""
    resp = _create(client, project, parent_id=str(parent.pk))

    assert resp.status_code == 201
    assert Task.objects.get(pk=resp.data["id"]).wbs_path == "1.1"


@pytest.mark.django_db
def test_is_subtask_still_creates_a_drawer_subtask(
    client: APIClient, project: Project, parent: Task
) -> None:
    resp = _create(client, project, parent_id=str(parent.pk), is_subtask=True)

    assert resp.status_code == 201
    assert Task.objects.get(pk=resp.data["id"]).is_subtask is True


@pytest.mark.django_db
@pytest.mark.parametrize("raw", ["yes", "on", "TRUE", 1, True])
def test_is_subtask_accepts_every_value_that_can_only_mean_true(
    client: APIClient, project: Project, parent: Task, raw: Any
) -> None:
    """``"yes"`` used to parse as False and silently create a structural WBS node."""
    resp = _create(client, project, parent_id=str(parent.pk), is_subtask=raw)

    assert resp.status_code == 201, resp.data
    assert Task.objects.get(pk=resp.data["id"]).is_subtask is True


@pytest.mark.django_db
@pytest.mark.parametrize("raw", ["no", "off", "FALSE", 0, False, ""])
def test_is_subtask_accepts_every_value_that_can_only_mean_false(
    client: APIClient, project: Project, parent: Task, raw: Any
) -> None:
    resp = _create(client, project, parent_id=str(parent.pk), is_subtask=raw)

    assert resp.status_code == 201, resp.data
    assert Task.objects.get(pk=resp.data["id"]).is_subtask is False


@pytest.mark.django_db
@pytest.mark.parametrize("raw", [1.0, "maybe", "1.0", [], {"a": 1}])
def test_is_subtask_refuses_a_value_it_cannot_interpret(
    client: APIClient, project: Project, parent: Task, raw: Any
) -> None:
    """A 400 beats a guess: the flag decides subtask vs. WBS node, and a 201 hides the miss."""
    resp = _create(client, project, parent_id=str(parent.pk), is_subtask=raw)

    assert resp.status_code == 400
    assert "is_subtask" in resp.data


@pytest.mark.django_db
def test_malformed_parent_id_is_a_400_not_a_500(client: APIClient, project: Project) -> None:
    """``Task.objects.get(pk="nope")`` raises Django's ValidationError, which DRF does
    not convert — the declared uuid-typed key must fail as a 400 (#2785)."""
    resp = _create(client, project, parent_id="not-a-uuid")

    assert resp.status_code == 400
    assert "parent_id" in resp.data


@pytest.mark.django_db
def test_a_non_mapping_body_is_a_400_not_a_500(client: APIClient) -> None:
    """A JSON list has no ``.get`` at all, so the raw reads used to AttributeError (#2795)."""
    resp = client.post("/api/v1/tasks/", [{"name": "T"}], format="json")

    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# #2898 — the keys are create-only, and a PATCH now says so
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_patching_parent_id_reports_it_as_dropped(
    client: APIClient, project: Project, parent: Task
) -> None:
    """The silent no-op: a 200 for a move that never happened."""
    task = Task.objects.create(project=project, name="Child", wbs_path="2", duration=2)

    resp = client.patch(f"/api/v1/tasks/{task.pk}/", {"parent_id": str(parent.pk)}, format="json")

    assert resp.status_code == 200
    task.refresh_from_db()
    assert task.wbs_path == "2"
    assert "dropped_fields" in _warning_rules(resp)
    detail = _dropped_detail(resp)
    assert "parent_id" in detail
    # The warning has to name the operation that does work, or it only says "no".
    assert "reparent" in detail


@pytest.mark.django_db
def test_patching_is_subtask_reports_it_as_dropped(client: APIClient, project: Project) -> None:
    task = Task.objects.create(project=project, name="Child", wbs_path="2", duration=2)

    resp = client.patch(f"/api/v1/tasks/{task.pk}/", {"is_subtask": True}, format="json")

    assert resp.status_code == 200
    task.refresh_from_db()
    assert task.is_subtask is False
    assert "is_subtask" in _dropped_detail(resp)


@pytest.mark.django_db
def test_create_does_not_report_the_keys_it_honors(
    client: APIClient, project: Project, parent: Task
) -> None:
    """The mirror of the two tests above — on POST these keys are applied, not dropped."""
    resp = _create(client, project, parent_id=str(parent.pk), is_subtask=True)

    assert resp.status_code == 201
    assert "dropped_fields" not in _warning_rules(resp)


# ---------------------------------------------------------------------------
# #2899 — an unknown key is reported, not swallowed
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_predecessors_on_create_is_reported_with_the_endpoint_that_works(
    client: APIClient, project: Project, parent: Task
) -> None:
    """The integrator case: 201 per task, and the tool believes every edge landed."""
    resp = _create(client, project, predecessors=[str(parent.pk)])

    assert resp.status_code == 201
    detail = _dropped_detail(resp)
    assert "predecessors" in detail
    assert "/api/v1/dependencies/" in detail


@pytest.mark.django_db
def test_predecessors_on_patch_is_reported(client: APIClient, project: Project) -> None:
    task = Task.objects.create(project=project, name="Child", wbs_path="2", duration=2)

    resp = client.patch(f"/api/v1/tasks/{task.pk}/", {"predecessors": []}, format="json")

    assert resp.status_code == 200
    assert "predecessors" in _dropped_detail(resp)


@pytest.mark.django_db
def test_an_arbitrary_unknown_key_is_named_in_the_warning(
    client: APIClient, project: Project
) -> None:
    resp = _create(client, project, not_a_field="x", also_not="y")

    assert resp.status_code == 201
    detail = _dropped_detail(resp)
    assert "also_not" in detail and "not_a_field" in detail


@pytest.mark.django_db
def test_a_read_only_key_is_not_warned_about(client: APIClient, project: Project) -> None:
    """Round-tripping a full task object must stay quiet.

    ``early_start`` is declared and marked ``readOnly`` in the published schema, so a
    client can already know it will not be written. Warning on it would bury the keys
    that carry no signal at all — which is the entire point of the notice.
    """
    resp = _create(client, project, early_start="2026-02-01")

    assert resp.status_code == 201
    assert "dropped_fields" not in _warning_rules(resp)


@pytest.mark.django_db
def test_a_clean_write_carries_no_warnings_key_at_all(client: APIClient, project: Project) -> None:
    """Why ``warnings`` is declared optional rather than required in the response schema."""
    resp = _create(client, project)

    assert resp.status_code == 201
    assert "warnings" not in resp.data
