"""DB tests for the v2 event-timeline exporter (ADR-0114 §7 / #1109).

``export_program(program, with_events=True)`` emits a v2 seed: anchor-relative
dates plus an ``events`` array reconstructed from the history tables. These tests
assert the export re-validates, reconstructs the expected event kinds, and — the
load-bearing guarantee — round-trips byte-identically (export → import → export),
while the v1 default path stays unchanged.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.projects.seed import export_program, import_seed, validate_seed
from trueppm_api.apps.projects.seed.exporter import dump_seed

from .test_replay import _retro_seed, _v2_seed

pytestmark = pytest.mark.django_db

User = get_user_model()


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="v2-exporter-owner", email="o@example.com")


def _actions(doc: dict[str, Any]) -> list[str]:
    return [e["action"] for e in doc.get("events", [])]


# --- schema + reconstruction -----------------------------------------------


def test_v2_export_emits_version_anchor_and_events(owner: Any) -> None:
    program = import_seed(_v2_seed(), owner=owner, create_users=True)
    doc = export_program(program, with_events=True)

    validate_seed(doc)  # the reconstructed document must itself be a valid seed
    assert doc["schema_version"] == "2.0"
    assert "anchor" in doc
    assert doc.get("events"), "expected a reconstructed events timeline"


def test_v1_export_is_default_and_unchanged(owner: Any) -> None:
    # Regression: the default path stays v1 final-state — no anchor, no events —
    # so the #616 byte-identical round-trip is untouched.
    program = import_seed(_v2_seed(), owner=owner, create_users=True)
    doc = export_program(program)
    assert doc["schema_version"] == "1.0"
    assert "anchor" not in doc
    assert "events" not in doc


def test_v2_export_reconstructs_status_and_comment_events(owner: Any) -> None:
    program = import_seed(_v2_seed(), owner=owner, create_users=True)
    doc = export_program(program, with_events=True)
    actions = _actions(doc)
    # The COMPLETE task's synthesized progression is reconstructed as task.status,
    # and the authored comment as task.comment.
    assert "task.status" in actions
    assert "task.comment" in actions
    # every task.status walks a real transition (COMPLETE task reaches COMPLETE)
    tos = {e.get("to") for e in doc["events"] if e["action"] == "task.status"}
    assert "COMPLETE" in tos


def test_v2_export_reconstructs_task_points_for_burned_down_task(owner: Any) -> None:
    # task:core:2 stays IN_PROGRESS with remaining_points burned 3 -> 2; that
    # value only survives replay as a task.points event (a progressing task is
    # born with remaining = story_points), so the exporter must reconstruct it.
    program = import_seed(_v2_seed(), owner=owner, create_users=True)
    doc = export_program(program, with_events=True)
    points_events = [e for e in doc["events"] if e["action"] == "task.points"]
    assert any(
        e["target"] == "task:core:2" and e.get("remaining_points") == 2 for e in points_events
    )


def test_v2_export_reconstructs_sprint_lifecycle(owner: Any) -> None:
    program = import_seed(_v2_seed(), owner=owner, create_users=True)
    doc = export_program(program, with_events=True)
    actions = _actions(doc)
    assert "sprint.activate" in actions
    assert "sprint.close" in actions
    close = next(e for e in doc["events"] if e["action"] == "sprint.close")
    assert close["goal_outcome"] == "PARTIAL"


def test_v2_export_reconstructs_pending_scope_injection(owner: Any) -> None:
    # task:core:3 is injected mid-sprint and never resolved -> PENDING, so it
    # reconstructs as a sprint.scope_inject. (task:core:4 is REJECTED and is
    # deliberately not reconstructed.)
    program = import_seed(_v2_seed(), owner=owner, create_users=True)
    doc = export_program(program, with_events=True)
    injects = [e for e in doc["events"] if e["action"] == "sprint.scope_inject"]
    assert any(e["target"] == "task:core:3" and e.get("goal_impact") for e in injects)


def test_v2_export_reconstructs_retro_actions(owner: Any) -> None:
    program = import_seed(_retro_seed(), owner=owner, create_users=True)
    doc = export_program(program, with_events=True)
    retro_events = [e for e in doc["events"] if e["action"] == "retro.action"]
    bodies = {e["body"] for e in retro_events}
    assert {"Add integration tests", "Document the auth flow"} <= bodies
    # retro.promote is not reconstructed (a promoted backlog task has no
    # wbs_path); the action item is exported as a plain retro.action.
    assert "retro.promote" not in _actions(doc)


def test_v2_export_skips_soft_deleted_retro_actions(owner: Any) -> None:
    """A removed action item (soft-deleted by a retro save, #4591) is not exported.

    Exporting it would re-import it as a live action item.
    """
    from trueppm_api.apps.projects.models import RetroActionItem

    program = import_seed(_retro_seed(), owner=owner, create_users=True)
    RetroActionItem.objects.get(
        retro__sprint__project__program=program, text="Document the auth flow"
    ).soft_delete()
    doc = export_program(program, with_events=True)
    bodies = {e["body"] for e in doc["events"] if e["action"] == "retro.action"}
    assert "Add integration tests" in bodies
    assert "Document the auth flow" not in bodies


# --- byte-deterministic round-trip -----------------------------------------


def test_v2_export_round_trip_is_byte_identical(owner: Any) -> None:
    # The #616 guarantee at v2 grain: export -> import -> export is byte-identical.
    # This is the fixpoint that keeps a shared v2 seed reproducible.
    program1 = import_seed(_v2_seed(), owner=owner, create_users=True)
    export1 = export_program(program1, with_events=True)

    # replace=True: a round trip re-imports onto the same slug, which now needs
    # explicit consent (ADR-0726). Behavior here is unchanged.
    program2 = import_seed(export1, owner=owner, create_users=True, replace=True)
    export2 = export_program(program2, with_events=True)

    assert dump_seed(export1) == dump_seed(export2)


def test_v2_export_round_trip_with_retro_is_byte_identical(owner: Any) -> None:
    program1 = import_seed(_retro_seed(), owner=owner, create_users=True)
    export1 = export_program(program1, with_events=True)

    program2 = import_seed(export1, owner=owner, create_users=True, replace=True)
    export2 = export_program(program2, with_events=True)

    assert dump_seed(export1) == dump_seed(export2)


def test_v2_round_trip_preserves_task_end_states(owner: Any) -> None:
    # The reconstructed timeline replays to the same final task states.
    from trueppm_api.apps.projects.models import Task, TaskStatus

    program1 = import_seed(_v2_seed(), owner=owner, create_users=True)
    export1 = export_program(program1, with_events=True)
    program2 = import_seed(export1, owner=owner, create_users=True, replace=True)

    def status(program: Any, wbs: str) -> str:
        return Task.objects.get(project__program=program, wbs_path=wbs).status

    assert status(program2, "1") == TaskStatus.COMPLETE
    assert status(program2, "2") == TaskStatus.IN_PROGRESS
    # remaining_points burned down to 2 survives the round-trip (task.points)
    t2 = Task.objects.get(project__program=program2, wbs_path="2")
    assert t2.remaining_points == 2
    # ...and so does the in-flight progress the replay restores (#3486). Before
    # the finalize pass a second import re-zeroed it, so percent decayed one
    # round-trip at a time while the byte-identical fixpoint still held.
    assert t2.percent_complete == 40.0
    t5 = Task.objects.get(project__program=program2, wbs_path="5")
    assert (t5.percent_complete, t5.remaining_points) == (25.0, 3)


# --- sprint-close membership round-trip (#3740) ------------------------------


def _outcome_view(program: Any) -> set[tuple[Any, ...]]:
    from trueppm_api.apps.projects.models import SprintTaskOutcome

    return {
        (
            o.sprint.name,
            o.task.name,
            str(o.disposition),
            o.next_sprint.name if o.next_sprint else None,
            o.was_pending,
            o.final_status,
        )
        for o in SprintTaskOutcome.objects.filter(
            sprint__project__program=program, task__isnull=False
        ).select_related("sprint", "task", "next_sprint")
    }


def test_reimport_restores_outcomes_for_tasks_a_close_moved_out(owner: Any) -> None:
    """Carried-to-sprint and returned-to-backlog outcome rows survive a re-import (#3740).

    Those tasks are born in their final sprint (or sprintless) on replay, so the
    live-membership snapshot cannot see them; the close event must carry them.
    """
    from datetime import timedelta

    from trueppm_api.apps.projects.models import (
        Sprint,
        SprintState,
        SprintTaskDisposition,
        SprintTaskOutcome,
        Task,
        TaskStatus,
    )

    program1 = import_seed(_v2_seed(), owner=owner, create_users=True)
    closed = Sprint.objects.get(project__program=program1, state=SprintState.COMPLETED)
    next_sprint = Sprint.objects.create(
        project=closed.project,
        name="Next",
        start_date=closed.finish_date + timedelta(days=1),
        finish_date=closed.finish_date + timedelta(days=14),
        state=SprintState.ACTIVE,
        activated_at=closed.closed_at,
    )
    tasks = list(Task.objects.filter(project=closed.project, is_deleted=False).order_by("wbs_path"))
    carried, returned = tasks[1], tasks[2]
    # What a live close with carry-over leaves behind: the task now sits in the
    # next sprint (or none) and the closed sprint keeps only the outcome snapshot.
    Task.objects.filter(pk=carried.pk).update(sprint=next_sprint)
    Task.objects.filter(pk=returned.pk).update(sprint=None, status=TaskStatus.BACKLOG)
    SprintTaskOutcome.objects.filter(sprint=closed, task__in=[carried, returned]).delete()
    SprintTaskOutcome.objects.create(
        sprint=closed,
        task=carried,
        task_short_id="T-1",
        task_title=carried.name,
        final_status=TaskStatus.IN_PROGRESS,
        disposition=SprintTaskDisposition.CARRIED,
        next_sprint=next_sprint,
        was_pending=True,
    )
    SprintTaskOutcome.objects.create(
        sprint=closed,
        task=returned,
        task_short_id="T-2",
        task_title=returned.name,
        final_status=TaskStatus.NOT_STARTED,
        disposition=SprintTaskDisposition.DROPPED,
    )
    before = _outcome_view(program1)
    assert any(row[2] == "carried" and row[3] == "Next" for row in before)

    export1 = export_program(program1, with_events=True)
    close = next(e for e in export1["events"] if e["action"] == "sprint.close")
    assert {o["disposition"] for o in close["outcomes"]} >= {"carried", "dropped"}

    program2 = import_seed(export1, owner=owner, create_users=True, replace=True)
    assert _outcome_view(program2) == before
    # The new field is part of the byte-identical fixpoint.
    assert dump_seed(export_program(program2, with_events=True)) == dump_seed(export1)
