"""The refusal vocabulary the per-row bulk and structural-undo surfaces speak (#3037).

Every machine code these endpoints can put on the wire is defined here, once, and
published into ``docs/api/openapi.json`` as an ``enum`` from these members. That is
the whole point of the module: before it, the codes were string-literal constants
split across ``task_bulk`` and ``structural_operation_services`` while the schema
declared ``code`` as a bare ``"type": "string"``. A generated client therefore typed
it ``string``, and an integrator who wanted to tell "safe to retry" from "will never
succeed" had to hardcode a list read out of Python source.

Two enums rather than one, because they are two different questions asked at two
different moments. :class:`BulkRefusalCode` answers *why this row did not apply*, per
row, inside a 207 whose other rows did. :class:`StructuralUndoBlockedReason` answers
*why this ledger row cannot be reversed*, about one operation, and carries an empty
member because "no reason — it is undoable" is a real answer on that surface and not
on the other. Merging them would publish, to each caller, a set of codes their
endpoint cannot emit — which is the same failure as publishing none, pointing the
other way.

This module deliberately holds **only** the vocabulary. It imports nothing from
``task_bulk`` or ``structural_operation_services``, so both can import it without a
cycle, and neither owns it.

``TextChoices`` rather than a plain ``StrEnum``: ``.choices`` is what DRF's
``ChoiceField`` takes and what drf-spectacular reads to emit the ``enum``, and the
second element of each pair is a human label the schema surfaces. Nothing here is a
model field — the enum shape is for the serializer, not the ORM.
"""

from __future__ import annotations

from django.db import models


class BulkRefusalCode(models.TextChoices):
    """Why one row of a bulk batch was refused (``rejected``) or not applied (``skipped``).

    Emitted by ``POST /api/v1/projects/{id}/tasks/bulk/`` in ``rejected[].code``,
    ``skipped[].code`` and ``dependencies.rejected[].code`` — one serializer, one
    vocabulary, three buckets.

    **Retry semantics**, which is the distinction the schema exists to let a client
    make. Retrying the identical row is futile for :attr:`MALFORMED_ID`,
    :attr:`SELF_REFERENCE`, :attr:`CYCLIC_DEPENDENCY` and :attr:`INVALID` — the row
    itself is wrong and will be wrong again. It may succeed later for
    :attr:`UNRESOLVED_ENDPOINT` (the endpoint may exist by then), :attr:`CONFLICT`
    (a lost race) and :attr:`FORBIDDEN` (a role can be granted). :attr:`TOMBSTONED`
    and :attr:`MILESTONE_GATE` are documented no-ops rather than failures, and a
    caller that retries them is asking the same question and getting the same
    non-answer.
    """

    #: The id was not a parseable UUID (guard 1). Reported before any ORM query runs.
    MALFORMED_ID = "malformed_id", "Malformed id"

    #: The id cannot be used by this caller in this project (guard 2).
    #:
    #: Deliberately non-asserting, and it must stay that way. It covers BOTH "this id
    #: belongs to a project you cannot see" and "you may not have this id", and the
    #: caller cannot tell which — see ``row_identity.foreign_task_ids`` and #359.
    #: Splitting it into two codes to make the enum tidier would hand back the
    #: cross-project existence oracle ADR-0772 removed.
    ID_UNAVAILABLE = "id_unavailable", "Id unavailable"

    #: An update/delete named a task that is not in this project (or does not exist).
    #: Reported identically to a foreign id, for the same membership-inference reason.
    NOT_FOUND = "not_found", "Not found"

    #: The caller's role does not permit this row's operation. On a dependency row
    #: this is the Scheduler floor described by ``capabilities_denied``.
    FORBIDDEN = "forbidden", "Forbidden"

    #: The row body failed serializer validation.
    INVALID = "invalid", "Invalid"

    #: A database constraint rejected the row after validation passed.
    CONFLICT = "conflict", "Conflict"

    #: A dependency edge would close a cycle (ADR-0259 graph guard).
    CYCLIC_DEPENDENCY = "cyclic_dependency", "Cyclic dependency"

    #: A dependency edge links a task to itself.
    SELF_REFERENCE = "self_reference", "Self reference"

    #: An edge endpoint did not resolve to a live task in scope.
    UNRESOLVED_ENDPOINT = "unresolved_endpoint", "Unresolved endpoint"

    #: A create whose id matches a soft-deleted row here (guard 3). A documented no-op.
    TOMBSTONED = "tombstoned", "Tombstoned"

    #: A cascade crossed a milestone, which is a gate rather than a failure (#2723 §4).
    MILESTONE_GATE = "milestone_gate", "Milestone gate"


class StructuralUndoBlockedReason(models.TextChoices):
    """Why a structural operation cannot be undone — or that it can (ADR-0880).

    Read on two surfaces that must agree: ``undo_blocked_reason`` on every
    ``StructuralOperation`` read, and ``code`` in the ``409`` body from
    ``POST .../undo/``.

    :attr:`NONE` is the empty string and means *undoable*. It is a member rather than
    an absent field because the read surface always sends the key, and a client
    branching on this value needs "" to be in the published set — otherwise the one
    value it sees most often is the one value the schema says cannot occur.

    :attr:`SHAPE_CHANGED` is racy by construction and the list endpoint does not
    evaluate it: it can flip between a client reading the list and pressing Undo, and
    the 409 on the write is authoritative either way.
    """

    #: Undoable — no blocking reason. The empty string, on the wire and here.
    NONE = "", "Undoable"

    #: The operation has already been reversed; undoing again is a no-op, not an error.
    ALREADY_UNDONE = "already_undone", "Already undone"

    #: The affected region was too large to record a reversal for.
    TOO_LARGE = "too_large", "Region too large to reverse"

    #: A more recent operation sits above this one; undo that first.
    NOT_TOP_OF_STACK = "not_top_of_stack", "Not top of stack"

    #: The outline changed inside the affected region since the operation ran.
    SHAPE_CHANGED = "shape_changed", "Outline changed since"

    #: This caller may not undo this operation. Shares its wire value with
    #: :attr:`BulkRefusalCode.FORBIDDEN` deliberately — one word for one meaning
    #: across both surfaces.
    FORBIDDEN = "forbidden", "Forbidden"


#: The capability name reported in ``capabilities_denied`` when a batch's dependency
#: edges are refused for role reasons (#3037 facet B).
#:
#: Named after the request bucket it governs (``dependencies``) rather than after the
#: role that would satisfy it, so a client keys on the thing it sent rather than on
#: TruePPM's role vocabulary — which is exactly the knowledge the caller was being
#: asked to already have.
CAPABILITY_DEPENDENCIES = "dependencies"
