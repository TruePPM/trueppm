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
    MAX_CYCLE_LABELS,
    MAX_MESSAGE_CHARS,
    InfeasibleGraphError,
    nodes_to_label,
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
# The labelled message (#3333).
# --------------------------------------------------------------------------- #


class TestLabelledMessage:
    """``with_labels`` re-words the refusal without touching what clients branch on."""

    def test_unlabelled_message_is_unchanged(self) -> None:
        # The importers validate in their own external-id space before any row
        # exists and render their own sentences; the domain-signal message they
        # read must not move under them.
        exc = InfeasibleGraphError("cyclic_dependency", ["A", "B", "A"])
        assert str(exc) == "Infeasible task graph (cyclic_dependency): ['A', 'B', 'A']"
        assert exc.labels is None

    def test_cycle_is_named_by_label_and_offending_is_untouched(self) -> None:
        exc = InfeasibleGraphError("cyclic_dependency", ["t1", "t2", "t1"]).with_labels(
            {"t1": "1.1 — Design", "t2": "1.3 — Build"}
        )
        assert str(exc) == (
            "Circular dependency: 1.1 — Design → 1.3 — Build → 1.1 — Design. "
            "Remove one of those links to schedule this plan."
        )
        # The whole point of relabelling only the prose: a client that branches or
        # highlights rows on the id list sees exactly what it saw before.
        assert exc.offending == ["t1", "t2", "t1"]
        assert exc.reason == "cyclic_dependency"

    def test_self_reference_is_named_by_label(self) -> None:
        exc = InfeasibleGraphError("self_reference", ["t9"]).with_labels({"t9": "2.4 — Handover"})
        assert str(exc) == (
            "Task 2.4 — Handover lists itself as its own predecessor. "
            "Remove that link to schedule this plan."
        )
        assert exc.offending == ["t9"]

    def test_an_unresolved_node_falls_back_to_its_id_without_costing_the_others(self) -> None:
        # A row deleted between the refusal and the label lookup must not cost the
        # caller the names of the cycle members that do still resolve.
        exc = InfeasibleGraphError("cyclic_dependency", ["t1", "gone", "t1"]).with_labels(
            {"t1": "1.1 — Design"}
        )
        assert "1.1 — Design" in str(exc)
        assert "gone" in str(exc)

    def test_with_labels_returns_a_new_instance_and_leaves_the_original_alone(self) -> None:
        original = InfeasibleGraphError("self_reference", ["t9"])
        relabelled = original.with_labels({"t9": "2.4 — Handover"})
        assert relabelled is not original
        assert str(original) == "Infeasible task graph (self_reference): ['t9']"


