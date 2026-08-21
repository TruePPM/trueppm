"""Recovery of a failed sprint close (#2894).

Before this, a close that raised was **terminal**: the task marked the request
FAILED without re-raising (so the decorator's ``max_retries`` never fired),
``close_sprint`` short-circuits on re-entry into a FAILED row, and the drain
recovered only IN_FLIGHT rows. One unsnapshottable task left the sprint ACTIVE
indefinitely with no path back except manual DB intervention — and two comments
in the source asserted the opposite, that "the drain retries".

The invariant these tests pin is a single line: **``next_attempt_at is None``
means no further attempt will be made.** A transient failure sets the clock; an
unfixable one (cancelled / non-closable sprint) and an exhausted budget both
leave it null.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Project,
    Sprint,
    SprintCloseRequest,
    SprintCloseRequestStatus,
    SprintState,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.tasks import _MAX_CLOSE_ATTEMPTS, _do_drain, close_sprint

User = get_user_model()
pytestmark = pytest.mark.django_db


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
    return User.objects.create_user(username="owner", password="pw")


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


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _boom(*_args: Any, **_kwargs: Any) -> None:
    """Stand-in for the unsnapshottable task in the issue's scenario."""
    raise RuntimeError("snapshot exploded")


# --------------------------------------------------------------------------- #
# A transient failure stays recoverable
# --------------------------------------------------------------------------- #


def test_transient_failure_schedules_a_retry_and_rolls_the_close_back(
    project: Project, owner: Any
) -> None:
    sprint = _active_sprint(project)
    req = _request(sprint, owner)

    with patch("trueppm_api.apps.projects.services.snapshot_sprint_task_outcomes", _boom):
        close_sprint.run(str(req.id))

    req.refresh_from_db()
    sprint.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.FAILED
    # Explicitly the point, not incidental: the increment happens OUTSIDE the
    # atomic block, so it survives the rollback. If it ever moves inside — or
    # close_sprint gains a @transaction.atomic wrapper — attempt_count stays 0
    # forever, the budget is never spent, and the drain re-queues a permanently
    # failing close without end. This assertion is what catches that.
    assert req.attempt_count == 1
    assert req.next_attempt_at is not None, "a transient failure must stay retryable"
    assert "snapshot exploded" in req.error_message
    # The whole close rolled back, which is what makes a retry safe to run from
    # the top rather than resuming a half-applied close.
    assert sprint.state == SprintState.ACTIVE
    assert sprint.closed_at is None


def test_drain_requeues_a_failed_request_once_its_clock_passes(
    project: Project, owner: Any
) -> None:
    sprint = _active_sprint(project)
    req = _request(sprint, owner)
    with patch("trueppm_api.apps.projects.services.snapshot_sprint_task_outcomes", _boom):
        close_sprint.run(str(req.id))

    # Not yet due — the drain must leave it alone.
    with patch.object(close_sprint, "delay") as delay:
        _do_drain()
    req.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.FAILED
    assert delay.call_count == 0

    # Wind the clock back past the backoff.
    SprintCloseRequest.objects.filter(pk=req.pk).update(
        next_attempt_at=timezone.now() - timedelta(seconds=1)
    )
    with patch.object(close_sprint, "delay") as delay:
        _do_drain()
    req.refresh_from_db()
    # The requeue is the contract: FAILED → PENDING, retry clock cleared, and no
    # longer reading as finished.
    assert req.status == SprintCloseRequestStatus.PENDING
    assert req.next_attempt_at is None
    assert req.completed_at is None, "a row waiting to run again must not read as finished"
    # Dispatch is a separate concern and intentionally lags: the drain only sends
    # rows whose requested_at has cleared its 2-second settle window, and this row
    # was created milliseconds ago. In production requested_at is long past, so
    # the same sweep both requeues and dispatches.
    assert delay.call_count == 0

    SprintCloseRequest.objects.filter(pk=req.pk).update(
        requested_at=timezone.now() - timedelta(seconds=30)
    )
    with patch.object(close_sprint, "delay") as delay:
        _do_drain()
    assert delay.call_count == 1
    assert delay.call_args[0][0] == str(req.id)


