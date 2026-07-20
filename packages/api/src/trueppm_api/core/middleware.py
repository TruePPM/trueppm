"""Request-hardening middleware (#2229).

Rejects client input that PostgreSQL cannot store or compare *before* it reaches
the ORM, converting an otherwise-uncaught driver error into a clean 400.

The concrete case: a NUL byte (``0x00``) in a query param. PostgreSQL forbids
NUL bytes in ``text``/``varchar`` values, so the moment such a value is used in a
``.filter(field=value)`` the driver raises ``psycopg`` ``DataError`` ("A string
literal cannot contain NUL (0x00) characters"). That is not a DRF
``APIException``, so the project exception handler leaves it as a 500. It cannot
be salvaged in the DRF exception handler either: ``ATOMIC_REQUESTS = True`` wraps
every request in a transaction that the failed statement has already aborted, so
returning a 4xx from inside the view would only make the request-level ``COMMIT``
fail. Rejecting the request here — before the view opens that transaction — is
the only safe layer.
"""

from __future__ import annotations

from collections.abc import Callable

from django.http import HttpRequest, HttpResponse, JsonResponse

# Percent-encoding of a NUL byte is always ``%00`` (hex, no letters, so no case
# folding needed); a raw ``\x00`` can also appear in a malformed query string.
_NUL_MARKERS = ("\x00", "%00")


class RejectNullBytesMiddleware:
    """Return 400 for any ``/api/`` request whose query string carries a NUL byte.

    Scoped to the API surface so admin/static paths keep Django's own handling.
    The check is on the raw ``QUERY_STRING`` (both the literal byte and its
    ``%00`` escape), which is cheaper than materializing ``request.GET`` and
    matches exactly what Django will decode into the values the ORM receives.
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        if request.path.startswith("/api/"):
            query_string = request.META.get("QUERY_STRING", "")
            if any(marker in query_string for marker in _NUL_MARKERS):
                # DRF-shaped body so API clients get the same error envelope they
                # would for any other 400.
                return JsonResponse(
                    {"detail": "Query parameters must not contain NUL (0x00) bytes."},
                    status=400,
                )
        return self.get_response(request)
