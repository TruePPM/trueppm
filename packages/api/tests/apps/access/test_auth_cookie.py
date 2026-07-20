"""httpOnly refresh-cookie auth-flow tests (#897).

Covers the cookie-based login/refresh/logout flow:
  - login returns the access token in the body but NOT the refresh token, and
    sets a hardened httpOnly refresh cookie;
  - refresh reads the refresh token from that cookie (never the body) and returns
    a new access token, re-setting a rotated cookie;
  - refresh without the cookie is rejected;
  - logout clears the cookie.
"""

from __future__ import annotations

import pytest
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.response import Response
from rest_framework.test import APIClient
from rest_framework.throttling import ScopedRateThrottle

User = get_user_model()

_LOGIN_URL = "/api/v1/auth/token/"
_REFRESH_URL = "/api/v1/auth/token/refresh/"
_LOGOUT_URL = "/api/v1/auth/logout/"
_COOKIE = settings.AUTH_REFRESH_COOKIE_NAME


@pytest.fixture
def user():
    return User.objects.create_user(username="cookie_user", password="correct-horse-battery")


@pytest.fixture(autouse=True)
def _clear_throttle_cache():
    # The login/refresh endpoints are scoped-throttled; isolate the LocMem
    # throttle history so repeated logins across tests don't trip the cap.
    cache.clear()
    yield
    cache.clear()


@pytest.mark.django_db
def test_login_sets_httponly_refresh_cookie_and_omits_it_from_body(user) -> None:
    client = APIClient()
    resp = client.post(
        _LOGIN_URL,
        {"username": "cookie_user", "password": "correct-horse-battery"},
        format="json",
    )

    assert resp.status_code == 200
    # Access token is returned; refresh token is NOT in the JSON body.
    assert "access" in resp.data
    assert "refresh" not in resp.data

    # Refresh token rides in a hardened httpOnly cookie scoped to the refresh path.
    cookie = resp.cookies[_COOKIE]
    assert cookie.value  # non-empty refresh JWT
    assert cookie["httponly"]
    assert cookie["samesite"] == settings.AUTH_REFRESH_COOKIE_SAMESITE
    assert cookie["path"] == settings.AUTH_REFRESH_COOKIE_PATH


@pytest.mark.django_db
def test_refresh_reads_token_from_cookie_not_body(user) -> None:
    client = APIClient()
    login = client.post(
        _LOGIN_URL,
        {"username": "cookie_user", "password": "correct-horse-battery"},
        format="json",
    )
    refresh_value = login.cookies[_COOKIE].value

    # APIClient carries cookies forward automatically; refresh with an empty body.
    resp = client.post(_REFRESH_URL, {}, format="json")

    assert resp.status_code == 200
    assert "access" in resp.data
    # The refresh token is never echoed back in the body.
    assert "refresh" not in resp.data
    # Rotation re-sets the cookie with a fresh (different) token.
    assert _COOKIE in resp.cookies
    assert resp.cookies[_COOKIE].value != refresh_value


@pytest.mark.django_db
def test_refresh_without_cookie_is_rejected() -> None:
    client = APIClient()
    resp = client.post(_REFRESH_URL, {}, format="json")
    assert resp.status_code == 401


@pytest.mark.django_db
def test_refresh_ignores_token_in_body(user) -> None:
    # A token supplied in the body must be ignored — only the cookie is honored.
    # With no cookie present, even a syntactically valid body token yields 401.
    client = APIClient()
    login = client.post(
        _LOGIN_URL,
        {"username": "cookie_user", "password": "correct-horse-battery"},
        format="json",
    )
    body_token = login.cookies[_COOKIE].value
    # New client with no cookie jar carries the token only in the body.
    fresh = APIClient()
    resp = fresh.post(_REFRESH_URL, {"refresh": body_token}, format="json")
    assert resp.status_code == 401