def test_a_retried_close_completes_when_the_transient_fault_clears(
    project: Project, owner: Any
) -> None:
    """The point of the whole mechanism: the sprint actually closes on the retry."""
    sprint = _active_sprint(project)
    Task.objects.create(
        project=project,
        name="Done",
        duration=1,
        sprint=sprint,
        story_points=8,
        status=TaskStatus.COMPLETE,
    )
    req = _request(sprint, owner)

    with patch("trueppm_api.apps.projects.services.snapshot_sprint_task_outcomes", _boom):
        close_sprint.run(str(req.id))
    assert Sprint.objects.get(pk=sprint.pk).state == SprintState.ACTIVE

    # Due for retry, and old enough to clear the drain's settle window.
    SprintCloseRequest.objects.filter(pk=req.pk).update(
        next_attempt_at=timezone.now() - timedelta(seconds=1),
        requested_at=timezone.now() - timedelta(seconds=30),
    )
    with patch.object(close_sprint, "delay") as delay:
        _do_drain()
    assert delay.call_count == 1

    # The fault has cleared; run the redispatched task for real.
    close_sprint.run(str(req.id))

    req.refresh_from_db()
    sprint.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.COMPLETED
    assert sprint.state == SprintState.COMPLETED
    assert sprint.closed_at is not None


# --------------------------------------------------------------------------- #
# The budget is bounded, and terminal means terminal
# --------------------------------------------------------------------------- #


def test_budget_exhaustion_is_terminal_and_the_drain_stops_requeueing(
    project: Project, owner: Any
) -> None:
    """A fault that reproduces must not loop forever."""
    sprint = _active_sprint(project)
    req = _request(sprint, owner)

    for _ in range(_MAX_CLOSE_ATTEMPTS):
        with patch("trueppm_api.apps.projects.services.snapshot_sprint_task_outcomes", _boom):
            close_sprint.run(str(req.id))
        req.refresh_from_db()
        if req.next_attempt_at is not None:
            # Make the next sweep eligible so the loop advances.
            SprintCloseRequest.objects.filter(pk=req.pk).update(
                next_attempt_at=timezone.now() - timedelta(seconds=1)
            )
            with patch.object(close_sprint, "delay"):
                _do_drain()

    req.refresh_from_db()
    assert req.attempt_count == _MAX_CLOSE_ATTEMPTS
    assert req.status == SprintCloseRequestStatus.FAILED
    assert req.next_attempt_at is None, "the budget is spent — nothing may retry this"

    with patch.object(close_sprint, "delay") as delay:
        _do_drain()
    req.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.FAILED
    assert delay.call_count == 0
    # And the sprint is honestly still open rather than wrongly reported closed.
    assert Sprint.objects.get(pk=sprint.pk).state == SprintState.ACTIVE


def test_a_cancelled_sprint_fails_terminally_and_is_never_retried(
    project: Project, owner: Any
) -> None:
    """Retrying an unfixable failure is not resilience, it is noise.

    ``_finalize_non_closable_sprint`` marks FAILED for a reason no retry can
    change, so it must leave the retry clock null — this is the case that makes
    ``next_attempt_at`` the right carrier for the distinction rather than
    ``attempt_count`` alone.
    """
    sprint = _active_sprint(project)
    req = _request(sprint, owner)
    Sprint.objects.filter(pk=sprint.pk).update(state=SprintState.CANCELLED)

    close_sprint.run(str(req.id))

    req.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.FAILED
    assert req.next_attempt_at is None
    assert "cancelled" in req.error_message.lower()

    with patch.object(close_sprint, "delay") as delay:
        _do_drain()
    req.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.FAILED
    assert delay.call_count == 0


