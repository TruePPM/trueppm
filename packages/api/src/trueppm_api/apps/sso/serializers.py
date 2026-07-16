"""Serializers for the OIDC provider config + flow responses (ADR-0187).

The provider's client secret is **never** exposed: the read serializer reports
only ``secret_set: bool``; the write serializer accepts ``client_secret`` as a
write-only field and providing it is the rotation path. ``scopes`` is read-only
(OSS-fixed to ``openid email profile``), and ``default_role`` is restricted to
MEMBER/ADMIN so SSO can never auto-grant OWNER.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from django.conf import settings
from rest_framework import serializers

from trueppm_api.apps.sso.models import OIDCProvider
from trueppm_api.apps.workspace.models import WorkspaceRole

# SSO auto-create must never mint an OWNER. Members and Admins only.
_ALLOWED_DEFAULT_ROLES = (WorkspaceRole.MEMBER, WorkspaceRole.ADMIN)


class OIDCProviderReadSerializer(serializers.ModelSerializer[OIDCProvider]):
    """Read shape for the admin SSO config — secret reduced to a boolean.

    ``redirect_uri`` is the value the operator must allow-list in their IdP; it is
    derived (never stored) and passed in via serializer context by the view.
    ``allow_password_signin_enforced`` is **always False in OSS** — the field is
    informational here; enforcement is an enterprise capability (ADR-0187 §4).
    """

    secret_set = serializers.BooleanField(read_only=True)
    redirect_uri = serializers.SerializerMethodField()
    allow_password_signin_enforced = serializers.SerializerMethodField()

    class Meta:
        model = OIDCProvider
        fields = [
            "enabled",
            "display_name",
            "issuer_url",
            "client_id",
            "scopes",
            "allowed_email_domains",
            "auto_create_members",
            "default_role",
            "allow_password_signin",
            "allow_password_signin_enforced",
            "secret_set",
            "redirect_uri",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def get_redirect_uri(self, _obj: OIDCProvider) -> str:
        return str(self.context.get("redirect_uri", ""))

    def get_allow_password_signin_enforced(self, _obj: OIDCProvider) -> bool:
        # OSS never enforces the OFF state; always False. Enterprise's serializer
        # would compute this from its registered policy provider.
        return False


class OIDCProviderWriteSerializer(serializers.ModelSerializer[OIDCProvider]):
    """Write shape for the admin SSO config (PUT).

    ``client_secret`` is write-only; omitting it preserves the stored secret and
    providing a non-empty value rotates it. ``scopes`` is not writable (OSS-fixed).
    """

    client_secret = serializers.CharField(write_only=True, required=False, allow_blank=False)

    class Meta:
        model = OIDCProvider
        fields = [
            "enabled",
            "display_name",
            "issuer_url",
            "client_id",
            "client_secret",
            "allowed_email_domains",
            "auto_create_members",
            "default_role",
            "allow_password_signin",
        ]

    def validate_issuer_url(self, value: str) -> str:
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
        """Reject the field in OSS instead of persisting a set-but-ignored no-op.

        ``allow_password_signin`` is an *enforcement* setting: only an edition that
        registers a local-login policy provider (Enterprise) actually blocks password
        login when it is ``False``. In OSS nothing enforces it, so silently storing a
        client's value would be a footgun — the admin sets "off", nothing changes, and
        the API reports success (#2025). A field-level validator fires only when the
        client actually sends the key (the view PATCHes ``partial=True``), so an
        untouched provider save is unaffected. The read serializer still surfaces
        ``allow_password_signin_enforced: false`` so clients can discover why.
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

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        # Enabling SSO requires a complete configuration — refuse to enable a
        # half-configured provider that would fail at the first login.
        instance = self.instance
        enabled = attrs.get("enabled", getattr(instance, "enabled", False))
        if enabled:
            issuer = attrs.get("issuer_url", getattr(instance, "issuer_url", ""))
            client_id = attrs.get("client_id", getattr(instance, "client_id", ""))
            has_secret = bool(attrs.get("client_secret")) or bool(
                getattr(instance, "secret_set", False)
            )
            domains = attrs.get(
                "allowed_email_domains", getattr(instance, "allowed_email_domains", [])
            )
            missing = []
            if not issuer:
                missing.append("issuer_url")
            if not client_id:
                missing.append("client_id")
            if not has_secret:
                missing.append("client_secret")
            if not domains:
                missing.append("allowed_email_domains")
            if missing:
                raise serializers.ValidationError(
                    {
                        "enabled": (
                            f"Cannot enable SSO until configured: missing {', '.join(missing)}."
                        )
                    }
                )
        return attrs

    def update(self, instance: OIDCProvider, validated_data: dict[str, Any]) -> OIDCProvider:
        secret = validated_data.pop("client_secret", None)
        for field, value in validated_data.items():
            setattr(instance, field, value)
        if secret:
            # Providing a secret rotates it; the plaintext is encrypted and never
            # stored or returned in clear.
            instance.set_client_secret(secret)
        instance.save()
        return instance


class OIDCDiscoverResponseSerializer(serializers.Serializer[Any]):
    """Response for ``GET /auth/oidc/discover`` — domain-level only, no enumeration."""

    provider_present = serializers.BooleanField()
    display_name = serializers.CharField(required=False, allow_blank=True)
    issuer = serializers.CharField(required=False, allow_blank=True)


class OIDCTestConnectionRequestSerializer(serializers.Serializer[Any]):
    """Optional issuer override for the admin "Test connection" probe."""

    issuer_url = serializers.URLField(required=False, allow_blank=True)


class OIDCTestConnectionResponseSerializer(serializers.Serializer[Any]):
    """Structured result of the admin "Test connection" probe."""

    ok = serializers.BooleanField()
    issuer = serializers.CharField(required=False, allow_blank=True)
    endpoints = serializers.DictField(required=False)
    error = serializers.CharField(required=False, allow_blank=True)
    detail = serializers.CharField(required=False, allow_blank=True)
