"""DRF dispatch-layer idempotency mixin (ADR-0083).

The hook lives at the DRF dispatch layer rather than in Django middleware because
``ATOMIC_REQUESTS = True``: the per-request transaction wraps only the view call, so a
Django ``process_response`` middleware runs *outside* it and cannot store the response
row atomically with the mutation. ``initial()`` and ``finalize_response()`` both run
inside that transaction and after authentication, which is exactly what we need.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from django.conf import settings
from django.db import IntegrityError, connection, transaction
from rest_framework.exceptions import APIException, ValidationError
from rest_framework.request import Request
from rest_framework.response import Response

from trueppm_api.apps.idempotency.models import IdempotencyKey

logger = logging.getLogger(__name__)

UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
HEADER = "Idempotency-Key"
# Headers replayed verbatim on a cache hit. Kept minimal on purpose.
SAFELISTED_RESPONSE_HEADERS = ("Location",)
DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024  # 1 MiB
MAX_KEY_LENGTH = 255  # matches IdempotencyKey.key max_length

# Sentinel: response is not replayable (5xx, streaming, non-JSON, or oversized).
_NOT_STORABLE = object()


class IdempotencyConflict(APIException):
    """Raised when a key is reused with a different request hash."""

    status_code = 422
    default_detail = "Idempotency-Key was reused with a different request."
    default_code = "idempotency_key_conflict"


class _IdempotentReplay(Exception):
    """Internal control-flow signal: replay a stored response instead of running the view."""

    def __init__(self, row: IdempotencyKey) -> None:
        self.row = row
        super().__init__("idempotent replay")


class IdempotencyMixin:
    """Adds ``Idempotency-Key`` replay/store semantics to a DRF view.

    Apply by inheriting before the DRF base (so its ``initial`` /
    ``finalize_response`` / ``handle_exception`` overrides precede ``APIView`` in the
    MRO). Set ``idempotency_exempt = True`` to opt a view out (auth/token endpoints,
    already-deduped outbox entrypoints, streaming/export views).
    """

    idempotency_exempt: bool = False

    def initial(self, request: Request, *args: Any, **kwargs: Any) -> None:
        # Run authentication/throttling/negotiation first so request.user is resolved.
        super().initial(request, *args, **kwargs)  # type: ignore[misc]

        self._idempotency_row: IdempotencyKey | None = None

        if self.idempotency_exempt or request.method not in UNSAFE_METHODS:
            return
        key = request.headers.get(HEADER)
        if not key:
            return  # opt-in: no header is a no-op, preserving prior behavior
        user = getattr(request, "user", None)
        if user is None or not user.is_authenticated:
            return
        if len(key) > MAX_KEY_LENGTH:
            raise ValidationError(
                {HEADER: f"Idempotency-Key must be {MAX_KEY_LENGTH} characters or fewer."}
            )
        # Requests larger than the body cap aren't idempotency-protected — skip rather than
        # buffer+hash a very large body. They run normally (no claim stored).
        try:
            content_length = int(request.META.get("CONTENT_LENGTH") or 0)
        except (TypeError, ValueError):
            content_length = 0
        max_bytes = getattr(settings, "IDEMPOTENCY_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES)
        if content_length > max_bytes:
            return

        request_hash = self._compute_request_hash(request)

        existing = IdempotencyKey.objects.filter(user=user, key=key).first()
        if existing is not None:
            self._resolve_existing(existing, request_hash)
            return

        # Miss → insert a claim row inside a savepoint so a concurrent-duplicate
        # IntegrityError can be caught without poisoning the outer request transaction.
        try:
            with transaction.atomic():
                self._idempotency_row = IdempotencyKey.objects.create(
                    user=user,
                    key=key,
                    method=request.method,
                    path=request.path[:512],
                    request_hash=request_hash,
                    status=IdempotencyKey.Status.PROCESSING,
                )
        except IntegrityError:
            # A concurrent request claimed (user, key) first. Its INSERT blocked ours on
            # the unique constraint until it committed; re-read the winner and replay.
            winner = IdempotencyKey.objects.filter(user=user, key=key).first()
            if winner is None:
                # Winner rolled back (its mutation failed) after releasing the lock.
                # Proceed without idempotency rather than failing the legitimate request.
                return
            self._resolve_existing(winner, request_hash)

    def _resolve_existing(self, row: IdempotencyKey, request_hash: str) -> None:
        """Replay a completed row, or raise 422 on a hash mismatch."""
        if row.request_hash != request_hash:
            raise IdempotencyConflict()
        # A committed row is always COMPLETED (see model invariant); replay it.
        raise _IdempotentReplay(row)

    def handle_exception(self, exc: Exception) -> Response:
        if isinstance(exc, _IdempotentReplay):
            row = exc.row
            response = Response(row.response_body, status=row.response_status)
            # Re-apply the safelist on replay (defense in depth — never trust the stored
            # dict to contain only safe headers).
            for name, value in (row.response_headers or {}).items():
                if name in SAFELISTED_RESPONSE_HEADERS:
                    response[name] = value
            response["Idempotent-Replay"] = "true"
            return response
        return super().handle_exception(exc)  # type: ignore[misc,no-any-return]

    def finalize_response(
        self, request: Request, response: Response, *args: Any, **kwargs: Any
    ) -> Response:
        response = super().finalize_response(request, response, *args, **kwargs)  # type: ignore[misc]
        row = getattr(self, "_idempotency_row", None)
        if row is None:
            return response

        # DRF's exception_handler calls set_rollback() for handled 4xx/5xx, marking the
        # whole ATOMIC_REQUESTS transaction (including our claim row) for rollback. We must
        # not query a broken transaction, and the claim is discarded with it — so a retry
        # re-runs, which is correct for deterministic errors. Skip persistence entirely.
        if connection.get_rollback():
            return response

        body = self._storable_body(response)
        if body is _NOT_STORABLE:
            # Non-storable (5xx, streaming, oversized): don't consume the key — delete
            # the claim so a retry re-runs. Same transaction, so this is atomic too.
            row.delete()
            return response

        row.status = IdempotencyKey.Status.COMPLETED
        row.response_status = response.status_code
        row.response_body = body
        headers = {
            name: response[name]
            for name in SAFELISTED_RESPONSE_HEADERS
            if response.has_header(name)
        }
        row.response_headers = headers or None
        row.save(
            update_fields=[
                "status",
                "response_status",
                "response_body",
                "response_headers",
            ]
        )
        return response

    def _storable_body(self, response: Response) -> Any:
        """Return JSON-native body to store, or ``_NOT_STORABLE``.

        Stores the DRF-rendered JSON round-tripped through ``json.loads`` rather than raw
        ``response.data`` — the latter may hold dates/Decimals/UUIDs that the default
        JSONField encoder cannot serialize.
        """
        # Never cache server errors — they propagate/roll back and must stay retryable.
        if response.status_code >= 500:
            return _NOT_STORABLE
        if not hasattr(response, "data"):
            return _NOT_STORABLE
        from rest_framework.renderers import JSONRenderer

        try:
            rendered = JSONRenderer().render(response.data)
        except (TypeError, ValueError):
            return _NOT_STORABLE
        max_bytes = getattr(settings, "IDEMPOTENCY_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES)
        if len(rendered) > max_bytes:
            return _NOT_STORABLE
        if not rendered:
            return None  # e.g. 204 No Content — DRF renders None as empty bytes
        return json.loads(rendered)

    @staticmethod
    def _compute_request_hash(request: Request) -> str:
        """sha256 of method + full path (with query) + raw body.

        Read ``request.body`` here in ``initial()`` — before the handler accesses
        ``request.data`` — so Django buffers the raw bytes and the view can still parse
        the body downstream.
        """
        try:
            body = request.body
        except Exception:
            body = b""
        hasher = hashlib.sha256()
        hasher.update((request.method or "").encode("utf-8"))
        hasher.update(b"\n")
        hasher.update(request.get_full_path().encode("utf-8"))
        hasher.update(b"\n")
        hasher.update(body)
        return hasher.hexdigest()
