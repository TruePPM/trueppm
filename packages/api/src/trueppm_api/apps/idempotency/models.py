"""Models for client-driven HTTP idempotency (ADR-0083).

A single model, :class:`IdempotencyKey`, stores the response to an unsafe mutation
(POST/PATCH/PUT/DELETE) that carried an ``Idempotency-Key`` header so a retry with the
same key replays the stored response instead of re-applying the write.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class IdempotencyKey(models.Model):
    """Stored response for a client-supplied ``Idempotency-Key`` on an unsafe mutation.

    Does NOT inherit ``VersionedModel`` — this is a server-side request-dedup record,
    not synced to mobile clients.

    Invariant (ADR-0083): a *committed* row is always ``status=COMPLETED``. The claim
    row is inserted (``PROCESSING``) and updated to ``COMPLETED`` inside the same
    ``ATOMIC_REQUESTS`` transaction as the mutation, so a rolled-back mutation (5xx /
    unhandled exception) leaves no row and a retry re-runs. The ``PROCESSING`` state is
    therefore only ever observed transiently *within* the originating request's open
    transaction; it serves the concurrent-duplicate blocking semantics (a second request
    with the same key blocks on the unique constraint until the first transaction ends).
    """

    class Status(models.TextChoices):
        PROCESSING = "processing", "Processing"
        COMPLETED = "completed", "Completed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="idempotency_keys",
        # The (user, key) unique constraint already indexes user_id as its left prefix,
        # so the implicit per-FK index would be redundant.
        db_index=False,
    )
    # Client-supplied key. A UUID is recommended but any opaque string is accepted;
    # uniqueness is scoped per-user so a leaked key cannot replay another user's response.
    key = models.CharField(max_length=255)
    method = models.CharField(max_length=8)
    path = models.CharField(max_length=512)
    # sha256 hex of method + path-with-query + raw body. A reused key with a different
    # request hash is rejected with 422 (idempotency_key_conflict).
    request_hash = models.CharField(max_length=64)
    status = models.CharField(
        max_length=10,
        choices=Status.choices,
        default=Status.PROCESSING,
    )
    response_status = models.SmallIntegerField(null=True, blank=True)
    response_body = models.JSONField(null=True, blank=True)
    # Safelisted response headers replayed verbatim (currently only Location).
    response_headers = models.JSONField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["user", "key"],
                name="idempotency_key_unique_per_user",
            ),
        ]
        indexes = [
            models.Index(fields=["created_at"], name="idempotency_created_idx"),
        ]

    def __str__(self) -> str:
        return f"IdempotencyKey({self.method} {self.path} {self.status})"
