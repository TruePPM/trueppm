"""Demo read-only mode: deny-by-default write refusal (ADR-1197 D2, #3924).

The interactive demo publishes a login, and the seeded account is a Member, so the
role *permits* comments, reactions and attachments. This middleware is the only
thing standing between that account and every write; the tests below are therefore
built so that each one would fail if the guarantee quietly weakened:

* the refusal is asserted over the **route table itself**, not a hand-written list,
  so a route added next release is covered the day it lands;
* the allowlist is pinned to an exact literal, so growing it is a deliberate,
  reviewed act;
* every refusal is paired with the read that must keep working, so breaking the
  whole surface cannot satisfy a refusal test;
* the default (flag off) state is asserted separately from the flag-on state, with a
  negative control that would fail if the middleware were always on.
"""

from __future__ import annotations

import re
import uuid
from typing import Any
from unittest.mock import patch

import pytest
from django.conf import settings as django_settings
from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.core.exceptions import ImproperlyConfigured
from django.core.files.uploadedfile import SimpleUploadedFile
from django.http import HttpResponse
from django.test import Client, RequestFactory
from django.urls import Resolver404, resolve
from rest_framework.test import APIClient

from tests.apps.access.test_route_table_invariants import (
    _FORMAT_SUFFIX,
    _unsafe_pairs,
    _view_class,
    _walk,
)
from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Risk,
    RiskComment,
    Task,
    TaskAttachment,
    TaskComment,
)
from trueppm_api.core.demo_read_only import (
    ALLOWED_WRITES,
    DEMO_READ_ONLY_CODE,
    SAFE_METHODS,
    DemoReadOnlyMiddleware,
    parse_demo_read_only,
)

User = get_user_model()

_LOGIN = "/api/v1/auth/token/"
_REFRESH = "/api/v1/auth/token/refresh/"
_LOGOUT = "/api/v1/auth/logout/"
_PASSWORD_RESET = "/api/v1/auth/password/reset/"
_PASSWORD = "correct-horse-battery"


# ---------------------------------------------------------------------------
# Route-table enumeration (reuses the #2772 harness's walker)
# ---------------------------------------------------------------------------

_SAMPLES = {
    "uuid": "6f1c2a4e-3b5d-4e7a-9c1d-0a1b2c3d4e5f",
    "int": "1",
    "slug": "x",
    "str": "x",
    "path": "x",
}


def _sample_url(path: str) -> str:
    """A concrete URL for a walked route pattern, in ``path()`` and ``re_path()`` form.

    Regex groups are substituted first: ``(?P<pk>...)`` also contains ``<pk>``, which
    the ``path()`` converter pattern would otherwise chew on.
    """

    url = re.sub(r"\(\?P<\w+>[^)]*\)", "x", path)
    url = re.sub(r"<(?:(\w+):)?\w+>", lambda m: _SAMPLES[m.group(1) or "str"], url)
    url = url.replace("^", "").replace("$", "").replace("\\.", ".").replace("/?", "")
    return "/" + url


def _unsafe_routes() -> list[tuple[str, str, str, Any]]:
    """Every ``(method, path, url, entry)`` unsafe route the resolver serves.

    Format-suffix duplicates are dropped for the same reason the invariants file drops
    them: same view, same methods, and they would double the parameter list.
    """

    rows = []
    for path, entry in _walk():
        if _FORMAT_SUFFIX.search(path):
            continue
        cls = _view_class(entry)
        if cls is None:
            continue
        for method, _action in _unsafe_pairs(entry, cls):
            rows.append((method, path, _sample_url(path), entry))
    return sorted(rows, key=lambda r: (r[1], r[0]))


_ALL_UNSAFE = _unsafe_routes()


def _in_scope(method: str, url: str) -> bool:
    """Routes the middleware is meant to refuse: under ``/api/`` and not allowlisted."""

    return url.startswith("/api/") and (method, url) not in ALLOWED_WRITES


_SWEEP = [(m, u) for m, _p, u, _e in _ALL_UNSAFE if _in_scope(m, u)]


@pytest.fixture
def demo(settings: Any) -> Any:
    settings.DEMO_READ_ONLY = True
    return settings


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    # Login / password-reset are scoped-throttled; keep their counters per-test.
    cache.clear()
    yield
    cache.clear()


