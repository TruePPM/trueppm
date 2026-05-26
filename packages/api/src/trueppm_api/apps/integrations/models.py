"""Data model for external integrations (ADR-0049 §3).

This module owns two tables:

- ``IntegrationCredential`` — per-user PAT storage that the User → Settings →
  Connected Accounts page (#587) lists and ``TaskLink`` refresh consumes.
- ``TaskLink`` (#637) — a GitLab/GitHub/generic URL attached to a task, with a
  cached status (open / draft / merged / closed / unknown) refreshed on demand.

Sync note: ``IntegrationCredential`` does **not** inherit ``VersionedModel`` —
PATs are intentionally never synced to (or serialized back to) any client,
including the owner (ADR-0049 §3). ``TaskLink`` **does** inherit
``VersionedModel`` for offline-sync parity with ``Task``, so link adds/removes
and status changes reach the mobile client through the project sync delta.
"""

from __future__ import annotations

import uuid
from typing import Any, ClassVar

from django.conf import settings
from django.db import models

from trueppm_api.apps.projects.models import VersionedModel

from .encryption import encrypt_secret
from .registry import LINK_STATUS_CHOICES, LINK_STATUS_UNKNOWN, TASK_LINK_PROVIDERS


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


class TaskLink(VersionedModel):
    """A GitLab/GitHub/generic URL attached to a task (ADR-0049 §3, #637).

    Inherits ``VersionedModel`` (UUID PK, ``server_version``, ``is_deleted``,
    ``deleted_version``) so link adds/removes and status changes flow to the
    mobile client through the project sync delta, exactly like ``Task`` and
    ``Dependency``.

    ``provider`` is a free-form ``CharField`` validated against
    ``TASK_LINK_PROVIDERS.keys()`` at write time (Enterprise can register
    ``jira``/``bitbucket``/… without an OSS migration). ``status`` is a cached
    classification refreshed on demand via the provider's API — there is **no**
    background polling; it goes stale until the user (or mobile) hits refresh,
    which is why ``fetched_at`` is surfaced so the UI can show "as of …".
    """

    # Explicit default manager. The django-stubs plugin does not inject the
    # implicit ``objects`` manager for this model (a cross-app abstract-base
    # quirk: ``VersionedModel`` lives in ``projects``), so we declare it so
    # ``TaskLink.objects`` type-checks. Runtime behavior is identical to the
    # implicit default manager.
    objects: ClassVar[models.Manager[TaskLink]] = models.Manager()

    task = models.ForeignKey(
        "projects.Task",
        on_delete=models.CASCADE,
        related_name="links",
    )
    url = models.URLField(max_length=2048)
    # Validated against TASK_LINK_PROVIDERS at write time (see clean()); not a
    # DB-level choices constraint so Enterprise providers need no OSS migration.
    provider = models.CharField(max_length=32)
    # Human title the provider reported (PR/MR/issue title). Blank until the
    # first successful refresh; the UI falls back to the URL.
    title = models.CharField(max_length=512, blank=True, default="")
    # Cached status — one of LINK_STATUS_VALUES. Starts "unknown" on create
    # (nothing fetched yet) and is updated by the refresh endpoint.
    status = models.CharField(
        max_length=16,
        choices=LINK_STATUS_CHOICES,
        default=LINK_STATUS_UNKNOWN,
    )
    # When the cached status/title was last fetched from the provider. Null
    # until the first refresh — drives the "as of …" / "never refreshed" hint.
    fetched_at = models.DateTimeField(null=True, blank=True)
    # Manual ordering within a task's link list (lower sorts first).
    display_order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ("display_order", "id")
        indexes = [
            # The link list is always read per-task; index the FK + ordering so
            # the section query is a single index range scan.
            models.Index(fields=("task", "display_order"), name="integrations_link_task_order"),
        ]
        verbose_name = "Task link"
        verbose_name_plural = "Task links"

    def __str__(self) -> str:  # pragma: no cover — debugging aid only
        return f"{self.provider} link on task {self.task_id}"

    @property
    def project_id(self) -> Any:
        """Surface the parent project's id for the RBAC resolver.

        ``access.permissions._get_project_id_from_obj`` traverses ``obj.project_id``
        to gate project-scoped permissions. A task-nested model has no direct
        project FK, so we expose the parent task's project id here — the same
        pattern ``TaskAttachment`` uses, so ``IsProjectMember``/``IsProjectMemberWrite``
        resolve the project for object-level checks (create/destroy/refresh).
        """
        return self.task.project_id

    def clean(self) -> None:
        """Validate ``provider`` against the live registry.

        Mirrors ``IntegrationCredential.upsert``'s rule so the model is the
        single source of truth for provider validation — the serializer calls
        ``full_clean`` so an unknown key is a 400, not a 500 at read time.
        """
        super().clean()
        from django.core.exceptions import ValidationError

        if TASK_LINK_PROVIDERS.get(self.provider) is None:
            raise ValidationError({"provider": f"Unknown provider {self.provider!r}."})