@pytest.mark.django_db
def test_refresh_is_scope_throttled_past_the_cap(user, monkeypatch) -> None:
    """The refresh endpoint enforces the scoped ``refresh`` throttle (#814).

    With the rate tightened to 2/min, a third exchange inside the window is
    rejected with 429 rather than minting another access token — this bounds
    how fast a leaked refresh cookie can be traded for access tokens. The
    existing flow tests deliberately clear the throttle cache, so this is the
    only assertion that the limiter actually fires.

    The rate is patched on the throttle class rather than via
    ``override_settings``: DRF binds ``THROTTLE_RATES`` to a class attribute at
    import, so a settings override never reaches the already-bound throttle.
    """
    monkeypatch.setattr(
        ScopedRateThrottle,
        "THROTTLE_RATES",
        {**ScopedRateThrottle.THROTTLE_RATES, "refresh": "2/min"},
    )
    client = APIClient()
    login = client.post(
        _LOGIN_URL,
        {"username": "cookie_user", "password": "correct-horse-battery"},
        format="json",
    )
    assert login.status_code == 200

    # Two exchanges inside the window succeed; the token rotates each time and
    # the APIClient carries the freshest cookie forward.
    for _ in range(2):
        ok = client.post(_REFRESH_URL, format="json")
        assert ok.status_code == 200, ok.data

    throttled = client.post(_REFRESH_URL, format="json")
    assert throttled.status_code == 429


@pytest.mark.django_db
def test_logout_clears_refresh_cookie(user) -> None:
    client = APIClient()
    client.post(
        _LOGIN_URL,
        {"username": "cookie_user", "password": "correct-horse-battery"},
        format="json",
    )

    resp = client.post(_LOGOUT_URL, {}, format="json")

    assert resp.status_code == 205
    # delete_cookie emits the cookie with an empty value + immediate expiry.
    cleared = resp.cookies[_COOKIE]
    assert cleared.value == ""
    assert cleared["path"] == settings.AUTH_REFRESH_COOKIE_PATH


# ---------------------------------------------------------------------------
# Refresh-token revocation (#910) — requires the token_blacklist app, now
# installed by default. Rotation and logout must reject the prior refresh token
# rather than letting it live out its 7-day TTL.
# ---------------------------------------------------------------------------


def _login(client: APIClient) -> str:
    """Log in and return the refresh token set in the httpOnly cookie."""
    resp = client.post(
        _LOGIN_URL,
        {"username": "cookie_user", "password": "correct-horse-battery"},
        format="json",
    )
    assert resp.status_code == 200
    return resp.cookies[_COOKIE].value


@pytest.mark.django_db
def test_rotated_refresh_token_is_rejected_on_replay(user) -> None:
    """After rotation the previous refresh token is blacklisted and replay → 401."""
    client = APIClient()
    old_refresh = _login(client)

    # Rotate: the client carries the cookie forward; the old token is blacklisted.
    rotated = client.post(_REFRESH_URL, {}, format="json")
    assert rotated.status_code == 200

    # Replay the pre-rotation token from a fresh client that only has the old cookie.
    replay = APIClient()
    replay.cookies[_COOKIE] = old_refresh
    resp = replay.post(_REFRESH_URL, {}, format="json")
    assert resp.status_code == 401


@pytest.mark.django_db
def test_logged_out_refresh_token_is_rejected_on_replay(user) -> None:
    """After logout the cleared refresh token is blacklisted and replay → 401."""
    client = APIClient()
    old_refresh = _login(client)

    logout = client.post(_LOGOUT_URL, {}, format="json")
    assert logout.status_code == 205

    replay = APIClient()
    replay.cookies[_COOKIE] = old_refresh
    resp = replay.post(_REFRESH_URL, {}, format="json")
    assert resp.status_code == 401


@pytest.mark.django_db
def test_flush_expired_blacklisted_tokens_task_runs(user) -> None:
    """The nightly flush task runs cleanly when the blacklist app is installed."""
    from trueppm_api.apps.access.tasks import flush_expired_blacklisted_tokens

    # A login mints an OutstandingToken; the task flushes only *expired* rows, so
    # with a freshly-issued (unexpired) token it succeeds without deleting it.
    _login(APIClient())
    result = flush_expired_blacklisted_tokens()
    assert result["status"] == "ok"


def test_login_maps_serializer_tokenerror_to_invalid_token(monkeypatch) -> None:
    """A ``TokenError`` raised during login validation is re-raised as ``InvalidToken``.

    #1516: pins the defense-in-depth error mapping in ``CookieTokenObtainPairView.post``.
    simplejwt's login serializer normally raises ``AuthenticationFailed`` on bad
    credentials, but a token-construction failure surfaces as ``TokenError``; the
    view must translate it to ``InvalidToken`` (HTTP 401) rather than let a raw
    500 escape. Reached by direct call because no HTTP request naturally drives
    this branch.
    """
    from rest_framework.parsers import JSONParser
    from rest_framework.request import Request
    from rest_framework.test import APIRequestFactory
    from rest_framework_simplejwt.exceptions import InvalidToken, TokenError

    from trueppm_api.core import auth_views

    class _RaisingSerializer:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def is_valid(self, raise_exception: bool = False) -> bool:
            raise TokenError("token construction failed")

    monkeypatch.setattr(auth_views, "TokenObtainPairSerializer", _RaisingSerializer)

    raw = APIRequestFactory().post(_LOGIN_URL, {"username": "x", "password": "y"}, format="json")
    request = Request(raw, parsers=[JSONParser()])

    with pytest.raises(InvalidToken) as excinfo:
        auth_views.CookieTokenObtainPairView().post(request)

    # simplejwt's InvalidToken maps to a 401 through DRF's exception handler.
    assert excinfo.value.status_code == 401