def test_retries_cannot_starve_fresh_closes_of_the_dispatch_budget(
    project: Project, owner: Any
) -> None:
    """A re-queued row keeps its original ``requested_at``, so it sorts ahead of
    every newer close. With one shared ordered slice, a correlated failure would
    let the retry cohort fill the entire budget and strand fresh user closes
    behind it — the sprint would simply appear to hang. Separate budgets.
    """
    from trueppm_api.apps.projects.tasks import _DISPATCH_BUDGET

    old = timezone.now() - timedelta(hours=1)
    # Fill the shared budget entirely with older, already-attempted rows.
    for _ in range(_DISPATCH_BUDGET):
        sprint = _active_sprint(project)
        req = _request(sprint, owner)
        SprintCloseRequest.objects.filter(pk=req.pk).update(
            requested_at=old, attempt_count=1, status=SprintCloseRequestStatus.PENDING
        )

    # One fresh close, requested after all of them.
    fresh_sprint = _active_sprint(project)
    fresh = _request(fresh_sprint, owner)
    SprintCloseRequest.objects.filter(pk=fresh.pk).update(
        requested_at=timezone.now() - timedelta(seconds=30)
    )

    with patch.object(close_sprint, "delay") as delay:
        _do_drain()

    dispatched = {call[0][0] for call in delay.call_args_list}
    assert str(fresh.id) in dispatched, "a fresh close must not queue behind the retry cohort"


def test_purge_spares_a_failed_request_that_is_still_awaiting_retry(
    project: Project, owner: Any
) -> None:
    """🔴 The retention purge reaps COMPLETED/FAILED rows older than 7 days, and
    the window is measured from ``requested_at``. A request that sat PENDING
    through a long outage is already past the cutoff the moment it first runs, so
    a transient failure there would schedule a 60-second retry that the nightly
    purge could delete first — stranding the sprint AND destroying the record of
    why, which is worse than the bug this branch fixes.
    """
    from trueppm_api.apps.projects.tasks import purge_sprint_close_requests

    sprint = _active_sprint(project)
    retryable = _request(sprint, owner)
    SprintCloseRequest.objects.filter(pk=retryable.pk).update(
        status=SprintCloseRequestStatus.FAILED,
        requested_at=timezone.now() - timedelta(days=30),
        completed_at=timezone.now(),
        next_attempt_at=timezone.now() + timedelta(seconds=60),
    )

    # A genuinely finished one of the same age, to prove the purge still works.
    done_sprint = _active_sprint(project)
    done = _request(done_sprint, owner)
    SprintCloseRequest.objects.filter(pk=done.pk).update(
        status=SprintCloseRequestStatus.COMPLETED,
        requested_at=timezone.now() - timedelta(days=30),
        completed_at=timezone.now(),
        next_attempt_at=None,
    )

    purge_sprint_close_requests.run()

    assert SprintCloseRequest.objects.filter(pk=retryable.pk).exists(), (
        "a row with a live retry clock is not finished, whatever its status says"
    )
    assert not SprintCloseRequest.objects.filter(pk=done.pk).exists()


def test_orphan_recovery_honors_the_attempt_budget_and_abandons_explicitly(
    project: Project, owner: Any
) -> None:
    """A close that orphans rather than raising — a worker killed on each attempt —
    was recovered without limit while ``attempt_count`` climbed forever, because
    the budget was enforced only on the failure path. Capping it is half the fix:
    an orphan past the budget must be abandoned into a terminal state, not left
    wedged IN_FLIGHT where no sweep touches it and no reader can interpret it.
    """
    sprint = _active_sprint(project)
    req = _request(sprint, owner)
    SprintCloseRequest.objects.filter(pk=req.pk).update(
        status=SprintCloseRequestStatus.IN_FLIGHT,
        started_at=timezone.now() - timedelta(minutes=30),
        attempt_count=_MAX_CLOSE_ATTEMPTS,
    )

    with patch.object(close_sprint, "delay") as delay:
        _do_drain()

    req.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.FAILED
    assert req.next_attempt_at is None, "abandoned, not scheduled for another go"
    assert req.completed_at is not None
    assert delay.call_count == 0
    assert Sprint.objects.get(pk=sprint.pk).state == SprintState.ACTIVE


def test_orphan_within_budget_is_still_recovered(project: Project, owner: Any) -> None:
    """The cap must not break ordinary orphan recovery — a stalled first attempt
    still goes back to PENDING and is re-dispatched."""
    sprint = _active_sprint(project)
    req = _request(sprint, owner)
    SprintCloseRequest.objects.filter(pk=req.pk).update(
        status=SprintCloseRequestStatus.IN_FLIGHT,
        started_at=timezone.now() - timedelta(minutes=30),
        attempt_count=1,
        requested_at=timezone.now() - timedelta(seconds=30),
    )

    with patch.object(close_sprint, "delay") as delay:
        _do_drain()

    req.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.PENDING
    assert delay.call_count == 1


