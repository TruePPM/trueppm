"""Serializers for the multi-provider SSO config + flow responses (ADR-0517 §3.4).

Each provider is an allauth ``SocialApp`` (``provider``, ``provider_id``,
``client_id``, ``settings.server_url``) + a :class:`SsoProviderPolicy` side row.
The serializers span both models by hand (a plain ``Serializer``, not a
``ModelSerializer``) so the two rows are written atomically and the client sees a
single flat provider object.

Security-relevant shapes preserved from ADR-0187:

- the client secret is **never** exposed: the read serializer reports only
  ``secret_set: bool``; the write serializer accepts ``client_secret`` as a
  write-only field and providing it is the rotation path;
- ``scopes`` is server-fixed (``openid email profile`` / GitHub
  ``read:user user:email``) and read-only — the admin cannot widen it;
- ``default_role`` is restricted to MEMBER/ADMIN so SSO never auto-grants OWNER;
- ``allow_password_signin`` is rejected in OSS (a set-but-ignored no-op, #2025);
- the composed ``server_url`` is re-validated as an absolute https URL, and a
  pasted ``.well-known`` discovery URL is rejected (ADR-0187 issuer rules).
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from allauth.socialaccount.models import SocialApp
from django.conf import settings
from django.db import transaction
from rest_framework import serializers

from trueppm_api.apps.sso import services
from trueppm_api.apps.sso.models import SsoProviderPolicy
from trueppm_api.apps.workspace.models import Workspace, WorkspaceRole

# SSO auto-create must never mint an OWNER. Members and Admins only.
_ALLOWED_DEFAULT_ROLES = (WorkspaceRole.MEMBER, WorkspaceRole.ADMIN)


class SsoProviderReadSerializer(serializers.Serializer[SsoProviderPolicy]):
    """Read shape for one configured provider — secret reduced to a boolean.

    ``redirect_uri`` is the value the operator must allow-list in their IdP; it is
    derived (never stored) and passed via serializer context by the view — the
    callback path is **unchanged** for every provider (ADR-0517 §3.5).
    ``allow_password_signin_enforced`` is **always False in OSS**.
    """

    slug = serializers.CharField(read_only=True)
    provider = serializers.SerializerMethodField()
    kind = serializers.SerializerMethodField()
    display_name = serializers.SerializerMethodField()
    enabled = serializers.BooleanField(read_only=True)
    client_id = serializers.SerializerMethodField()
    server_url = serializers.SerializerMethodField()
    github_org = serializers.CharField(read_only=True)
    scopes = serializers.SerializerMethodField()
    allowed_email_domains = serializers.ListField(child=serializers.CharField(), read_only=True)
    auto_create_members = serializers.BooleanField(read_only=True)
    default_role = serializers.IntegerField(read_only=True)
    allow_password_signin = serializers.BooleanField(read_only=True)
    allow_password_signin_enforced = serializers.SerializerMethodField()
    secret_set = serializers.BooleanField(read_only=True)
    redirect_uri = serializers.SerializerMethodField()
    created_at = serializers.DateTimeField(read_only=True)
    updated_at = serializers.DateTimeField(read_only=True)

    def get_provider(self, obj: SsoProviderPolicy) -> str:
        return str(obj.social_app.provider)

    def get_kind(self, obj: SsoProviderPolicy) -> str:
        entry = services.registry_entry(obj.slug)
        return entry.kind if entry else ""

    def get_display_name(self, obj: SsoProviderPolicy) -> str:
        return str(obj.social_app.name)

    def get_client_id(self, obj: SsoProviderPolicy) -> str:
        return str(obj.social_app.client_id)

    def get_server_url(self, obj: SsoProviderPolicy) -> str:
        return str(obj.social_app.settings.get("server_url", ""))

    def get_scopes(self, obj: SsoProviderPolicy) -> list[str]:
        entry = services.registry_entry(obj.slug)
        if entry and entry.allauth_provider == services.ALLAUTH_GITHUB:
            return services.GITHUB_SCOPES
        return services.OIDC_SCOPES

    def get_allow_password_signin_enforced(self, _obj: SsoProviderPolicy) -> bool:
        # OSS never enforces the OFF state; always False. Enterprise's serializer
        # would compute this from its registered policy provider.
        return False

    def get_redirect_uri(self, _obj: SsoProviderPolicy) -> str:
        return str(self.context.get("redirect_uri", ""))


class SsoProviderWriteSerializer(serializers.Serializer[SsoProviderPolicy]):
    """Create/update shape for one provider (POST create / PUT update).

    ``slug`` selects the registry type (required + immutable on create).
    ``client_secret`` is write-only; omitting it preserves the stored secret and
    providing a non-empty value rotates it. ``scopes`` is not writable (server-fixed).
    """

    slug = serializers.CharField(required=False)
    display_name = serializers.CharField(required=False, allow_blank=True)
    client_id = serializers.CharField(required=False, allow_blank=True)
    client_secret = serializers.CharField(write_only=True, required=False, allow_blank=False)
    server_url = serializers.CharField(required=False, allow_blank=True)
    github_org = serializers.CharField(required=False, allow_blank=True)
    enabled = serializers.BooleanField(required=False)
    allowed_email_domains = serializers.ListField(child=serializers.CharField(), required=False)
    auto_create_members = serializers.BooleanField(required=False)
    default_role = serializers.IntegerField(required=False)
    allow_password_signin = serializers.BooleanField(required=False)

    def validate_slug(self, value: str) -> str:
        value = value.strip().lower()
        if value not in services.REGISTRY:
            raise serializers.ValidationError(f"Unknown provider type: {value!r}.")
        return value

    def validate_server_url(self, value: str) -> str:
        value = value.strip()
        if not value:
            return value
        parsed = urlparse(value)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise serializers.ValidationError("Issuer must be an absolute http(s) URL.")
        # Outside DEBUG, require https: an http issuer would carry the client secret
        # (token exchange) and the ID token over cleartext. Local dev may use http.
        if parsed.scheme == "http" and not settings.DEBUG:
            raise serializers.ValidationError("Issuer must use https.")
        if parsed.query or parsed.fragment:
            raise serializers.ValidationError("Issuer URL must not contain a query or fragment.")
        # The discovery path is appended by the server; reject a pasted well-known URL.
        if parsed.path.rstrip("/").endswith("/.well-known/openid-configuration"):
            raise serializers.ValidationError(
                "Enter the issuer URL, not the .well-known discovery URL."
            )
        return value

    def validate_default_role(self, value: int) -> int:
        if value not in _ALLOWED_DEFAULT_ROLES:
            raise serializers.ValidationError("default_role must be Member or Admin.")
        return value

    def validate_allow_password_signin(self, value: bool) -> bool:
        """Reject the field in OSS instead of persisting a set-but-ignored no-op (#2025).

        ``allow_password_signin`` is an *enforcement* setting: only an edition that
        registers a local-login policy provider (Enterprise) actually blocks password
        login when it is ``False``. In OSS nothing enforces it, so silently storing a
        client's value would be a footgun. A field-level validator fires only when the
        client actually sends the key, so an untouched provider save is unaffected.
        """
        from trueppm_api.apps.sso.extensions import local_login_policy_enforced

        if not local_login_policy_enforced():
            raise serializers.ValidationError(
                "Enforcing password sign-in on/off is an Enterprise-governed setting "
                "and is not honored in the community edition, so it cannot be set here."
            )
        return value

    def validate_allowed_email_domains(self, value: list[str]) -> list[str]:
        cleaned: list[str] = []
        for raw in value:
            domain = raw.strip().lower().lstrip("@")
            if not domain or "@" in domain or "/" in domain or " " in domain:
                raise serializers.ValidationError(f"Invalid email domain: {raw!r}")
            if domain not in cleaned:
                cleaned.append(domain)
        return cleaned

    def _effective_slug(self, attrs: dict[str, Any]) -> str:
        if self.instance is not None:
            return str(self.instance.slug)
        return str(attrs.get("slug", ""))

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        instance = self.instance
        if instance is None and not attrs.get("slug"):
            raise serializers.ValidationError({"slug": "This field is required."})

        slug = self._effective_slug(attrs)
        entry = services.REGISTRY.get(slug)
        is_github = bool(entry and entry.allauth_provider == services.ALLAUTH_GITHUB)

        # Enabling SSO requires a complete configuration — refuse to enable a
        # half-configured provider that would fail at the first login.
        enabled = attrs.get("enabled", getattr(instance, "enabled", False))
        if enabled:
            missing = self._missing_enable_requirements(attrs, is_github=is_github)
            if missing:
                raise serializers.ValidationError(
                    {
                        "enabled": (
                            f"Cannot enable SSO until configured: missing {', '.join(missing)}."
                        )
                    }
                )
        return attrs

    def _missing_enable_requirements(self, attrs: dict[str, Any], *, is_github: bool) -> list[str]:
        """Names of required config still absent when the client wants SSO enabled.

        Enabling refuses a half-configured provider, so this collects every
        required field that is neither in ``attrs`` nor already stored on the
        instance. GitHub derives its endpoints from constants and so is exempt
        from the issuer (``server_url``) requirement.
        """
        instance = self.instance
        client_id = attrs.get("client_id") or self._current_client_id()
        has_secret = bool(attrs.get("client_secret")) or bool(
            getattr(instance, "secret_set", False)
        )
        domains = attrs.get("allowed_email_domains", getattr(instance, "allowed_email_domains", []))
        server_url = attrs.get("server_url") or self._current_server_url()
        missing: list[str] = []
        if not client_id:
            missing.append("client_id")
        if not has_secret:
            missing.append("client_secret")
        if not domains:
            missing.append("allowed_email_domains")
        # OIDC needs an issuer; GitHub derives its endpoints from constants.
        if not is_github and not server_url:
            missing.append("server_url")
        return missing

    def _current_client_id(self) -> str:
        return self.instance.social_app.client_id if self.instance is not None else ""

    def _current_server_url(self) -> str:
        if self.instance is None:
            return ""
        return str(self.instance.social_app.settings.get("server_url", ""))

    @transaction.atomic
    def create(self, validated_data: dict[str, Any]) -> SsoProviderPolicy:
        slug = validated_data["slug"]
        entry = services.REGISTRY[slug]
        secret = validated_data.pop("client_secret", None)

        app = SocialApp.objects.create(
            provider=entry.allauth_provider,
            # provider_id is the slug for OIDC apps (so distinct IdPs coexist under
            # the shared openid_connect type); GitHub keeps it as the slug too for a
            # stable SocialAccount ``provider`` key. SocialApp.secret stays EMPTY —
            # the real secret lives Fernet-encrypted on the policy (control 2).
            provider_id=slug,
            name=validated_data.get("display_name", "") or entry.display,
            client_id=validated_data.get("client_id", ""),
            secret="",
            settings={"server_url": validated_data.get("server_url", "")},
        )
        app.sites.add(_current_site_id())

        policy = SsoProviderPolicy(
            social_app=app,
            workspace=Workspace.load(),
            slug=slug,
            enabled=validated_data.get("enabled", False),
            allowed_email_domains=validated_data.get("allowed_email_domains", []),
            auto_create_members=validated_data.get("auto_create_members", False),
            default_role=validated_data.get("default_role", WorkspaceRole.MEMBER),
            github_org=validated_data.get("github_org", ""),
        )
        if secret:
            policy.set_client_secret(secret)
        policy.save()
        return policy

    @transaction.atomic
    def update(
        self, instance: SsoProviderPolicy, validated_data: dict[str, Any]
    ) -> SsoProviderPolicy:
        secret = validated_data.pop("client_secret", None)
        app = instance.social_app

        if "display_name" in validated_data:
            app.name = validated_data["display_name"]
        if "client_id" in validated_data:
            app.client_id = validated_data["client_id"]
        if "server_url" in validated_data:
            app.settings = {**app.settings, "server_url": validated_data["server_url"]}
        app.save()

        for field in (
            "enabled",
            "allowed_email_domains",
            "auto_create_members",
            "default_role",
            "github_org",
        ):
            if field in validated_data:
                setattr(instance, field, validated_data[field])
        if secret:
            # Providing a secret rotates it; the plaintext is encrypted and never
            # stored or returned in clear.
            instance.set_client_secret(secret)
        instance.save()
        return instance


def _current_site_id() -> int:
    """The Site id a SocialApp is bound to (the singleton install → SITE_ID).

    A SocialApp is an M2M to Site; we bind every provider to the configured
    ``SITE_ID`` so allauth's on-site lookups resolve.
    """
    return int(getattr(settings, "SITE_ID", 1))


class SsoDiscoverResponseSerializer(serializers.Serializer[Any]):
    """Response for ``GET /auth/oidc/discover`` — domain-level only, no enumeration."""

    provider_present = serializers.BooleanField()
    providers = serializers.ListField(child=serializers.DictField(), required=False)


class SsoTestConnectionResponseSerializer(serializers.Serializer[Any]):
    """Structured result of the admin "Test connection" probe."""

    ok = serializers.BooleanField()
    issuer = serializers.CharField(required=False, allow_blank=True)
    endpoints = serializers.DictField(required=False)
    error = serializers.CharField(required=False, allow_blank=True)
    detail = serializers.CharField(required=False, allow_blank=True)
