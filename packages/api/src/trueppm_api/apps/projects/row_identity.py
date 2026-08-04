"""Shared guards for client-minted task row ids (ADR-0772 §Security).

Accepting a caller-supplied primary key is a trust-boundary change, and it is
guarded in exactly four places. Those guards were written first for the offline
sync push (``apps/sync/upload.py``) and are now also required by the Designer's
batch endpoint (``TaskBulkView``, #2723). They live here so there is **one**
implementation rather than two that drift — ADR-0743 §4 is the standing rule, and
the reason it exists is that enforcement drifted apart before precisely by being
re-stated in one place and not the other.

The two callers differ in how they *report* a failed guard, not in what the guard
decides:

- ``sync.upload`` aborts the whole batch (409 ``SyncIdCollision``, or a skip).
- ``TaskBulkView`` rejects the single row and applies the rest (207).

So this module answers questions and never raises a surface-specific exception.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Project, Task


def parse_row_uuid(raw: Any) -> uuid.UUID | None:
    """Return ``raw`` as a UUID, or ``None`` if it is not one.

    Guard 1 — well-formedness, and it runs **before any ORM query**. This is not
    cosmetic: an unparseable id reaching ``Task.objects.filter(pk__in=…)`` raises a
    Django-core ``ValidationError``/``ValueError`` at query-build time that DRF does
    not catch, which surfaces as a 500 rather than a 400 (#1730).

    Accepts any parseable UUID version. Rejecting non-v4 was considered and declined
    in ADR-0772: version bits are self-asserted by the caller and therefore prove
    nothing, project scope is the real boundary, and enforcing it here would diverge
    from the sync path for no security gain.
    """
    if raw is None:
        return None
    if isinstance(raw, uuid.UUID):
        return raw
    try:
        return uuid.UUID(str(raw))
    except (ValueError, AttributeError, TypeError):
        return None


def fetch_project_scoped_tasks(row_ids: set[str], project: Project) -> dict[str, Task]:
    """Bulk-fetch every row the batch references, scoped to ``project``.

    Guard 2, first half — the IDOR guard (#887). The scoping is the security
    property: the created-bucket upsert treats a hit as an idempotent re-create and
    applies content after a role check on the **URL-scoped** project. If this lookup
    were unscoped, a caller could mint an id colliding with a task in a project they
    cannot see and mutate it using their role *here* rather than their (possibly
    absent) role *there*.

    Keyed by ``str(pk)`` because ``in_bulk()``'s UUID keys will not match the string
    ids in a JSON payload. One query, so a large batch is not N round-trips (#809).
    """
    from trueppm_api.apps.projects.models import Task

    if not row_ids:
        return {}
    return {str(t.pk): t for t in Task.objects.filter(pk__in=row_ids, project=project)}


def foreign_task_ids(
    candidate_ids: set[str], existing_by_id: dict[str, Task], project: Project
) -> set[str]:
    """Of ``candidate_ids``, those that resolve to a task in a **different** project.

    Guard 2, second half. Only ids absent from the project-scoped fetch can be
    foreign, so probe just those — an all-local batch issues no extra query at all.

    Callers must report a hit **without asserting that the id exists elsewhere**.
    ``TaskBulkView`` uses a non-asserting ``id_unavailable`` rather than an
    ``id_collision``: a code meaning *this id exists in a project you cannot see* is
    an existence oracle, and under per-row 207 a caller learns N bits per request
    instead of the one bit the whole-request sync abort leaks. #359 (closed,
    ``security``) was decided on exactly those grounds — a foreign UUID must be
    indistinguishable from a permission failure. The remedy is *mint a new UUID and
    retry* either way, so the distinction was never actionable.
    """
    from trueppm_api.apps.projects.models import Task

    if not candidate_ids:
        return set()
    unknown_ids = candidate_ids - set(existing_by_id)
    if not unknown_ids:
        return set()
    return {
        str(pk)
        for pk in Task.objects.filter(pk__in=unknown_ids)
        .exclude(project=project)
        .values_list("pk", flat=True)
    }


def is_tombstoned(existing: Task | None) -> bool:
    """Whether an existing row is a soft-deleted tombstone.

    Guard 3. A create whose id matches a tombstone is **skipped** — not applied, not
    rejected, no ``server_version`` bump, no broadcast (#1730). ``is_deleted`` is not
    writable so the row could never be resurrected even without this guard; the guard
    exists so the re-create branch does not run a full serializer save on a dead row
    and emit a spurious ``task_updated``.
    """
    return existing is not None and bool(existing.is_deleted)
