"""SSO provider configuration is session/JWT-only — a token cannot reach it (#3551).

The paired file for ``tests/apps/projects/test_token_management_is_session_only.py``.
That one closed the credential surface; this one closes the surface that can *manufacture*
a credential without touching a token at all.

**Why this surface belongs behind the same guard.** ``IsNotTokenAuthenticated`` refuses
any caller whose credential is an ``ApiToken``. Before this change the three SSO admin
views used the default authentication stack, so an admin's leaked ``legacy:full``
personal access token — the default scope for a newly minted one — could, with no
session at all:

* ``PUT`` ``auto_create_members=true`` with ``default_role`` ADMIN;
* add an attacker-controlled domain to ``allowed_email_domains``;
* rotate the IdP client secret;
* ``DELETE`` a provider with ``?confirm_lockout=true``.

One SSO login at the widened domain then mints a real, persistent ADMIN **session**.
Revoking the token afterwards does not revoke that session, so
``features/personal-access-tokens.md#revoking-a-token`` ("revoke the token and you are
contained") was false for an admin's token.

**The trap this file exists to avoid**, inherited from its pair: an *identity* refusal is
raised by the **authenticator**, so on that path ``request.auth`` is ``None`` and no
permission class runs at all. A suite that only exercises live tokens proves the 403 and
says nothing about the 401 — every test would stay green while the refusal path silently
regressed. So each refusal is asserted twice: a **live** token (403 from
``IsNotTokenAuthenticated``) and a **dead** one (401 from the authenticator).

**The second trap, specific to this surface.** Every token below is owned by a real
workspace ADMIN. If it were not, ``IsWorkspaceAdminStrict`` would answer 403 on its own
and every assertion here would pass against the unfixed code — a vacuous suite that reads
as proof. ``test_the_refusal_comes_from_the_token_guard_not_the_admin_gate`` pins that
distinction on the refusal envelope, which only ``IsNotTokenAuthenticated`` writes.
"""

from __future__ import annotations

import secrets
from datetime import timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import SCOPE_LEGACY_FULL, SCOPE_MCP_READ, ApiToken
from trueppm_api.apps.sso import services
from trueppm_api.apps.sso.models import SsoProviderPolicy
from trueppm_api.apps.workspace.permissions import IsWorkspaceAdminStrict

from .conftest import ISSUER, api_client, make_oidc_ctx

User = get_user_model()

COLLECTION = "/api/v1/workspace/sso/providers/"
DETAIL = COLLECTION + "generic/"
TEST_CONN = DETAIL + "test-connection/"


def _full_config() -> dict[str, Any]:
    return {
        "slug": "generic",
        "display_name": "Example IdP",
        "server_url": ISSUER,
        "client_id": "trueppm-web",
        "client_secret": "rotate-me",
        "allowed_email_domains": ["example.com"],
        "enabled": True,
    }


def _mint(owner: Any, **kwargs: Any) -> tuple[ApiToken, str]:
    """Mint a real ``ApiToken`` row and return it with its raw bearer value."""
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    kwargs.setdefault("expires_at", timezone.now() + timedelta(days=30))
    kwargs.setdefault("scopes", [SCOPE_LEGACY_FULL])
    token = ApiToken.objects.create(
        owner=owner,
        name=kwargs.pop("name", "pat"),
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
        **kwargs,
    )
    return token, raw


def _bearer(raw: str) -> APIClient:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client


def _jwt(user: Any) -> APIClient:
    """A real JWT bearer, not ``force_authenticate``.

    Both credentials arrive as ``Authorization: Bearer …`` and both are offered to the
    same authentication stack, so this is the assertion that the fix refuses *API
    tokens* rather than the Bearer scheme — the regression a blunter guard would cause,
    and one ``force_authenticate`` (which skips authentication entirely) cannot see.
    """
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {RefreshToken.for_user(user).access_token}")
    return client


# ---------------------------------------------------------------------------
# 1 — a live token is refused on every method of all three views
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_a_token_cannot_list_providers(admin: Any) -> None:
    """The reconnaissance step: the list discloses issuers, client ids and domains."""
    make_oidc_ctx()
    _, raw = _mint(admin)
    resp = _bearer(raw).get(COLLECTION)
    assert resp.status_code == 403, resp.data


@pytest.mark.django_db
def test_a_token_cannot_add_a_provider(admin: Any) -> None:
    """Adding a provider is adding a way in — the attacker's own IdP, if they choose."""
    _, raw = _mint(admin)
    resp = _bearer(raw).post(COLLECTION, _full_config(), format="json")
    assert resp.status_code == 403, resp.data
    assert not SsoProviderPolicy.objects.exists()


