"""A Jira 429 is re-queued, not dead-lettered as "unreachable" (#2924).

`external_sources.py` folded a 429 into the generic ``ExternalSourceError``, and
the sync worker ``_mark_dead``s that arm as ``unreachable: ExternalSourceError``.
So a **transient rate limit read to the owner as a broken connection** — no
``Retry-After`` honored and no automatic retry. The file's own comment said the
backoff "is the #1419 sync worker's job"; #1419's worker *is* that file, and it
did not implement it.

A 429 is categorically different from the failures around it: it is the source
telling us *when* to come back. So it re-queues against that clock, and it
deliberately does **not** touch the connection status — the credential is valid
and the host is reachable, and flagging it would send the user to re-issue a
token that was never the problem.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import AbstractBaseUser
from django.utils import timezone

from trueppm_api.apps.integrations import http, tasks
from trueppm_api.apps.integrations.encryption import encrypt_secret
from trueppm_api.apps.integrations.external_sources import (
    ExternalSourceError,
    ExternalSourceRateLimited,
    JiraSource,
    parse_retry_after,
)
from trueppm_api.apps.integrations.models import (
    ExternalSyncRequest,
    ExternalSyncRequestStatus,
    ExternalWorkItem,
    IntegrationCredential,
)
from trueppm_api.apps.integrations.tasks import _do_poll

User = get_user_model()
pytestmark = pytest.mark.django_db

_JIRA_BASE = "https://acme.atlassian.net"


class _FakeResult:
    id = "fake-task-id"


@pytest.fixture(autouse=True)
def _no_broker(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tasks.external_sync, "delay", lambda *a, **k: _FakeResult())


@pytest.fixture
def user() -> AbstractBaseUser:
    return User.objects.create_user(username="rl_user", password="pw")


def _connect(user: AbstractBaseUser) -> IntegrationCredential:
    return IntegrationCredential.objects.create(
        user=user,
        provider="jira",
        secret_ciphertext=encrypt_secret("jira-token"),
        base_url=_JIRA_BASE,
        config={"account_email": "priya@acme.io", "jql": "", "status": "connected"},
    )


def _dispatched_request(user: AbstractBaseUser, **kwargs: Any) -> ExternalSyncRequest:
    return ExternalSyncRequest.objects.create(
        user=user, source="jira", status=ExternalSyncRequestStatus.DISPATCHED, **kwargs
    )


def _mock_429(monkeypatch: pytest.MonkeyPatch, headers: dict[str, str] | None = None) -> None:
    monkeypatch.setattr(http, "get", lambda *a, **k: http.EgressResponse(429, b"{}", headers or {}))


# --------------------------------------------------------------------------- #
# Header parsing
# --------------------------------------------------------------------------- #


def test_retry_after_delta_seconds() -> None:
    assert parse_retry_after({"Retry-After": "45"}) == 45.0


def test_retry_after_is_case_insensitive() -> None:
    """EgressResponse carries a plain dict, not a case-folding mapping."""
    assert parse_retry_after({"retry-after": "45"}) == 45.0


@pytest.mark.parametrize(
    "headers",
    [{}, {"Retry-After": ""}, {"Retry-After": "later"}, {"Retry-After": "-1"}],
    ids=["absent", "empty", "unparseable", "negative"],
)
def test_unusable_retry_after_degrades_to_none(headers: dict[str, str]) -> None:
    assert parse_retry_after(headers) is None


# --------------------------------------------------------------------------- #
# The source
# --------------------------------------------------------------------------- #


def test_jira_429_raises_rate_limited_with_the_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_429(monkeypatch, {"Retry-After": "30"})

    with pytest.raises(ExternalSourceRateLimited) as excinfo:
        JiraSource().fetch_assigned_items(
            base_url=_JIRA_BASE, secret="t", config={"account_email": "p@acme.io"}
        )

    assert excinfo.value.retry_after == 30.0
    # Subclass, so any caller that only knows the base class still degrades safely.
    assert isinstance(excinfo.value, ExternalSourceError)


def test_other_non_200_is_still_a_plain_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(http, "get", lambda *a, **k: http.EgressResponse(503, b"{}", {}))

    with pytest.raises(ExternalSourceError) as excinfo:
        JiraSource().fetch_assigned_items(
            base_url=_JIRA_BASE, secret="t", config={"account_email": "p@acme.io"}
        )

    assert not isinstance(excinfo.value, ExternalSourceRateLimited)


# --------------------------------------------------------------------------- #
# The worker
# --------------------------------------------------------------------------- #


def test_rate_limited_pull_is_requeued_against_the_sources_own_clock(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    cred = _connect(user)
    req = _dispatched_request(user)
    _mock_429(monkeypatch, {"Retry-After": "120"})

    before = timezone.now()
    tasks._do_sync(str(req.id))

    req.refresh_from_db()
    cred.refresh_from_db()
    assert req.status == ExternalSyncRequestStatus.PENDING, "must re-queue, not dead-letter"
    assert req.next_attempt_at is not None
    assert req.next_attempt_at >= before + timedelta(seconds=119)
    assert req.attempt_count == 1
    # The whole point: the connection is NOT flagged. It is not broken.
    assert cred.config["status"] == "connected"


def test_requeue_falls_back_to_a_default_backoff_without_a_header(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    _connect(user)
    req = _dispatched_request(user)
    _mock_429(monkeypatch)

    before = timezone.now()
    tasks._do_sync(str(req.id))

    req.refresh_from_db()
    assert req.status == ExternalSyncRequestStatus.PENDING
    assert req.next_attempt_at is not None
    assert req.next_attempt_at >= before + tasks._RATE_LIMIT_DEFAULT_BACKOFF - timedelta(seconds=2)


def test_an_absurd_retry_after_is_clamped(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A hostile or clock-skewed header must not park the pull for hours."""
    _connect(user)
    req = _dispatched_request(user)
    _mock_429(monkeypatch, {"Retry-After": "86400"})

    before = timezone.now()
    tasks._do_sync(str(req.id))

    req.refresh_from_db()
    assert req.next_attempt_at is not None
    assert req.next_attempt_at <= before + tasks._RATE_LIMIT_MAX_BACKOFF + timedelta(seconds=2)