@pytest.fixture(autouse=True)
def _mute_side_channels() -> Any:
    """The flag-off control cases run real write paths: mute broadcast and Redis throttles."""

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch(
            "trueppm_api.apps.notifications.throttles.MentionRateThrottle.allow_request",
            return_value=True,
        ),
        patch("trueppm_api.apps.notifications.throttles.record_mention_usage"),
        patch(
            "trueppm_api.apps.projects.throttles.TaskAttachmentUploadThrottle.allow_request",
            return_value=True,
        ),
    ):
        yield


# ---------------------------------------------------------------------------
# The route-table sweep
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(("method", "url"), _SWEEP, ids=[f"{m} {u}" for m, u in _SWEEP])
def test_every_unsafe_route_is_refused(demo: Any, method: str, url: str) -> None:
    """Deny-by-default: every unsafe route in the route table answers 403 ``demo_read_only``.

    Sent anonymously on purpose. Refusing here, before authentication, is what makes the
    result independent of role, viewset and permission class -- which is the property
    under test. Covers router viewsets, ``@action`` routes and every bare ``path()``.
    """

    resp = Client().generic(method, url, data=b"{}", content_type="application/json")

    assert resp.status_code == 403, f"{method} {url} was not refused: {resp.status_code}"
    assert resp.json()["code"] == DEMO_READ_ONLY_CODE


def test_the_sweep_is_not_vacuous() -> None:
    """A walker that silently enumerates nothing would pass every test above."""

    methods = {m for m, _u in _SWEEP}
    assert methods == {"POST", "PUT", "PATCH", "DELETE"}
    # Measured 2026-09-20: ~340 (method, route) pairs. A floor well under that catches a
    # broken enumerator without turning every new endpoint into a failing assertion.
    assert len(_SWEEP) > 250


def test_every_route_sample_resolves_to_its_own_view() -> None:
    """The sweep must exercise the URL the route table means, not a URL that 404s.

    The middleware refuses before routing, so a mis-built sample would still be refused
    and the sweep would pass without ever testing the route it names. Resolving each
    sample back to the same callback is what keeps the sweep honest.
    """

    wrong = []
    for method, path, url, entry in _ALL_UNSAFE:
        if not url.startswith("/api/"):
            continue
        try:
            match = resolve(url)
        except Resolver404:
            wrong.append((method, path, url, "404"))
            continue
        if match.func is not entry.callback:
            wrong.append((method, path, url, "resolves to a different view"))
    assert wrong == []


def test_unsafe_routes_outside_api_are_pinned_to_the_admin_site() -> None:
    """The fence covers ``/api/``. Anything unsafe outside it must be a known exception.

    ``/admin/`` is closed by ``DJANGO_ADMIN_ENABLED`` and at the edge. A new write route
    mounted anywhere else -- outside the fence -- has to fail here and be decided
    deliberately, rather than being silently writable in the demo.
    """

    outside = {p.split("/", 1)[0] for _m, p, _u, _e in _ALL_UNSAFE if not p.startswith("api/")}
    assert outside == {"admin"}