@pytest.mark.django_db
def test_a_token_cannot_read_one_provider(admin: Any) -> None:
    make_oidc_ctx()
    _, raw = _mint(admin)
    resp = _bearer(raw).get(DETAIL)
    assert resp.status_code == 403, resp.data


@pytest.mark.django_db
def test_a_token_cannot_widen_the_join_policy(admin: Any) -> None:
    """The escalation itself: a domain the attacker controls, auto-created as ADMIN.

    This is the write that turns a token leak into a durable session. Asserting the
    stored policy is unchanged — not just the status code — is what makes the test
    about containment rather than about a number.
    """
    from trueppm_api.apps.workspace.models import WorkspaceRole

    ctx = make_oidc_ctx(domains=["example.com"], auto_create=False)
    _, raw = _mint(admin)

    resp = _bearer(raw).put(
        DETAIL,
        {
            "allowed_email_domains": ["example.com", "attacker.test"],
            "auto_create_members": True,
            "default_role": WorkspaceRole.ADMIN,
        },
        format="json",
    )

    assert resp.status_code == 403, resp.data
    ctx.policy.refresh_from_db()
    assert ctx.policy.allowed_email_domains == ["example.com"]
    assert ctx.policy.auto_create_members is False


@pytest.mark.django_db
def test_a_token_cannot_rotate_the_client_secret(admin: Any) -> None:
    """A rotated secret is a denial of service against every member's only way in."""
    ctx = make_oidc_ctx(secret="original-secret")
    _, raw = _mint(admin)

    resp = _bearer(raw).put(DETAIL, {"client_secret": "attacker-secret"}, format="json")

    assert resp.status_code == 403, resp.data
    ctx.policy.refresh_from_db()
    assert ctx.policy.get_client_secret() == "original-secret"


@pytest.mark.django_db
def test_a_token_cannot_delete_a_provider_even_with_the_confirm_flag(admin: Any) -> None:
    """``?confirm_lockout=true`` is the most destructive query on the surface.

    The flag exists so a human is told the lockout count first (#2874). A token caller
    is by definition not being shown that number, so the confirmation it sends is not
    an informed one.
    """
    make_oidc_ctx()
    _, raw = _mint(admin)

    resp = _bearer(raw).delete(f"{DETAIL}?confirm_lockout=true")

    assert resp.status_code == 403, resp.data
    assert SsoProviderPolicy.objects.filter(slug="generic").exists()


