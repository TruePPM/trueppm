"""Tests for the writable workspace SMTP configuration (#712, ADR-0213).

Covers the security-critical contracts from the pre-build review: password
encrypted at rest + never echoed, superuser-only writes (C1), validate-before-
persist (§3), the empty-password rotate-vs-keep semantics (M2), SSRF rejection
of an internal SMTP host / bounce URL (H1/M3), header-injection guards (M3), the
dynamic backend resolver (cloud fallback vs. model SMTP), and the send-test /
health actions.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.core import mail
from django.test import override_settings
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications import email_backend, email_health
from trueppm_api.apps.notifications.email_backend import (
    resolve_email_connection,
    resolve_from_email,
    resolve_reply_to,
)
from trueppm_api.apps.notifications.models import (
    EmailTransportMode,
    WorkspaceEmailSettings,
)
from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.workspace.models import Workspace, WorkspaceMembership, WorkspaceRole

User = get_user_model()

URL = "/api/v1/workspace/email-settings/"
TEST_URL = "/api/v1/workspace/email-settings/send-test/"
HEALTH_URL = "/api/v1/workspace/email-settings/health/"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def operator(db: object) -> object:
    """A Django superuser — the install operator who may write mail config."""
    return User.objects.create_superuser(username="root", email="root@corp.test", password="pw")


@pytest.fixture
def project_admin(db: object) -> object:
    """A non-superuser who is ADMIN on one project but holds no workspace role.

    Resolves to the implicit workspace MEMBER (``_workspace_membership_role``), so
    they must NOT read the installation mail config under the strict gate (#2016).
    """
    user = User.objects.create_user(username="pm", email="pm@corp.test", password="pw")
    calendar = Calendar.objects.create(name="Standard")
    project = Project.objects.create(name="Alpha", start_date=date(2026, 1, 1), calendar=calendar)
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    return user


@pytest.fixture
def workspace_admin(db: object) -> object:
    """A non-superuser with an explicit workspace ADMIN membership (#2016).

    The genuine reader: workspace-scoped ADMIN, distinct from a mere project
    admin, mirroring the SSO config read gate.
    """
    user = User.objects.create_user(username="wsadmin", email="wsadmin@corp.test", password="pw")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=user, role=WorkspaceRole.ADMIN
    )
    return user


@pytest.fixture
def workspace_admin_client(workspace_admin: object) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=workspace_admin)
    return client


@pytest.fixture
def operator_client(operator: object) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=operator)
    return client


@pytest.fixture
def admin_client(project_admin: object) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=project_admin)
    return client


@pytest.fixture
def _no_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    """Neutralize the validate-before-persist SMTP probe (no live server in CI)."""
    monkeypatch.setattr(email_backend, "probe_transport", lambda **kwargs: None)


# ---------------------------------------------------------------------------
# Model: encryption round-trip
# ---------------------------------------------------------------------------


def test_set_get_password_round_trip(db: object) -> None:
    obj = WorkspaceEmailSettings.load()
    obj.set_password("hunter2")
    obj.save()
    reloaded = WorkspaceEmailSettings.load()
    # Stored ciphertext is not the plaintext, and decrypt recovers it.
    assert bytes(reloaded.password_ciphertext) != b"hunter2"
    assert reloaded.get_password() == "hunter2"
    assert reloaded.password_is_set is True


def test_get_password_empty_returns_blank_not_error(db: object) -> None:
    # L1: an unconfigured/cloud row must never raise on decrypt.
    obj = WorkspaceEmailSettings.load()
    assert obj.get_password() == ""
    assert obj.password_is_set is False


def test_set_empty_password_clears(db: object) -> None:
    obj = WorkspaceEmailSettings.load()
    obj.set_password("x")
    obj.set_password("")
    assert obj.password_ciphertext == b""


# ---------------------------------------------------------------------------
# RBAC: writes require superuser (C1); reads require workspace ADMIN (#2016) —
# a single-project admin must not read installation mail-transport posture.
# ---------------------------------------------------------------------------


def test_get_forbidden_for_single_project_admin(admin_client: APIClient) -> None:
    # #2016: the read gate is IsWorkspaceAdminStrict, aligned with the SSO config
    # read. ADMIN on one project resolves to workspace MEMBER — not enough to see
    # SMTP host / from-domain / bounce-webhook / rate-limit disclosure.
    resp = admin_client.get(URL)
    assert resp.status_code == 403


def test_get_allowed_for_workspace_admin(workspace_admin_client: APIClient) -> None:
    resp = workspace_admin_client.get(URL)
    assert resp.status_code == 200
    assert resp.data["transport_mode"] == EmailTransportMode.CLOUD
    assert resp.data["can_edit"] is False  # workspace admin, but not the superuser operator


def test_get_allowed_for_operator(operator_client: APIClient) -> None:
    # The superuser install operator resolves to the implicit workspace OWNER and
    # can both read and (uniquely) write.
    resp = operator_client.get(URL)
    assert resp.status_code == 200
    assert resp.data["can_edit"] is True


def test_get_requires_auth(db: object) -> None:
    resp = APIClient().get(URL)
    assert resp.status_code in (401, 403)


@override_settings(FRONTEND_BASE_URL="https://app.example.com")
def test_public_url_surfaced_when_configured(workspace_admin_client: APIClient) -> None:
    # The install's public origin is shown read-only so an admin can confirm that
    # emailed invite/reset deep-links will resolve (#2015).
    resp = workspace_admin_client.get(URL)
    assert resp.data["frontend_base_url"] == "https://app.example.com"
    assert resp.data["frontend_base_url_configured"] is True


@override_settings(FRONTEND_BASE_URL="https://app.example.com/")
def test_public_url_trailing_slash_stripped(workspace_admin_client: APIClient) -> None:
    resp = workspace_admin_client.get(URL)
    assert resp.data["frontend_base_url"] == "https://app.example.com"


@override_settings(FRONTEND_BASE_URL="")
def test_public_url_flagged_unconfigured_when_unset(workspace_admin_client: APIClient) -> None:
    # Unset → the page shows a warning that emailed links are broken.
    resp = workspace_admin_client.get(URL)
    assert resp.data["frontend_base_url"] == ""
    assert resp.data["frontend_base_url_configured"] is False


def test_write_forbidden_for_single_project_admin(admin_client: APIClient, _no_probe: None) -> None:
    # The core C1 finding: a project admin must NOT be able to repoint workspace mail.
    resp = admin_client.patch(URL, {"from_name": "Evil"}, format="json")
    assert resp.status_code == 403
    assert WorkspaceEmailSettings.load().from_name == ""


def test_write_allowed_for_operator(operator_client: APIClient, _no_probe: None) -> None:
    resp = operator_client.patch(
        URL, {"from_name": "Ops", "from_email": "o@corp.test"}, format="json"
    )
    assert resp.status_code == 200
    assert resp.data["can_edit"] is True
    assert WorkspaceEmailSettings.load().from_name == "Ops"


# ---------------------------------------------------------------------------
# Password never echoed
# ---------------------------------------------------------------------------


def test_password_never_returned(operator_client: APIClient, _no_probe: None) -> None:
    resp = operator_client.patch(
        URL,
        {
            "transport_mode": "smtp",
            "host": "mail.corp.test",
            "username": "u",
            "password": "s3cret",
        },
        format="json",
    )
    assert resp.status_code == 200
    assert "password" not in resp.data
    assert resp.data["password_is_set"] is True
    # And a fresh GET also never leaks it.
    body = operator_client.get(URL).data
    assert "password" not in body
    assert "s3cret" not in str(body)


# ---------------------------------------------------------------------------
# Validate-before-persist (§3) + empty-password no-op (M2)
# ---------------------------------------------------------------------------


def test_bad_transport_rejected_and_not_persisted(
    operator_client: APIClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(**kwargs: object) -> None:
        raise email_backend.EmailTransportError("Could not connect to the mail server.")

    monkeypatch.setattr(email_backend, "probe_transport", boom)
    resp = operator_client.put(
        URL,
        {
            "transport_mode": "smtp",
            "host": "mail.corp.test",
            "port": 587,
            "security": "tls",
            "username": "u",
            "password": "s3cret",
        },
        format="json",
    )
    assert resp.status_code == 400
    # The row must remain unconfigured — the workspace is not locked out.
    assert WorkspaceEmailSettings.load().transport_mode == EmailTransportMode.CLOUD


def test_empty_password_on_update_keeps_secret(operator_client: APIClient, _no_probe: None) -> None:
    operator_client.put(
        URL,
        {
            "transport_mode": "smtp",
            "host": "mail.corp.test",
            "port": 587,
            "security": "tls",
            "username": "u",
            "password": "keepme",
        },
        format="json",
    )
    # Edit another field, submit blank password → secret retained.
    resp = operator_client.patch(URL, {"from_name": "Later"}, format="json")
    assert resp.status_code == 200
    assert WorkspaceEmailSettings.load().get_password() == "keepme"


def test_transport_change_requires_password_reentry(
    operator_client: APIClient, _no_probe: None
) -> None:
    operator_client.put(
        URL,
        {
            "transport_mode": "smtp",
            "host": "mail.corp.test",
            "username": "u",
            "password": "smtp-pw",
        },
        format="json",
    )
    # M2: switching to SendGrid without a new key must be rejected, not silently
    # reuse the SMTP password as the API key.
    resp = operator_client.patch(URL, {"transport_mode": "sendgrid"}, format="json")
    assert resp.status_code == 400
    assert "password" in resp.data


# ---------------------------------------------------------------------------
# SSRF + header-injection guards (H1/M3)
# ---------------------------------------------------------------------------


def test_internal_smtp_host_rejected(operator_client: APIClient) -> None:
    # localhost resolves to 127.0.0.1 → the SSRF guard must reject it. No probe
    # patch: the rejection happens in build_smtp_connection's host check.
    resp = operator_client.put(
        URL,
        {
            "transport_mode": "smtp",
            "host": "localhost",
            "port": 587,
            "security": "tls",
            "username": "u",
            "password": "s3cret",
        },
        format="json",
    )
    assert resp.status_code == 400
    assert WorkspaceEmailSettings.load().transport_mode == EmailTransportMode.CLOUD


def test_internal_bounce_webhook_rejected(operator_client: APIClient, _no_probe: None) -> None:
    resp = operator_client.patch(
        URL, {"bounce_webhook_url": "http://169.254.169.254/latest/meta-data/"}, format="json"
    )
    assert resp.status_code == 400
    assert "bounce_webhook_url" in resp.data


def test_from_name_crlf_rejected(operator_client: APIClient, _no_probe: None) -> None:
    resp = operator_client.patch(URL, {"from_name": "Ops\r\nBcc: victim@corp.test"}, format="json")
    assert resp.status_code == 400
    assert "from_name" in resp.data


def test_dkim_selector_injection_rejected(operator_client: APIClient, _no_probe: None) -> None:
    resp = operator_client.patch(URL, {"dkim_selector": "bad selector!"}, format="json")
    assert resp.status_code == 400
    assert "dkim_selector" in resp.data


# ---------------------------------------------------------------------------
# Dynamic backend resolver
# ---------------------------------------------------------------------------


def test_resolver_cloud_uses_global_backend(db: object) -> None:
    obj = WorkspaceEmailSettings.load()  # default cloud
    conn = resolve_email_connection(obj)
    # In tests the global EMAIL_BACKEND is locmem; it is NOT the smtp backend.
    assert "smtp" not in type(conn).__module__


def test_resolver_smtp_builds_from_model(db: object) -> None:
    obj = WorkspaceEmailSettings.load()
    obj.transport_mode = EmailTransportMode.SMTP
    obj.host = "mail.corp.test"
    obj.port = 2525
    obj.security = "ssl"
    obj.username = "u"
    obj.set_password("s3cret")
    obj.save()
    conn = resolve_email_connection(obj)
    assert conn.host == "mail.corp.test"
    assert conn.port == 2525
    assert conn.username == "u"
    assert conn.password == "s3cret"
    assert conn.use_ssl is True
    assert conn.use_tls is False


def test_resolver_sendgrid_forces_fixed_host(db: object) -> None:
    obj = WorkspaceEmailSettings.load()
    obj.transport_mode = EmailTransportMode.SENDGRID
    obj.host = "ignored.example"
    obj.set_password("SG.key")
    obj.save()
    conn = resolve_email_connection(obj)
    assert conn.host == email_backend.SENDGRID_HOST
    assert conn.username == email_backend.SENDGRID_USERNAME
    assert conn.password == "SG.key"


def test_resolver_falls_back_on_decrypt_failure(db: object) -> None:
    obj = WorkspaceEmailSettings.load()
    obj.transport_mode = EmailTransportMode.SMTP
    obj.host = "mail.corp.test"
    obj.password_ciphertext = b"not-a-valid-fernet-token"
    obj.save()
    # L3: a corrupt row must not crash — resolver logs and returns the global backend.
    conn = resolve_email_connection(obj)
    assert "smtp" not in type(conn).__module__


def test_from_identity_resolution(db: object) -> None:
    obj = WorkspaceEmailSettings.load()
    assert "@" in resolve_from_email(obj)  # falls back to DEFAULT_FROM_EMAIL
    assert resolve_reply_to(obj) == []
    obj.from_name = "TruePPM"
    obj.from_email = "hi@corp.test"
    obj.reply_to = "help@corp.test"
    obj.save()
    assert resolve_from_email(obj) == "TruePPM <hi@corp.test>"
    assert resolve_reply_to(obj) == ["help@corp.test"]


# ---------------------------------------------------------------------------
# Send-test action (M5)
# ---------------------------------------------------------------------------


def test_send_test_delivers_to_operator_only(operator_client: APIClient, operator: object) -> None:
    mail.outbox.clear()
    resp = operator_client.post(TEST_URL, {}, format="json")
    assert resp.status_code == 200
    assert resp.data["sent"] is True
    assert len(mail.outbox) == 1
    # Recipient is server-derived (the operator's own address) — never body input.
    assert mail.outbox[0].to == [operator.email]


def test_send_test_ignores_body_recipient(operator_client: APIClient, operator: object) -> None:
    mail.outbox.clear()
    resp = operator_client.post(TEST_URL, {"to": "attacker@evil.test"}, format="json")
    assert resp.status_code == 200
    assert mail.outbox[0].to == [operator.email]


def test_send_test_forbidden_for_project_admin(admin_client: APIClient) -> None:
    resp = admin_client.post(TEST_URL, {}, format="json")
    assert resp.status_code == 403


def test_send_test_requires_email_on_file(db: object) -> None:
    user = User.objects.create_superuser(username="noemail", email="", password="pw")
    client = APIClient()
    client.force_authenticate(user=user)
    resp = client.post(TEST_URL, {}, format="json")
    assert resp.status_code == 400
    assert resp.data["sent"] is False


# ---------------------------------------------------------------------------
# Deliverability health
# ---------------------------------------------------------------------------


def test_health_unavailable_without_from_domain(db: object) -> None:
    result = email_health.check_deliverability("", "")
    assert result["available"] is False


def test_health_endpoint_superuser_gated(
    operator_client: APIClient, admin_client: APIClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        email_health,
        "check_deliverability",
        lambda from_email, selector="": {
            "available": True,
            "domain": "corp.test",
            "spf": "pass",
            "dkim": "warn",
            "dmarc": "fail",
        },
    )
    assert admin_client.get(HEALTH_URL).status_code == 403
    resp = operator_client.get(HEALTH_URL)
    assert resp.status_code == 200
    assert resp.data["spf"] == "pass"
