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
"""

from __future__ import annotations

from typing import Any

from rest_framework import status
from rest_framework.exceptions import APIException
from rest_framework.request import Request


class InvalidRequestBody(APIException):
    """400 for a JSON body that parsed fine but is not an object.

    A dedicated exception rather than ``ValidationError`` so the response is the
    flat ``{"detail": ...}`` the existing hand-written guards already return
    (``projects/views.py`` reparent, group/ungroup) — ``ValidationError`` would
    wrap the message in a list under a field key and describe a field problem,
    which this is not.
    """

    status_code = status.HTTP_400_BAD_REQUEST
    default_detail = "Request body must be a JSON object."
    default_code = "invalid_body"


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
