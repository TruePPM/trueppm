"""SSO policy side-model (ADR-0517 §3.1).

ADR-0517 adopts ``allauth.socialaccount`` as the provider registry: each
configured IdP is an allauth :class:`~allauth.socialaccount.models.SocialApp`
(``provider``, ``provider_id``, ``client_id``, ``settings.server_url``) and each
per-user binding is a :class:`~allauth.socialaccount.models.SocialAccount`
(``provider``, ``uid=subject``, ``extra_data={"iss": issuer}``). The two models
this app owned under ADR-0187 (``OIDCProvider`` / ``OIDCIdentity``) are dropped by
the migration and replaced by those allauth models plus :class:`SsoProviderPolicy`
— a 1:1 *side row* that carries the TruePPM policy fields ``SocialApp`` has no
home for, and, critically, the **Fernet-encrypted client secret**.

Why a side row rather than allauth's own columns:

- ``SocialApp.secret`` is stored **plaintext** — below our secret-at-rest bar
  (ADR-0049 §3). We hold the bar by leaving ``SocialApp.secret`` **empty** and
  storing the real secret Fernet-encrypted in
  :attr:`SsoProviderPolicy.secret_ciphertext`, decrypted only at token-exchange
  time by our own egress-backed service (never handed to an allauth network path).
- ``enabled`` / ``allowed_email_domains`` / ``auto_create_members`` /
  ``default_role`` / ``allow_password_signin`` are TruePPM policy with no
  ``SocialApp`` field.

Like ``OIDCProvider`` before it, this is admin, secret-bearing configuration read
only over the ``IsWorkspaceAdminStrict`` API — it is *not* a ``VersionedModel``,
carries no ``server_version``, and never enters the WatermelonDB sync delta.
"""

from __future__ import annotations

import uuid

from allauth.socialaccount.models import SocialApp
from django.contrib.postgres.fields import ArrayField
from django.db import models

from trueppm_api.apps.integrations.encryption import decrypt_secret, encrypt_secret
from trueppm_api.apps.workspace.models import Workspace, WorkspaceRole


class SsoProviderPolicy(models.Model):
    """TruePPM policy + encrypted client secret for one allauth ``SocialApp`` (ADR-0517 §3.1).

    One row per configured provider (1:1 to ``SocialApp``). The community edition
    is single-workspace, so the ``workspace`` FK is effectively installation-wide;
    it is retained to keep enterprise multi-tenancy open without an OSS schema
    change. Multiple policies (Google **and** GitHub **and** a Keycloak realm) can
    be enabled simultaneously — the capability the ADR-0187 singleton lacked.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # CASCADE: the policy belongs to its SocialApp and has no meaning without it —
    # deleting the provider config removes both rows together.
    social_app = models.OneToOneField(
        SocialApp,
        on_delete=models.CASCADE,
        related_name="trueppm_policy",
    )
    # CASCADE (not the PROTECT default): SSO config belongs to its workspace and
    # has no meaning without it — mirrors the retired OIDCProvider FK.
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="sso_provider_policies",
    )
    # Fail-closed default: a freshly created provider is disabled until an admin
    # supplies credentials and explicitly enables it. Every flow endpoint re-checks
    # ``enabled`` so a disabled provider fails closed.
    enabled = models.BooleanField(default=False)
    # The registry id (ADR-0517 §2). For OIDC IdPs this equals the openid_connect
    # ``provider_id`` on the linked SocialApp (``generic``/``keycloak``/…); for
    # GitHub it is ``github``. It is also the SocialAccount ``provider`` value used
    # for durable identity resolution, so distinct OIDC IdPs never collide on
    # allauth's ``(provider, uid)`` key.
    slug = models.CharField(max_length=64)
    # Gates both account-linking and auto-create. Empty list = no domain permitted
    # → fail closed. Stored lower-cased by the serializer.
    allowed_email_domains = ArrayField(models.CharField(max_length=255), default=list, blank=True)
    auto_create_members = models.BooleanField(default=False)
    # Single role granted to auto-created members. Restricted to MEMBER/ADMIN by
    # the serializer — SSO must never auto-grant OWNER. Claim→role mapping is an
    # enterprise extension (``oidc_role_for``); OSS always assigns this role.
    default_role = models.PositiveSmallIntegerField(
        choices=WorkspaceRole.choices,
        default=WorkspaceRole.MEMBER,
    )
    # INFORMATIONAL in OSS (ADR-0517 §4 / ADR-0187 §4): stored but never enforced.
    # Enterprise registers a ``local_login_allowed`` provider that enforces the OFF
    # state; OSS ships the field, never the lock.
    allow_password_signin = models.BooleanField(default=True)
    # GitHub only: optional org-membership restriction. Empty = any GitHub user
    # whose verified primary email clears the domain gate may sign in. When set,
    # the service fails closed unless the user is a member of this org (ADR-0517
    # §3.2). Ignored for OIDC providers.
    github_org = models.CharField(max_length=255, blank=True, default="")
    # Fernet ciphertext (ADR-0049 §3). Write-only: never serialized back to any
    # client. ``default=b""`` keeps the AddField migration non-interactive and
    # models "no secret set yet". ``editable=False`` keeps it out of ModelForms /
    # the Django admin; the API write path goes through ``set_client_secret``.
    secret_ciphertext = models.BinaryField(default=b"", blank=True, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    # Declared explicitly (codebase convention) so the default manager is typed
    # under django-stubs strict mode.
    objects: models.Manager[SsoProviderPolicy] = models.Manager()

    class Meta:
        db_table = "sso_provider_policy"
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "slug"], name="uniq_sso_policy_workspace_slug"
            ),
        ]

    def __str__(self) -> str:
        state = "enabled" if self.enabled else "disabled"
        return f"SsoProviderPolicy({self.slug}, {state})"

    @property
    def secret_set(self) -> bool:
        """Whether a client secret is stored (the only thing exposed about it)."""
        return bool(self.secret_ciphertext)

    def set_client_secret(self, plaintext: str) -> None:
        """Fernet-encrypt and store the client secret (write path only).

        Storing a new value is the rotation path: the previous ciphertext is
        overwritten. The plaintext is never persisted or logged, and — because our
        own token-exchange code makes the outbound call — is never injected into an
        allauth-owned network path (ADR-0517 §3.1).
        """
        self.secret_ciphertext = encrypt_secret(plaintext)

    def get_client_secret(self) -> str:
        """Decrypt the stored client secret for use in the token-exchange request.

        Server-side only — the result is sent to the IdP token endpoint and never
        returned to a client.
        """
        if not self.secret_ciphertext:
            return ""
        return decrypt_secret(self.secret_ciphertext)
