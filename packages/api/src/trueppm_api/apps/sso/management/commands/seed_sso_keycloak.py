"""Seed a Keycloak OIDC provider for the ``sso:integration`` nightly CI job (#2274).

Provisions the one enabled ``keycloak`` provider (an allauth ``SocialApp`` +
:class:`SsoProviderPolicy`) pointing at the live Keycloak service that the CI job
runs, plus a workspace-admin account the Playwright spec authenticates as to hit
the admin-only ``test-connection`` endpoint. Idempotent — re-running updates the
existing rows rather than duplicating them.

The provider mirrors what an operator configures in Workspace Settings → SSO for a
self-hosted Keycloak realm: issuer (base URL + realm), confidential client id +
secret, a permitted email domain, and auto-create so the seeded Keycloak test
user becomes a TruePPM member on first login (exercising the full ``resolve_user``
path, not just the handshake).

Environment variables (all have CI-friendly defaults; the job sets them
explicitly so the values match the baked realm export):

    SSO_KEYCLOAK_ISSUER          e.g. http://keycloak:8080/realms/trueppm-ci
    SSO_KEYCLOAK_CLIENT_ID       confidential client id (default: trueppm-web)
    SSO_KEYCLOAK_CLIENT_SECRET   confidential client secret
    SSO_KEYCLOAK_ALLOWED_DOMAIN  domain of the Keycloak test user's email
    SSO_ADMIN_EMAIL              workspace-admin account for test-connection
    INTEGRATION_USER_PASSWORD    password for the admin account (shared with the
                                 web:integration fixtures)

The issuer host must be present in ``EGRESS_ALLOWLISTED_HOSTS`` (ADR-0590) or the
SSRF egress guard blocks discovery/token/JWKS — the CI job sets both together.
"""

from __future__ import annotations

import os
import secrets

from allauth.socialaccount.models import SocialApp
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from trueppm_api.apps.sso import services
from trueppm_api.apps.sso.models import SsoProviderPolicy
from trueppm_api.apps.workspace.models import (
    MemberStatus,
    Workspace,
    WorkspaceMembership,
    WorkspaceRole,
)

_SLUG = "keycloak"
_DEFAULT_ISSUER = "http://keycloak:8080/realms/trueppm-ci"
_DEFAULT_CLIENT_ID = "trueppm-web"
_DEFAULT_CLIENT_SECRET = "trueppm-ci-secret"  # matches the baked realm export
_DEFAULT_ALLOWED_DOMAIN = "trueppm-ci.test"
_DEFAULT_ADMIN_EMAIL = "sso-admin@trueppm-ci.test"

_PASSWORD_ENV = "INTEGRATION_USER_PASSWORD"
_DEBUG_DEFAULT_PASSWORD = "ci-integration-pw"  # only honored under settings.DEBUG


def _resolve_admin_password() -> tuple[str, str]:
    """Resolve the seeded admin's password + its source (mirrors #1375).

    The seeded admin is a real, loginable, workspace-admin account, so a fixed weak
    password must never reach a public (non-DEBUG) instance. Resolution order:
    ``INTEGRATION_USER_PASSWORD`` env (operator/CI opt-in) → the static default
    under DEBUG (local dev) → a random token otherwise. Returns ``(password,
    source)`` where source is ``"env"`` / ``"debug"`` / ``"generated"``.
    """
    env_pw = os.environ.get(_PASSWORD_ENV)
    if env_pw:
        return env_pw, "env"
    if settings.DEBUG:
        return _DEBUG_DEFAULT_PASSWORD, "debug"
    return secrets.token_urlsafe(16), "generated"


