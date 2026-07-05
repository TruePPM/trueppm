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
    # The emailed link points at the SPA confirm route and carries the uid.
    assert f"/reset-password/confirm/{uid}/" in body


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