def test_requeue_clears_started_at(project: Project, owner: Any) -> None:
    """A row waiting to run again has not started. A stale ``started_at`` would
    misread on the API and feed the orphan sweep a start time from a previous
    attempt — which, with the cap above, could abandon a row that was merely
    waiting out its backoff."""
    sprint = _active_sprint(project)
    req = _request(sprint, owner)
    with patch("trueppm_api.apps.projects.services.snapshot_sprint_task_outcomes", _boom):
        close_sprint.run(str(req.id))
    req.refresh_from_db()
    assert req.started_at is not None

    SprintCloseRequest.objects.filter(pk=req.pk).update(
        next_attempt_at=timezone.now() - timedelta(seconds=1)
    )
    with patch.object(close_sprint, "delay"):
        _do_drain()

    req.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.PENDING
    assert req.started_at is None


def test_drain_does_not_requeue_a_completed_request(project: Project, owner: Any) -> None:
    """The retry sweep is scoped to FAILED — a successful close stays closed."""
    sprint = _active_sprint(project)
    req = _request(sprint, owner)
    close_sprint.run(str(req.id))
    req.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.COMPLETED

    with patch.object(close_sprint, "delay") as delay:
        _do_drain()
    req.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.COMPLETED
    assert delay.call_count == 0


# --------------------------------------------------------------------------- #
# The read route — the 202's request_id now addresses something
# --------------------------------------------------------------------------- #


def _url(sprint: Sprint) -> str:
    return f"/api/v1/sprints/{sprint.pk}/close-request/"


def test_close_request_route_reports_a_retryable_failure_as_not_terminal(
    project: Project, owner: Any
) -> None:
    sprint = _active_sprint(project)
    req = _request(sprint, owner)
    with patch("trueppm_api.apps.projects.services.snapshot_sprint_task_outcomes", _boom):
        close_sprint.run(str(req.id))

    resp = _client(owner).get(_url(sprint))
    assert resp.status_code == 200
    assert resp.data["id"] == str(req.id), "matches the request_id the 202 handed out"
    assert resp.data["status"] == SprintCloseRequestStatus.FAILED
    assert resp.data["attempt_count"] == 1
    # OWNER >= ADMIN, so the raw stored text is theirs to see.
    assert "snapshot exploded" in resp.data["error_message"]
    # FAILED alone must not read as dead — this is why clients branch on terminal.
    assert resp.data["terminal"] is False
    assert resp.data["next_attempt_at"] is not None


def test_close_request_route_reports_an_abandoned_request_as_terminal(
    project: Project, owner: Any
) -> None:
    sprint = _active_sprint(project)
    req = _request(sprint, owner)
    Sprint.objects.filter(pk=sprint.pk).update(state=SprintState.CANCELLED)
    close_sprint.run(str(req.id))

    resp = _client(owner).get(_url(sprint))
    assert resp.status_code == 200
    assert resp.data["terminal"] is True
    assert resp.data["next_attempt_at"] is None


def test_close_request_route_reports_success(project: Project, owner: Any) -> None:
    sprint = _active_sprint(project)
    _request(sprint, owner)
    close_sprint.run(str(SprintCloseRequest.objects.get(sprint=sprint).id))

    resp = _client(owner).get(_url(sprint))
    assert resp.status_code == 200
    assert resp.data["status"] == SprintCloseRequestStatus.COMPLETED
    assert resp.data["terminal"] is True


def test_close_request_route_404s_when_no_close_was_ever_requested(
    project: Project, owner: Any
) -> None:
    sprint = _active_sprint(project)
    resp = _client(owner).get(_url(sprint))
    assert resp.status_code == 404


def test_close_request_route_returns_the_most_recent_attempt(project: Project, owner: Any) -> None:
    """A second close after an abandoned one must not read as the old failure."""
    sprint = _active_sprint(project)
    first = _request(sprint, owner)
    SprintCloseRequest.objects.filter(pk=first.pk).update(
        status=SprintCloseRequestStatus.FAILED,
        completed_at=timezone.now(),
        error_message="old failure",
    )
    second = _request(sprint, owner)

    resp = _client(owner).get(_url(sprint))
    assert resp.status_code == 200
    assert resp.data["id"] == str(second.id)
    assert resp.data["status"] == SprintCloseRequestStatus.PENDING