def test_rate_limited_pull_keeps_the_last_good_cache(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    _connect(user)
    ExternalWorkItem.objects.create(
        user=user,
        source="jira",
        external_id="ACME-1",
        external_url=f"{_JIRA_BASE}/browse/ACME-1",
        title="Cached",
        external_status="In Progress",
        display_bucket="in_progress",
    )
    req = _dispatched_request(user)
    _mock_429(monkeypatch, {"Retry-After": "10"})

    tasks._do_sync(str(req.id))

    item = ExternalWorkItem.objects.get(user=user, external_id="ACME-1")
    assert item.is_stale is False, "a rate limit must never soft-remove the cache"


def test_retry_budget_is_bounded(user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch) -> None:
    """A source that 429s forever retires instead of cycling forever."""
    _connect(user)
    req = _dispatched_request(user, attempt_count=tasks._MAX_RATE_LIMIT_ATTEMPTS - 1)
    _mock_429(monkeypatch, {"Retry-After": "5"})

    tasks._do_sync(str(req.id))

    req.refresh_from_db()
    assert req.status == ExternalSyncRequestStatus.DEAD
    assert "rate_limited" in req.last_error


# --------------------------------------------------------------------------- #
# The drain
# --------------------------------------------------------------------------- #


def test_drain_does_not_redispatch_before_the_clock(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Re-dispatching early would just earn another 429."""
    _connect(user)
    req = ExternalSyncRequest.objects.create(
        user=user,
        source="jira",
        status=ExternalSyncRequestStatus.PENDING,
        next_attempt_at=timezone.now() + timedelta(minutes=5),
    )
    # Past the drain's young-row floor, so only the retry clock can hold it back.
    ExternalSyncRequest.objects.filter(pk=req.pk).update(
        requested_at=timezone.now() - timedelta(minutes=10)
    )

    calls: list[str] = []
    monkeypatch.setattr(
        tasks.external_sync, "delay", lambda rid, *a, **k: calls.append(rid) or _FakeResult()
    )
    tasks._do_drain()

    req.refresh_from_db()
    assert calls == []
    assert req.status == ExternalSyncRequestStatus.PENDING


def test_drain_redispatches_once_the_clock_passes(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    _connect(user)
    req = ExternalSyncRequest.objects.create(
        user=user,
        source="jira",
        status=ExternalSyncRequestStatus.PENDING,
        next_attempt_at=timezone.now() - timedelta(seconds=1),
    )
    ExternalSyncRequest.objects.filter(pk=req.pk).update(
        requested_at=timezone.now() - timedelta(minutes=10)
    )

    calls: list[str] = []
    monkeypatch.setattr(
        tasks.external_sync, "delay", lambda rid, *a, **k: calls.append(rid) or _FakeResult()
    )
    tasks._do_drain()

    req.refresh_from_db()
    assert calls == [str(req.id)]
    assert req.status == ExternalSyncRequestStatus.DISPATCHED


def test_drain_still_dispatches_rows_that_were_never_rate_limited(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A null clock means "eligible now" — the ordinary path is unchanged."""
    _connect(user)
    req = ExternalSyncRequest.objects.create(
        user=user, source="jira", status=ExternalSyncRequestStatus.PENDING
    )
    ExternalSyncRequest.objects.filter(pk=req.pk).update(
        requested_at=timezone.now() - timedelta(minutes=10)
    )

    calls: list[str] = []
    monkeypatch.setattr(
        tasks.external_sync, "delay", lambda rid, *a, **k: calls.append(rid) or _FakeResult()
    )
    tasks._do_drain()

    assert calls == [str(req.id)]


def test_poll_does_not_redispatch_a_pull_still_inside_its_retry_after(
    django_user_model: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An always-on poll must not preempt the clock the source itself gave us.

    ``_requeue_rate_limited`` parks a 429'd pull back in PENDING behind
    ``next_attempt_at``. A later trigger for the same (user, source) adopts that
    row — and used to re-dispatch it immediately, re-hitting the source inside its
    own ``Retry-After``. ``drain_external_sync`` honored the clock; the adopt path
    did not, so the backoff held only as long as nothing else asked for a pull.

    Latent before the background-poll opt-in (#3104), routine after it: the poll
    ticks every 15 minutes and ``_RATE_LIMIT_MAX_BACKOFF`` is also 15 minutes, so
    an opted-in connection lands inside an active backoff window with no user
    involved at all.
    """
    from trueppm_api.apps.integrations import services

    user = django_user_model.objects.create_user(username="rl_poll", password="pw")
    IntegrationCredential.objects.create(
        user=user,
        provider="jira",
        secret_ciphertext=encrypt_secret("t"),
        base_url="https://acme.atlassian.net",
        config={"status": "connected", "poll_enabled": True},
    )
    # A pull already rate-limited and parked ten minutes out.
    ExternalSyncRequest.objects.create(
        user=user,
        source="jira",
        status=ExternalSyncRequestStatus.PENDING,
        next_attempt_at=timezone.now() + timedelta(minutes=10),
    )

    dispatched: list[str] = []
    monkeypatch.setattr(services, "_dispatch_on_commit", lambda rid: dispatched.append(str(rid)))

    _do_poll()

    # The poll adopts the parked row (no second row is stacked) and leaves it be —
    # the drain picks it up once the clock elapses.
    assert ExternalSyncRequest.objects.filter(user=user, source="jira").count() == 1
    assert dispatched == []


def test_an_elapsed_retry_clock_is_dispatched_again(
    django_user_model: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The guard is a clock check, not a freeze — an elapsed backoff still fires."""
    from trueppm_api.apps.integrations import services

    user = django_user_model.objects.create_user(username="rl_poll_ok", password="pw")
    IntegrationCredential.objects.create(
        user=user,
        provider="jira",
        secret_ciphertext=encrypt_secret("t"),
        base_url="https://acme.atlassian.net",
        config={"status": "connected", "poll_enabled": True},
    )
    ExternalSyncRequest.objects.create(
        user=user,
        source="jira",
        status=ExternalSyncRequestStatus.PENDING,
        next_attempt_at=timezone.now() - timedelta(seconds=1),
    )

    dispatched: list[str] = []
    monkeypatch.setattr(services, "_dispatch_on_commit", lambda rid: dispatched.append(str(rid)))

    _do_poll()

    assert len(dispatched) == 1
