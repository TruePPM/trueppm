"""A durable-grant mint in flight across a password reset cannot survive the sweep (#4839).

#4499 makes a reset refuse every credential issued before it. It cannot help a mint
request that *already passed authentication* when the reset commits: the reset's
sweep runs under READ COMMITTED and cannot see the mint's uncommitted INSERT, so a PAT
or share link minted by a pre-reset token survived (and a PAT can have no expiry).
Both sides now take a row lock on the caller's ``UserProfile``
(``lock_and_recheck_credential_cutoff``), so they serialize.

Each mint endpoint is exercised in both orderings, with two real database connections
(threads), made deterministic with events and a ``pg_stat_activity`` wait probe rather
than sleeps:

- **reset first** — the reset has stamped the cutoff and swept, and is holding its
  transaction open. A mint carrying a pre-reset JWT (it passed authentication before
  the cutoff was visible) must block on the lock and then be refused with a 401.
- **mint first** — the mint holds the lock mid-request. The reset must wait for it, so
  its sweep sees and revokes what the mint wrote.

Negative control: removing the lock call from any endpoint makes that endpoint's tests
fail (the reset-first mint returns 201 and survives; the mint-first reset finishes
without waiting and misses the grant).
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import connection, connections, transaction
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.access.services import (
    create_program,
    revoke_all_personal_access_tokens,
    revoke_all_refresh_tokens,
    revoke_personal_durable_grants,
)
from trueppm_api.apps.integrations.models import BoardAutomation
from trueppm_api.apps.projects.models import (
    ApiToken,
    Calendar,
    Methodology,
    Program,
    Project,
    ShareLink,
)
from trueppm_api.apps.webhooks.models import Webhook
from trueppm_api.apps.workspace.models import InviteStatus, WorkspaceInvite
from trueppm_api.core.credential_cutoff import lock_and_recheck_credential_cutoff

User = get_user_model()

pytestmark = pytest.mark.django_db(transaction=True)

_TIMEOUT = 10


@dataclass
class _Mint:
    """One mint endpoint: how to call it and how to tell whether its grant survived."""

    id: str
    #: Dotted module whose ``lock_and_recheck_credential_cutoff`` name the view calls.
    patch_module: str
    url: Callable[[Project, Program], str]
    body: dict[str, Any]
    #: ``True`` when the grant is live after the call. ``None`` for grants the sweep
    #: deliberately leaves alone (project and program tokens are org assets).
    live: Callable[[Any], bool] | None
    success: int = 201


_MINTS = [
    _Mint(
        "pat",
        "trueppm_api.apps.projects.views",
        lambda p, g: "/api/v1/me/api-tokens/",
        {"name": "race-pat"},
        lambda u: ApiToken.objects.filter(owner=u, revoked_at__isnull=True).exists(),
    ),
    _Mint(
        "project-token",
        "trueppm_api.apps.projects.views",
        lambda p, g: f"/api/v1/projects/{p.pk}/api-tokens/",
        {"name": "race-project-token"},
        None,
    ),
    _Mint(
        "program-token",
        "trueppm_api.apps.projects.views",
        lambda p, g: f"/api/v1/programs/{g.pk}/api-tokens/",
        {"name": "race-program-token"},
        None,
    ),
    _Mint(
        "share-link",
        "trueppm_api.apps.projects.share_views",
        lambda p, g: f"/api/v1/projects/{p.pk}/share-links/",
        {"label": "race-link"},
        lambda u: ShareLink.objects.filter(created_by=u, revoked_at__isnull=True).exists(),
    ),
    _Mint(
        "automation-secret",
        "trueppm_api.apps.integrations.views",
        lambda p, g: f"/api/v1/integrations/projects/{p.pk}/git-automation/rotate-secret/",
        {},
        lambda u: (
            BoardAutomation.objects.filter(configured_by=u).exclude(secret_ciphertext=b"").exists()
        ),
    ),
    _Mint(
        "project-webhook",
        "trueppm_api.apps.webhooks.views",
        lambda p, g: f"/api/v1/projects/{p.pk}/webhooks/",
        {"url": "https://example.com/h", "events": ["task.created"]},
        lambda u: Webhook.objects.filter(created_by=u, is_active=True).exists(),
    ),
    _Mint(
        "program-webhook",
        "trueppm_api.apps.webhooks.views",
        lambda p, g: f"/api/v1/programs/{g.pk}/webhooks/",
        {"url": "https://example.com/h", "events": ["task.created"]},
        lambda u: Webhook.objects.filter(created_by=u, is_active=True).exists(),
    ),
    _Mint(
        "workspace-invite",
        "trueppm_api.apps.workspace.views",
        lambda p, g: "/api/v1/workspace/invites/",
        {"email": "race-invitee@example.com"},
        lambda u: WorkspaceInvite.objects.filter(
            invited_by=u, status=InviteStatus.PENDING
        ).exists(),
    ),
]


@pytest.fixture(autouse=True)
def _clear_cache() -> Any:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def user() -> Any:
    # Superuser so the workspace-invite endpoint is reachable; the project and program
    # memberships below make every other endpoint reachable on their own merits.
    return User.objects.create_user(
        username="race_user", email="race@example.com", password="pw", is_superuser=True
    )


@pytest.fixture
def project(user: Any) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    proj = Project.objects.create(
        name="P", start_date=date(2026, 4, 1), calendar=calendar, public_sharing=True
    )
    ProjectMembership.objects.create(project=proj, user=user, role=Role.OWNER)
    return proj


@pytest.fixture
def program(user: Any) -> Program:
    prog = create_program(name="G", description="", methodology=Methodology.HYBRID, created_by=user)
    assert ProgramMembership.objects.filter(program=prog, user=user).exists()
    return prog


def _waiters() -> int:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT count(*) FROM pg_stat_activity "
            "WHERE wait_event_type = 'Lock' AND datname = current_database()"
        )
        return int(cursor.fetchone()[0])


def _wait_until_blocked_or_done(thread: threading.Thread) -> None:
    """Return once ``thread`` is parked on a row lock or has finished."""
    deadline = time.monotonic() + _TIMEOUT
    while time.monotonic() < deadline:
        if not thread.is_alive() or _waiters() > 0:
            return
        time.sleep(0.02)
    raise AssertionError("thread neither blocked on a lock nor finished")


def _reset_sweep(user: Any, *, hold: threading.Event | None, swept: threading.Event) -> None:
    """What the confirm view does in its transaction, on this thread's own connection."""
    try:
        with transaction.atomic():
            revoke_all_refresh_tokens(user)
            revoke_all_personal_access_tokens(user, actor=user, reason="password_reset")
            revoke_personal_durable_grants(user, actor=user)
            swept.set()
            if hold is not None:
                assert hold.wait(_TIMEOUT)
    finally:
        connections.close_all()


