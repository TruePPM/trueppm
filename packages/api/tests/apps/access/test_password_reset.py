"""Self-service password reset endpoint tests (#765, ADR-0209).

Covers the two endpoints and the security properties they must hold:
  - the request endpoint returns an identical 200 for existing and non-existing
    addresses (no user enumeration) and only sends mail for a real account;
  - confirm with a valid uid+token sets the password and revokes every other
    session (all refresh tokens blacklisted);
  - invalid, unknown, and expired tokens all return the same ``invalid_token``;
  - the password policy is enforced server-side (length, number/symbol, reuse);
  - both endpoints are throttled under the shared ``password_reset`` scope.
"""

from __future__ import annotations

import html
import secrets

import pytest
from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.tokens import default_token_generator
from django.core import mail
from django.core.cache import cache
from django.test import override_settings
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode
from rest_framework.test import APIClient
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken

from trueppm_api.core.password_reset import enforce_reset_password_policy

User = get_user_model()

_REQUEST_URL = "/api/v1/auth/password/reset/"
_CONFIRM_URL = "/api/v1/auth/password/reset/confirm/"
_LOGIN_URL = "/api/v1/auth/token/"
_REFRESH_URL = "/api/v1/auth/token/refresh/"
_COOKIE = settings.AUTH_REFRESH_COOKIE_NAME

_LOCMEM = "django.core.mail.backends.locmem.EmailBackend"
_OLD_PASSWORD = "correct-horse-battery"
_NEW_PASSWORD = "N3w-Secure-Passw0rd!"


@pytest.fixture(autouse=True)
def _clear_throttle_cache():
    # The reset endpoints are scoped-throttled (password_reset). Isolate the LocMem
    # throttle history so repeated calls across tests don't trip the 5/min cap.
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def user():
    return User.objects.create_user(
        username="reset_user", email="reset@example.com", password=_OLD_PASSWORD
    )


def _uid_token(u) -> tuple[str, str]:
    return urlsafe_base64_encode(force_bytes(u.pk)), default_token_generator.make_token(u)


# ---------------------------------------------------------------------------
# Request endpoint — no user enumeration
# ---------------------------------------------------------------------------


@override_settings(EMAIL_BACKEND=_LOCMEM, FRONTEND_BASE_URL="https://ppm.example.com")
@pytest.mark.django_db
def test_request_existing_email_returns_200_and_sends_link(user) -> None:
    mail.outbox.clear()
    resp = APIClient().post(_REQUEST_URL, {"email": "reset@example.com"}, format="json")

    assert resp.status_code == 200
    assert len(mail.outbox) == 1
    body = mail.outbox[0].body
    uid, _ = _uid_token(user)
    # The emailed link points at the SPA confirm route and carries the uid — in
    # the URL FRAGMENT, never the path (#3553).
    assert f"/reset-password/confirm#uid={uid}&token=" in body


@override_settings(EMAIL_BACKEND=_LOCMEM, FRONTEND_BASE_URL="https://ppm.example.com")
@pytest.mark.django_db
def test_reset_link_carries_the_credential_only_in_the_fragment(user) -> None:
    """The uid/token pair must appear after the ``#`` and nowhere else (#3553).

    ``(uid, token)`` is a 30-minute bearer credential for the account. Everything
    before the fragment is visible to the SPA's own telemetry envelope, to its
    route-error boundary, to any path-logging proxy, and to any cross-origin
    destination as ``Referer``. A fragment is never transmitted to a server at
    all, so none of those can see it.

    Asserted on both MIME parts: the plain-text body and the HTML alternative are
    rendered separately, so a fix applied to one and not the other would leak
    through whichever the recipient's client displays.
    """
    mail.outbox.clear()
    APIClient().post(_REQUEST_URL, {"email": "reset@example.com"}, format="json")

    message = mail.outbox[0]
    uid, _ = _uid_token(user)
    parts = [message.body, *(content for content, _mimetype in message.alternatives)]

    for part in parts:
        # Locate the link, then split it at the fragment delimiter. The HTML part
        # renders the URL inside an href, where `&` is correctly written `&amp;`
        # (and decoded by every browser) — so unescape before parsing, rather
        # than asserting something weaker that a real breakage could satisfy.
        start = part.index("https://ppm.example.com/reset-password/confirm")
        link = html.unescape(part[start:].split()[0].split('"')[0])
        before_fragment, _, fragment = link.partition("#")

        assert before_fragment == "https://ppm.example.com/reset-password/confirm"
        assert "?" not in before_fragment, "a query string is sent to the server too"
        assert uid not in before_fragment
        assert fragment.startswith(f"uid={uid}&token=")
        # The token half must be present and non-empty — a link that lost it is
        # not "safe", it is broken.
        assert len(fragment.split("&token=")[1]) > 0


