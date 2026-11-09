"""Tests for GET /api/v1/projects/<pk>/schedule/driving-chain/ (ADR-1381, #4891)."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Project,
    Sprint,
    SprintState,
    Task,
    TaskStatus,
)
from trueppm_api.apps.scheduling.serializers import ScheduleDrivingChainSerializer

User = get_user_model()

FORBIDDEN_KEYS = {"assignee", "assignees", "assignments", "owners", "hours", "velocity"}


@pytest.fixture(autouse=True)
def clear_cache() -> object:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="chain_user", password="pw")


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    # A fixed Monday data date keeps every computed date independent of today.
    return Project.objects.create(
        name="Chain", start_date=date(2026, 3, 2), status_date=date(2026, 3, 2), calendar=cal
    )


@pytest.fixture
def chain(project: Project) -> dict[str, Task]:
    """A→B→C→D finish-to-start, every link driving."""
    tasks = {n: Task.objects.create(project=project, name=n, duration=2) for n in "ABCD"}
    for p, s in ("AB", "BC", "CD"):
        Dependency.objects.create(predecessor=tasks[p], successor=tasks[s], dep_type="FS", lag=0)
    return tasks


def _client(user: object, project: Project, role: str) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=role)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def viewer_client(user: object, project: Project) -> APIClient:
    return _client(user, project, Role.VIEWER)


def url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/schedule/driving-chain/"


def _walk_keys(value: object) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _walk_keys(v)}
    if isinstance(value, list):
        return {k for v in value for k in _walk_keys(v)}
    return set()


@pytest.mark.django_db
class TestDrivingChainAuth:
    def test_unauthenticated_returns_401(self, project: Project) -> None:
        assert APIClient().get(url(project.pk), {"task_id": "x"}).status_code == 401

    def test_non_member_refused(self, project: Project, chain: dict[str, Task]) -> None:
        outsider = User.objects.create_user(username="chain_out", password="pw")
        c = APIClient()
        c.force_authenticate(user=outsider)
        res = c.get(url(project.pk), {"task_id": str(chain["B"].pk)})
        # 403, same as the derivation view (test_schedule_derivation.py).
        assert res.status_code == 403

    @pytest.mark.parametrize("role", [Role.VIEWER, Role.MEMBER, Role.SCHEDULER, Role.OWNER])
    def test_every_member_role_reads(
        self, user: object, project: Project, chain: dict[str, Task], role: str
    ) -> None:
        res = _client(user, project, role).get(url(project.pk), {"task_id": str(chain["B"].pk)})
        assert res.status_code == 200

    def test_archived_project_stays_readable(
        self, viewer_client: APIClient, project: Project, chain: dict[str, Task]
    ) -> None:
        Project.objects.filter(pk=project.pk).update(is_archived=True)
        res = viewer_client.get(url(project.pk), {"task_id": str(chain["B"].pk)})
        assert res.status_code == 200


@pytest.mark.django_db
class TestDrivingChain:
    def test_walks_both_directions_with_provenance(
        self, viewer_client: APIClient, project: Project, chain: dict[str, Task]
    ) -> None:
        res = viewer_client.get(url(project.pk), {"task_id": str(chain["B"].pk)})
        assert res.status_code == 200
        data = res.json()
        assert data["computable"] is True
        assert data["truncated"] is False
        by_name = {n["name"]: n for n in data["nodes"]}
        assert by_name["B"]["direction"] == "self"
        assert by_name["A"]["direction"] == "upstream"
        assert {by_name["C"]["direction"], by_name["D"]["direction"]} == {"downstream"}
        assert by_name["D"]["hops"] == 2
        assert by_name["D"]["is_project_finish"] is True
        assert all(n["is_critical"] for n in data["nodes"])
        pairs = {(e["predecessor_id"], e["successor_id"]) for e in data["edges"]}
        ids = {k: str(t.pk) for k, t in chain.items()}
        assert pairs == {(ids["A"], ids["B"]), (ids["B"], ids["C"]), (ids["C"], ids["D"])}
        assert all(e["via_summary"] is None and e["is_driving"] for e in data["edges"])
        prov = data["_provenance"]
        assert prov["schema_version"] == 1
        assert prov["input_hash"].startswith("sha256:")
        assert set(prov) == {
            "schema_version",
            "engine_version",
            "api_version",
            "input_hash",
            "computed_at",
        }
        # Same inputs → same hash (ADR-0112 §2.2 idempotency).
        again = viewer_client.get(url(project.pk), {"task_id": str(chain["B"].pk)}).json()
        assert again["_provenance"]["input_hash"] == prov["input_hash"]

    def test_payload_matches_declared_schema_and_carries_no_team_internals(
        self, viewer_client: APIClient, project: Project, chain: dict[str, Task]
    ) -> None:
        sprint = Sprint.objects.create(
            project=project,
            name="S1",
            start_date=date(2026, 3, 2),
            finish_date=date(2026, 3, 13),
            state=SprintState.ACTIVE,
        )
        Task.objects.filter(pk=chain["A"].pk).update(sprint=sprint)
        data = viewer_client.get(url(project.pk), {"task_id": str(chain["B"].pk)}).json()
        assert set(data) == set(ScheduleDrivingChainSerializer().fields)
        a = next(n for n in data["nodes"] if n["name"] == "A")
        assert a["sprint"] == {"id": str(sprint.pk), "finish_date": "2026-03-13"}
        assert not (_walk_keys(data) & FORBIDDEN_KEYS)

    def test_depth_truncates(
        self, viewer_client: APIClient, project: Project, chain: dict[str, Task]
    ) -> None:
        data = viewer_client.get(
            url(project.pk), {"task_id": str(chain["A"].pk), "depth": "1"}
        ).json()
        assert data["truncated"] is True
        assert data["truncated_reason"] == "depth"
        assert {n["name"] for n in data["nodes"]} == {"A", "B"}

    def test_node_cap_truncates(
        self,
        viewer_client: APIClient,
        project: Project,
        chain: dict[str, Task],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from trueppm_api.apps.scheduling import driving_chain

        monkeypatch.setattr(driving_chain, "NODE_CAP", 2)
        data = viewer_client.get(url(project.pk), {"task_id": str(chain["B"].pk)}).json()
        assert data["truncated"] is True
        assert data["truncated_reason"] == "node_cap"
        assert data["node_cap"] == 2
        assert len(data["nodes"]) == 2
        # The cap's downstream half is reserved: the path toward the finish is kept.
        assert any(n["direction"] == "downstream" for n in data["nodes"])

    def test_fan_in_larger_than_cap_keeps_downstream_to_finish(
        self,
        viewer_client: APIClient,
        project: Project,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from trueppm_api.apps.scheduling import driving_chain

        monkeypatch.setattr(driving_chain, "NODE_CAP", 6)
        root = Task.objects.create(project=project, name="Root", duration=2)
        # Ten equal predecessors all drive Root: a fan-in larger than the cap.
        for i in range(10):
            p = Task.objects.create(project=project, name=f"P{i}", duration=2)
            Dependency.objects.create(predecessor=p, successor=root, dep_type="FS", lag=0)
        prev = root
        for name in ("S1", "S2", "S3"):
            nxt = Task.objects.create(project=project, name=name, duration=2)
            Dependency.objects.create(predecessor=prev, successor=nxt, dep_type="FS", lag=0)
            prev = nxt
        data = viewer_client.get(url(project.pk), {"task_id": str(root.pk)}).json()
        assert data["truncated_reason"] == "node_cap"
        assert len(data["nodes"]) == 6
        by_name = {n["name"]: n for n in data["nodes"]}
        assert {"S1", "S2", "S3"} <= set(by_name)
        assert by_name["S3"]["is_project_finish"] is True
        # Upstream still gets the slots downstream did not need.
        assert sum(n["direction"] == "upstream" for n in data["nodes"]) == 2

    def test_chain_is_cycle_free(
        self, viewer_client: APIClient, project: Project, chain: dict[str, Task]
    ) -> None:
        # A diamond re-converging on D: every task appears once, edges stay a DAG.
        Dependency.objects.create(
            predecessor=chain["A"], successor=chain["C"], dep_type="FS", lag=2
        )
        data = viewer_client.get(url(project.pk), {"task_id": str(chain["D"].pk)}).json()
        ids = [n["task_id"] for n in data["nodes"]]
        assert len(ids) == len(set(ids))
        assert all(e["predecessor_id"] != e["successor_id"] for e in data["edges"])

    # TODO(#4906): the engine may omit a driving link whose calendar-day lag lands on a
    # weekend (unconfirmed); this test's lag is pinned so the successor starts on a
    # weekday, so it does not exercise that case.
    def test_summary_gated_edge_is_expanded_server_side(
        self, viewer_client: APIClient, project: Project
    ) -> None:
        phase = Task.objects.create(project=project, name="Phase", duration=1, wbs_path="1")
        leaf = Task.objects.create(project=project, name="Leaf", duration=3, wbs_path="1.1")
        after = Task.objects.create(project=project, name="After", duration=2, wbs_path="2")
        # The only stored link is Phase → After; the leaf edge exists only after expansion.
        Dependency.objects.create(predecessor=phase, successor=after, dep_type="FS", lag=1)
        data = viewer_client.get(url(project.pk), {"task_id": str(after.pk)}).json()
        assert data["computable"] is True
        edge = next(e for e in data["edges"] if e["successor_id"] == str(after.pk))
        assert edge["predecessor_id"] == str(leaf.pk)
        assert edge["via_summary"] == [str(phase.pk)]
        assert edge["lag_days"] == 1

    def test_summary_task_is_not_computable(
        self, viewer_client: APIClient, project: Project
    ) -> None:
        phase = Task.objects.create(project=project, name="Phase", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="Leaf", duration=4, wbs_path="1.1")
        data = viewer_client.get(url(project.pk), {"task_id": str(phase.pk)}).json()
        assert data["computable"] is False
        assert data["reason"] == "summary"

    def test_backlog_task_is_not_computable(
        self, viewer_client: APIClient, project: Project, chain: dict[str, Task]
    ) -> None:
        backlog = Task.objects.create(
            project=project, name="Someday", duration=2, status=TaskStatus.BACKLOG
        )
        res = viewer_client.get(url(project.pk), {"task_id": str(backlog.pk)})
        assert res.status_code == 200
        data = res.json()
        assert data["computable"] is False
        assert data["reason"] == "backlog"
        assert data["nodes"] == [] and data["edges"] == []
        assert "_provenance" in data

    @pytest.mark.parametrize("bad", ["0", "51", "x"])
    def test_invalid_depth_is_400(
        self, viewer_client: APIClient, project: Project, chain: dict[str, Task], bad: str
    ) -> None:
        res = viewer_client.get(url(project.pk), {"task_id": str(chain["A"].pk), "depth": bad})
        assert res.status_code == 400

    @pytest.mark.parametrize("task_id", ["not-a-uuid", "00000000-0000-0000-0000-000000000000"])
    def test_unknown_task_is_404(
        self, viewer_client: APIClient, project: Project, task_id: str
    ) -> None:
        assert viewer_client.get(url(project.pk), {"task_id": task_id}).status_code == 404

    def test_missing_task_id_is_400(self, viewer_client: APIClient, project: Project) -> None:
        assert viewer_client.get(url(project.pk)).status_code == 400


@pytest.mark.django_db
class TestDrivingChainThrottle:
    """One schedule() pass per call — throttled exactly like the derivation (#2839)."""

    def test_session_caller_is_throttled_by_cpm_on_read(
        self,
        viewer_client: APIClient,
        project: Project,
        chain: dict[str, Task],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from rest_framework.throttling import ScopedRateThrottle

        monkeypatch.setitem(ScopedRateThrottle.THROTTLE_RATES, "cpm_on_read", "2/min")
        params = {"task_id": str(chain["B"].pk)}
        statuses = [viewer_client.get(url(project.pk), params).status_code for _ in range(3)]
        assert statuses == [200, 200, 429]

    def test_mcp_token_reads_and_is_throttled_by_compute_bucket(
        self,
        user: object,
        project: Project,
        chain: dict[str, Task],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        import secrets

        from rest_framework.throttling import ScopedRateThrottle

        from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
        from trueppm_api.apps.projects.models import SCOPE_MCP_READ, ApiToken

        ProjectMembership.objects.create(project=project, user=user, role=Role.VIEWER)
        raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
        ApiToken.objects.create(
            owner=user,
            name="mcp",
            scopes=[SCOPE_MCP_READ],
            token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
            token_hash=sha256_hex(raw),
            created_by=user,
        )
        monkeypatch.setitem(ScopedRateThrottle.THROTTLE_RATES, "mcp_read_compute", "1/min")
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
        params = {"task_id": str(chain["B"].pk)}
        statuses = [client.get(url(project.pk), params).status_code for _ in range(2)]
        assert statuses == [200, 429]
