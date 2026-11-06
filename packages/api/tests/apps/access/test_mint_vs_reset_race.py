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

import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, timedelta
from io import StringIO
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.tokens import default_token_generator
from django.core.cache import cache
from django.core.management import call_command
from django.db import connection, connections, transaction
from django.utils import timezone
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.access.services import (
    create_program,
)
from trueppm_api.apps.integrations.models import BoardAutomation
from trueppm_api.apps.profiles.models import UserProfile
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
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
from trueppm_api.core.credential_cutoff import (
    lock_and_recheck_credential_cutoff,
    mark_credentials_revoked,
)

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


_CONFIRM_URL = "/api/v1/auth/password/reset/confirm/"
_NEW_PASSWORD = "N3w-Secure-Passw0rd!"
_EVICT = "trueppm_api.apps.access.signals.evict_all_live_project_sockets"


def _waiters() -> int:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT count(*) FROM pg_stat_activity "
            "WHERE wait_event_type = 'Lock' AND datname = current_database()"
        )
        return int(cursor.fetchone()[0])


def _wait_until_blocked_or_done(thread: threading.Thread) -> bool:
    """Return ``True`` once ``thread`` is parked on a row lock, ``False`` if it finished."""
    deadline = time.monotonic() + _TIMEOUT
    while time.monotonic() < deadline:
        if not thread.is_alive():
            return False
        if _waiters() > 0:
            return True
        time.sleep(0.02)
    raise AssertionError("thread neither blocked on a lock nor finished")


class _Reset:
    """A revocation the test can park at its commit point.

    The hook replaces ``evict_all_live_project_sockets``, which both the password-reset
    confirm view and ``revoke_api_tokens`` call as the LAST step inside their
    transaction, after every stamp and sweep. ``swept`` fires there; the transaction
    then stays open until ``hold`` is set. Driving the real view and command (not the
    services directly) means a reordering of their steps turns these tests red.
    """

    def __init__(self, user: Any, kind: str) -> None:
        self.user, self.kind = user, kind
        self.hold, self.swept = threading.Event(), threading.Event()
        self.status: int | None = None
        # make_token depends on the pre-reset password hash, so mint it up front.
        self._uid = urlsafe_base64_encode(force_bytes(user.pk))
        self._token = default_token_generator.make_token(user)

    def hook(self) -> Callable[[Any], Any]:
        from trueppm_api.apps.access.signals import evict_all_live_project_sockets as real

        def _evict(pk: Any) -> Any:
            result = real(pk)
            self.swept.set()
            assert self.hold.wait(_TIMEOUT)
            return result

        return _evict

    def run(self) -> None:
        try:
            if self.kind == "view":
                resp = APIClient().post(
                    _CONFIRM_URL,
                    {"uid": self._uid, "token": self._token, "new_password": _NEW_PASSWORD},
                    format="json",
                )
                self.status = resp.status_code
            else:
                call_command(
                    "revoke_api_tokens",
                    "--user",
                    self.user.username,
                    "--commit",
                    "--yes",
                    stdout=StringIO(),
                )
                self.status = 0
        finally:
            connections.close_all()

    def start(self) -> threading.Thread:
        thread = threading.Thread(target=self.run)
        thread.start()
        return thread


def _mint(
    call: Callable[[APIClient], Any], bearer: str, out: dict[str, Any], key: str = "resp"
) -> None:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {bearer}")
    try:
        out[key] = call(client)
    finally:
        connections.close_all()


def _post(mint: _Mint, project: Project, program: Program) -> Callable[[APIClient], Any]:
    return lambda c: c.post(mint.url(project, program), mint.body, format="json")


def _join(*threads: threading.Thread) -> None:
    for t in threads:
        t.join(_TIMEOUT)
        assert not t.is_alive(), "a worker thread hung (deadlock?)"


def _no_grants(user: Any) -> None:
    assert not ApiToken.objects.filter(name__startswith="race-").exists()
    assert not ShareLink.objects.filter(label="race-link").exists()
    assert not Webhook.objects.filter(created_by=user).exists()
    assert not WorkspaceInvite.objects.filter(invited_by=user).exists()