@override_settings(EMAIL_BACKEND=_LOCMEM, FRONTEND_BASE_URL="https://ppm.example.com")
@pytest.mark.django_db
def test_request_unknown_email_returns_200_and_sends_nothing() -> None:
    mail.outbox.clear()
    resp = APIClient().post(_REQUEST_URL, {"email": "nobody@example.com"}, format="json")

    assert resp.status_code == 200
    assert len(mail.outbox) == 0


@override_settings(EMAIL_BACKEND=_LOCMEM, FRONTEND_BASE_URL="https://ppm.example.com")
@pytest.mark.django_db
def test_request_response_body_is_identical_for_existing_and_unknown(user) -> None:
    client = APIClient()
    existing = client.post(_REQUEST_URL, {"email": "reset@example.com"}, format="json")
    cache.clear()  # avoid the throttle counting toward the second call
    unknown = client.post(_REQUEST_URL, {"email": "ghost@example.com"}, format="json")

    # No enumeration: the response is byte-identical whether or not the account exists.
    assert existing.status_code == unknown.status_code == 200
    assert existing.data == unknown.data


@override_settings(EMAIL_BACKEND=_LOCMEM, FRONTEND_BASE_URL="https://ppm.example.com")
@pytest.mark.django_db
def test_request_sso_only_account_sends_no_link_but_still_200() -> None:
    # An SSO-only account has an unusable password — it must get the same silent 200
    # and never a reset link (ADR-0209).
    sso_user = User.objects.create_user(username="sso_user", email="sso@example.com")
    sso_user.set_unusable_password()
    sso_user.save()

    mail.outbox.clear()
    resp = APIClient().post(_REQUEST_URL, {"email": "sso@example.com"}, format="json")

    assert resp.status_code == 200
    assert len(mail.outbox) == 0


@pytest.mark.django_db
def test_request_rejects_malformed_email() -> None:
    resp = APIClient().post(_REQUEST_URL, {"email": "not-an-email"}, format="json")
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Confirm endpoint — happy path + session revocation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_confirm_valid_token_sets_new_password(user) -> None:
    uid, token = _uid_token(user)
    resp = APIClient().post(
        _CONFIRM_URL,
        {"uid": uid, "token": token, "new_password": _NEW_PASSWORD},
        format="json",
    )

    assert resp.status_code == 200
    user.refresh_from_db()
    assert user.check_password(_NEW_PASSWORD)
    assert not user.check_password(_OLD_PASSWORD)


@pytest.mark.django_db
def test_confirm_revokes_all_other_sessions(user) -> None:
    client = APIClient()
    # Two active sessions → two outstanding refresh tokens.
    login1 = client.post(
        _LOGIN_URL, {"username": "reset_user", "password": _OLD_PASSWORD}, format="json"
    )
    cache.clear()
    login2 = client.post(
        _LOGIN_URL, {"username": "reset_user", "password": _OLD_PASSWORD}, format="json"
    )
    cache.clear()
    refresh_cookie_1 = login1.cookies[_COOKIE].value
    assert login2.status_code == 200
    assert OutstandingToken.objects.filter(user=user).count() == 2

    uid, token = _uid_token(user)
    confirm = client.post(
        _CONFIRM_URL,
        {"uid": uid, "token": token, "new_password": _NEW_PASSWORD},
        format="json",
    )
    assert confirm.status_code == 200

    # Every outstanding refresh token for the user is now blacklisted...
    assert BlacklistedToken.objects.filter(token__user=user).count() == 2
    # ...so a pre-reset refresh cookie can no longer be exchanged for an access token.
    cache.clear()
    client.cookies[_COOKIE] = refresh_cookie_1
    refresh = client.post(_REFRESH_URL)
    assert refresh.status_code == 401


