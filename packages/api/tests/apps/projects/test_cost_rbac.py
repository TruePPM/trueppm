"""Cost-field trust boundary: one test per leak path (ADR-1324 §7, #754).

The rule (#4810): a Member or Viewer never receives a rate or a cost field. Each
test names the leak path it closes (L1–L14 in the ADR's table).
"""

from __future__ import annotations

import json
import secrets
from decimal import Decimal
from typing import Any
from unittest.mock import patch

import pytest
from rest_framework.test import APIClient

from tests.apps.projects import cost_helpers as h
from tests.on_commit import capture_on_commit_callbacks
from trueppm_api.apps.access.models import Role
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import SCOPE_MCP_READ, ApiToken, Project
from trueppm_api.apps.resources.models import ProjectResource

pytestmark = pytest.mark.django_db

BUDGET = "98765.43"
RATE = "123.45"


@pytest.fixture
def world(db: object) -> dict[str, Any]:
    admin, scheduler, member, viewer = (h.user(n) for n in ("padmin", "sched", "mem", "view"))
    p = h.project("Secretive", budget=BUDGET)
    h.member(p, admin, Role.ADMIN)
    h.member(p, scheduler, Role.SCHEDULER)
    h.member(p, member, Role.MEMBER)
    h.member(p, viewer, Role.VIEWER)
    r = h.resource("Rated person", member, RATE)
    ProjectResource.objects.create(project=p, resource=r)
    t = h.task(p, percent=10)
    h.log(t, member, 60)
    return {
        "p": p,
        "r": r,
        "t": t,
        "admin": admin,
        "scheduler": scheduler,
        "member": member,
        "viewer": viewer,
        "wsadmin": h.workspace_admin(),
    }


def _no_cost(payload: Any) -> None:
    """Neither the key names nor the values appear anywhere in the payload."""
    blob = json.dumps(payload, default=str)
    for needle in ('"budget"', '"cost_rate"', BUDGET, RATE):
        assert needle not in blob, needle


# L1 ---------------------------------------------------------------------------
def test_resource_rate_hidden_from_non_admin(world: dict[str, Any]) -> None:
    for who in ("admin", "member", "viewer"):  # project Admin is NOT workspace Admin
        resp = h.client(world[who]).get(f"/api/v1/resources/{world['r'].pk}/")
        assert resp.status_code == 200
        assert "cost_rate" not in resp.json(), who
        listed = h.client(world[who]).get("/api/v1/resources/").json()
        _no_cost(listed)
    admin_view = h.client(world["wsadmin"]).get(f"/api/v1/resources/{world['r'].pk}/").json()
    assert admin_view["cost_rate"] == RATE


def test_resource_patch_refuses_cost_rate(world: dict[str, Any]) -> None:
    # A project Admin passes the catalog's IsOrgAdmin write gate, so this reaches
    # the serializer: a read-only field must be refused, not silently dropped.
    resp = h.client(world["admin"]).patch(
        f"/api/v1/resources/{world['r'].pk}/", {"cost_rate": "1.00"}, format="json"
    )
    assert resp.status_code == 400
    assert "cost_rate" in resp.json()
    world["r"].refresh_from_db()
    assert world["r"].cost_rate == Decimal(RATE)


def test_rate_endpoint_requires_workspace_admin(world: dict[str, Any]) -> None:
    url = f"/api/v1/resources/{world['r'].pk}/rate/"
    body = {"cost_rate": "1.00", "dry_run": True}
    for who in ("admin", "member"):
        assert h.client(world[who]).post(url, body, format="json").status_code == 403, who


# L2 ---------------------------------------------------------------------------
def test_roster_nested_resource_hides_rate(world: dict[str, Any]) -> None:
    resp = h.client(world["member"]).get(f"/api/v1/project-resources/?project={world['p'].pk}")
    assert resp.status_code == 200
    _no_cost(resp.json())


# L3 ---------------------------------------------------------------------------
def test_project_budget_hidden_from_member_and_scheduler(world: dict[str, Any]) -> None:
    p = world["p"]
    for who in ("scheduler", "member", "viewer"):
        detail = h.client(world[who]).get(f"/api/v1/projects/{p.pk}/").json()
        assert "budget" not in detail, who
        _no_cost(h.client(world[who]).get("/api/v1/projects/").json())
        assert h.client(world[who]).get(f"/api/v1/projects/{p.pk}/cost/").status_code == 403
    admin_view = h.client(world["admin"]).get(f"/api/v1/projects/{p.pk}/").json()
    assert admin_view["budget"] == BUDGET


