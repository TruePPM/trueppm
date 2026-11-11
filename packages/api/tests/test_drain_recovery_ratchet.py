"""Ratchet: every drained durable-request table classifies every status (#2994).

#2894 fixed sprint close and #2994 found the identical shape in the workflow
outbox: a terminal-but-unsuccessful status that no sweep recovered and no reader
could observe. This test makes the next durable-request table declare, in one
place, what happens to each of its statuses. Adding a status to a registered enum
fails here until it is classified, and a table that lists an unsuccessful terminal
status as ``retried`` must carry the ``next_attempt_at`` retry clock whose
invariant ("null means no further attempt") the drains rely on.

It cannot prove the drain's filter really covers a status; the behavioral tests
beside each drain do that. It makes the omission a decision someone has to write
down rather than a thing nobody noticed.
"""

from __future__ import annotations

from django.db import models

from trueppm_api.apps.projects.models import SprintCloseRequest, SprintCloseRequestStatus
from trueppm_api.apps.workflow_engine.models import WorkflowOutboxRow, WorkflowOutboxStatus

# status value -> how the drain treats it.
#   in_progress : a live attempt (or orphan-recovered / abandoned by the drain)
#   success     : terminal and successful
#   retried     : unsuccessful, re-queued by the drain while next_attempt_at is set
_TABLES: list[tuple[type[models.Model], type[models.TextChoices], dict[str, str]]] = [
    (
        SprintCloseRequest,
        SprintCloseRequestStatus,
        {
            SprintCloseRequestStatus.PENDING.value: "in_progress",
            SprintCloseRequestStatus.IN_FLIGHT.value: "in_progress",
            SprintCloseRequestStatus.COMPLETED.value: "success",
            SprintCloseRequestStatus.FAILED.value: "retried",
        },
    ),
    (
        WorkflowOutboxRow,
        WorkflowOutboxStatus,
        {
            WorkflowOutboxStatus.PENDING.value: "in_progress",
            WorkflowOutboxStatus.DISPATCHED.value: "in_progress",
            WorkflowOutboxStatus.DONE.value: "success",
            WorkflowOutboxStatus.DEAD.value: "retried",
        },
    ),
]


def test_every_status_of_a_drained_table_is_classified() -> None:
    for model, enum, classes in _TABLES:
        assert set(classes) == {m.value for m in enum}, (
            f"{model.__name__}: a status was added or removed without deciding whether the "
            "drain recovers it, treats it as success, or abandons it (#2994)"
        )
        assert set(classes.values()) <= {"in_progress", "success", "retried"}


def test_unsuccessful_terminal_statuses_carry_a_retry_clock() -> None:
    for model, _enum, classes in _TABLES:
        if "retried" not in classes.values():
            continue
        field = model._meta.get_field("next_attempt_at")
        assert isinstance(field, models.DateTimeField) and field.null, (
            f"{model.__name__} re-queues a failed status but has no nullable "
            "next_attempt_at; 'null means no further attempt' is the terminal test"
        )