def test_close_request_route_denies_a_non_member(project: Project, owner: Any) -> None:
    """404, not 403 — the action resolves through the membership-filtered
    queryset, so a non-member cannot use the status code to tell a real sprint id
    from a fabricated one. Pinned exactly rather than `in (403, 404)`: a loose
    assertion would keep passing if the gate degraded into some other shape."""
    sprint = _active_sprint(project)
    _request(sprint, owner)
    outsider = User.objects.create_user(username="outsider", password="pw")

    resp = _client(outsider).get(_url(sprint))
    assert resp.status_code == 404


def test_close_request_route_denies_a_member_of_a_different_project(
    project: Project, owner: Any
) -> None:
    """The classic IDOR shape: a legitimate user of project B asking for project
    A's sprint. The role is resolved against *this sprint's* project, not the
    caller's own, so membership elsewhere grants nothing here — and this is the
    case a future has_object_permission refactor would break silently."""
    sprint = _active_sprint(project)
    _request(sprint, owner)

    other_project = Project.objects.create(name="Other", start_date=date(2026, 1, 1))
    intruder = User.objects.create_user(username="intruder", password="pw")
    ProjectMembership.objects.create(project=other_project, user=intruder, role=Role.OWNER)

    resp = _client(intruder).get(_url(sprint))
    assert resp.status_code == 404


def test_close_request_route_requires_authentication(project: Project, owner: Any) -> None:
    sprint = _active_sprint(project)
    _request(sprint, owner)
    assert APIClient().get(_url(sprint)).status_code == 401