def _reset_first(
    reset_kind: str, call: Callable[[APIClient], Any], user: Any, bearer: str | None = None
) -> tuple[_Reset, dict[str, Any]]:
    """Park a revocation at its commit point, then run ``call`` with a pre-reset credential."""
    stale = bearer or str(AccessToken.for_user(user))
    reset = _Reset(user, reset_kind)
    with patch(_EVICT, reset.hook()):
        resetter = reset.start()
        assert reset.swept.wait(_TIMEOUT), "the revocation never reached its commit point"
        # The cutoff is not committed yet, so authentication (a plain read) passes.
        out: dict[str, Any] = {}
        minter = threading.Thread(target=_mint, args=(call, stale, out))
        minter.start()
        _wait_until_blocked_or_done(minter)
        reset.hold.set()
        _join(resetter, minter)
    return reset, out


def _mint_first(
    mint: _Mint,
    reset_kind: str,
    call: Callable[[APIClient], Any],
    user: Any,
    bearer: str | None = None,
    pause_before_lock: bool = False,
) -> dict[str, Any]:
    """Park a mint holding the profile lock, then run a revocation against it.

    With ``pause_before_lock`` the mint is parked after authentication but BEFORE it
    takes the profile lock, holding whatever row locks authentication itself took (the
    deadlock shape for an API-token caller). The revocation is then expected to run
    to completion rather than park behind the mint.
    """
    token = bearer or str(AccessToken.for_user(user))
    locked, proceed = threading.Event(), threading.Event()

    def _pause_after_lock(request: Any) -> None:
        if pause_before_lock:
            locked.set()
            assert proceed.wait(_TIMEOUT)
            lock_and_recheck_credential_cutoff(request)
            return
        lock_and_recheck_credential_cutoff(request)
        locked.set()
        assert proceed.wait(_TIMEOUT)

    reset = _Reset(user, reset_kind)
    reset.hold.set()
    out: dict[str, Any] = {}
    with (
        patch(f"{mint.patch_module}.lock_and_recheck_credential_cutoff", _pause_after_lock),
        patch(_EVICT, reset.hook()),
    ):
        minter = threading.Thread(target=_mint, args=(call, token, out))
        minter.start()
        assert locked.wait(_TIMEOUT), "the mint never reached its lock"
        resetter = reset.start()
        blocked = _wait_until_blocked_or_done(resetter)
        # The revocation must be parked behind the mint. Without the lock it runs to
        # completion here, and the grant the mint writes afterwards escapes the sweep.
        if not pause_before_lock:
            assert blocked and resetter.is_alive(), "the revocation did not wait for the mint"
        proceed.set()
        _join(minter, resetter)
    assert reset.status in (200, 0)
    return out


@pytest.mark.parametrize("mint", _MINTS, ids=lambda m: m.id)
def test_mint_that_passed_auth_before_a_reset_commits_is_refused(
    mint: _Mint, user: Any, project: Project, program: Program
) -> None:
    """Reset swept and still open; a pre-reset JWT's mint blocks, then is refused."""
    _, out = _reset_first("view", _post(mint, project, program), user)
    assert out["resp"].status_code == 401, (mint.id, out["resp"].status_code, out["resp"].data)
    _no_grants(user)


@pytest.mark.parametrize("mint", _MINTS, ids=lambda m: m.id)
def test_reset_waits_for_an_in_flight_mint_and_sweeps_what_it_wrote(
    mint: _Mint, user: Any, project: Project, program: Program
) -> None:
    """Mint holds the profile lock mid-request; the reset must wait, then revoke it.

    Project and program tokens are org assets the reset deliberately never revokes
    (``live`` is ``None``): for those this proves only that the reset serialized behind
    the mint and the mint completed.
    """
    out = _mint_first(mint, "view", _post(mint, project, program), user)
    assert out["resp"].status_code == mint.success, (mint.id, out["resp"].data)
    if mint.live is not None:
        assert not mint.live(user), f"{mint.id} survived the reset's sweep"


_SWEPT = [m for m in _MINTS if m.live is not None]


@pytest.mark.parametrize(
    "mint", [m for m in _SWEPT if m.id in {"pat", "share-link"}], ids=lambda m: m.id
)
def test_revoke_api_tokens_command_serializes_with_an_in_flight_mint(
    mint: _Mint, user: Any, project: Project, program: Program
) -> None:
    """``revoke_api_tokens --user`` stamps the cutoff (and takes the lock) before its sweep."""
    out = _mint_first(mint, "command", _post(mint, project, program), user)
    assert out["resp"].status_code == mint.success
    assert not mint.live(user), f"{mint.id} survived the command's sweep"  # type: ignore[misc]


