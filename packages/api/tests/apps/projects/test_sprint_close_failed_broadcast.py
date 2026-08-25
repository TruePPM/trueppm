"""The terminal sprint-close failure announces itself on the board (#2992).

#2894 made a failed close recoverable and added a read route to observe it.
Nothing pushed. A close abandoned on the drain minutes after the button was
pressed left the sprint ACTIVE with no signal anywhere, so the user's only way
to learn about it was to go looking for a page they had no reason to open.

Two things are pinned here, and the second is the one that is easy to get wrong:

1. **Terminality, not status.** A FAILED row with a live ``next_attempt_at`` is
   one the drain will run again in about a minute. Broadcasting *that* would
   alarm a user about a fault that self-heals before they could act on it, so
   the event fires only when ``next_attempt_at`` is null.
2. **All four writers.** A close request reaches terminal-FAILED from four
   independent places, only one of which is the obvious ``except`` block. A
   broadcast wired into that one site alone would stay silent for a cancelled
   sprint, a non-closable sprint, and — the case with no exception anywhere — a
   worker that dies mid-attempt on every try and is abandoned by the drain's
   orphan sweep. Each has its own test below.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, timedelta
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Project,
    Sprint,
    SprintCloseRequest,
    SprintCloseRequestFailureReason,
    SprintCloseRequestStatus,
    SprintState,
)
from trueppm_api.apps.projects.tasks import (
    _MAX_CLOSE_ATTEMPTS,
    _do_drain,
    _finalize_close_failure,
    close_sprint,
)

User = get_user_model()
pytestmark = pytest.mark.django_db

EVENT = "sprint_close_failed"


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
def _mock_redis_lock() -> Any:
    """Bypass the Redis SET NX lock so idempotent_task wrappers run inline."""
    mock_client = MagicMock()
    mock_client.set.return_value = True
    mock_client.register_script.return_value = MagicMock(return_value=1)
    with patch("trueppm_api.core.idempotent.valkey") as redis_module:
        redis_module.client.return_value = mock_client
        yield mock_client


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="closer", password="pw")


@pytest.fixture
def project(owner: Any) -> Project:
    project = Project.objects.create(name="Proj", start_date=date(2026, 1, 1))
    ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
    return project


def _active_sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 1, 6),
        finish_date=date(2026, 1, 20),
        state=SprintState.ACTIVE,
        committed_points=10,
    )


def _request(sprint: Sprint, owner: Any) -> SprintCloseRequest:
    return SprintCloseRequest.objects.create(
        sprint=sprint, requested_by=owner, carry_over_to="backlog"
    )


def _boom(*_args: Any, **_kwargs: Any) -> None:
    raise RuntimeError("snapshot exploded")


def _events(broadcast: MagicMock, event_type: str) -> list[tuple[Any, ...]]:
    """Every call to broadcast_board_event carrying ``event_type``."""
    return [c.args for c in broadcast.call_args_list if len(c.args) > 1 and c.args[1] == event_type]


# --------------------------------------------------------------------------- #
# Terminality is the trigger — not FAILED
# --------------------------------------------------------------------------- #


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_a_retryable_failure_announces_nothing(
    broadcast: MagicMock,
    project: Project,
    owner: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """The single most important case in this file.

    The first failure marks the row FAILED and schedules a retry. Branching on
    ``status`` here — the mistake the read route's own docstring warns about —
    would fire an "it didn't close" alarm about a close that the drain re-runs
    sixty seconds later and that usually then succeeds.
    """
    sprint = _active_sprint(project)
    req = _request(sprint, owner)

    with (
        django_capture_on_commit_callbacks(execute=True),
        patch("trueppm_api.apps.projects.services.snapshot_sprint_task_outcomes", _boom),
    ):
        close_sprint.run(str(req.id))

    req.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.FAILED
    assert req.next_attempt_at is not None, "precondition: this failure is still retryable"
    assert _events(broadcast, EVENT) == [], "a retryable failure must stay silent"


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_budget_exhaustion_announces_the_terminal_failure(
    broadcast: MagicMock,
    project: Project,
    owner: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """The last attempt leaves the clock null, and *that* is what fires."""
    sprint = _active_sprint(project)
    req = _request(sprint, owner)
    SprintCloseRequest.objects.filter(pk=req.pk).update(attempt_count=_MAX_CLOSE_ATTEMPTS - 1)

    with (
        django_capture_on_commit_callbacks(execute=True),
        patch("trueppm_api.apps.projects.services.snapshot_sprint_task_outcomes", _boom),
    ):
        close_sprint.run(str(req.id))

    req.refresh_from_db()
    assert req.next_attempt_at is None, "precondition: the budget is spent"

    events = _events(broadcast, EVENT)
    assert len(events) == 1
    group_id, _event, payload = events[0]
    # Fanned out on the *project* id — the id type is what makes the event
    # deliverable at all, and is what the reachability gate classifies on.
    assert group_id == str(project.pk)
    assert payload["id"] == str(sprint.pk)
    assert payload["request_id"] == str(req.pk)
    assert payload["failure_reason"] == SprintCloseRequestFailureReason.ERROR
    assert payload["attempt_count"] == _MAX_CLOSE_ATTEMPTS
    assert payload["terminal"] is True


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_the_raw_failure_text_is_never_broadcast(
    broadcast: MagicMock,
    project: Project,
    owner: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """The read route gates ``error_message`` to project Admins and withholds it
    from agent tokens entirely, because a DB or broker exception puts internal
    hostnames and SQL fragments in it. A board broadcast reaches the whole
    project group with no per-recipient filtering available, so carrying the
    text here would silently reverse that gate for every socket."""
    sprint = _active_sprint(project)
    req = _request(sprint, owner)
    SprintCloseRequest.objects.filter(pk=req.pk).update(attempt_count=_MAX_CLOSE_ATTEMPTS - 1)

    with (
        django_capture_on_commit_callbacks(execute=True),
        patch("trueppm_api.apps.projects.services.snapshot_sprint_task_outcomes", _boom),
    ):
        close_sprint.run(str(req.id))

    req.refresh_from_db()
    assert "snapshot exploded" in req.error_message, "precondition: the text was stored"

    (_group, _event, payload) = _events(broadcast, EVENT)[0]
    assert "error_message" not in payload
    assert "snapshot exploded" not in str(payload)


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_a_successful_close_announces_no_failure(
    broadcast: MagicMock,
    project: Project,
    owner: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """The happy path still emits sprint_closed and must emit nothing else."""
    sprint = _active_sprint(project)
    req = _request(sprint, owner)

    with django_capture_on_commit_callbacks(execute=True):
        close_sprint.run(str(req.id))

    req.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.COMPLETED
    assert _events(broadcast, EVENT) == []
    assert len(_events(broadcast, "sprint_closed")) == 1


# --------------------------------------------------------------------------- #
# The three terminal sites that are not the except block
# --------------------------------------------------------------------------- #


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_a_cancelled_sprint_announces_its_terminal_failure(
    broadcast: MagicMock,
    project: Project,
    owner: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """Reached inside the atomic block, not the except block — a different
    transaction context, and the reason the broadcast is deferred rather than
    called inline."""
    sprint = _active_sprint(project)
    req = _request(sprint, owner)
    Sprint.objects.filter(pk=sprint.pk).update(state=SprintState.CANCELLED)

    with django_capture_on_commit_callbacks(execute=True):
        close_sprint.run(str(req.id))

    events = _events(broadcast, EVENT)
    assert len(events) == 1
    (_group, _event, payload) = events[0]
    assert payload["failure_reason"] == SprintCloseRequestFailureReason.CANCELLED
    assert payload["terminal"] is True


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_a_non_closable_sprint_announces_its_terminal_failure(
    broadcast: MagicMock,
    project: Project,
    owner: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    sprint = _active_sprint(project)
    req = _request(sprint, owner)
    Sprint.objects.filter(pk=sprint.pk).update(state=SprintState.PLANNED)

    with django_capture_on_commit_callbacks(execute=True):
        close_sprint.run(str(req.id))

    events = _events(broadcast, EVENT)
    assert len(events) == 1
    (_group, _event, payload) = events[0]
    assert payload["failure_reason"] == SprintCloseRequestFailureReason.NOT_CLOSABLE


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_the_drain_announces_an_abandoned_orphan(
    broadcast: MagicMock,
    project: Project,
    owner: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """The case with no exception anywhere.

    A worker OOM-killed on every attempt never reaches ``close_sprint``'s
    handler at all; the drain's orphan sweep is what finally abandons the row.
    It used to be one bulk UPDATE, which returns a count and therefore cannot
    say which project to notify — this is the site a naive implementation
    silently misses.
    """
    sprint = _active_sprint(project)
    req = _request(sprint, owner)
    SprintCloseRequest.objects.filter(pk=req.pk).update(
        status=SprintCloseRequestStatus.IN_FLIGHT,
        started_at=timezone.now() - timedelta(minutes=30),
        attempt_count=_MAX_CLOSE_ATTEMPTS,
    )

    with django_capture_on_commit_callbacks(execute=True), patch.object(close_sprint, "delay"):
        _do_drain()

    req.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.FAILED
    assert req.next_attempt_at is None

    events = _events(broadcast, EVENT)
    assert len(events) == 1
    group_id, _event, payload = events[0]
    assert group_id == str(project.pk)
    assert payload["id"] == str(sprint.pk)
    assert payload["failure_reason"] == SprintCloseRequestFailureReason.STALLED


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_the_drain_stays_silent_for_an_orphan_within_budget(
    broadcast: MagicMock,
    project: Project,
    owner: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """Ordinary orphan recovery is not a failure — the row goes back to PENDING."""
    sprint = _active_sprint(project)
    req = _request(sprint, owner)
    SprintCloseRequest.objects.filter(pk=req.pk).update(
        status=SprintCloseRequestStatus.IN_FLIGHT,
        started_at=timezone.now() - timedelta(minutes=30),
        attempt_count=1,
    )

    with django_capture_on_commit_callbacks(execute=True), patch.object(close_sprint, "delay"):
        _do_drain()

    req.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.PENDING
    assert _events(broadcast, EVENT) == []


# --------------------------------------------------------------------------- #
# The write is a check-and-set — a close that committed is never re-announced
# --------------------------------------------------------------------------- #


@pytest.mark.django_db(transaction=True)
@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_a_post_commit_hook_failure_cannot_turn_a_committed_close_into_a_failure(
    broadcast: MagicMock,
    project: Project,
    owner: Any,
) -> None:
    """The nastiest ordering in this file, and it is not hypothetical.

    Django runs non-robust ``on_commit`` hooks from ``Atomic.__exit__`` — that
    is, *after* the transaction commits but still inside the ``with`` block.
    ``close_sprint`` registers three on its success path, one of which
    dispatches webhooks and can raise. That exception propagates out of the
    ``with`` into ``close_sprint``'s own ``except`` handler, with the COMPLETED
    row already durable on disk.

    A blind ``filter(pk=...).update(status=FAILED)`` there would rewrite a close
    that genuinely succeeded as a failure and — once the attempt budget is spent
    — announce "your sprint didn't close" to the whole board about a sprint
    sitting there closed.

    Runs on a real transaction (``transaction=True``) deliberately: under the
    usual wrapped-in-atomic test DB, ``django_capture_on_commit_callbacks`` runs
    the hooks *after* ``close_sprint`` has already returned, so the exception
    lands in the test instead of the handler and the race cannot be reproduced
    at all.
    """
    sprint = _active_sprint(project)
    req = _request(sprint, owner)
    SprintCloseRequest.objects.filter(pk=req.pk).update(attempt_count=_MAX_CLOSE_ATTEMPTS - 1)

    def _explode(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("webhook dispatch blew up")

    with patch("trueppm_api.apps.projects.views._dispatch_webhooks", _explode):
        close_sprint.run(str(req.id))

    req.refresh_from_db()
    sprint.refresh_from_db()
    assert sprint.state == SprintState.COMPLETED, "the close really did happen"
    assert req.status == SprintCloseRequestStatus.COMPLETED, (
        "post-commit fallout must not rewrite a committed close as a failure"
    )
    assert _events(broadcast, EVENT) == []


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_expected_status_stops_a_row_that_moved_on_being_clobbered_and_announced(
    broadcast: MagicMock,
    project: Project,
    owner: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """The drain selects candidate rows and then writes them one at a time.

    That split lost the ``WHERE status=IN_FLIGHT`` predicate the single bulk
    UPDATE used to carry, so a row that finished between the SELECT and its own
    write could be clobbered to FAILED and announced as a failure. This drives
    the guard directly: the row has moved to COMPLETED by the time the write is
    attempted, exactly as it would have mid-sweep.
    """
    sprint = _active_sprint(project)
    req = _request(sprint, owner)
    SprintCloseRequest.objects.filter(pk=req.pk).update(status=SprintCloseRequestStatus.COMPLETED)

    with django_capture_on_commit_callbacks(execute=True):
        _finalize_close_failure(
            req_pk=req.pk,
            sprint_id=sprint.pk,
            project_id=project.pk,
            error_message="stalled",
            failure_reason=SprintCloseRequestFailureReason.STALLED,
            attempt_count=_MAX_CLOSE_ATTEMPTS,
            expected_status=SprintCloseRequestStatus.IN_FLIGHT,
        )

    req.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.COMPLETED, "the row was not clobbered"
    assert _events(broadcast, EVENT) == [], "and no failure was announced for it"


# --------------------------------------------------------------------------- #
# Ordering and registration
# --------------------------------------------------------------------------- #


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_the_row_is_terminal_before_the_event_goes_out(
    broadcast: MagicMock,
    project: Project,
    owner: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """The event tells clients to read the close-request route, so the row it
    will read must already say FAILED-and-terminal. Deferring to on_commit is
    what guarantees the ordering across four sites with two different ambient
    transaction contexts."""
    sprint = _active_sprint(project)
    req = _request(sprint, owner)
    SprintCloseRequest.objects.filter(pk=req.pk).update(attempt_count=_MAX_CLOSE_ATTEMPTS - 1)

    observed: list[tuple[str, Any]] = []

    def _record(*args: Any, **_kwargs: Any) -> None:
        row = SprintCloseRequest.objects.get(pk=req.pk)
        observed.append((row.status, row.next_attempt_at))

    broadcast.side_effect = _record

    with (
        django_capture_on_commit_callbacks(execute=True),
        patch("trueppm_api.apps.projects.services.snapshot_sprint_task_outcomes", _boom),
    ):
        close_sprint.run(str(req.id))

    assert observed, "the broadcast never ran"
    status, next_attempt_at = observed[-1]
    assert status == SprintCloseRequestStatus.FAILED
    assert next_attempt_at is None


def test_the_event_type_is_frozen() -> None:
    """A WS event that is broadcast but not frozen is one no consumer can rely
    on, and the taxonomy gate reads this set to check the published docs."""
    from tests.apps.sync.test_broadcast import FROZEN_WS_EVENT_TYPES

    assert EVENT in FROZEN_WS_EVENT_TYPES