# ---------------------------------------------------------------------------
# "Remember me" / session-only login (#2246, ADR-0544). remember_me=true → a
# persistent 30-day cookie + 30d token exp; unchecked/omitted → a session cookie
# (no Max-Age) + a short 12h sliding exp. The choice rides a `remember` claim on
# the refresh token so it survives rotation; pre-#2246 tokens (no claim) keep the
# legacy 7-day persistent behavior.
# ---------------------------------------------------------------------------

_REMEMBER_SECONDS = 30 * 24 * 3600
_SESSION_SECONDS = 12 * 3600
_LEGACY_SECONDS = 7 * 24 * 3600


def _login_remember(client: APIClient, *, remember: bool | None) -> Response:
    """Log in with an explicit remember_me (or omit it when remember is None)."""
    body: dict[str, object] = {"username": "cookie_user", "password": "correct-horse-battery"}
    if remember is not None:
        body["remember_me"] = remember
    resp = client.post(_LOGIN_URL, body, format="json")
    assert resp.status_code == 200, resp.data
    return resp


def _token_lifetime_and_remember(token_value: str):
    """Decode a fresh refresh token → (remember_claim, remaining_lifetime_seconds)."""
    from rest_framework_simplejwt.tokens import RefreshToken
    from rest_framework_simplejwt.utils import aware_utcnow, datetime_from_epoch

    rt = RefreshToken(token_value)  # type: ignore[arg-type]
    remaining = (datetime_from_epoch(rt["exp"]) - aware_utcnow()).total_seconds()
    return rt.payload.get("remember"), remaining


@pytest.mark.django_db
def test_remember_me_true_sets_persistent_30d_cookie_and_exp(user) -> None:
    client = APIClient()
    resp = _login_remember(client, remember=True)
    cookie = resp.cookies[_COOKIE]
    # Persistent cookie: an explicit ~30-day Max-Age so it survives browser close.
    assert int(cookie["max-age"]) == pytest.approx(_REMEMBER_SECONDS, abs=5)
    remember, remaining = _token_lifetime_and_remember(cookie.value)
    assert remember is True
    assert remaining == pytest.approx(_REMEMBER_SECONDS, abs=300)


@pytest.mark.django_db
@pytest.mark.parametrize("remember", [False, None])
def test_default_login_sets_session_cookie_with_12h_exp(user, remember) -> None:
    """Unchecked (False) and omitted both yield a session cookie + 12h exp."""
    client = APIClient()
    resp = _login_remember(client, remember=remember)
    cookie = resp.cookies[_COOKIE]
    # Session cookie: Django emits no Max-Age → the browser drops it on close.
    assert cookie["max-age"] == ""
    remember_claim, remaining = _token_lifetime_and_remember(cookie.value)
    assert remember_claim is False
    assert remaining == pytest.approx(_SESSION_SECONDS, abs=300)