# L4 ---------------------------------------------------------------------------
def test_scheduler_cannot_probe_budget_by_patch(world: dict[str, Any]) -> None:
    """An unchanged value is refused too, or 200-vs-400 would leak the amount."""
    url = f"/api/v1/projects/{world['p'].pk}/"
    c = h.client(world["scheduler"])
    assert c.patch(url, {"budget": BUDGET}, format="json").status_code == 400
    assert c.patch(url, {"budget": "1.00"}, format="json").status_code == 400
    ok = h.client(world["admin"]).patch(url, {"budget": "500.00"}, format="json")
    assert ok.status_code == 200, ok.data
    assert ok.json()["budget"] == "500.00"


# L5 ---------------------------------------------------------------------------
def test_sync_pull_project_has_no_budget(world: dict[str, Any]) -> None:
    from trueppm_api.apps.sync.serializers import SyncProjectSerializer

    data = SyncProjectSerializer(world["p"]).data
    assert "budget" not in data
    _no_cost(data)


# L6 ---------------------------------------------------------------------------
def test_broadcasts_carry_no_cost(world: dict[str, Any]) -> None:
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bcast:
        with capture_on_commit_callbacks(execute=True):
            resp = h.client(world["admin"]).patch(
                f"/api/v1/projects/{world['p'].pk}/", {"budget": "1.00"}, format="json"
            )
        assert resp.status_code == 200
        with capture_on_commit_callbacks(execute=True):
            h.client(world["wsadmin"]).post(
                f"/api/v1/resources/{world['r'].pk}/rate/",
                {"cost_rate": "9.99", "dry_run": False},
                format="json",
            )
    payloads = [c.args[2] for c in bcast.call_args_list]
    assert payloads, "the budget write should still broadcast project_updated"
    for p in payloads:
        assert set(p) <= {"id"}, p
    assert all(c.args[1] != "resource_updated" for c in bcast.call_args_list)


# L7 ---------------------------------------------------------------------------
def test_changelog_never_shows_budget(world: dict[str, Any]) -> None:
    from trueppm_api.apps.history.diff_policy import is_compared

    h.client(world["admin"]).patch(
        f"/api/v1/projects/{world['p'].pk}/",
        {"budget": "4242.42", "name": "Renamed"},
        format="json",
    )
    assert not is_compared("budget", object_scoped=False)
    assert not is_compared("budget", object_scoped=True)
    for path in ("changelog", "history"):
        resp = h.client(world["viewer"]).get(f"/api/v1/projects/{world['p'].pk}/{path}/")
        assert resp.status_code == 200, (path, resp.status_code)
        blob = json.dumps(resp.json(), default=str)
        assert "4242.42" not in blob and BUDGET not in blob and '"budget"' not in blob


# L8 / L9 ------------------------------------------------------------------------
def test_program_bundle_history_drops_budget_for_viewer(world: dict[str, Any]) -> None:
    from trueppm_api.apps.projects.export_bundle import _project_history_budget_gate

    row = {"id": world["p"].pk, "name": "x", "budget": Decimal(BUDGET)}
    assert "budget" not in _project_history_budget_gate(world["viewer"], world["p"].pk)(row)
    assert "budget" not in _project_history_budget_gate(None, world["p"].pk)(row)
    # Project Admin (the project bundle's own gate) keeps it — intended.
    assert _project_history_budget_gate(world["admin"], world["p"].pk)(row)["budget"]


# L10 ----------------------------------------------------------------------------
def test_workspace_export_is_owner_only(world: dict[str, Any]) -> None:
    for who in ("admin", "member", "wsadmin"):
        resp = h.client(world[who]).post("/api/v1/workspace/export/", {}, format="json")
        assert resp.status_code == 403, who


# L11 ----------------------------------------------------------------------------
def test_seed_export_has_no_cost_fields(world: dict[str, Any]) -> None:
    from trueppm_api.apps.projects.seed.exporter import export_project

    _no_cost(export_project(world["p"], requesting_user=world["wsadmin"]))


# L12 ----------------------------------------------------------------------------
def _bearer(u: Any) -> APIClient:
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    ApiToken.objects.create(
        owner=u,
        name="mcp",
        scopes=[SCOPE_MCP_READ],
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=u,
    )
    c = APIClient()
    c.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return c


def test_mcp_member_token_sees_no_cost(world: dict[str, Any]) -> None:
    c = _bearer(world["member"])
    detail = c.get(f"/api/v1/projects/{world['p'].pk}/")
    assert detail.status_code == 200, detail.status_code
    _no_cost(detail.json())
    assert c.get(f"/api/v1/projects/{world['p'].pk}/cost/").status_code == 403


def test_agent_token_cannot_change_a_rate(world: dict[str, Any]) -> None:
    resp = _bearer(world["wsadmin"]).post(
        f"/api/v1/resources/{world['r'].pk}/rate/",
        {"cost_rate": "1.00", "dry_run": False},
        format="json",
    )
    assert resp.status_code in (401, 403)
    world["r"].refresh_from_db()
    assert world["r"].cost_rate == Decimal(RATE)