def test_raw_failure_text_is_withheld_below_admin(project: Project, owner: Any) -> None:
    """The stored text is a raw ``str(exc)`` — a DB or broker failure puts
    internal hostnames, container IPs, DB usernames, constraint names, or SQL
    fragments in it, which is precisely what Django's production 500 handler
    suppresses. The sibling surface for this pattern (``export_jobs``) is
    Admin-gated, so serving it to Viewer+ would widen the audience for raw
    exception text rather than follow the house pattern.

    A viewer still learns the close failed and whether it will be retried — the
    endpoint's whole purpose — without the operational detail riding along.
    """
    sprint = _active_sprint(project)
    with patch("trueppm_api.apps.projects.services.snapshot_sprint_task_outcomes", _boom):
        close_sprint.run(str(_request(sprint, owner).id))

    viewer = User.objects.create_user(username="viewer2", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)

    resp = _client(viewer).get(_url(sprint))
    assert resp.status_code == 200
    assert "snapshot exploded" not in resp.data["error_message"]
    assert "RuntimeError" not in resp.data["error_message"]
    # The failure itself is not hidden — only its internals.
    assert resp.data["status"] == SprintCloseRequestStatus.FAILED
    assert "retried" in resp.data["error_message"]

    # A MEMBER is below ADMIN too — the gate is the role, not merely "not viewer".
    member = User.objects.create_user(username="member2", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    member_resp = _client(member).get(_url(sprint))
    assert "snapshot exploded" not in member_resp.data["error_message"]


def test_withheld_failure_text_distinguishes_abandoned_from_retrying(
    project: Project, owner: Any
) -> None:
    """The summary a below-admin reader gets still answers the question that
    matters — is this sprint coming back on its own, or is it stuck?"""
    sprint = _active_sprint(project)
    _request(sprint, owner)
    Sprint.objects.filter(pk=sprint.pk).update(state=SprintState.CANCELLED)
    close_sprint.run(str(SprintCloseRequest.objects.get(sprint=sprint).id))

    viewer = User.objects.create_user(username="viewer3", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)

    resp = _client(viewer).get(_url(sprint))
    assert resp.data["terminal"] is True
    assert "will not be retried" in resp.data["error_message"]
    assert "cancelled" not in resp.data["error_message"].lower()


def test_failure_reason_is_a_server_fact_available_to_every_reader(
    project: Project, owner: Any
) -> None:
    """The role gate on ``error_message`` contains raw *exception* text. Two of
    the failure writers record a deterministic, non-sensitive structural cause
    the server already knows, and gating those would leave every non-Admin reader
    — including an agent asking why a sprint is still open — with a verdict and
    no derivation. So the classification is unconditional.

    Asserted off the stored field, not off the message text: reconstructing it by
    matching prose would couple every reader to a string nobody treats as an API.
    """
    sprint = _active_sprint(project)
    _request(sprint, owner)
    Sprint.objects.filter(pk=sprint.pk).update(state=SprintState.CANCELLED)
    close_sprint.run(str(SprintCloseRequest.objects.get(sprint=sprint).id))

    viewer = User.objects.create_user(username="viewer4", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)

    resp = _client(viewer).get(_url(sprint))
    assert resp.status_code == 200
    assert resp.data["failure_reason"] == "cancelled"
    # The raw text is still withheld from them.
    assert "cancelled before close" not in resp.data["error_message"]


def test_failure_reason_distinguishes_an_exception_from_a_structural_refusal(
    project: Project, owner: Any
) -> None:
    sprint = _active_sprint(project)
    req = _request(sprint, owner)
    with patch("trueppm_api.apps.projects.services.snapshot_sprint_task_outcomes", _boom):
        close_sprint.run(str(req.id))

    resp = _client(owner).get(_url(sprint))
    assert resp.data["failure_reason"] == "error"


def test_failure_reason_is_blank_on_a_successful_close(project: Project, owner: Any) -> None:
    """Cleared on success, so a retried-then-succeeded row does not keep
    advertising the reason its earlier attempt failed."""
    sprint = _active_sprint(project)
    req = _request(sprint, owner)
    with patch("trueppm_api.apps.projects.services.snapshot_sprint_task_outcomes", _boom):
        close_sprint.run(str(req.id))
    SprintCloseRequest.objects.filter(pk=req.pk).update(
        next_attempt_at=timezone.now() - timedelta(seconds=1),
        requested_at=timezone.now() - timedelta(seconds=30),
    )
    with patch.object(close_sprint, "delay"):
        _do_drain()
    close_sprint.run(str(req.id))

    resp = _client(owner).get(_url(sprint))
    assert resp.data["status"] == SprintCloseRequestStatus.COMPLETED
    assert resp.data["failure_reason"] == ""


def test_agent_token_never_receives_the_raw_failure_text(project: Project, owner: Any) -> None:
    """An ``mcp:read`` token resolves to its owning human, so a role-only gate
    would hand raw exception text to an Admin's agent — and from there into an
    LLM context, possibly a hosted one. ADR-0678 governs whether a project
    consents to agent *reads*; it is not consent to ship internal hostnames and
    SQL fragments off-box. ``is_agent_token`` is the one place that distinction
    is made (#2877), so this guard cannot drift from the other MCP controls.
    """
    import secrets

    from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
    from trueppm_api.apps.projects.models import SCOPE_MCP_READ, ApiToken

    sprint = _active_sprint(project)
    with patch("trueppm_api.apps.projects.services.snapshot_sprint_task_outcomes", _boom):
        close_sprint.run(str(_request(sprint, owner).id))

    # The owner is an OWNER, i.e. above ADMIN — a role-only gate would pass.
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    ApiToken.objects.create(
        owner=owner,
        name="agent-token",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
        scopes=[SCOPE_MCP_READ],
    )
    agent = APIClient()
    agent.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")

    resp = agent.get(_url(sprint))
    assert resp.status_code == 200
    assert "snapshot exploded" not in resp.data["error_message"]
    # It still learns *why* — the classification is not gated, so an agent can
    # answer "why is this sprint still open?" without the internals.
    assert resp.data["failure_reason"] == "error"
    assert resp.data["terminal"] is False


def test_close_request_route_is_readable_by_a_viewer(project: Project, owner: Any) -> None:
    """Viewer+, deliberately: closing needs write, but seeing that a close failed
    is a plain team read, and gating it at write would hide the failure from the
    people most likely to notice the sprint never closed."""
    sprint = _active_sprint(project)
    _request(sprint, owner)
    viewer = User.objects.create_user(username="viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)

    resp = _client(viewer).get(_url(sprint))
    assert resp.status_code == 200
