"""Tests for the shared task-graph validation guard (#1665).

The guard exists so bulk / agent write paths (the offline Jira importer #1664,
inbound sync, any future non-interactive writer) run the *same* self-reference
and cycle detection the interactive ``DependencySerializer`` path runs — the
"hybrid by construction" guarantee that a human and an agent principal are
governed identically.

Two layers:
  * pure unit tests of ``validate_task_graph`` — cyclic / self-referential input
    is rejected with a clear ``InfeasibleGraphError`` rather than crashing the
    CPM engine downstream;
  * a cross-path validation-parity test — an identical cyclic graph is rejected
    identically by the human dependency-create endpoint and by the guard the
    agent/import write path uses. (A literal token-vs-session test on
    ``DependencyViewSet`` is not expressible: API tokens authenticate only the
    inbound-sync task path, which writes no dependency edges, so the meaningful
    parity is cross-*path*, not cross-*auth-on-one-endpoint*.)
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient
from trueppm_scheduler import InvalidScheduleInput

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.scheduling.graph_guard import (
    InfeasibleGraphError,
    validate_task_graph,
)


class TestValidateTaskGraphUnit:
    """Pure, DB-free checks on the guard's detection and error shape."""

    def test_acyclic_graph_passes(self) -> None:
        # A → B → C, plus a diamond join, is feasible: no exception.
        validate_task_graph([("A", "B"), ("B", "C"), ("A", "C")])

    def test_empty_graph_passes(self) -> None:
        validate_task_graph([])

    def test_self_reference_rejected(self) -> None:
        with pytest.raises(InfeasibleGraphError) as exc:
            validate_task_graph([("A", "B"), ("C", "C")])
        assert exc.value.reason == "self_reference"
        # The offending node is surfaced precisely so an importer can quarantine
        # just that edge rather than reject the whole graph.
        assert exc.value.offending == ["C"]

    def test_two_cycle_rejected(self) -> None:
        with pytest.raises(InfeasibleGraphError) as exc:
            validate_task_graph([("A", "B"), ("B", "A")])
        assert exc.value.reason == "cyclic_dependency"
        # The cycle path closes on its first node (A → B → A).
        assert exc.value.offending[0] == exc.value.offending[-1]
        assert set(exc.value.offending) == {"A", "B"}

    def test_three_cycle_rejected(self) -> None:
        with pytest.raises(InfeasibleGraphError) as exc:
            validate_task_graph([("A", "B"), ("B", "C"), ("C", "A")])
        assert exc.value.reason == "cyclic_dependency"
        assert set(exc.value.offending) == {"A", "B", "C"}

    def test_summary_logical_cycle_rejected(self) -> None:
        # Edge-level acyclic (A → S is a single edge), but S is a summary whose
        # only leaf is A, so it expands to the self-loop A → A — a logical cycle
        # the serializer path catches via the same children_map expansion.
        with pytest.raises(InfeasibleGraphError) as exc:
            validate_task_graph([("A", "S")], children_map={"S": ["A"]})
        assert exc.value.reason == "cyclic_dependency"

    def test_malformed_children_map_reraises_invalid_input(self) -> None:
        # A summary declared with no children is a malformed graph, distinct from
        # a cycle in the edges — the engine's InvalidScheduleInput passes through
        # so the caller can reject it too (never a bare 500 / crash).
        with pytest.raises(InvalidScheduleInput):
            validate_task_graph([("X", "Y")], children_map={"S": []})


# --------------------------------------------------------------------------- #
# Cross-path validation parity (the #1665 regression AC).
# --------------------------------------------------------------------------- #


@pytest.fixture
def user(db: object) -> object:
    return get_user_model().objects.create_user(username="parity", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    project = Project.objects.create(name="Parity", start_date=date(2026, 3, 2), calendar=calendar)
    return project


@pytest.fixture
def membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.mark.django_db
class TestValidationParity:
    """The human write path and the agent/import guard reject the same graph."""

    def test_human_endpoint_and_guard_reject_identical_cycle(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        # Build A → B, then close the cycle with B → A.
        a = Task.objects.create(project=project, name="A", duration=1)
        b = Task.objects.create(project=project, name="B", duration=1)
        Dependency.objects.create(predecessor=a, successor=b)

        # Human path: POST the closing edge to the interactive endpoint.
        human = client.post(
            "/api/v1/dependencies/",
            {"predecessor": str(b.pk), "successor": str(a.pk), "dep_type": "FS"},
        )
        assert human.status_code == 400
        assert human.data["detail"] == "cyclic_dependency"
        human_cycle = {node["id"] for node in human.data["cycle"]}
        assert human_cycle == {str(a.pk), str(b.pk)}
        # The edge was not persisted — validation ran before the write.
        assert not Dependency.objects.filter(predecessor=b, successor=a).exists()

        # Agent / import path: the guard sees the complete edge set the importer
        # would bulk_create and rejects it with the identical outcome.
        with pytest.raises(InfeasibleGraphError) as exc:
            validate_task_graph([(str(a.pk), str(b.pk)), (str(b.pk), str(a.pk))])
        assert exc.value.reason == "cyclic_dependency"
        assert set(exc.value.offending) == human_cycle

    def test_human_endpoint_and_guard_reject_identical_self_loop(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        a = Task.objects.create(project=project, name="A", duration=1)

        human = client.post(
            "/api/v1/dependencies/",
            {"predecessor": str(a.pk), "successor": str(a.pk), "dep_type": "FS"},
        )
        assert human.status_code == 400
        assert human.data["detail"] == "cyclic_dependency"

        # The guard classifies a self-loop distinctly so importers can quarantine
        # it; both paths still refuse to persist it.
        with pytest.raises(InfeasibleGraphError) as exc:
            validate_task_graph([(str(a.pk), str(a.pk))])
        assert exc.value.reason == "self_reference"
        assert exc.value.offending == [str(a.pk)]