@pytest.mark.parametrize(
    "mint", [m for m in _SWEPT if m.id in {"pat", "share-link"}], ids=lambda m: m.id
)
def test_revoke_api_tokens_command_refuses_a_stale_jwt_mint(
    mint: _Mint, user: Any, project: Project, program: Program
) -> None:
    _, out = _reset_first("command", _post(mint, project, program), user)
    assert out["resp"].status_code == 401
    _no_grants(user)


@pytest.mark.parametrize(
    "mint", [m for m in _SWEPT if m.id in {"pat", "share-link"}], ids=lambda m: m.id
)
def test_reset_first_when_the_profile_row_already_exists(
    mint: _Mint, user: Any, project: Project, program: Program
) -> None:
    """The row exists, so the mint waits on ``FOR UPDATE`` (not on an INSERT) and re-reads."""
    UserProfile.objects.create(user=user)
    _, out = _reset_first("view", _post(mint, project, program), user)
    assert out["resp"].status_code == 401
    _no_grants(user)


@pytest.mark.parametrize(
    "mint", [m for m in _SWEPT if m.id in {"pat", "share-link"}], ids=lambda m: m.id
)
def test_mint_first_when_the_profile_row_already_exists(
    mint: _Mint, user: Any, project: Project, program: Program
) -> None:
    UserProfile.objects.create(user=user)
    out = _mint_first(mint, "view", _post(mint, project, program), user)
    assert out["resp"].status_code == mint.success
    assert not mint.live(user)  # type: ignore[misc]


# --- webhook update: repoint / re-enable (WebhookViewSet.perform_update) -----------


@pytest.fixture
def foreign_webhook(project: Project) -> Webhook:
    """A webhook registered by someone else, so only the *editor* leg can sweep it."""
    other = User.objects.create_user(username="race_registrant", password="pw")
    return Webhook.objects.create(
        project=project,
        url="https://example.com/orig",
        secret="s" * 16,
        events=["task.created"],
        created_by=other,
    )


_WEBHOOK_EDITS = {
    "repoint": ({"url": "https://example.com/moved"}, True),
    "reenable": ({"is_active": True}, False),
}


@pytest.mark.parametrize("edit", sorted(_WEBHOOK_EDITS))
def test_webhook_edit_that_passed_auth_before_a_reset_is_refused(
    edit: str, user: Any, project: Project, foreign_webhook: Webhook
) -> None:
    body, start_active = _WEBHOOK_EDITS[edit]
    Webhook.objects.filter(pk=foreign_webhook.pk).update(is_active=start_active)
    url = f"/api/v1/projects/{project.pk}/webhooks/{foreign_webhook.pk}/"
    _, out = _reset_first("view", lambda c: c.patch(url, body, format="json"), user)
    assert out["resp"].status_code == 401, out["resp"].data
    foreign_webhook.refresh_from_db()
    assert foreign_webhook.url == "https://example.com/orig"
    assert foreign_webhook.is_active is start_active
    assert not foreign_webhook.editors.exists()


@pytest.mark.parametrize("edit", sorted(_WEBHOOK_EDITS))
def test_reset_sweeps_a_webhook_edit_that_was_in_flight(
    edit: str, user: Any, project: Project, foreign_webhook: Webhook
) -> None:
    body, start_active = _WEBHOOK_EDITS[edit]
    Webhook.objects.filter(pk=foreign_webhook.pk).update(is_active=start_active)
    url = f"/api/v1/projects/{project.pk}/webhooks/{foreign_webhook.pk}/"
    edit_mint = _Mint(
        "webhook-edit", "trueppm_api.apps.webhooks.views", lambda p, g: url, body, None, 200
    )
    out = _mint_first(edit_mint, "view", lambda c: c.patch(url, body, format="json"), user)
    assert out["resp"].status_code == 200, out["resp"].data
    foreign_webhook.refresh_from_db()
    assert foreign_webhook.editors.filter(user=user).exists()
    assert foreign_webhook.is_active is False, "the edited webhook survived the sweep"


# --- the lock must not lock out legitimate post-cutoff credentials ----------------


def _stamp_old_cutoff(user: Any) -> None:
    mark_credentials_revoked(user, at=timezone.now() - timedelta(seconds=30))


