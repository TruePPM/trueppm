"""Data model for external integrations (ADR-0049 §3).

In 0.2 this module owns only ``IntegrationCredential`` — per-user PAT storage
that the User → Settings → Connected Accounts page (#587) lists and the
git-aware task follow-up (#637) will consume for status fetches. ``TaskLink``
ships with #637; the credentials table is independent of it.

Sync note: ``IntegrationCredential`` does **not** inherit ``VersionedModel``.
PATs are intentionally not synced to the mobile client — they live only on
the server and are never serialized back to any client, including the
authenticated owner. ADR-0049 §3 ("never returned to the client") is the
constraint that drives this choice.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models

from .encryption import encrypt_secret
from .registry import TASK_LINK_PROVIDERS


class IntegrationCredential(models.Model):
    """A user's encrypted PAT for one integration provider (ADR-0049 §3).

    The ``provider`` field is a free-form ``CharField`` validated against
    ``TASK_LINK_PROVIDERS.keys()`` at write time so Enterprise can register
    additional providers (``jira``, ``servicenow``, ``bitbucket``,
    ``azure_devops``) without an OSS migration. ``secret_ciphertext`` is
    Fernet-encrypted with ``settings.INTEGRATION_ENCRYPTION_KEY`` and is
    **never** returned to any client — the serializer exposes only an
    ``exists`` flag, the ``base_url``, and timestamps.

    The ``(user, provider)`` pair is unique: each user has at most one
    credential per provider. Connecting a second time rotates the secret
    via update-or-create rather than appending a row, which keeps the
    credentials list a flat one-per-provider read on the page.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="integration_credentials",
    )
    provider = models.CharField(max_length=32)
    # Encrypted PAT — Fernet-encrypted bytes blob, never returned to clients.
    secret_ciphertext = models.BinaryField()
    # Self-hosted GitLab / GitHub Enterprise base URL. Empty string for
    # gitlab.com / github.com so we can distinguish "not provided" from
    # "explicitly cleared" without making the column NULL-able.
    base_url = models.CharField(max_length=512, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    # Stamped by the git-aware tasks refresh endpoint when the credential
    # was last used to fetch link metadata (#637). Null until then.
    last_used_at = models.DateTimeField(null=True, blank=True)
    # Optional expiration the user can record so the UI can warn before a
    # PAT lapses. Not enforced server-side — PAT validity is enforced by
    # the upstream provider — this is purely a UX hint.
    expires_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            # The unique constraint creates an implicit btree on
            # ``(user, provider)`` in that column order — Postgres uses it
            # for the per-user list lookups too. An explicit ``models.Index``
            # would be a redundant copy that doubles write cost.
            models.UniqueConstraint(
                fields=("user", "provider"),
                name="integrations_credential_unique_per_user_provider",
            )
        ]
        ordering = ("provider",)
        verbose_name = "Integration credential"
        verbose_name_plural = "Integration credentials"

    def __str__(self) -> str:  # pragma: no cover — debugging aid only
        return f"{self.provider} for user {self.user_id}"

    @classmethod
    def upsert(
        cls,
        *,
        user: object,
        provider: str,
        secret: str,
        base_url: str = "",
        expires_at: object | None = None,
    ) -> IntegrationCredential:
        """Encrypt and store a PAT, replacing any existing row for the pair.

        Connect and rotate are the same operation — both produce one row
        per ``(user, provider)`` — so callers don't need to branch on
        whether a row already exists. The plaintext ``secret`` is encrypted
        before the row touches the database.

        Raises:
            ValueError: If ``provider`` is not registered in
                ``TASK_LINK_PROVIDERS``. Validation happens here rather
                than in the serializer so the model is the single source
                of truth for the provider-validation rule.
        """
        if TASK_LINK_PROVIDERS.get(provider) is None:
            raise ValueError(
                f"Unknown provider {provider!r}. Known: {', '.join(TASK_LINK_PROVIDERS.keys())}"
            )
        ciphertext = encrypt_secret(secret)
        obj, _ = cls.objects.update_or_create(
            user=user,
            provider=provider,
            defaults={
                "secret_ciphertext": ciphertext,
                "base_url": base_url or "",
                "expires_at": expires_at,
            },
        )
        return obj