def _mint(
    mint: _Mint, bearer: str, project: Project, program: Program, out: dict[str, Any]
) -> None:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {bearer}")
    try:
        out["resp"] = client.post(mint.url(project, program), mint.body, format="json")
    finally:
        connections.close_all()


def _join(*threads: threading.Thread) -> None:
    for t in threads:
        t.join(_TIMEOUT)
        assert not t.is_alive(), "a worker thread hung (deadlock?)"


@pytest.mark.parametrize("mint", _MINTS, ids=lambda m: m.id)
def test_mint_that_passed_auth_before_a_reset_commits_is_refused(
    mint: _Mint, user: Any, project: Project, program: Program
) -> None:
    """Reset swept and still open; a pre-reset JWT's mint blocks, then is refused."""
    stale = str(AccessToken.for_user(user))
    hold, swept = threading.Event(), threading.Event()
    reset = threading.Thread(
        target=_reset_sweep, args=(user,), kwargs={"hold": hold, "swept": swept}
    )
    reset.start()
    assert swept.wait(_TIMEOUT), "reset never reached its commit point"

    # The cutoff is not committed yet, so authentication (a plain read) still passes.
    out: dict[str, Any] = {}
    minter = threading.Thread(target=_mint, args=(mint, stale, project, program, out))
    minter.start()
    _wait_until_blocked_or_done(minter)
    hold.set()
    _join(reset, minter)

    assert out["resp"].status_code == 401, (mint.id, out["resp"].status_code, out["resp"].data)
    assert not ApiToken.objects.filter(name__startswith="race-").exists()
    assert not ShareLink.objects.filter(label="race-link").exists()
    assert not Webhook.objects.filter(created_by=user).exists()
    assert not WorkspaceInvite.objects.filter(invited_by=user).exists()


@pytest.mark.parametrize("mint", _MINTS, ids=lambda m: m.id)
def test_reset_waits_for_an_in_flight_mint_and_sweeps_what_it_wrote(
    mint: _Mint, user: Any, project: Project, program: Program
) -> None:
    """Mint holds the profile lock mid-request; the reset must wait, then revoke it."""
    token = str(AccessToken.for_user(user))
    locked, proceed, swept = threading.Event(), threading.Event(), threading.Event()

    def _pause_after_lock(request: Any) -> None:
        lock_and_recheck_credential_cutoff(request)
        locked.set()
        assert proceed.wait(_TIMEOUT)

    out: dict[str, Any] = {}
    with patch(f"{mint.patch_module}.lock_and_recheck_credential_cutoff", _pause_after_lock):
        minter = threading.Thread(target=_mint, args=(mint, token, project, program, out))
        minter.start()
        assert locked.wait(_TIMEOUT), "the mint never reached its lock"

        reset = threading.Thread(
            target=_reset_sweep, args=(user,), kwargs={"hold": None, "swept": swept}
        )
        reset.start()
        _wait_until_blocked_or_done(reset)
        proceed.set()
        _join(minter, reset)

    assert out["resp"].status_code == mint.success, (mint.id, out["resp"].data)
    if mint.live is not None:
        assert not mint.live(user), f"{mint.id} survived the reset's sweep"


def test_lock_creates_the_profile_row_when_none_exists(user: Any) -> None:
    """A user who never touched preferences has no profile; the lock must still exist."""
    from trueppm_api.apps.profiles.models import UserProfile

    assert not UserProfile.objects.filter(user=user).exists()

    class _Req:
        pass

    req = _Req()
    req.user = user  # type: ignore[attr-defined]
    req.auth = AccessToken.for_user(user)  # type: ignore[attr-defined]
    with transaction.atomic():
        lock_and_recheck_credential_cutoff(req)
    assert UserProfile.objects.filter(user=user).exists()


def test_lock_refuses_a_caller_with_no_iat_once_a_cutoff_exists(user: Any) -> None:
    from rest_framework.exceptions import AuthenticationFailed

    from trueppm_api.core.credential_cutoff import mark_credentials_revoked

    class _Req:
        pass

    req = _Req()
    req.user = user  # type: ignore[attr-defined]
    req.auth = None  # type: ignore[attr-defined]
    with transaction.atomic():
        lock_and_recheck_credential_cutoff(req)  # no cutoff yet: allowed
        mark_credentials_revoked(user)
    with transaction.atomic(), pytest.raises(AuthenticationFailed):
        lock_and_recheck_credential_cutoff(req)