def _pat_for(user: Any, *, name: str = "race-pat-auth") -> str:
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    ApiToken.objects.create(
        name=name,
        owner=user,
        created_by=user,
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
    )
    return raw


@pytest.mark.parametrize("mint", _MINTS, ids=lambda m: m.id)
def test_jwt_issued_after_a_cutoff_can_still_mint(
    mint: _Mint, user: Any, project: Project, program: Program
) -> None:
    _stamp_old_cutoff(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {AccessToken.for_user(user)}")
    resp = _post(mint, project, program)(client)
    assert resp.status_code == mint.success, (mint.id, resp.status_code, resp.data)


def test_pat_created_after_the_cutoff_can_create_an_invite(user: Any) -> None:
    """Workspace invites accept API tokens; a PAT has no ``iat``, so ``created_at`` decides."""
    _stamp_old_cutoff(user)
    raw = _pat_for(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    resp = client.post("/api/v1/workspace/invites/", {"email": "pat-invitee@x.io"}, format="json")
    assert resp.status_code == 201, resp.data


def test_pat_created_before_the_cutoff_is_refused_for_an_invite(user: Any) -> None:
    raw = _pat_for(user)
    # A cutoff that postdates the PAT, with the PAT still un-revoked (the in-flight case).
    mark_credentials_revoked(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    resp = client.post("/api/v1/workspace/invites/", {"email": "pat-invitee@x.io"}, format="json")
    assert resp.status_code == 401, resp.data
    assert not WorkspaceInvite.objects.filter(email="pat-invitee@x.io").exists()


# --- an API-token caller must not deadlock against a revocation (#4839) -----------

_INVITE_URL = "/api/v1/workspace/invites/"
_INVITE = _Mint(
    "pat-invite", "trueppm_api.apps.workspace.views", lambda p, g: _INVITE_URL, {}, None
)


def _invite_call(client: APIClient) -> Any:
    return client.post(_INVITE_URL, {"email": "pat-race@example.com"}, format="json")


@pytest.mark.parametrize("reset_kind", ["view", "command"])
def test_pat_caller_mint_does_not_deadlock_with_a_revocation(reset_kind: str, user: Any) -> None:
    """Authentication used to hold the PAT row lock (a ``last_used_at`` UPDATE) while the
    mint reached for the profile lock; the revocation takes them in the opposite order
    and Postgres aborted one of them with ``deadlock detected``. A deadlocked reset rolls
    back with a 500, so a stolen PAT could repeatedly break a reset.
    """
    raw = _pat_for(user)
    out = _mint_first(_INVITE, reset_kind, _invite_call, user, bearer=raw, pause_before_lock=True)
    # The revocation finished (``_mint_first`` asserts a clean status) and the mint, which
    # carried a credential that predates the cutoff, was refused.
    assert out["resp"].status_code == 401, out["resp"]
    assert not WorkspaceInvite.objects.filter(email="pat-race@example.com").exists()


@pytest.mark.parametrize("reset_kind", ["view", "command"])
def test_pat_caller_mint_first_is_swept_and_reset_first_is_refused(
    reset_kind: str, user: Any
) -> None:
    raw = _pat_for(user)
    out = _mint_first(_INVITE, reset_kind, _invite_call, user, bearer=raw)
    assert out["resp"].status_code == 201, out["resp"].data
    assert not WorkspaceInvite.objects.filter(
        invited_by=user, status=InviteStatus.PENDING
    ).exists(), "the invite survived the sweep"


def test_pat_caller_reset_first_is_refused(user: Any) -> None:
    raw = _pat_for(user)
    _, out = _reset_first("view", _invite_call, user, bearer=raw)
    assert out["resp"].status_code == 401
    assert not WorkspaceInvite.objects.filter(email="pat-race@example.com").exists()


def test_pat_created_exactly_at_the_cutoff_is_refused(user: Any) -> None:
    """The comparison is ``<=``: a credential at the cutoff's own instant cannot be ordered."""
    raw = _pat_for(user)
    pat = ApiToken.objects.get(owner=user, name="race-pat-auth")
    mark_credentials_revoked(user, at=pat.created_at - timedelta(seconds=1))
    assert UserProfile.objects.get(user=user).credentials_revoked_at == pat.created_at
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    assert _invite_call(client).status_code == 401


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