def test_a_route_that_does_not_exist_is_refused_not_404(demo: Any) -> None:
    """Deny-by-default includes routes nobody has written yet."""

    resp = Client().post(
        "/api/v1/a-route-added-next-release/", data=b"{}", content_type="application/json"
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == DEMO_READ_ONLY_CODE


@pytest.mark.parametrize("method", ["TRACE", "PROPFIND", "MADE-UP"])
def test_an_unrecognized_method_is_refused_as_a_write(demo: Any, method: str) -> None:
    """Only GET/HEAD/OPTIONS are safe; an unknown verb is not waved through."""

    assert method not in SAFE_METHODS
    resp = Client().generic(method, "/api/v1/projects/")
    assert resp.status_code == 403
    assert resp.json()["code"] == DEMO_READ_ONLY_CODE


@pytest.mark.parametrize(
    "url",
    [
        "/api/v1/auth/token",  # no trailing slash: not the allowlisted path
        "/api/v1/auth/token/extra/",  # no prefix matching on allowlisted paths
        "/api/v1/auth/logout",
        "/api/v1/auth/token/refresh",
    ],
)
def test_path_tricks_do_not_reach_the_allowlist(demo: Any, url: str) -> None:
    resp = Client().generic("POST", url, data=b"{}", content_type="application/json")
    assert resp.status_code == 403
    assert resp.json()["code"] == DEMO_READ_ONLY_CODE


@pytest.mark.parametrize(
    "path_info",
    [
        "//api/v1/projects/",  # leading slashes are not a way around the /api/ prefix
        "///api/v1/projects/",
        "//api/v1/auth/token/",  # ... nor onto the allowlist, which matches exactly
        "///api/v1/auth/token/",
    ],
)
def test_leading_slashes_are_not_a_way_around_the_fence(demo: Any, path_info: str) -> None:
    """Driven through the middleware directly: Django's test client parses ``//x`` as a host.

    A server can hand the app a ``path_info`` with a run of leading slashes. Whether the
    resolver would 404 it is not something the fence should depend on, so the request
    must be refused *before* it gets that far.
    """

    reached = []
    middleware = DemoReadOnlyMiddleware(
        lambda request: reached.append(request) or HttpResponse("ok")
    )
    request = RequestFactory().post("/placeholder/")
    request.path_info = path_info

    response = middleware(request)

    assert response.status_code == 403
    assert reached == [], "the request was passed to the rest of the stack"


# ---------------------------------------------------------------------------
# The allowlist is the whole guarantee
# ---------------------------------------------------------------------------


def test_the_allowlist_is_pinned_and_fails_when_it_grows() -> None:
    """Exact literal. Adding an entry means editing this test, in the same reviewed diff.

    ADR-1197 Risks: the allowlist is the whole guarantee, and one careless addition
    re-opens a write path. A subset check would let it grow silently; equality does not.
    """

    assert {
        ("POST", "/api/v1/auth/token/"),
        ("POST", "/api/v1/auth/token/refresh/"),
        ("POST", "/api/v1/auth/logout/"),
    } == ALLOWED_WRITES


def test_every_allowlisted_write_is_a_real_route() -> None:
    """A renamed auth route must fail here, not leave a stale entry that guards nothing."""

    real = {(m, u) for m, _p, u, _e in _ALL_UNSAFE}
    assert real >= ALLOWED_WRITES


def test_the_allowlist_is_only_post() -> None:
    assert {m for m, _p in ALLOWED_WRITES} == {"POST"}


# ---------------------------------------------------------------------------
# Off by default -- a normal install is unaffected
# ---------------------------------------------------------------------------


def test_the_flag_is_off_by_default() -> None:
    """Asserted from the default state, not inferred from the flag-on tests."""

    assert django_settings.DEMO_READ_ONLY is False


@pytest.mark.django_db
def test_with_the_flag_off_writes_reach_their_views() -> None:
    """Negative control: this fails if the middleware were always on.

    Each request below is refused *by its view* (401/400), never with the demo code. If
    the middleware ignored the flag, the first assertion would see 403 + ``demo_read_only``.
    """

    assert django_settings.DEMO_READ_ONLY is False
    anon_write = Client().post("/api/v1/projects/", data=b"{}", content_type="application/json")
    assert anon_write.status_code in (401, 403)
    assert "demo_read_only" not in anon_write.content.decode()

    bad_login = Client().post(_LOGIN, data=b"{}", content_type="application/json")
    assert bad_login.status_code == 400  # serializer validation -- the view ran

    mail.outbox.clear()
    User.objects.create_user(username="normal", email="normal@example.com", password=_PASSWORD)
    reset = Client().post(
        _PASSWORD_RESET, data={"email": "normal@example.com"}, content_type="application/json"
    )
    assert reset.status_code == 200
    assert len(mail.outbox) == 1  # the write path really ran


@pytest.mark.django_db
def test_reads_are_never_refused(demo: Any) -> None:
    """Safe methods pass the fence. The view may still answer 405 for a verb it does not serve."""

    assert Client().get("/api/v1/health/").status_code == 200
    for method in ("HEAD", "OPTIONS"):
        resp = Client().generic(method, "/api/v1/health/")
        assert resp.status_code != 403, method
        assert "demo_read_only" not in resp.content.decode(), method


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, False),
        ("", False),
        ("false", False),
        ("FALSE", False),
        ("0", False),
        ("no", False),
        ("off", False),
        (" true ", True),
        ("TRUE", True),
        ("1", True),
        ("yes", True),
        ("on", True),
    ],
)
def test_parse_recognized_values(raw: str | None, expected: bool) -> None:
    assert parse_demo_read_only(raw) is expected


@pytest.mark.parametrize("raw", ["ture", "flase", "2", "enabled", "tru", "yes please"])
def test_parse_refuses_to_boot_on_an_ambiguous_value(raw: str) -> None:
    """``env.bool`` would read every one of these as False and silently disable the mode."""

    with pytest.raises(ImproperlyConfigured):
        parse_demo_read_only(raw)


