"""Shared rendering for ``PROTECT``-ed delete refusals (#2364).

Django raises :class:`~django.db.models.ProtectedError` when a ``DELETE`` would
orphan rows behind an ``on_delete=PROTECT`` foreign key. It is not an
``APIException``, so DRF's stock handler returns ``None`` for it and the request
escapes as an unhandled **500** — a server error for what is really a
well-formed, authorized request that conflicts with current state. **409** is the
honest status.

Two layers use this module, and the split is deliberate:

* :func:`protected_error_response` builds the *rich* body — a
  ``reference_count`` plus a bounded ``references`` sample naming what still
  points at the row — for the endpoints where a client can realistically act on
  the list (detach the calendar, retag the resource). Views opt in per-endpoint
  because only the view knows how to name a blocker usefully.
* :func:`trueppm_exception_handler` falls back to a generic, **count-only** 409 for
  every other ``PROTECT``-ed delete. That net is what stops the *next* ``PROTECT``
  FK from reintroducing the 500 — the failure mode that produced this module, where
  a delete path written against the FKs that existed at the time silently rotted as
  new ones landed. It never names rows: it fires on paths that have not reasoned
  about their permission gate at all, so it cannot know whether the caller is
  authorized to see them.

Responses are *returned*, never raised as an ``APIException``: DRF coerces every
value in an exception ``detail`` to ``ErrorDetail`` (a ``str`` subclass), which
would ship ``reference_count`` as ``"3"`` instead of ``3``. That is safe because
``ProtectedError`` is raised while the collector walks the FKs, *before* any
DELETE is issued — there is no partial state for ``ATOMIC_REQUESTS`` to roll back.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable

from django.db import models
from rest_framework import status
from rest_framework.response import Response

#: Cap on the referencing rows echoed back on a 409. A shared library row can be
#: referenced by hundreds of others; the client needs enough to name the blockers,
#: not the whole set.
REFERENCE_SAMPLE_SIZE = 10


def describe_reference(obj: models.Model) -> dict[str, str]:
    """Render one ``PROTECT``-ing row as a ``{type, id, name}`` entry.

    The default shape for any blocker a user can recognize by name. Views pass a
    custom callable to :func:`protected_error_response` when the blocker is a join
    row the user never sees and the actionable object is its parent.
    """
    return {
        "type": obj._meta.model_name or "",
        "id": str(obj.pk),
        "name": str(getattr(obj, "name", "") or obj._meta.verbose_name),
    }


def protected_error_response(
    protected_objects: Iterable[models.Model],
    *,
    detail: str,
    code: str,
    describe: Callable[[models.Model], dict[str, str]] | None = None,
) -> Response:
    """Build the 409 body for a refused delete.

    ``describe`` is **opt-in on purpose**: naming the blocking rows discloses data,
    and only the endpoint knows whether its permission gate authorizes the caller to
    see those names. Omitting it returns the count alone — always safe, because a
    caller who just tried the delete already knows the row exists, and a bare count
    reveals nothing about *what* references it.

    Args:
        protected_objects: ``ProtectedError.protected_objects`` — the rows whose
            ``PROTECT`` foreign keys blocked the delete.
        detail: Human-readable refusal, shown to the user as-is.
        code: Stable machine-readable slug the client branches on.
        describe: Renders one blocker. Pass one only after confirming the endpoint's
            permission gate authorizes the caller to see every name it can emit —
            and have it drop or redact rows the caller cannot see. Omit to return
            ``reference_count`` with no ``references`` key at all.

    Returns:
        A ``409`` response carrying ``detail``, ``code`` and an integer
        ``reference_count``, plus — when ``describe`` is given — a ``references``
        sample capped at :data:`REFERENCE_SAMPLE_SIZE`.
    """
    # Sort before sampling so the truncated list is deterministic — an arbitrary
    # 10-of-200 that reshuffles per request makes the refusal impossible to act on.
    blockers = sorted(protected_objects, key=lambda o: (o._meta.model_name or "", str(o.pk)))
    body: dict[str, object] = {
        "detail": detail,
        "code": code,
        "reference_count": len(blockers),
    }
    if describe is not None:
        body["references"] = [describe(o) for o in blockers[:REFERENCE_SAMPLE_SIZE]]
    return Response(body, status=status.HTTP_409_CONFLICT)