@pytest.mark.django_db
@pytest.mark.parametrize("bad_value", ["false", "0", "true", 1, "yes"])
def test_non_boolean_remember_me_falls_back_to_session(user, bad_value) -> None:
    """A non-boolean remember_me must NOT be truthy-coerced into a persistent
    session (#2246): only JSON `true` opts in, so a string "true"/"false" or an int
    errs toward the safe session default rather than a 30-day credential."""
    client = APIClient()
    resp = client.post(
        _LOGIN_URL,
        {"username": "cookie_user", "password": "correct-horse-battery", "remember_me": bad_value},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    cookie = resp.cookies[_COOKIE]
    assert cookie["max-age"] == ""  # session cookie
    remember, remaining = _token_lifetime_and_remember(cookie.value)
    assert remember is False
    assert remaining == pytest.approx(_SESSION_SECONDS, abs=300)


@pytest.mark.django_db
def test_non_object_login_body_is_a_clean_4xx_not_500(user) -> None:
    """A non-object JSON body must not 500 — the remember_me read is dict-guarded."""
    client = APIClient()
    resp = client.post(_LOGIN_URL, [1, 2, 3], format="json")
    assert resp.status_code in (400, 401)


@pytest.mark.django_db
def test_remember_choice_survives_rotation(user) -> None:
    """Rotating a remember token keeps it persistent, 30d, and claim=True."""
    client = APIClient()
    _login_remember(client, remember=True)
    resp = client.post(_REFRESH_URL, {}, format="json")
    assert resp.status_code == 200
    cookie = resp.cookies[_COOKIE]
    assert int(cookie["max-age"]) == pytest.approx(_REMEMBER_SECONDS, abs=5)
    remember, remaining = _token_lifetime_and_remember(cookie.value)
    assert remember is True
    assert remaining == pytest.approx(_REMEMBER_SECONDS, abs=300)


@pytest.mark.django_db
def test_session_choice_survives_rotation(user) -> None:
    """Rotating a session token keeps it a session cookie, 12h, claim=False."""
    client = APIClient()
    _login_remember(client, remember=False)
    resp = client.post(_REFRESH_URL, {}, format="json")
    assert resp.status_code == 200
    cookie = resp.cookies[_COOKIE]
    assert cookie["max-age"] == ""
    remember, remaining = _token_lifetime_and_remember(cookie.value)
    assert remember is False
    assert remaining == pytest.approx(_SESSION_SECONDS, abs=300)


@pytest.mark.django_db
def test_legacy_token_without_remember_claim_rotates_to_7d_persistent(user) -> None:
    """A pre-#2246 token (no remember claim) keeps the legacy 7d persistent behavior.

    Back-compat: existing sessions must not be forcibly logged out or silently
    converted to session cookies. They stay legacy until the next fresh login.
    """
    from rest_framework_simplejwt.tokens import RefreshToken

    legacy = RefreshToken.for_user(user)  # no remember claim, 7d default exp
    assert "remember" not in legacy.payload

    client = APIClient()
    client.cookies[_COOKIE] = str(legacy)
    resp = client.post(_REFRESH_URL, {}, format="json")
    assert resp.status_code == 200

    cookie = resp.cookies[_COOKIE]
    # Still persistent, still ~7 days — unchanged from pre-#2246.
    assert int(cookie["max-age"]) == pytest.approx(_LEGACY_SECONDS, abs=5)
    remember, remaining = _token_lifetime_and_remember(cookie.value)
    assert remember is None  # no claim added — stays legacy
    assert remaining == pytest.approx(_LEGACY_SECONDS, abs=300)


@pytest.mark.django_db
def test_remember_login_syncs_outstanding_token_expiry_to_30d(user) -> None:
    """SECURITY: the OutstandingToken bookkeeping row's expires_at tracks the real
    30d exp, not the 7d default — otherwise a blacklisted remember token's
    revocation row would be flushed at day 7 while the JWT stays valid to day 30,
    making it replayable in that window (#2246, ADR-0544)."""
    from rest_framework_simplejwt.token_blacklist.models import OutstandingToken
    from rest_framework_simplejwt.tokens import RefreshToken
    from rest_framework_simplejwt.utils import aware_utcnow

    client = APIClient()
    resp = _login_remember(client, remember=True)
    jti = RefreshToken(resp.cookies[_COOKIE].value)["jti"]  # type: ignore[arg-type]

    row = OutstandingToken.objects.get(jti=jti)
    remaining = (row.expires_at - aware_utcnow()).total_seconds()
    assert remaining == pytest.approx(_REMEMBER_SECONDS, abs=600)


def test_login_openapi_schema_omits_phantom_refresh_field() -> None:
    """#997: the generated OpenAPI login response must NOT declare a ``refresh``
    field. The body only ever carries ``access`` (refresh is an httpOnly cookie),
    so a schema claiming a required ``refresh`` breaks every schema-driven client
    (the 0.4 read-only MCP server, generated SDKs)."""
    from drf_spectacular.generators import SchemaGenerator

    schema = SchemaGenerator().get_schema(request=None, public=True)
    login = schema["paths"]["/api/v1/auth/token/"]["post"]
    ref = login["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]
    response_schema = schema["components"]["schemas"][ref.rsplit("/", 1)[-1]]

    assert "access" in response_schema["properties"]
    assert "refresh" not in response_schema["properties"]
    assert "refresh" not in response_schema.get("required", [])
    # The phantom simplejwt TokenObtainPair schema (which still declares a
    # required refresh) must no longer be emitted at all.
    assert "TokenObtainPair" not in schema["components"]["schemas"]