@pytest.mark.parametrize("bad", ["false", "", "0", None, 1, "yes"])
def test_a_non_boolean_setting_value_enforces_rather_than_disables(settings: Any, bad: Any) -> None:
    """Fail closed at request time too: only an exact ``False`` lets a write through."""

    settings.DEMO_READ_ONLY = bad
    resp = Client().post("/api/v1/projects/", data=b"{}", content_type="application/json")
    assert resp.status_code == 403
    assert resp.json()["code"] == DEMO_READ_ONLY_CODE


def test_the_middleware_runs_ahead_of_session_and_authentication() -> None:
    """Position is the anonymous-POST guarantee, so it is asserted, not assumed."""

    stack = list(django_settings.MIDDLEWARE)
    ours = stack.index("trueppm_api.core.demo_read_only.DemoReadOnlyMiddleware")
    assert ours < stack.index("django.contrib.sessions.middleware.SessionMiddleware")
    assert ours < stack.index("django.contrib.auth.middleware.AuthenticationMiddleware")


# ---------------------------------------------------------------------------
# The refusal shape
# ---------------------------------------------------------------------------


def test_the_refusal_shape_is_stable(demo: Any) -> None:
    resp = Client().delete(f"/api/v1/projects/{uuid.uuid4()}/")
    assert resp.status_code == 403
    assert resp["Content-Type"].startswith("application/json")
    body = resp.json()
    assert set(body) == {"detail", "code"}
    assert body["code"] == "demo_read_only"
    assert isinstance(body["detail"], str) and body["detail"]


def test_a_refusal_still_carries_the_correlation_id_and_csp(demo: Any) -> None:
    """Outer middleware wraps the refusal, so logs and headers stay attributable."""

    resp = Client().post("/api/v1/projects/", data=b"{}", content_type="application/json")
    assert resp.status_code == 403
    assert resp.has_header("Content-Security-Policy")
    assert resp.has_header("X-Request-ID")


# ---------------------------------------------------------------------------
# Method override: the fence keys on the real HTTP method
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "extra",
    [
        {"HTTP_X_HTTP_METHOD_OVERRIDE": "GET"},
        {"HTTP_X_HTTP_METHOD": "GET"},
        {"HTTP_X_METHOD_OVERRIDE": "GET"},
    ],
)
def test_a_method_override_header_cannot_downgrade_a_write(
    demo: Any, extra: dict[str, str]
) -> None:
    resp = Client().post("/api/v1/projects/", data=b"{}", content_type="application/json", **extra)
    assert resp.status_code == 403
    assert resp.json()["code"] == DEMO_READ_ONLY_CODE


