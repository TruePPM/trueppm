"""The hosted demo's read-only posture, asserted rather than assumed (#2773).

``try.trueppm.com`` is read-only *by construction*: the seeder is run without
``--with-personas`` so no login-capable account exists, there is no public
registration route to make one, and the only reachable surface is the tokenized
share endpoint, which is GET-only. That posture is real — and until this module
it was defended entirely by the **absence** of a flag in two YAML files and the
**absence** of a route. Nothing failed if someone added either.

Three one-line changes, each individually reasonable, silently invert it:

1. ``--with-personas`` added to a seed job for a sales walkthrough;
2. ``allauth.urls`` included to enable signup;
3. a demo PAT minted for a scripted tour.

The tests below fail on the first two. The third is a runtime act rather than a
code change, so it is covered by the surface assertion instead: whatever exists,
the *public* demo path stays GET-only.

Deliberately **property-based, not roster-based.** The pre-existing
``test_without_personas_creates_no_demo_users`` asserts the six known persona
usernames are absent — which passes unchanged if the seeder grows a seventh
account under a new name. These assert the property that actually matters:
*no seeded account can log in.*

The manifest half of this guard (the two YAML files must not carry the flag)
cannot be checked from pytest, because neither file is imported by anything;
``scripts/check-demo-readonly.sh`` covers it and runs in CI.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.urls import URLPattern, URLResolver, get_resolver

from trueppm_api.apps.projects.models import Project, ShareLink
from trueppm_api.apps.workspace.models import Workspace

if TYPE_CHECKING:
    from rest_framework.test import APIClient

User = get_user_model()

DEMO_TOKEN = "posture-test-demo-token"


def _seed_demo() -> Project:
    """Seed exactly as both demo manifests do — no ``--with-personas``."""

    call_command("seed_demo_project")
    return Project.objects.get(name="Platform Migration", is_sample=True)


# ---------------------------------------------------------------------------
# 1. Zero login-capable accounts
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_seed_without_personas_creates_no_login_capable_account() -> None:
    """No account that could authenticate exists after a default demo seed.

    ``has_usable_password()`` is the real predicate: a user row with an unusable
    password (``!``-prefixed) cannot authenticate through any password backend,
    and is what the seeder's non-persona path must leave behind — if it leaves a
    user row at all.
    """

    _seed_demo()

    login_capable = [u for u in User.objects.filter(is_active=True) if u.has_usable_password()]
    assert login_capable == [], (
        "seed_demo_project without --with-personas created an account that can log in: "
        f"{[u.get_username() for u in login_capable]}. The hosted demo's read-only posture "
        "depends on there being no way in."
    )


@pytest.mark.django_db
def test_seed_without_personas_creates_no_staff_or_superuser() -> None:
    """Independent of password state, no privileged row may be seeded.

    A staff/superuser row is reachable through the Django admin and through any
    future auth backend, so its absence is worth asserting separately rather
    than folding into the password check.
    """

    _seed_demo()

    privileged = User.objects.filter(is_staff=True) | User.objects.filter(is_superuser=True)
    assert not privileged.exists(), (
        "seed_demo_project without --with-personas created a staff/superuser account: "
        f"{list(privileged.values_list('username', flat=True))}"
    )


@pytest.mark.django_db
def test_with_personas_is_the_only_way_to_get_a_login() -> None:
    """The negative test above is only meaningful if the positive one holds.

    Without this, a seeder that stopped creating personas entirely would make
    the read-only assertion pass vacuously.
    """

    call_command("seed_demo_project", "--with-personas")

    login_capable = [u for u in User.objects.filter(is_active=True) if u.has_usable_password()]
    assert login_capable, (
        "--with-personas created no login-capable account, so the no-personas "
        "assertion above is now vacuous"
    )


# ---------------------------------------------------------------------------
# 2. No public registration route
# ---------------------------------------------------------------------------


def _all_routes(resolver: Any = None, prefix: str = "") -> list[str]:
    """Flatten the root URLconf into full route strings.

    Walks the resolver rather than grepping source, so an ``include()`` of a
    third-party urlconf (the allauth drift this guards) is seen for the routes
    it actually contributes, not for the one line that added it.
    """

    resolver = resolver if resolver is not None else get_resolver()
    routes: list[str] = []
    for entry in resolver.url_patterns:
        pattern = prefix + str(entry.pattern)
        if isinstance(entry, URLResolver):
            routes.extend(_all_routes(entry, pattern))
        elif isinstance(entry, URLPattern):
            routes.append(pattern)
    return routes


# Substrings that mark a self-service account-creation route. `register` is
# deliberately absent: DRF's `router.register()` names appear nowhere in a route
# *string*, but "registry" plausibly could, and the signup wording below is what
# allauth and every hand-rolled equivalent actually mount.
REGISTRATION_MARKERS = ("signup", "sign-up", "registration", "/register")

# The self-service password-reset routes (#765, ADR-0209). Named here as a
# literal so the guard test below fails loudly if they move, rather than passing
# because the substring stopped matching anything.
PASSWORD_RESET_ROUTE = "auth/password/reset/"


@pytest.mark.django_db
def test_root_urlconf_exposes_no_registration_route() -> None:
    """A visitor must not be able to mint themselves an account.

    ``ACCOUNT_EMAIL_VERIFICATION = "none"`` in settings is safe only for as long
    as this holds — the setting's own comment says so. Including ``allauth.urls``
    is a one-line change that would invert the demo's posture without failing
    anything else.
    """

    offenders = [r for r in _all_routes() if any(m in r.lower() for m in REGISTRATION_MARKERS)]
    assert offenders == [], (
        f"the root URLconf exposes what looks like a registration route: {offenders}. "
        "Public self-service signup is what makes the hosted demo mintable, and the "
        "read-only posture assumes it does not exist."
    )


@pytest.mark.django_db
def test_password_reset_is_not_an_account_creation_path() -> None:
    """Guard the marker list itself.

    Password reset legitimately exists and must keep existing; it is not a
    registration route. Asserting it survives the filter keeps a future
    over-broad marker (``account``, ``auth``) from being added silently.
    """

    routes = _all_routes()
    assert any(PASSWORD_RESET_ROUTE in r for r in routes), (
        f"expected {PASSWORD_RESET_ROUTE} to be present — if it moved, the "
        "REGISTRATION_MARKERS list above needs re-checking against reality"
    )


# ---------------------------------------------------------------------------
# 3. The demo's reachable surface is GET-only
# ---------------------------------------------------------------------------


def _publish_demo_link() -> ShareLink:
    """Seed, mint, and put the workspace in the state a working demo requires.

    ``public_sharing`` is enabled here rather than left at its default because
    these tests are about the *method surface* of the demo URL. The default-state
    behavior is a defect with its own test below and its own issue (#2781) — the
    two must not be conflated, or fixing one would silently un-test the other.
    """

    _seed_demo()
    workspace = Workspace.load()
    workspace.public_sharing = True
    workspace.save(update_fields=["public_sharing"])
    call_command("create_demo_share_link", token=DEMO_TOKEN)
    return ShareLink.objects.get(revoked_at__isnull=True)


@pytest.mark.django_db
def test_demo_share_link_surface_is_get_only(client: APIClient) -> None:
    """The one URL the demo publishes answers reads and refuses writes.

    This is the assertion that survives drift 3 (someone mints a demo PAT): it
    does not care what tokens exist, only that the *published* demo address is
    incapable of mutation.
    """

    link = _publish_demo_link()
    url = f"/api/v1/share/schedule/{DEMO_TOKEN}/"

    assert link.project.is_sample is True
    assert client.get(url).status_code == 200

    for method in ("post", "put", "patch", "delete"):
        response = getattr(client, method)(url)
        assert response.status_code == 405, (
            f"{method.upper()} {url} returned {response.status_code}, not 405 — the public "
            "demo share endpoint must be read-only"
        )


@pytest.mark.django_db
def test_demo_share_link_read_needs_no_credentials(client: APIClient) -> None:
    """No login, by design — so there is no login to attack.

    Stated as its own test because "the demo works anonymously" and "the demo is
    read-only" are separate properties, and a change that broke the first would
    otherwise look like a fixture problem.
    """

    _publish_demo_link()

    response = client.get(f"/api/v1/share/schedule/{DEMO_TOKEN}/")

    assert response.status_code == 200
    assert User.objects.filter(is_active=True).count() == 0


@pytest.mark.django_db
def test_demo_link_does_not_resolve_on_a_default_workspace() -> None:
    """Pins the #2781 defect: the demo is unreachable out of the box.

    ``Workspace.public_sharing`` defaults to ``False`` and nothing on the demo
    path turns it on, so the link ``create_demo_share_link`` confidently prints
    at startup answers ``410 Public sharing has been turned off``. Minting
    succeeds because the command calls ``mint_share_link()`` directly, below the
    API view's policy gate — only the read fails, which is why the startup log
    looks healthy.

    This asserts the **broken** behavior on purpose, so that fixing #2781 fails
    here and forces this test to be replaced by the 200 assertion rather than
    leaving a stale expectation behind.
    """

    from django.test import Client

    _seed_demo()
    call_command("create_demo_share_link", token=DEMO_TOKEN)

    response = Client().get(f"/api/v1/share/schedule/{DEMO_TOKEN}/")

    assert response.status_code == 410, (
        "the demo share link now resolves on a default workspace — #2781 is fixed. "
        "Delete this test and assert 200 in the two above without the "
        "public_sharing fixture."
    )
    assert Workspace.load().public_sharing is False
