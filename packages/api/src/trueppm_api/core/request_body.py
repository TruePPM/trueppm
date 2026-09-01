"""Narrowing helpers for a JSON request body that has to be an object.

DRF types ``Request.data`` as ``dict[str, Any] | list[Any]`` because a JSON body
may legitimately be a top-level array. An endpoint that reads *named* fields off
it therefore has to establish that the body is an object **before** the first
``.get(...)`` or ``[...]`` — a ``list`` has neither, so reaching for one raises
``AttributeError``/``TypeError`` and DRF returns a **500**, not the 400 the
caller is owed.

That is the #2795 class, and its defining trait is that the value-type guards
these endpoints already carry (``if not isinstance(presenter, str)``) sit
*downstream* of the container access that already blew up, so they never run.
The container check has to come first, and it has to come before any write.

Use :func:`object_body` at the top of any handler that reads named fields. Where
a non-object body is genuinely unreachable — a view whose ``parser_classes`` are
multipart-only, or one whose envelope serializer has already rejected a
non-mapping — narrow with a ``cast`` and say *why* in a comment instead; a guard
that can never fire is untestable and reads as protection that is not there.

Note the neighbour with the opposite rule: ``_task_body_mapping()`` in
``apps/projects/views.py`` coerces a non-mapping to ``{}`` rather than refusing
it. That is safe only because a ``ModelSerializer`` has already rejected non-dicts
at both its call sites — do not copy the pattern to a handler that reads
``request.data`` first.
"""

from __future__ import annotations

from typing import Any

from rest_framework import status
from rest_framework.exceptions import APIException
from rest_framework.request import Request

#: The one body every non-object refusal puts on the wire (#3281).
#:
#: A **dict** ``default_detail``, not a string, and that is the whole mechanism:
#: DRF's handler passes a ``dict``/``list`` detail through verbatim and only wraps
#: a *string* one as ``{"detail": ...}``. A string here therefore drops
#: ``default_code`` on the floor — it stays on the ``ErrorDetail`` object and the
#: client never sees it, which is exactly what #3278 shipped and what left one
#: refusal speaking three different bodies.
INVALID_BODY_DETAIL = "Request body must be a JSON object."
INVALID_BODY_CODE = "invalid_body"


class InvalidRequestBody(APIException):
    """400 for a JSON body that parsed fine but is not an object.

    A dedicated exception rather than ``ValidationError``: the latter would wrap
    the message in a list under a field key and describe a *field* problem, and
    this is a problem with the envelope — no field is at fault.

    Shape 2 (``docs/api/errors.md``) — ``{"code", "detail"}`` — because the page
    reserves the ``code`` for failures a client is expected to *handle*
    differently rather than merely report, and a body the caller constructed
    wrongly is a bug in its request construction, not a rejected field value.

    Converging **upward** is what makes this non-breaking: ``detail`` is still
    present everywhere it already was, so no client that reads it breaks, and the
    group/ungroup guard that already emitted ``code`` is byte-identical. Stripping
    ``code`` to match the other two would have been the client-visible direction.
    """

    status_code = status.HTTP_400_BAD_REQUEST
    default_detail = {"code": INVALID_BODY_CODE, "detail": INVALID_BODY_DETAIL}  # noqa: RUF012
    default_code = INVALID_BODY_CODE


def object_body(request: Request) -> dict[str, Any]:
    """Return the request body as a mapping, or raise :class:`InvalidRequestBody`.

    Args:
        request: The DRF request whose parsed body is being read.

    Returns:
        The parsed body, narrowed to ``dict[str, Any]``.

    Raises:
        InvalidRequestBody: The body parsed to a list or other non-mapping.
    """
    data = request.data
    if not isinstance(data, dict):
        raise InvalidRequestBody
    return data