class Command(BaseCommand):
    """Seed the Keycloak SSO provider + a workspace-admin (idempotent)."""

    help = "Seed a live-Keycloak OIDC provider for the sso:integration CI job."

    def add_arguments(self, parser: object) -> None:
        parser.add_argument(  # type: ignore[attr-defined]
            "--force",
            action="store_true",
            help=(
                "Allow the seed to run even when a throwaway password would be "
                "generated (DEBUG off and no INTEGRATION_USER_PASSWORD)."
            ),
        )

    @transaction.atomic
    def handle(self, *args: object, **options: object) -> None:
        # Prod guard (mirrors seed_integration_fixtures, #1375): this command
        # creates an *enabled* SSO provider and a loginable workspace-admin account.
        # On a non-DEBUG instance with no env password the only resolvable password
        # is a useless random throwaway, so refuse to create the admin unless the
        # operator explicitly opts in — it must never mint a known-credential admin
        # (or a stray CI provider) on a real instance.
        password, password_source = _resolve_admin_password()
        if password_source == "generated" and not options.get("force"):
            raise CommandError(
                "Refusing to seed the Keycloak CI provider on a non-DEBUG instance "
                "without a password — this creates an enabled SSO provider and a "
                f"loginable workspace-admin. Set {_PASSWORD_ENV} (as the CI job does) "
                "or pass --force to override."
            )

        issuer = os.environ.get("SSO_KEYCLOAK_ISSUER", _DEFAULT_ISSUER)
        client_id = os.environ.get("SSO_KEYCLOAK_CLIENT_ID", _DEFAULT_CLIENT_ID)
        client_secret = os.environ.get("SSO_KEYCLOAK_CLIENT_SECRET", _DEFAULT_CLIENT_SECRET)
        allowed_domain = os.environ.get("SSO_KEYCLOAK_ALLOWED_DOMAIN", _DEFAULT_ALLOWED_DOMAIN)
        admin_email = os.environ.get("SSO_ADMIN_EMAIL", _DEFAULT_ADMIN_EMAIL)

        workspace = Workspace.load()

        # allauth SocialApp holds the endpoint/claim knowledge; the real secret
        # lives Fernet-encrypted on the policy side row (SocialApp.secret stays
        # empty — ADR-0517 §3.1), so update_or_create the app with an empty secret.
        app, _ = SocialApp.objects.update_or_create(
            provider_id=_SLUG,
            defaults={
                "provider": services.ALLAUTH_OPENID_CONNECT,
                "name": "Keycloak (CI)",
                "client_id": client_id,
                "secret": "",
                "settings": {"server_url": issuer},
            },
        )
        app.sites.add(int(getattr(settings, "SITE_ID", 1)))

        policy, _ = SsoProviderPolicy.objects.update_or_create(
            social_app=app,
            defaults={
                "workspace": workspace,
                "slug": _SLUG,
                "enabled": True,
                "allowed_email_domains": [allowed_domain.lower()],
                # Auto-create so the seeded Keycloak user becomes a member on first
                # login — the smoke exercises the full resolve/create path.
                "auto_create_members": True,
            },
        )
        policy.set_client_secret(client_secret)
        policy.save(update_fields=["secret_ciphertext"])

        # Workspace-admin for the admin-only test-connection call. Least privilege:
        # an explicit WorkspaceMembership at ADMIN (not a Django superuser) is enough
        # to clear IsWorkspaceAdminStrict, and is workspace-scoped rather than a
        # global backdoor. username == email so the password login (/auth/token/)
        # succeeds (Django's default USERNAME_FIELD is "username").
        user_model = get_user_model()
        admin, _ = user_model.objects.update_or_create(
            email=admin_email,
            defaults={"username": admin_email},
        )
        # nosemgrep: unvalidated-password  # CI fixture, not an interactive signup.
        admin.set_password(password)
        admin.save(update_fields=["password"])
        WorkspaceMembership.objects.update_or_create(
            workspace=workspace,
            user=admin,
            defaults={"role": WorkspaceRole.ADMIN, "status": MemberStatus.ACTIVE},
        )

        self.stdout.write(self.style.SUCCESS("Keycloak SSO provider seeded"))
        self.stdout.write(f"  issuer:  {issuer}")
        self.stdout.write(f"  client:  {client_id}")
        self.stdout.write(f"  domain:  {allowed_domain}")
        self.stdout.write(f"  admin:   {admin_email}")
