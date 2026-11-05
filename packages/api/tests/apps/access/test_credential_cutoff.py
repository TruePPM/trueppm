"""The per-user credential cutoff closes the stale-access-JWT window (#4499).

A password reset blacklists refresh tokens, but an access JWT is stateless and kept
working for the rest of its 15-minute lifetime — long enough to mint a WebSocket
ticket, a Personal Access Token, a project token (which a reset deliberately leaves
alone) or a share link, each of which outlived the reset. ``revoke_all_refresh_tokens``
now stamps ``UserProfile.credentials_revoked_at``, and every authenticator refuses a
credential issued at or before it.

Every refusal here is asserted as a **401** — the authenticator refuses the identity,
so the request must neither fall through to anonymous nor reach a permission class.
"""

from __future__ import annotations

import time
from datetime import date, timedelta
from typing import Any
from unittest.mock import patch

import pytest
from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.tokens import default_token_generator
from django.core.cache import cache
from django.utils import timezone
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken, RefreshToken

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.profiles.models import UserProfile
from trueppm_api.apps.projects.models import ApiToken, Calendar, Project, ShareLink
from trueppm_api.apps.sync import ws_auth
from trueppm_api.core.authentication import CredentialCutoffJWTAuthentication
from trueppm_api.core.credential_cutoff import (
    credentials_revoked_at,
    issued_before_cutoff,
    mark_credentials_revoked,
)

User = get_user_model()

_CONFIRM_URL = "/api/v1/auth/password/reset/confirm/"
_REFRESH_URL = "/api/v1/auth/token/refresh/"
_ME_URL = "/api/v1/auth/me/"
_TICKET_URL = "/api/v1/ws/ticket/"
_MY_TOKENS = "/api/v1/me/api-tokens/"
_COOKIE = settings.AUTH_REFRESH_COOKIE_NAME
_OLD_PASSWORD = "correct-horse-battery"
_NEW_PASSWORD = "N3w-Secure-Passw0rd!"


@pytest.fixture(autouse=True)
def _clear_throttle_cache() -> Any:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def user(db: object) -> Any:
    return User.objects.create_user(
        username="cutoff_user", email="cutoff@example.com", password=_OLD_PASSWORD
    )


@pytest.fixture
def project(user: Any) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    # public_sharing=True so the share-link mint is reachable at all — otherwise a
    # 403 from the sharing policy would stand in for the 401 this file asserts.
    proj = Project.objects.create(
        name="P", start_date=date(2026, 4, 1), calendar=calendar, public_sharing=True
    )
    ProjectMembership.objects.create(project=proj, user=user, role=Role.OWNER)
    return proj


def _bearer(raw: str) -> APIClient:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client


def _access_issued_at(user: Any, iat: int) -> str:
    token = AccessToken.for_user(user)
    token["iat"] = iat
    return str(token)


def _reset_password(user: Any) -> None:
    uid = urlsafe_base64_encode(force_bytes(user.pk))
    token = default_token_generator.make_token(user)
    resp = APIClient().post(
        _CONFIRM_URL, {"uid": uid, "token": token, "new_password": _NEW_PASSWORD}, format="json"
    )
    assert resp.status_code == 200, resp.data
    cache.clear()


def _mint_requests(project: Project) -> list[tuple[str, dict[str, Any]]]:
    """Every durable-grant mint the stale JWT used to reach (issue comment, 2026-10-18)."""
    return [
        (_TICKET_URL, {}),
        (_MY_TOKENS, {"name": "backdoor-pat"}),
        (f"/api/v1/projects/{project.pk}/api-tokens/", {"name": "backdoor-project"}),
        (f"/api/v1/projects/{project.pk}/share-links/", {"label": "backdoor-link"}),
    ]


# ---------------------------------------------------------------------------
# A JWT issued before the reset is refused everywhere
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_pre_reset_access_jwt_is_refused_on_rest(user: Any) -> None:
    stale = str(AccessToken.for_user(user))
    assert _bearer(stale).get(_ME_URL).status_code == 200

    _reset_password(user)

    resp = _bearer(stale).get(_ME_URL)
    assert resp.status_code == 401
    assert "signed out" in str(resp.data["detail"])
    assert resp.has_header("WWW-Authenticate")


