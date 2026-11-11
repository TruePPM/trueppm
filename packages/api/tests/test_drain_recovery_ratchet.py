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

The candidate set is DISCOVERED, not hand-listed: every installed model with a
``status`` choices field and an ``attempt_count`` or ``dispatched_at`` column is
a durable-request table, and must be either classified in ``_TABLES`` or named
in ``_EXEMPT`` with the reason its unsuccessful terminal status is safe. A new
table of that shape fails here until someone makes that call.
"""

from __future__ import annotations

from django.apps import apps
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


# Tables of the drained shape whose unsuccessful terminal status is safe without
# a retry clock. Seeded from the #2994 sweep (18 request/job/run models checked,
# 16 cleared); these are the cleared ones the discovery rule above matches.
_EXEMPT: dict[str, str] = {
    "projects.ConfigNoticeRequest": (
        "drain recovers stale claims by age and abandons to DEAD only once "
        "attempt_count spends MAX_CONFIG_NOTICE_ATTEMPTS"
    ),
    "scheduling.ScheduleRequest": (
        "DEAD is a deterministic recalc failure; the next edit enqueues a fresh request"
    ),
    "msproject.ImportRequest": (
        "DEAD is a deterministically bad file; the user resubmits, nothing is stranded"
    ),
    "jiraimport.JiraImportRequest": (
        "DEAD is a deterministically bad file; the user resubmits, nothing is stranded"
    ),
    "csvimport.CsvImportRequest": (
        "DEAD/UNDONE end a user-driven import; resubmission is unblocked"
    ),
    "webhooks.WebhookDelivery": (
        "FAILED is reached only after the task's own bounded Celery broker retries"
    ),
    "integrations.ExternalSyncRequest": (
        "DEAD ends a one-way pull; the next scheduled sync enqueues a fresh request"
    ),
}


def _discovered_tables() -> set[str]:
    found: set[str] = set()
    for model in apps.get_models():
        names = {f.name for f in model._meta.concrete_fields}
        status = next(
            (f for f in model._meta.concrete_fields if f.name == "status" and f.choices),
            None,
        )
        if status is not None and names & {"attempt_count", "dispatched_at"}:
            found.add(model._meta.label)
    return found


def test_every_drained_shape_table_is_classified_or_exempt() -> None:
    classified = {model._meta.label for model, _enum, _classes in _TABLES}
    assert not classified & set(_EXEMPT), "a table is both classified and exempt"
    unaccounted = _discovered_tables() - classified - set(_EXEMPT)
    assert not unaccounted, (
        f"{sorted(unaccounted)} look like drained durable-request tables (status + "
        "attempt_count/dispatched_at). Classify each status in _TABLES, or add it to "
        "_EXEMPT with the reason its failure state cannot strand work (#2994)"
    )
    stale = set(_EXEMPT) - _discovered_tables()
    assert not stale, f"{sorted(stale)} no longer match the drained shape; drop the exemption"


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