@pytest.mark.django_db
def test_confirm_revokes_personal_access_tokens_but_not_project_tokens(user) -> None:
    """A password reset revokes the user's PATs but leaves org tokens alone (ADR-0214)."""
    from datetime import date

    from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
    from trueppm_api.apps.projects.models import ApiToken, Calendar, Project

    def _mint(**kwargs):
        raw = TOKEN_PREFIX + secrets.token_hex(32)
        return ApiToken.objects.create(
            name="tok",
            token_prefix=raw[len(TOKEN_PREFIX) :][:8],
            token_hash=sha256_hex(raw),
            **kwargs,
        )

    # Two personal tokens owned by the resetting user, plus one project token they
    # happen to have minted (an org asset).
    pat_a = _mint(owner=user)
    pat_b = _mint(owner=user)
    cal = Calendar.objects.create(name="Std")
    project = Project.objects.create(name="P", start_date=date(2026, 1, 5), calendar=cal)
    project_token = _mint(project=project, created_by=user)

    uid, token = _uid_token(user)
    resp = APIClient().post(
        _CONFIRM_URL,
        {"uid": uid, "token": token, "new_password": _NEW_PASSWORD},
        format="json",
    )
    assert resp.status_code == 200

    pat_a.refresh_from_db()
    pat_b.refresh_from_db()
    project_token.refresh_from_db()
    # Both personal tokens are revoked; the project token is untouched.
    assert pat_a.revoked_at is not None
    assert pat_b.revoked_at is not None
    assert project_token.revoked_at is None


@pytest.mark.django_db
def test_confirm_revokes_share_links_and_git_automation_secret(user) -> None:
    """#4006: a reset is the "my credentials are compromised" path, so it must

    revoke the same durable, non-token grants that off-boarding revokes
    (``_revoke_offboarded_credentials``) — a public share link the user minted and
    a git-automation webhook secret they configured — not just sessions and PATs.
    A co-admin's own grant on the same project must survive untouched.
    """
    from datetime import date

    from trueppm_api.apps.access.models import ProjectMembership, Role
    from trueppm_api.apps.integrations.models import BoardAutomation
    from trueppm_api.apps.projects.authentication import sha256_hex
    from trueppm_api.apps.projects.models import Calendar, Project, ShareLink

    calendar = Calendar.objects.create(name="Standard")
    project = Project.objects.create(name="P", start_date=date(2026, 1, 1), calendar=calendar)
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)

    coadmin = User.objects.create_user(username="coadmin_pwreset", password="pw")
    ProjectMembership.objects.create(project=project, user=coadmin, role=Role.ADMIN)

    user_link = ShareLink.objects.create(
        project=project,
        token_prefix="user-tok-pfx",
        token_hash=sha256_hex("user-share-link"),
        created_by=user,
    )
    coadmin_link = ShareLink.objects.create(
        project=project,
        token_prefix="coadmin-pfx",
        token_hash=sha256_hex("coadmin-share-link"),
        created_by=coadmin,
    )
    automation = BoardAutomation(project=project, enabled=True, configured_by=user)
    automation.set_secret("s3cr3t-webhook-token")
    automation.save()

    uid, token = _uid_token(user)
    resp = APIClient().post(
        _CONFIRM_URL,
        {"uid": uid, "token": token, "new_password": _NEW_PASSWORD},
        format="json",
    )
    assert resp.status_code == 200

    user_link.refresh_from_db()
    coadmin_link.refresh_from_db()
    automation.refresh_from_db()
    assert user_link.revoked_at is not None
    assert coadmin_link.revoked_at is None
    assert automation.has_secret is False


@pytest.mark.django_db
def test_confirm_revoked_share_link_serves_410_after_reset(user) -> None:
    """The revoked-row effect is observable from the public serve path, not just

    the model: a share link the resetting user minted 410s once the reset runs.
    """
    from datetime import date

    from trueppm_api.apps.projects.authentication import sha256_hex
    from trueppm_api.apps.projects.models import Calendar, Project, ShareLink

    calendar = Calendar.objects.create(name="Standard")
    project = Project.objects.create(
        name="P", start_date=date(2026, 1, 1), calendar=calendar, public_sharing=True
    )
    raw_token = "user-share-link-raw"
    ShareLink.objects.create(
        project=project,
        token_prefix=raw_token[:12],
        token_hash=sha256_hex(raw_token),
        created_by=user,
    )

    uid, token = _uid_token(user)
    confirm = APIClient().post(
        _CONFIRM_URL,
        {"uid": uid, "token": token, "new_password": _NEW_PASSWORD},
        format="json",
    )
    assert confirm.status_code == 200

    serve = APIClient().get(f"/api/v1/share/board/{raw_token}/")
    assert serve.status_code == 410


# ---------------------------------------------------------------------------
# Confirm endpoint — invalid / expired token (all indistinguishable)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_confirm_wrong_token_returns_invalid_token(user) -> None:
    uid, _ = _uid_token(user)
    resp = APIClient().post(
        _CONFIRM_URL,
        {"uid": uid, "token": "not-a-real-token", "new_password": _NEW_PASSWORD},
        format="json",
    )
    assert resp.status_code == 400
    assert resp.data["code"] == "invalid_token"