def test_a_method_override_form_field_cannot_downgrade_a_write(demo: Any) -> None:
    for field in ("_method", "method", "_METHOD"):
        resp = Client().post("/api/v1/projects/", data={field: "GET"})
        assert resp.status_code == 403
        assert resp.json()["code"] == DEMO_READ_ONLY_CODE

    resp = Client().post(
        "/api/v1/projects/?_method=GET", data=b"{}", content_type="application/json"
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_a_method_override_cannot_upgrade_a_read_into_a_write(demo: Any) -> None:
    """The reverse direction: a GET stays a GET, so it cannot be turned into a DELETE."""

    project = Project.objects.create(
        name="P", start_date="2026-01-01", calendar=Calendar.objects.create(name="Std")
    )
    user = User.objects.create_user(username="reader", password=_PASSWORD)
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    client = APIClient()
    client.force_authenticate(user=user)

    resp = client.get(
        f"/api/v1/projects/{project.pk}/?_method=DELETE",
        HTTP_X_HTTP_METHOD_OVERRIDE="DELETE",
    )
    assert resp.status_code == 200
    assert Project.objects.filter(pk=project.pk).exists()


# ---------------------------------------------------------------------------
# Login genuinely works under the flag
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_login_refresh_and_logout_work_under_the_flag(demo: Any) -> None:
    """The three allowlisted writes complete, and the database writes they make succeed.

    Login is not a pure read: issuing a token records an ``OutstandingToken`` row, and
    refresh rotation blacklists one and records another. That is why the allowlist
    exists at all, and why a read-only database user would have broken sign-in.
    """

    from rest_framework_simplejwt.token_blacklist.models import (
        BlacklistedToken,
        OutstandingToken,
    )

    User.objects.create_user(username="demo-visitor", password=_PASSWORD)
    client = APIClient()

    login = client.post(_LOGIN, {"username": "demo-visitor", "password": _PASSWORD}, format="json")
    assert login.status_code == 200
    assert login.json().get("code") != DEMO_READ_ONLY_CODE
    assert "access" in login.json()
    assert OutstandingToken.objects.count() == 1

    refresh = client.post(_REFRESH, {}, format="json")
    assert refresh.status_code == 200
    assert "access" in refresh.json()
    assert BlacklistedToken.objects.count() == 1  # rotation wrote through the fence

    logout = client.post(_LOGOUT, {}, format="json")
    assert logout.status_code == 205


@pytest.mark.django_db
def test_a_wrong_password_is_still_refused_by_the_login_view_not_the_middleware(demo: Any) -> None:
    User.objects.create_user(username="demo-visitor", password=_PASSWORD)
    resp = Client().post(
        _LOGIN,
        data={"username": "demo-visitor", "password": "wrong"},
        content_type="application/json",
    )
    assert resp.status_code == 401
    assert "demo_read_only" not in resp.content.decode()


# ---------------------------------------------------------------------------
# Anonymous POSTs
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_password_reset_request_is_refused_so_the_demo_is_not_an_email_relay(demo: Any) -> None:
    """The request endpoint mails an arbitrary address; refusing it closes the relay."""

    User.objects.create_user(username="target", email="target@example.com", password=_PASSWORD)
    mail.outbox.clear()

    resp = Client().post(
        _PASSWORD_RESET, data={"email": "target@example.com"}, content_type="application/json"
    )

    assert resp.status_code == 403
    assert resp.json()["code"] == DEMO_READ_ONLY_CODE
    assert mail.outbox == []


@pytest.mark.django_db
def test_password_reset_confirm_is_refused(demo: Any) -> None:
    resp = Client().post(
        _PASSWORD_RESET + "confirm/",
        data={"uid": "x", "token": "y", "new_password": "N3w-Secure-Passw0rd!"},
        content_type="application/json",
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == DEMO_READ_ONLY_CODE


@pytest.mark.django_db
def test_an_unauthenticated_project_create_is_refused(demo: Any) -> None:
    resp = Client().post("/api/v1/projects/", data={"name": "x"}, content_type="application/json")
    assert resp.status_code == 403
    assert resp.json()["code"] == DEMO_READ_ONLY_CODE


# ---------------------------------------------------------------------------
# Named must-refuse cases -- the demo account is a Member, so the role PERMITS these
# ---------------------------------------------------------------------------


@pytest.fixture
def world(db: object) -> dict[str, Any]:
    """A project with a Member, one task, one seeded comment and one seeded risk."""

    project = Project.objects.create(
        name="Atlas", start_date="2026-01-01", calendar=Calendar.objects.create(name="Std")
    )
    member = User.objects.create_user(username="demo-member", password=_PASSWORD)
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    other = User.objects.create_user(username="seed-author", password=_PASSWORD)
    ProjectMembership.objects.create(project=project, user=other, role=Role.MEMBER)
    task = Task.objects.create(project=project, name="Foundation", duration=1)
    comment = TaskComment.objects.create(task=task, author=other, body="seeded comment")
    risk = Risk.objects.create(
        project=project, title="Slippage", probability=3, impact=4, created_by=other
    )
    RiskComment.objects.create(risk=risk, author=other, message="seeded risk comment")
    client = APIClient()
    client.force_authenticate(user=member)
    return {
        "project": project,
        "task": task,
        "comment": comment,
        "risk": risk,
        "client": client,
        "member": member,
    }


def _task_base(w: dict[str, Any]) -> str:
    return f"/api/v1/projects/{w['project'].pk}/tasks/{w['task'].pk}"


def test_a_member_cannot_create_a_task_comment(demo: Any, world: dict[str, Any]) -> None:
    before = TaskComment.objects.count()
    resp = world["client"].post(f"{_task_base(world)}/comments/", {"body": "hello"}, format="json")
    assert resp.status_code == 403
    assert resp.json()["code"] == DEMO_READ_ONLY_CODE
    assert TaskComment.objects.count() == before


def test_a_member_cannot_create_a_risk_comment(demo: Any, world: dict[str, Any]) -> None:
    before = RiskComment.objects.count()
    url = f"/api/v1/projects/{world['project'].pk}/risks/{world['risk'].pk}/comments/"
    resp = world["client"].post(url, {"message": "hello"}, format="json")
    assert resp.status_code == 403
    assert resp.json()["code"] == DEMO_READ_ONLY_CODE
    assert RiskComment.objects.count() == before


def test_a_member_cannot_react_to_a_comment(demo: Any, world: dict[str, Any]) -> None:
    url = f"{_task_base(world)}/comments/{world['comment'].pk}/reactions/"
    resp = world["client"].post(url, {"emoji": "👍"}, format="json")
    assert resp.status_code == 403
    assert resp.json()["code"] == DEMO_READ_ONLY_CODE
    assert world["comment"].reactions.count() == 0


def test_a_member_cannot_upload_an_attachment(demo: Any, world: dict[str, Any]) -> None:
    """Multipart, the shape a real browser upload takes."""

    upload = SimpleUploadedFile("a.pdf", b"%PDF-1.4 x", content_type="application/pdf")
    resp = world["client"].post(
        f"{_task_base(world)}/attachments/", {"file": upload}, format="multipart"
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == DEMO_READ_ONLY_CODE
    assert TaskAttachment.objects.count() == 0


def test_the_same_writes_succeed_with_the_flag_off(world: dict[str, Any]) -> None:
    """Negative control for the four cases above: the role permits them, only D2 refuses.

    If this passes while the tests above also pass, the refusal is coming from the
    middleware and not from a permission that happened to be missing from the fixture.
    """

    assert django_settings.DEMO_READ_ONLY is False
    client = world["client"]
    assert (
        client.post(f"{_task_base(world)}/comments/", {"body": "hi"}, format="json").status_code
        == 201
    )
    risk_url = f"/api/v1/projects/{world['project'].pk}/risks/{world['risk'].pk}/comments/"
    assert client.post(risk_url, {"message": "hi"}, format="json").status_code == 201
    react = f"{_task_base(world)}/comments/{world['comment'].pk}/reactions/"
    assert client.post(react, {"emoji": "👍"}, format="json").status_code == 201
    upload = SimpleUploadedFile("a.pdf", b"%PDF-1.4 x", content_type="application/pdf")
    att = client.post(f"{_task_base(world)}/attachments/", {"file": upload}, format="multipart")
    assert att.status_code == 201, att.content


# ---------------------------------------------------------------------------
# The read counterpart of each refusal still works
# ---------------------------------------------------------------------------


def test_seeded_comments_still_render(demo: Any, world: dict[str, Any]) -> None:
    resp = world["client"].get(f"{_task_base(world)}/comments/")
    assert resp.status_code == 200
    assert [c["body"] for c in resp.json()["results"]] == ["seeded comment"]


def test_seeded_risk_comments_still_render(demo: Any, world: dict[str, Any]) -> None:
    url = f"/api/v1/projects/{world['project'].pk}/risks/{world['risk'].pk}/comments/"
    resp = world["client"].get(url)
    assert resp.status_code == 200
    assert [c["message"] for c in resp.json()["results"]] == ["seeded risk comment"]


def test_seeded_reactions_still_render(settings: Any, world: dict[str, Any]) -> None:
    """A reaction seeded before the mode was on stays visible on the comment list."""

    world["comment"].reactions.create(user=world["member"], emoji="👍")
    settings.DEMO_READ_ONLY = True
    resp = world["client"].get(f"{_task_base(world)}/comments/")
    assert resp.status_code == 200
    row = resp.json()["results"][0]
    assert row["reaction_count"] == 1
    assert row["has_my_reaction"] is True


def test_a_seeded_attachment_still_downloads_via_the_signed_url_route(
    settings: Any, world: dict[str, Any]
) -> None:
    """Seeded before the flag went on (as the importer does), read after it did."""

    client = world["client"]
    upload = SimpleUploadedFile("a.pdf", b"%PDF-1.4", content_type="application/pdf")
    created = client.post(f"{_task_base(world)}/attachments/", {"file": upload}, format="multipart")
    assert created.status_code == 201, created.content
    att_id = created.json()["id"]

    settings.DEMO_READ_ONLY = True
    listing = client.get(f"{_task_base(world)}/attachments/")
    assert listing.status_code == 200
    assert [a["id"] for a in listing.json()["results"]] == [att_id]

    with patch(
        "trueppm_api.core.security_checks.storage_backend_supports_signed_urls",
        return_value=True,
    ):
        signed = client.get(f"{_task_base(world)}/attachments/{att_id}/signed-url/")
    assert signed.status_code == 200
    assert "url" in signed.json()