@pytest.mark.django_db
def test_pre_reset_access_jwt_cannot_mint_any_durable_grant(user: Any, project: Project) -> None:
    stale = str(AccessToken.for_user(user))
    _reset_password(user)

    with patch("trueppm_api.apps.sync.views.issue_ticket", return_value="nope") as mint_ticket:
        for url, body in _mint_requests(project):
            resp = _bearer(stale).post(url, body, format="json")
            assert resp.status_code == 401, (url, resp.status_code, resp.data)
            cache.clear()

    mint_ticket.assert_not_called()
    assert not ApiToken.objects.filter(name__startswith="backdoor").exists()
    assert not ShareLink.objects.filter(label="backdoor-link").exists()


@pytest.mark.django_db
def test_offboarding_style_revocation_also_cuts_access_tokens(user: Any) -> None:
    """The cutoff lives in ``revoke_all_refresh_tokens``, so every caller gets it."""
    from trueppm_api.apps.access.services import revoke_all_refresh_tokens

    stale = str(AccessToken.for_user(user))
    revoke_all_refresh_tokens(user)

    assert credentials_revoked_at(User.objects.select_related("profile").get(pk=user.pk))
    assert _bearer(stale).get(_ME_URL).status_code == 401


# ---------------------------------------------------------------------------
# A JWT issued after the reset — and an account with no cutoff — keep working
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_access_jwt_issued_after_cutoff_works(user: Any, project: Project) -> None:
    cutoff = mark_credentials_revoked(user, at=timezone.now() - timedelta(seconds=10))
    fresh = _access_issued_at(user, int(cutoff.timestamp()) + 1)

    assert _bearer(fresh).get(_ME_URL).status_code == 200
    with patch("trueppm_api.apps.sync.views.issue_ticket", return_value="tkt"):
        assert _bearer(fresh).post(_TICKET_URL).status_code == 200
    resp = _bearer(fresh).post(
        f"/api/v1/projects/{project.pk}/share-links/", {"label": "ok"}, format="json"
    )
    assert resp.status_code == 201, resp.data


@pytest.mark.django_db
def test_login_after_reset_works_once_the_second_has_passed(user: Any) -> None:
    """The legitimate re-login after a reset must not be locked out."""
    _reset_password(user)
    # Move the cutoff back past the strict same-second boundary (see the next test).
    UserProfile.objects.filter(user=user).update(
        credentials_revoked_at=timezone.now() - timedelta(seconds=5)
    )

    login = APIClient().post(
        "/api/v1/auth/token/", {"username": "cutoff_user", "password": _NEW_PASSWORD}
    )
    assert login.status_code == 200, login.data
    assert _bearer(login.data["access"]).get(_ME_URL).status_code == 200


@pytest.mark.django_db
def test_user_without_any_cutoff_is_unaffected(user: Any) -> None:
    assert not UserProfile.objects.filter(user=user).exists()
    assert _bearer(str(AccessToken.for_user(user))).get(_ME_URL).status_code == 200

    UserProfile.objects.create(user=user)  # a profile row with a null cutoff
    assert _bearer(str(AccessToken.for_user(user))).get(_ME_URL).status_code == 200


# ---------------------------------------------------------------------------
# The iat boundary
# ---------------------------------------------------------------------------


def test_same_second_token_is_refused_strictly() -> None:
    """A token in the cutoff's own second cannot be ordered against it — refuse it."""
    cutoff = timezone.now().replace(microsecond=700_000)
    second = int(cutoff.timestamp())
    assert issued_before_cutoff(second - 1, cutoff)
    assert issued_before_cutoff(second, cutoff)
    assert not issued_before_cutoff(second + 1, cutoff)


def test_precise_comparison_for_self_recorded_issue_times() -> None:
    cutoff = timezone.now().replace(microsecond=700_000)
    ts = cutoff.timestamp()
    assert issued_before_cutoff(ts - 0.1, cutoff, whole_seconds=False)
    assert not issued_before_cutoff(ts + 0.1, cutoff, whole_seconds=False)