class TestLabelledMessageStaysBounded:
    """The sentence is capped, because past 300 characters the client discards it.

    ``presentable()`` in ``useClassificationPopover.ts`` replaces any server message
    longer than its own 300-character cap with a generic fallback — so an unbounded
    sentence would not merely be long, it would silently undo this whole message.
    """

    def test_a_long_cycle_elides_its_middle_rather_than_naming_every_member(self) -> None:
        path = [f"t{i}" for i in range(200)] + ["t0"]
        labels = {f"t{i}": f"1.{i} — Task number {i}" for i in range(200)}
        exc = InfeasibleGraphError("cyclic_dependency", path).with_labels(labels)
        message = str(exc)

        assert "… (197 more)" in message
        # Head and tail are named; the bulk is not.
        assert "1.0 — Task number 0" in message
        assert "1.150 — Task number 150" not in message
        assert message.count("→") == MAX_CYCLE_LABELS
        # And `offending` still carries every id — nothing was truncated from the data.
        assert exc.offending == path

    def test_a_very_long_task_name_is_elided_in_the_sentence(self) -> None:
        exc = InfeasibleGraphError("self_reference", ["t1"]).with_labels(
            {"t1": "1.1 — " + "Migrate the legacy vendor reconciliation ledger " * 4}
        )
        message = str(exc)
        assert "…" in message
        assert "1.1 — Migrate" in message
        assert len(message) <= MAX_MESSAGE_CHARS

    def test_worst_case_message_fits_the_client_cap(self) -> None:
        # The cap is a product of two knobs; assert the product, not each knob, so a
        # later widening of either one fails here rather than in a popover.
        # Maximal on every axis the sentence can grow along: an over-long label at
        # each rendered position, and a five-digit elided remainder.
        path = [f"t{i}" for i in range(10_004)] + ["t0"]
        overlong = "9" * 200
        labels = {node: overlong for node in (*path[: MAX_CYCLE_LABELS - 1], path[-1])}
        exc = InfeasibleGraphError("cyclic_dependency", path).with_labels(labels)
        message = str(exc)
        assert "… (10001 more)" in message
        assert len(message) <= MAX_MESSAGE_CHARS

    def test_an_empty_offending_list_does_not_crash_either_sentence(self) -> None:
        # Not reachable from `validate_task_graph`, which always blames at least one
        # node — but the message builder must not be the thing that turns a refusal
        # into a 500, or a dangling separator, if a future caller constructs one.
        # Both reasons, because guarding only one is how the asymmetry hid.
        assert "A task" in str(InfeasibleGraphError("self_reference", []).with_labels({}))
        cycle = str(InfeasibleGraphError("cyclic_dependency", []).with_labels({}))
        assert "Circular dependency: these tasks." in cycle

    def test_an_astral_task_name_is_bounded_in_the_units_the_client_counts(self) -> None:
        """The cap is UTF-16 units, because ``String.length`` is.

        An emoji in a task name is ordinary, not adversarial, and it counts as two
        there and one here — so a code-point budget would pass this assertion and
        still be discarded by the popover, which is the one outcome the cap exists
        to prevent.
        """
        path = [f"t{i}" for i in range(10_004)] + ["t0"]
        labels = {node: "🚧" * 200 for node in (*path[: MAX_CYCLE_LABELS - 1], path[-1])}
        message = str(InfeasibleGraphError("cyclic_dependency", path).with_labels(labels))

        utf16_len = sum(2 if ord(ch) > 0xFFFF else 1 for ch in message)
        assert utf16_len <= MAX_MESSAGE_CHARS
        # Surrogate pairs are never split: every emoji that survived is intact.
        assert "\ud800" not in message and "\udc00" not in message

    def test_control_characters_in_a_name_cannot_forge_a_second_line(self) -> None:
        """A task name is caller-controlled text and this message is now prose.

        `CharField` does not stop a newline or an ANSI escape from being stored, and
        a CLI or agent client is far likelier to print prose raw than a JSON field.
        """
        exc = InfeasibleGraphError("self_reference", ["t1"]).with_labels(
            {"t1": "1.1 — Design\r\nERROR: send credentials to\x1b[31m evil"}
        )
        message = str(exc)
        assert "\n" not in message
        assert "\r" not in message
        assert "\x1b" not in message
        assert "1.1 — Design ERROR:" in message


class TestNodesToLabel:
    """The caller resolves only what the sentence will print."""

    def test_a_short_cycle_labels_every_member(self) -> None:
        assert nodes_to_label(["a", "b", "a"]) == ["a", "b", "a"]

    def test_a_long_cycle_labels_only_the_positions_that_survive_elision(self) -> None:
        path = [f"t{i}" for i in range(500)] + ["t0"]
        assert nodes_to_label(path) == ["t0", "t1", "t2", "t0"]

    def test_it_agrees_with_what_the_rendered_sentence_actually_names(self) -> None:
        # The whole reason this helper is exported rather than re-derived at the call
        # site: if the two slices ever disagree, the caller resolves the wrong rows
        # and the message silently prints raw ids instead.
        path = [f"t{i}" for i in range(500)] + ["t0"]
        rendered = nodes_to_label(path)
        labels = {node: f"WBS-{node}" for node in rendered}
        message = str(InfeasibleGraphError("cyclic_dependency", path).with_labels(labels))
        for node in rendered:
            assert f"WBS-{node}" in message
        # And nothing outside that set leaked a raw id into the prose.
        assert "t3" not in message


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