@pytest.mark.django_db
def test_confirm_unknown_uid_returns_same_invalid_token() -> None:
    # A uid for a non-existent user must be indistinguishable from a wrong token.
    uid = urlsafe_base64_encode(force_bytes(999999))
    resp = APIClient().post(
        _CONFIRM_URL,
        {"uid": uid, "token": "whatever", "new_password": _NEW_PASSWORD},
        format="json",
    )
    assert resp.status_code == 400
    assert resp.data["code"] == "invalid_token"


@pytest.mark.django_db
def test_confirm_malformed_uid_returns_invalid_token() -> None:
    resp = APIClient().post(
        _CONFIRM_URL,
        {"uid": "!!!not-base64!!!", "token": "whatever", "new_password": _NEW_PASSWORD},
        format="json",
    )
    assert resp.status_code == 400
    assert resp.data["code"] == "invalid_token"


@override_settings(PASSWORD_RESET_TIMEOUT=-1)
@pytest.mark.django_db
def test_confirm_expired_token_returns_invalid_token(user) -> None:
    # A negative timeout makes any freshly-minted token already expired, so
    # check_token rejects it — deterministic, no time travel needed.
    uid, token = _uid_token(user)
    resp = APIClient().post(
        _CONFIRM_URL,
        {"uid": uid, "token": token, "new_password": _NEW_PASSWORD},
        format="json",
    )
    assert resp.status_code == 400
    assert resp.data["code"] == "invalid_token"
    user.refresh_from_db()
    assert user.check_password(_OLD_PASSWORD)  # unchanged


@pytest.mark.django_db
def test_confirm_token_is_single_use(user) -> None:
    uid, token = _uid_token(user)
    client = APIClient()
    first = client.post(
        _CONFIRM_URL,
        {"uid": uid, "token": token, "new_password": _NEW_PASSWORD},
        format="json",
    )
    assert first.status_code == 200
    # The same token no longer validates once the password hash has changed.
    cache.clear()
    second = client.post(
        _CONFIRM_URL,
        {"uid": uid, "token": token, "new_password": "An0ther-Passw0rd!"},
        format="json",
    )
    assert second.status_code == 400
    assert second.data["code"] == "invalid_token"


# ---------------------------------------------------------------------------
# Confirm endpoint — password policy
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    "weak",
    [
        "short1!",  # < 10 chars
        "alllowercaseletters",  # >= 10 but no number/symbol
    ],
)
def test_confirm_weak_password_returns_weak_password(user, weak) -> None:
    uid, token = _uid_token(user)
    resp = APIClient().post(
        _CONFIRM_URL,
        {"uid": uid, "token": token, "new_password": weak},
        format="json",
    )
    assert resp.status_code == 400
    assert resp.data["code"] == "weak_password"
    assert isinstance(resp.data["messages"], list) and resp.data["messages"]
    user.refresh_from_db()
    assert user.check_password(_OLD_PASSWORD)  # unchanged


@pytest.mark.django_db
def test_confirm_rejects_reuse_of_current_password(user) -> None:
    uid, token = _uid_token(user)
    resp = APIClient().post(
        _CONFIRM_URL,
        {"uid": uid, "token": token, "new_password": _OLD_PASSWORD},
        format="json",
    )
    assert resp.status_code == 400
    assert resp.data["code"] == "weak_password"
    assert any("different" in m.lower() for m in resp.data["messages"])


@pytest.mark.django_db
def test_enforce_policy_aggregates_all_violations(user) -> None:
    # A too-short, letters-only password should surface both the length and the
    # number/symbol failures in one pass (rendered as an inline checklist).
    from django.core.exceptions import ValidationError as DjangoValidationError

    with pytest.raises(DjangoValidationError) as exc:
        enforce_reset_password_policy("abc", user)
    joined = " ".join(exc.value.messages).lower()
    assert "10 characters" in joined
    assert "number or symbol" in joined


# ---------------------------------------------------------------------------
# Throttling
# ---------------------------------------------------------------------------


@override_settings(EMAIL_BACKEND=_LOCMEM)
@pytest.mark.django_db
def test_request_endpoint_is_throttled() -> None:
    client = APIClient()
    # password_reset scope is 5/min; the 6th call from the same client is throttled.
    statuses = [
        client.post(_REQUEST_URL, {"email": "reset@example.com"}, format="json").status_code
        for _ in range(6)
    ]
    assert statuses[:5] == [200, 200, 200, 200, 200]
    assert statuses[5] == 429
