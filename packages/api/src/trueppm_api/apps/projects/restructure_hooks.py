"""The post-commit hooks every whole-outline write shares (#3415).

``tasks_restructured`` with an empty payload means "the shape of this project's task
tree moved — refetch it", and every path that emits it also enqueues a recalculation,
because a shape change moves CPM dates. Ten call sites produce that outcome (six
structural endpoints, the MS Project / Jira / CSV importers, template apply); this
function is the shared implementation for the **two undos** that route through it, not
a description of the other eight.

It lives in its own module rather than in ``structural_operation_services`` (its first
home) so that ``template_services`` can reach it without importing a module about
StructuralOperation ledger rows — the same reason ``refusal_codes`` was split out of
``task_bulk``. Reaching across for a ``_``-prefixed helper is how the two hooks drift
apart again.

The forward paths still each carry their own copy, and ``template_tasks.apply_template``
has already drifted from this one: it calls ``enqueue_recalculate`` inline rather than on
commit. That difference is deliberate on both sides and should not be "harmonized"
without reading it. ``apply_template`` runs in a Celery task with no ambient transaction,
where inline and on-commit are the same thing. The undos run under ``ATOMIC_REQUESTS``,
where they are not: ``enqueue_recalculate`` writes its outbox row **and attempts an
immediate dispatch**, so calling it inline there would hand a worker a project whose
rows have not committed yet. Deferring trades that for a narrow window in which a crash
between commit and callback loses the ``ScheduleRequest`` row — the lesser of the two,
and the behavior the structural undo has shipped with since ADR-0880.

Both hooks are deferred to ``transaction.on_commit``. Announcing a restructure from
inside the transaction that performed it can tell every connected client about a state
that then rolls back, and there is no correcting event afterwards — the client simply
believes it. Under ``ATOMIC_REQUESTS`` that is not hypothetical: DRF's exception handler
calls ``set_rollback()`` for every ``APIException``, so anything a refusal path scheduled
is discarded. Call this only where the write has actually succeeded.
"""

from __future__ import annotations

from typing import Any

from django.db import transaction


def broadcast_tasks_restructured_and_recalc(project_id: Any) -> None:
    """Queue the ``tasks_restructured`` broadcast and a CPM recalculation, both on commit.

    Takes the project id rather than a ``Project`` so the closures capture a plain
    string: an ORM instance held across the atomic-block boundary can be stale, or
    deleted, by the time the callback fires.
    """
    from trueppm_api.apps.scheduling.services import enqueue_recalculate
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    project_id_str = str(project_id)
    transaction.on_commit(lambda: enqueue_recalculate(project_id_str))
    transaction.on_commit(lambda: broadcast_board_event(project_id_str, "tasks_restructured", {}))