# L13 ----------------------------------------------------------------------------
def test_share_payload_has_no_cost(world: dict[str, Any]) -> None:
    from trueppm_api.apps.projects.models import ShareContentKind, ShareLink
    from trueppm_api.apps.projects.share_services import (
        serialize_public_board,
        serialize_public_schedule,
    )

    p = Project.objects.get(pk=world["p"].pk)
    for kind in (ShareContentKind.BOARD, ShareContentKind.SCHEDULE):
        link = ShareLink(project=p, content_kind=kind, show_assignees=True)
        payload = (
            serialize_public_board(link)
            if kind == ShareContentKind.BOARD
            else serialize_public_schedule(link)
        )
        _no_cost(payload)


# L14 ----------------------------------------------------------------------------
def test_rollup_cost_kpis_restricted_for_program_viewer(world: dict[str, Any]) -> None:
    from trueppm_api.apps.access.models import ProgramMembership
    from trueppm_api.apps.access.services import create_program
    from trueppm_api.apps.projects.models import AggregationPolicy, Methodology, RollupKpi

    prog = create_program(
        name="Prog", description="", methodology=Methodology.HYBRID, created_by=world["admin"]
    )
    Project.objects.filter(pk=world["p"].pk).update(program=prog)
    ProgramMembership.objects.create(program=prog, user=world["viewer"], role=Role.VIEWER)
    prog.rollup_enabled_kpis = [RollupKpi.COST_VARIANCE.value, RollupKpi.BUDGET_UTILIZATION.value]
    prog.rollup_aggregation_policy = AggregationPolicy.WORST.value
    prog.save()
    for c in (h.client(world["viewer"]), _bearer(world["viewer"])):
        resp = c.get(f"/api/v1/programs/{prog.pk}/rollup/")
        assert resp.status_code == 200
        kpis = resp.json()["kpis"]
        assert kpis["cost_variance"] == {"available": False, "reason": "cost_restricted"}
        assert kpis["budget_utilization"] == {"available": False, "reason": "cost_restricted"}


# L8 (through the real path) ------------------------------------------------------
def _program_bundle_history(requester: Any, project: Project) -> list[dict[str, Any]]:
    """Build the program export bundle as ``requester`` and return the project history."""
    import io
    import tarfile

    from django.core.files.storage import default_storage

    from trueppm_api.apps.projects.models import ProgramExportJob
    from trueppm_api.apps.projects.tasks import run_program_export

    job = ProgramExportJob.objects.create(program=project.program, requested_by=requester)
    run_program_export.apply(args=[str(job.id)], throw=True)
    job.refresh_from_db()
    with (
        default_storage.open(job.file_path, "rb") as fh,
        tarfile.open(fileobj=io.BytesIO(fh.read()), mode="r:gz") as tar,
    ):
        member = tar.extractfile(f"projects/{project.pk}/history/project.json")
        assert member is not None
        rows: list[dict[str, Any]] = json.loads(member.read())
    return rows


def test_program_bundle_history_drops_budget_through_the_export_path(
    world: dict[str, Any],
) -> None:
    """The async program bundle a project Viewer requests carries no budget (L8)."""
    from trueppm_api.apps.access.models import ProgramMembership
    from trueppm_api.apps.access.services import create_program
    from trueppm_api.apps.projects.models import Methodology

    prog = create_program(
        name="Bundle", description="", methodology=Methodology.HYBRID, created_by=world["admin"]
    )
    p = Project.objects.get(pk=world["p"].pk)
    p.program = prog
    p.save()  # a HistoricalProject row carrying the budget
    ProgramMembership.objects.create(program=prog, user=world["viewer"], role=Role.ADMIN)

    viewer_rows = _program_bundle_history(world["viewer"], p)
    assert viewer_rows, "the history table must not be empty, or the check is vacuous"
    _no_cost(viewer_rows)

    admin_rows = _program_bundle_history(world["admin"], p)
    assert any(r.get("budget") is not None for r in admin_rows)


# Gap 4: a deactivated resource is still rateable ---------------------------------
def test_rate_endpoint_prices_a_deactivated_resource(world: dict[str, Any]) -> None:
    r = world["r"]
    r.cost_rate = None
    r.save()
    r.soft_delete()
    resp = h.client(world["wsadmin"]).post(
        f"/api/v1/resources/{r.pk}/rate/", {"cost_rate": "50.00", "dry_run": False}, format="json"
    )
    assert resp.status_code == 200, resp.data
    r.refresh_from_db()
    assert r.cost_rate == Decimal("50.00")
    # Its past hour (1 h on world["p"]) is now priced.
    (row,) = resp.json()["projects"]
    assert row["actual_after"] == "50.00"
    assert row["cost_computable_after"] is True
