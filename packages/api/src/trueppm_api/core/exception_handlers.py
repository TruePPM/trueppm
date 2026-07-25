"""Project-wide DRF exception handler.

The single custom ``EXCEPTION_HANDLER`` DRF invokes for every unhandled
exception raised inside a view. It translates non-``APIException`` failures that
DRF's stock handler would return as HTTP 500 into the clean 4xx they actually are.

Two families are handled. First, the two failure modes a malformed UUID produces
(#2125):

* ``uuid.UUID("<garbage>")`` raises ``ValueError("badly formed hexadecimal UUID
  string")``; and
* filtering a queryset on a ``UUIDField`` with a non-UUID value raises Django's
  ``django.core.exceptions.ValidationError`` ("... is not a valid UUID").

Neither is a subclass of DRF's ``APIException``, so DRF's default handler returns
``None`` for them and the request bubbles up as a 500. This fired on essentially
every endpoint that reads a UUID from a *nested* path segment (``project_pk`` in
``/projects/<project_pk>/labels/``), a custom action (which uses Django's
``get_object_or_404`` — that shortcut, unlike DRF's, does not catch
``ValidationError``), or a query/filter param (``/tasks/?project=<garbage>``).
Plain DRF detail routes were already safe because ``GenericAPIView.get_object``
routes through DRF's ``get_object_or_404``, which does catch these.

A single handler is the smallest-blast-radius systemic fix: it covers router
routes, hand-registered nested routes, and query params at once, without editing
~20 url modules or risking the non-UUID lookup routes (share tokens, etc.).

Second, ``ProtectedError`` from a delete blocked by an ``on_delete=PROTECT``
foreign key (#2364). The refusal is correct — a live schedule must not lose the
calendar it was computed against — but reporting it as a server error is not; it
is a 409. This is a **net, not the primary guard**: endpoints where the caller can
act on the blocker list catch ``ProtectedError`` themselves and return the richer
``reference_count``/``references`` body from
:mod:`trueppm_api.core.protect_conflict`. The net exists because the same bug was
found three times — a delete path written against the FKs that existed at the
time, silently rotting as new ``PROTECT`` FKs landed. It guarantees the next one
is a 409 rather than a 500 even if nobody remembers to update the view.
"""

from __future__ import annotations

import uuid
from typing import Any

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import ProtectedError
from rest_framework.exceptions import NotFound
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler

from trueppm_api.core.protect_conflict import protected_error_response

#: Generic refusal for a ``PROTECT``-ed delete no view claimed. Deliberately does
#: not name the referencing model — the net fires on paths that have not decided
#: how to describe their blockers, and leaking an internal model name reads as an
#: implementation detail rather than something the caller can act on.
_PROTECTED_DELETE_DETAIL = "This item is still referenced by other records and cannot be deleted."

# Stable substrings emitted by the two malformed-UUID code paths. Matching on the
# message keeps the handler narrowly scoped to genuine UUID-coercion failures, so
# an unrelated ``ValueError``/``ValidationError`` still falls through to the
# default 500 rather than being silently reclassified as client error.
_UUID_ERROR_MARKERS = (
    "is not a valid uuid",  # django.db.models.UUIDField.to_python
    "badly formed hexadecimal uuid",  # uuid.UUID(<garbage>)
)


def _is_malformed_uuid_error(exc: Exception) -> bool:
    """Return True when *exc* is Django/stdlib's malformed-UUID failure."""
    if isinstance(exc, DjangoValidationError):
        message = " ".join(exc.messages)
    elif isinstance(exc, ValueError):
        message = str(exc)
    else:
        return False
    message = message.lower()
    return any(marker in message for marker in _UUID_ERROR_MARKERS)


def _path_has_malformed_uuid(context: dict[str, Any]) -> bool:
    """Return True when a captured URL path kwarg is not a parseable UUID.

    A malformed UUID in the *path* addresses an object that cannot exist, so 404
    is the correct status (parity with DRF's own ``DoesNotExist`` -> 404). A
    malformed UUID that is *not* in the path came from a query/filter param — bad
    client input — and maps to 400. We only reach this check for a genuine
    UUID-coercion error, so a non-UUID path segment (e.g. a share ``token``) never
    trips it: those routes never coerce the segment to a UUID in the first place.
    """
    for value in (context.get("kwargs") or {}).values():
        if not isinstance(value, str):
            continue
        try:
            uuid.UUID(value)
        except (ValueError, AttributeError, TypeError):
            return True
    return False


def trueppm_exception_handler(exc: Exception, context: dict[str, Any]) -> Response | None:
    """Map malformed-UUID failures to 404/400 and PROTECT-ed deletes to 409.

    Delegates everything else to DRF's default handler unchanged.
    """
    if _is_malformed_uuid_error(exc):
        exc = NotFound() if _path_has_malformed_uuid(context) else DRFValidationError()
    elif isinstance(exc, ProtectedError):
        return protected_error_response(
            exc.protected_objects,
            detail=_PROTECTED_DELETE_DETAIL,
            code="protected_reference",
        )
    return drf_exception_handler(exc, context)
