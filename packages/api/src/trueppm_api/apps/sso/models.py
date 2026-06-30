"""Basic SSO models — the OIDC provider config and the durable identity link.

ADR-0187. Two models:

- :class:`OIDCProvider` is **singleton-aligned config**, following the
  ``Workspace`` pattern (``apps/workspace/models.py``) — it is *not* a
  ``VersionedModel``, carries **no** ``server_version``, and never enters the
  WatermelonDB sync delta. It is admin, secret-bearing configuration read only
  over a dedicated ``IsWorkspaceAdmin`` endpoint; putting it in the client sync
  stream would risk leaking config to every device.
- :class:`OIDCIdentity` is the **durable identity binding** keyed on
  ``(issuer, subject)``. Once an SSO login is bound to a local user, later logins
  resolve by the stable IdP subject — never the mutable email — which is the
  account-takeover mitigation the threat model signs off (ADR-0187 §2, Threat
  model). The client secret is Fernet-encrypted at rest reusing ADR-0049 §3.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.contrib.postgres.fields import ArrayField
from django.db import models

from trueppm_api.apps.integrations.encryption import decrypt_secret, encrypt_secret
from trueppm_api.apps.workspace.models import Workspace, WorkspaceRole


def _default_scopes() -> list[str]:
    """OSS-fixed scope set. ``groups`` / custom claims are an enterprise widening."""
    return ["openid", "email", "profile"]


class OIDCProvider(models.Model):
    """Installation-wide OIDC relying-party configuration (ADR-0187 §1).

    One row per workspace. OSS has exactly one workspace (the singleton), so this
    is effectively installation-wide config; the workspace FK keeps enterprise
    multi-tenancy open without an OSS schema change. Edited only through the
    ``IsWorkspaceAdmin``-gated ``/api/v1/workspace/sso/`` endpoint.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # CASCADE (not the PROTECT default): the SSO config belongs to its workspace
    # and has no meaning without it — deleting the workspace should take its
    # provider config with it.
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="oidc_providers",
    )
    # Fail-closed default: a freshly materialized row is disabled until an admin
    # configures the issuer/client and explicitly enables it. Every flow endpoint
    # re-checks ``enabled`` so a disabled provider fails closed.
    enabled = models.BooleanField(default=False)
    display_name = models.CharField(max_length=255, blank=True, default="")
    # Discovery base. The well-known document is fetched from
    # ``{issuer_url}/.well-known/openid-configuration`` and its ``issuer`` claim
    # must equal this value (OIDC Discovery §4.3) — verified in services.
    issuer_url = models.URLField(blank=True, default="")
    client_id = models.CharField(max_length=255, blank=True, default="")
    # Fernet ciphertext (ADR-0049 §3). Write-only: never serialized back to any
    # client. ``default=b""`` keeps the AddField migration non-interactive and
    # models "no secret set yet". ``editable=False`` keeps it out of ModelForms /
    # the Django admin; the API write path goes through ``set_client_secret``.
    client_secret_ciphertext = models.BinaryField(default=b"", blank=True, editable=False)
    # OSS-fixed; the column exists so enterprise can widen via its own provider
    # extension, but OSS never offers more than ``openid email profile``.
    scopes = ArrayField(models.CharField(max_length=64), default=_default_scopes)
    # Gates both account-linking and auto-create. Empty list = no domain permitted
    # → fail closed (admin must configure at least one domain before any login can
    # link or create an account). Stored lower-cased by the serializer.
    allowed_email_domains = ArrayField(models.CharField(max_length=255), default=list, blank=True)
    auto_create_members = models.BooleanField(default=False)
    # Single role granted to auto-created members. Restricted to MEMBER/ADMIN by
    # the serializer — SSO must never auto-grant OWNER. Claim→role mapping is an
    # enterprise extension (``oidc_role_for``); OSS always assigns this role.
    default_role = models.PositiveSmallIntegerField(
        choices=WorkspaceRole.choices,
        default=WorkspaceRole.MEMBER,
    )
    # INFORMATIONAL in OSS (ADR-0187 §4): stored but never enforced. OSS always
    # permits password login. Enterprise registers a ``local_login_allowed``
    # provider that enforces the OFF state; OSS ships the field, never the lock.
    allow_password_signin = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    # Declared explicitly (codebase convention, e.g. projects.PokerSession) so the
    # default manager is typed under django-stubs strict mode.
    objects: models.Manager[OIDCProvider] = models.Manager()

    class Meta:
        db_table = "sso_oidc_provider"
        constraints = [
            models.UniqueConstraint(fields=["workspace"], name="uniq_oidc_provider_workspace"),
        ]

    def __str__(self) -> str:
        state = "enabled" if self.enabled else "disabled"
        return f"OIDCProvider({self.display_name or self.issuer_url or 'unconfigured'}, {state})"

    @classmethod
    def load(cls) -> OIDCProvider:
        """Return the singleton provider for the singleton workspace, creating it lazily.

        Mirrors ``Workspace.load()`` (ADR-0079/0081): there is intentionally no
        data migration to seed the row; it is materialized disabled on first
        admin GET.
        """
        obj, _ = cls.objects.get_or_create(workspace=Workspace.load())
        return obj

    @property
    def secret_set(self) -> bool:
        """Whether a client secret is stored (the only thing exposed about it)."""
        return bool(self.client_secret_ciphertext)

    def set_client_secret(self, plaintext: str) -> None:
        """Fernet-encrypt and store the client secret (write path only).

        Storing a new value is the rotation path: the previous ciphertext is
        overwritten. The plaintext is never persisted or logged.
        """
        self.client_secret_ciphertext = encrypt_secret(plaintext)

    def get_client_secret(self) -> str:
        """Decrypt the stored client secret for use in the token-exchange request.

        Server-side only — the result is sent to the IdP token endpoint and never
        returned to a client.
        """
        if not self.client_secret_ciphertext:
            return ""
        return decrypt_secret(self.client_secret_ciphertext)


class OIDCIdentity(models.Model):
    """Durable binding from an IdP subject to a local user (ADR-0187 §2).

    Keyed on ``(issuer, subject)`` — the stable, IdP-assigned identifier. After
    the first login binds the identity (by verified email), every later login
    resolves through this row by subject, never by the mutable email, so a later
    email change at the IdP (or a hostile re-assertion of a victim's email) cannot
    re-point an existing binding.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # CASCADE (not the PROTECT default): an identity binding is meaningless without
    # its user — deleting the user must clear their SSO links, never be blocked by
    # them. This is conventional identity-link semantics.
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="oidc_identities",
    )
    issuer = models.CharField(max_length=512)
    subject = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)

    # Declared explicitly (codebase convention) so the default manager is typed
    # under django-stubs strict mode.
    objects: models.Manager[OIDCIdentity] = models.Manager()

    class Meta:
        db_table = "sso_oidc_identity"
        constraints = [
            models.UniqueConstraint(
                fields=["issuer", "subject"], name="uniq_oidc_identity_iss_sub"
            ),
        ]

    def __str__(self) -> str:
        return f"OIDCIdentity({self.issuer} / {self.subject} → user {self.user.pk})"