@pytest.mark.django_db
def test_a_token_cannot_run_the_connection_probe(
    admin: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The probe drives server-side egress at an admin-chosen host.

    Read-only, so it is not the escalation — but leaving one method of the surface
    token-reachable is how a guard erodes, and this one hands a token holder an
    outbound request from inside the deployment.

    The probe is stubbed even though a passing run never reaches it: on a *regression*
    the request would fall through to the real ``check_provider_reachability`` and make
    a live DNS lookup for the fixture issuer, so the failure would arrive as a CI
    network timeout rather than as this assertion.
    """
    make_oidc_ctx()
    monkeypatch.setattr(
        services, "check_provider_reachability", lambda ctx: {"ok": True, "issuer": ctx.issuer}
    )
    _, raw = _mint(admin)
    resp = _bearer(raw).post(TEST_CONN, {}, format="json")
    assert resp.status_code == 403, resp.data


@pytest.mark.django_db
def test_the_refusal_comes_from_the_token_guard_not_the_admin_gate(admin: Any) -> None:
    """**The assertion that keeps this whole file from being vacuous.**

    ``IsWorkspaceAdminStrict`` also answers 403. If the tokens above belonged to a
    non-admin, every status-code assertion would pass against the *unfixed* code and
    this suite would certify a hole. The refusal envelope is written only by
    ``IsNotTokenAuthenticated`` (``_mark_policy_refusal``), so it is the one signal
    that distinguishes the two gates — and the declaration order that guarantees the
    token guard answers first is pinned in ``views.py``.
    """
    make_oidc_ctx()
    _, raw = _mint(admin)

    resp = _bearer(raw).get(COLLECTION)

    assert resp.status_code == 403, resp.data
    assert resp.data["refusal"] == {
        "verdict": "refused",
        "reason": "policy",
        "constraint": "capability_scope",
    }, resp.data


# ---------------------------------------------------------------------------
# 2 — the 401 arm: a dead token never reaches the permission class at all
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("path", [COLLECTION, DETAIL, TEST_CONN])
def test_a_revoked_token_is_refused_at_the_authenticator_not_the_permission(
    admin: Any, path: str
) -> None:
    """The path that would leave every 403 above green while the guard regressed.

    A revoked token never reaches ``IsNotTokenAuthenticated`` — the authenticator
    raises first and ``request.auth`` stays ``None``. A guard keyed on ``request.auth``
    is therefore *correct* only because it is a permission class rather than a check
    inside the view body, and only this pair of arms demonstrates that.

    ``test-connection`` is included even though it is POST-only: DRF runs ``initial()``
    — authenticate, then permissions, then throttles — before it resolves a handler, so
    a ``GET`` here is answered 401 rather than 405. That view is the one carrying extra
    throttle classes, which makes it the one where the ordering is least obvious and so
    the one most worth pinning.
    """
    make_oidc_ctx()
    _, raw = _mint(admin, revoked_at=timezone.now())

    resp = _bearer(raw).get(path)

    assert resp.status_code == 401, resp.data
    assert resp.data["refusal"]["reason"] == "identity", resp.data


@pytest.mark.django_db
def test_an_mcp_read_token_is_also_refused_at_the_authenticator(admin: Any) -> None:
    """Second 401 arm: a live token on the wrong surface, not a dead one.

    Without it the suite would prove only that a ``legacy:full`` token is refused and
    say nothing about any other scope. ``OwnerScopedApiTokenAuthentication`` rejects an
    ``mcp:read``-only token before permissions run, so the two refusal mechanisms both
    have to be covered for the surface to count as closed.
    """
    make_oidc_ctx()
    _, raw = _mint(admin, scopes=[SCOPE_MCP_READ])

    resp = _bearer(raw).get(COLLECTION)

    assert resp.status_code == 401, resp.data


@pytest.mark.django_db
@pytest.mark.parametrize("path", [COLLECTION, DETAIL, TEST_CONN])
def test_an_anonymous_caller_gets_401_not_403(db: object, path: str) -> None:
    """``IsAuthenticated`` is declared, so "no credential" is answered by the right class.

    ``IsNotTokenAuthenticated`` returns ``True`` for an anonymous caller — ``request.auth``
    is ``None``, not an ``ApiToken`` — so it contributes nothing here. Without
    ``IsAuthenticated`` the whole anonymous refusal would rest on
    ``IsWorkspaceAdminStrict``, which does fail closed but answers **403** where 401 is
    correct, and would be a single point of failure for a case that has nothing to do
    with workspace roles.
    """
    resp = APIClient().get(path) if path != TEST_CONN else APIClient().post(path, {}, format="json")
    assert resp.status_code == 401, resp.data


# ---------------------------------------------------------------------------
# 3 — guard the guard: a human admin can still configure SSO
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_a_jwt_session_can_still_create_read_and_update_a_provider(admin: Any) -> None:
    """The surface must stay fully usable by the human it is for.

    Driven with a real JWT rather than ``force_authenticate`` so the request goes
    through the same authentication stack the token requests do.
    """
    client = _jwt(admin)

    created = client.post(COLLECTION, _full_config(), format="json")
    assert created.status_code == 201, created.data

    assert client.get(COLLECTION).status_code == 200
    assert client.get(DETAIL).status_code == 200

    updated = client.put(DETAIL, {"display_name": "Renamed IdP"}, format="json")
    assert updated.status_code == 200, updated.data
    assert updated.data["display_name"] == "Renamed IdP"

    assert client.delete(DETAIL).status_code == 204


@pytest.mark.django_db
def test_a_jwt_session_can_still_run_the_connection_probe(
    admin: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    make_oidc_ctx()
    monkeypatch.setattr(
        services, "check_provider_reachability", lambda ctx: {"ok": True, "issuer": ctx.issuer}
    )

    resp = _jwt(admin).post(TEST_CONN, {}, format="json")

    assert resp.status_code == 200, resp.data
    assert resp.data["ok"] is True


@pytest.mark.django_db
def test_a_session_can_still_configure_sso(admin: Any) -> None:
    """``force_authenticate`` arm — authentication skipped entirely, ``request.auth`` None.

    Deliberately weaker than ``_jwt`` and kept for what it isolates: it proves the
    *permission* chain admits a caller carrying no credential object at all, which is
    the shape ``IsNotTokenAuthenticated`` must pass. It cannot detect a
    ``SessionAuthentication`` regression — nothing here goes through an authenticator —
    so do not read it as the cookie-session arm.
    """
    client = api_client(admin)
    assert client.post(COLLECTION, _full_config(), format="json").status_code == 201
    assert client.get(COLLECTION).status_code == 200


# ---------------------------------------------------------------------------
# 4 — the guard is declared statically, which is what the tripwires read
# ---------------------------------------------------------------------------

_SSO_ADMIN_PREFIX = "workspace/sso/"


def _sso_admin_view_classes() -> list[type]:
    """Every view class serving a route under ``workspace/sso/`` (providers + redirect-uri).

    Derived from ``get_resolver()`` so a route added later is covered the day it is
    added, rather than the day somebody remembers to extend a literal list.
    """
    from django.urls import URLPattern, URLResolver, get_resolver

    def walk(resolver: Any, prefix: str = "") -> list[tuple[str, URLPattern]]:
        out: list[tuple[str, URLPattern]] = []
        for entry in resolver.url_patterns:
            path = prefix + str(entry.pattern)
            if isinstance(entry, URLResolver):
                out.extend(walk(entry, path))
            elif isinstance(entry, URLPattern):
                out.append((path, entry))
        return out

    seen: dict[str, type] = {}
    for path, entry in walk(get_resolver()):
        if _SSO_ADMIN_PREFIX not in path:
            continue
        cls = getattr(entry.callback, "cls", None) or getattr(entry.callback, "view_class", None)
        if cls is not None:
            seen[cls.__name__] = cls
    return [seen[name] for name in sorted(seen)]


@pytest.mark.django_db
def test_every_sso_admin_view_declares_the_guard_class_level() -> None:
    """``permission_classes``, not ``get_permissions`` — and first in the list.

    Two consumers read the class attribute and would both go blind to a guard
    contributed at runtime: ``core/openapi.py::_token_callers_refused`` (which strips
    the token security schemes from the published schema) and the route-table tripwire
    in ``tests/apps/access/test_route_table_invariants.py`` (which pins the
    token-writable surface). That failure mode is documented in
    ``token_write_surface.txt``: a ~50-route widening once produced no diff because the
    walker could not see a runtime-only guard.

    Position matters too — DRF stops at the first class that returns ``False``, so a
    token caller's refusal is deterministic only while the token guard precedes the
    role gate. Asserted as an ordering rather than an index so that adding a further
    guard cannot make this vacuous: what must hold is *token guard before role gate*,
    not "second in the list".

    ``IsAuthenticated`` is asserted too. Declaring ``permission_classes`` replaces
    ``DEFAULT_PERMISSION_CLASSES`` wholesale, and ``IsNotTokenAuthenticated`` returns
    ``True`` for an anonymous caller (``request.auth`` is ``None``) — so without it the
    entire anonymous refusal would rest on ``IsWorkspaceAdminStrict`` alone. That does
    fail closed today, but as a single point of failure and with a 403 where 401 is the
    correct answer.

    The view set is derived from the **live URL resolver**, not hand-listed. A literal
    list of the three classes would say nothing about a *fourth* route added later — and
    the registry-wide backstop in ``tests/apps/access/test_route_table_invariants.py``
    would not catch it either, because that one filters on unsafe methods and a
    read-only admin route (say a GET-only ``.../{slug}/metadata/``) has none. Reads are
    exactly what ``IsWorkspaceAdminStrict``'s own docstring calls sensitive here.
    """
    from rest_framework.permissions import IsAuthenticated

    from trueppm_api.apps.access.permissions import IsNotTokenAuthenticated

    view_classes = _sso_admin_view_classes()
    assert len(view_classes) >= 4, (
        f"expected at least the four SSO admin views, resolved {len(view_classes)} — "
        "the resolver walk is probably broken rather than the surface having shrunk"
    )

    for view_cls in view_classes:
        declared = list(view_cls.permission_classes)
        name = view_cls.__name__
        assert IsAuthenticated in declared, f"{name} must declare IsAuthenticated, got {declared}"
        assert IsNotTokenAuthenticated in declared, (
            f"{name} must declare IsNotTokenAuthenticated, got {declared}"
        )
        assert IsWorkspaceAdminStrict in declared, (
            f"{name} must still declare IsWorkspaceAdminStrict, got {declared}"
        )
        assert declared.index(IsNotTokenAuthenticated) < declared.index(IsWorkspaceAdminStrict), (
            f"{name} must declare IsNotTokenAuthenticated before IsWorkspaceAdminStrict "
            f"so a token caller's refusal does not depend on the token owner's role; "
            f"got {declared}"
        )