def test_no_cutoff_never_refuses_and_missing_iat_refuses_under_one() -> None:
    assert not issued_before_cutoff(None, None)
    cutoff = timezone.now()
    assert issued_before_cutoff(None, cutoff)
    assert issued_before_cutoff("123", cutoff)
    assert issued_before_cutoff(True, cutoff)


@pytest.mark.django_db
def test_authenticator_adds_no_query(user: Any, django_assert_num_queries: Any) -> None:
    """The cutoff rides on the user lookup the stock authenticator already runs."""
    mark_credentials_revoked(user, at=timezone.now() - timedelta(seconds=10))
    token = AccessToken(_access_issued_at(user, int(time.time())))
    with django_assert_num_queries(1):
        resolved = CredentialCutoffJWTAuthentication().get_user(token)
        assert resolved.pk == user.pk
        assert credentials_revoked_at(resolved) is not None


# ---------------------------------------------------------------------------
# Refresh tokens the blacklist cannot see
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_refresh_token_without_a_blacklist_row_is_refused_after_cutoff(user: Any) -> None:
    """A pre-#2999 refresh token has no OutstandingToken row; the cutoff still reaches it."""
    from rest_framework_simplejwt.token_blacklist.models import OutstandingToken

    refresh = RefreshToken.for_user(user)
    OutstandingToken.objects.filter(user=user).delete()
    mark_credentials_revoked(user)

    client = APIClient()
    client.cookies[_COOKIE] = str(refresh)
    assert client.post(_REFRESH_URL).status_code == 401


# ---------------------------------------------------------------------------
# WebSocket handshake
# ---------------------------------------------------------------------------


def _scope(query: str) -> dict[str, object]:
    return {"query_string": query.encode()}


def _set_cutoff(user: Any, at: Any) -> None:
    UserProfile.objects.update_or_create(user=user, defaults={"credentials_revoked_at": at})


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_ticket_minted_before_cutoff_is_refused(user: Any) -> None:
    from channels.db import database_sync_to_async

    issued = time.time() - 5
    await database_sync_to_async(_set_cutoff)(user, timezone.now())
    value = f"{user.pk}|{issued!r}"
    with patch.object(ws_auth, "consume_ticket", return_value=value):
        result = await ws_auth.authenticate_scope(_scope("ticket=tk"))
    assert result.user is None


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_ticket_minted_after_cutoff_and_legacy_ticket_connect(user: Any) -> None:
    from channels.db import database_sync_to_async

    await database_sync_to_async(_set_cutoff)(user, timezone.now() - timedelta(seconds=5))
    for value in (f"{user.pk}|{time.time()!r}", str(user.pk)):
        with patch.object(ws_auth, "consume_ticket", return_value=value):
            result = await ws_auth.authenticate_scope(_scope("ticket=tk"))
        assert result.user is not None and result.user.pk == user.pk, value


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_unparseable_ticket_time_is_refused_under_a_cutoff(user: Any) -> None:
    from channels.db import database_sync_to_async

    await database_sync_to_async(_set_cutoff)(user, timezone.now() - timedelta(seconds=5))
    with patch.object(ws_auth, "consume_ticket", return_value=f"{user.pk}|garbage"):
        result = await ws_auth.authenticate_scope(_scope("ticket=tk"))
    assert result.user is None


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_legacy_token_handshake_honors_the_cutoff(user: Any) -> None:
    from channels.db import database_sync_to_async

    cutoff = timezone.now() - timedelta(seconds=5)
    await database_sync_to_async(_set_cutoff)(user, cutoff)
    stale = _access_issued_at(user, int(cutoff.timestamp()) - 1)
    fresh = _access_issued_at(user, int(cutoff.timestamp()) + 1)

    assert await ws_auth.authenticate_token(stale) is None
    resolved = await ws_auth.authenticate_token(fresh)
    assert resolved is not None and resolved.pk == user.pk
