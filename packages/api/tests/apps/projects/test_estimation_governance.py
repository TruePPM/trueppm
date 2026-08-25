"""Tests for three-point estimate governance modes (issue #141 / ADR-0032)."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    EstimateStatus,
    EstimationMode,
    Project,
    Task,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


def _make_user(username: str) -> object:
    return User.objects.create_user(username=username, password="pw")


def _make_membership(project: Project, user: object, role: Role) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=role)


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def owner(project: Project) -> object:
    u = _make_user("owner")
    _make_membership(project, u, Role.OWNER)
    return u


@pytest.fixture
def scheduler(project: Project) -> object:
    u = _make_user("scheduler")
    _make_membership(project, u, Role.SCHEDULER)
    return u


@pytest.fixture
def contributor(project: Project) -> object:
    u = _make_user("contributor")
    _make_membership(project, u, Role.MEMBER)
    return u


@pytest.fixture
def viewer(project: Project) -> object:
    u = _make_user("viewer")
    _make_membership(project, u, Role.VIEWER)
    return u


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="T", duration=5)


@pytest.fixture
def admin(project: Project) -> object:
    # ADMIN (project manager) can edit any task without being the assignee —
    # the role used by the write-serializer validation tests below.
    u = _make_user("admin")
    _make_membership(project, u, Role.ADMIN)
    return u


# ---------------------------------------------------------------------------
# Model defaults
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_estimation_mode_defaults_to_open(project: Project) -> None:
    assert project.estimation_mode == EstimationMode.OPEN


@pytest.mark.django_db
def test_task_estimate_status_defaults_to_null(task: Task) -> None:
    assert task.estimate_status is None


# ---------------------------------------------------------------------------
# Serializer: estimation_mode on ProjectSerializer
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_serializer_exposes_estimation_mode(project: Project, scheduler: object) -> None:
    c = _client(scheduler)
    resp = c.get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200
    assert resp.data["estimation_mode"] == EstimationMode.OPEN


@pytest.mark.django_db
def test_scheduler_can_update_estimation_mode(project: Project, scheduler: object) -> None:
    c = _client(scheduler)
    resp = c.patch(
        f"/api/v1/projects/{project.pk}/",
        {"estimation_mode": EstimationMode.SUGGEST_APPROVE},
        format="json",
    )
    assert resp.status_code == 200
    project.refresh_from_db()
    assert project.estimation_mode == EstimationMode.SUGGEST_APPROVE


# ---------------------------------------------------------------------------
# Open mode: contributor writes estimates freely, no status tracking
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_open_mode_contributor_writes_estimates(
    project: Project, task: Task, contributor: object
) -> None:
    # MEMBER can edit their own assigned tasks (IsProjectMemberWriteOrOwn).
    from django.contrib.auth import get_user_model as _get_user_model

    _User = _get_user_model()
    _u = _User.objects.get(username="contributor")
    task.assignee = _u
    task.save(update_fields=["assignee"])

    c = _client(contributor)
    resp = c.patch(
        f"/api/v1/tasks/{task.pk}/",
        {"optimistic_duration": 3, "most_likely_duration": 5, "pessimistic_duration": 8},
        format="json",
    )
    assert resp.status_code == 200
    task.refresh_from_db()
    assert task.optimistic_duration == 3
    assert task.most_likely_duration == 5
    assert task.pessimistic_duration == 8
    # In open mode, estimate_status is null — not tracked.
    assert task.estimate_status is None


@pytest.mark.django_db
def test_open_mode_partial_save_allowed(project: Project, task: Task) -> None:
    # Project Manager (ADMIN, role=Role.ADMIN) can edit any task — no assignee needed.
    pm = _make_user("pm_partial")
    _make_membership(project, pm, Role.ADMIN)
    c = _client(pm)
    resp = c.patch(
        f"/api/v1/tasks/{task.pk}/",
        {"optimistic_duration": 3},
        format="json",
    )
    assert resp.status_code == 200
    task.refresh_from_db()
    assert task.optimistic_duration == 3
    assert task.most_likely_duration is None


# ---------------------------------------------------------------------------
# Three-point ordering invariant (#1982): the write serializer rejects a complete
# triple that violates optimistic <= most_likely <= pessimistic, mirroring the
# engine's #1069 guard so invalid data can never persist and detonate at compute
# time (the #1981 program-schedule 500 / stale single-project dates).
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("opt", "ml", "pess"),
    [
        (5, 3, 8),  # optimistic > most_likely
        (3, 8, 5),  # most_likely > pessimistic
        (8, 5, 3),  # optimistic > pessimistic (fully reversed)
    ],
)
def test_out_of_order_triple_rejected(
    project: Project, task: Task, admin: object, opt: int, ml: int, pess: int
) -> None:
    c = _client(admin)
    resp = c.patch(
        f"/api/v1/tasks/{task.pk}/",
        {"optimistic_duration": opt, "most_likely_duration": ml, "pessimistic_duration": pess},
        format="json",
    )
    assert resp.status_code == 400, resp.data
    assert "most_likely_duration" in resp.data
    task.refresh_from_db()
    # Rejected write must not persist any of the estimates.
    assert task.optimistic_duration is None


@pytest.mark.django_db
def test_valid_ordered_triple_accepted(project: Project, task: Task, admin: object) -> None:
    c = _client(admin)
    resp = c.patch(
        f"/api/v1/tasks/{task.pk}/",
        {"optimistic_duration": 2, "most_likely_duration": 2, "pessimistic_duration": 4},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    task.refresh_from_db()
    assert (task.optimistic_duration, task.most_likely_duration, task.pessimistic_duration) == (
        2,
        2,
        4,
    )


@pytest.mark.django_db
def test_partial_estimate_out_of_order_not_validated(project: Project, admin: object) -> None:
    """Only two of three estimates present — the engine never samples a partial
    triple, so the serializer leaves it unvalidated even if the two cross."""
    partial = Task.objects.create(project=project, name="Partial", duration=3)
    c = _client(admin)
    resp = c.patch(
        f"/api/v1/tasks/{partial.pk}/",
        {"optimistic_duration": 9, "most_likely_duration": 2},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    partial.refresh_from_db()
    assert partial.optimistic_duration == 9
    assert partial.pessimistic_duration is None


@pytest.mark.django_db
def test_single_field_patch_crossing_stored_values_rejected(
    project: Project, admin: object
) -> None:
    """A PATCH that sends only one estimate is validated against the task's stored
    values — the invariant is checked on the merged instance+attrs state, not on
    the payload alone."""
    stored = Task.objects.create(
        project=project,
        name="Stored",
        duration=5,
        optimistic_duration=2,
        most_likely_duration=5,
        pessimistic_duration=8,
    )
    c = _client(admin)
    # Drop pessimistic below most_likely — crosses the invariant against stored ml=5.
    resp = c.patch(
        f"/api/v1/tasks/{stored.pk}/",
        {"pessimistic_duration": 1},
        format="json",
    )
    assert resp.status_code == 400, resp.data
    assert "most_likely_duration" in resp.data
    stored.refresh_from_db()
    assert stored.pessimistic_duration == 8


# ---------------------------------------------------------------------------
# Suggest-approve mode: contributor sets pending, scheduler approves
# ---------------------------------------------------------------------------


@pytest.fixture
def suggest_project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="SA",
        start_date=date(2026, 4, 1),
        calendar=calendar,
        estimation_mode=EstimationMode.SUGGEST_APPROVE,
    )


@pytest.fixture
def suggest_task(suggest_project: Project) -> Task:
    return Task.objects.create(project=suggest_project, name="T", duration=5)


@pytest.fixture
def sa_scheduler(suggest_project: Project) -> object:
    u = _make_user("sa_scheduler")
    _make_membership(suggest_project, u, Role.SCHEDULER)
    return u


@pytest.fixture
def sa_contributor(suggest_project: Project) -> object:
    u = _make_user("sa_contributor")
    _make_membership(suggest_project, u, Role.MEMBER)
    return u


@pytest.mark.django_db
def test_suggest_approve_contributor_sets_pending(
    suggest_project: Project, suggest_task: Task, sa_contributor: object
) -> None:
    from django.contrib.auth import get_user_model as _get_user_model

    _u = _get_user_model().objects.get(username="sa_contributor")
    suggest_task.assignee = _u
    suggest_task.save(update_fields=["assignee"])

    c = _client(sa_contributor)
    resp = c.patch(
        f"/api/v1/tasks/{suggest_task.pk}/",
        {"optimistic_duration": 3, "most_likely_duration": 5, "pessimistic_duration": 8},
        format="json",
    )
    assert resp.status_code == 200
    suggest_task.refresh_from_db()
    assert suggest_task.estimate_status == EstimateStatus.PENDING


@pytest.mark.django_db
def test_suggest_approve_scheduler_writes_accepted(
    suggest_project: Project, suggest_task: Task, sa_scheduler: object
) -> None:
    c = _client(sa_scheduler)
    patch_resp = c.patch(
        f"/api/v1/tasks/{suggest_task.pk}/",
        {"optimistic_duration": 3, "most_likely_duration": 5, "pessimistic_duration": 8},
        format="json",
    )
    # A Resource Manager (Role.SCHEDULER) is read-only on task *content* — the
    # estimate PATCH is refused. Asserting the 403 keeps this test honest: without
    # it the unchecked response made the case look like a successful Scheduler write.
    assert patch_resp.status_code == 403
    # approve-estimates is the Scheduler's actual door, and it sets accepted
    # atomically regardless of what the PATCH path allows.
    resp = c.post(f"/api/v1/tasks/{suggest_task.pk}/approve-estimates/")
    assert resp.status_code == 200
    suggest_task.refresh_from_db()
    assert suggest_task.estimate_status == EstimateStatus.ACCEPTED


@pytest.mark.django_db
def test_approve_estimates_idempotent(
    suggest_project: Project, suggest_task: Task, sa_scheduler: object
) -> None:
    suggest_task.estimate_status = EstimateStatus.ACCEPTED
    suggest_task.save(update_fields=["estimate_status"])

    c = _client(sa_scheduler)
    resp = c.post(f"/api/v1/tasks/{suggest_task.pk}/approve-estimates/")
    assert resp.status_code == 200
    # No additional DB write — still accepted.
    suggest_task.refresh_from_db()
    assert suggest_task.estimate_status == EstimateStatus.ACCEPTED


@pytest.mark.django_db
def test_approve_estimates_returns_400_for_open_mode(
    project: Project, task: Task, scheduler: object
) -> None:
    c = _client(scheduler)
    resp = c.post(f"/api/v1/tasks/{task.pk}/approve-estimates/")
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# RBAC: approve-estimates requires Scheduler+
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_approve_estimates_forbidden_for_contributor(
    suggest_project: Project, suggest_task: Task, sa_contributor: object
) -> None:
    c = _client(sa_contributor)
    resp = c.post(f"/api/v1/tasks/{suggest_task.pk}/approve-estimates/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_approve_estimates_forbidden_for_viewer(
    suggest_project: Project, sa_contributor: object
) -> None:
    u = _make_user("sa_viewer")
    _make_membership(suggest_project, u, Role.VIEWER)
    task = Task.objects.create(project=suggest_project, name="T2", duration=3)
    c = _client(u)
    resp = c.post(f"/api/v1/tasks/{task.pk}/approve-estimates/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_approve_estimates_forbidden_for_unauthenticated(
    suggest_project: Project, suggest_task: Task
) -> None:
    c = APIClient()
    resp = c.post(f"/api/v1/tasks/{suggest_task.pk}/approve-estimates/")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# MC gate: pending estimates excluded from Monte Carlo input
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_mc_gate_pending_estimates_treated_as_none(
    suggest_project: Project, sa_scheduler: object
) -> None:
    """Pending estimates must not reach the Monte Carlo engine."""
    Task.objects.create(
        project=suggest_project,
        name="T",
        duration=5,
        optimistic_duration=3,
        most_likely_duration=5,
        pessimistic_duration=8,
        estimate_status=EstimateStatus.PENDING,
    )
    # The shared build_sched_tasks() converter gates pending estimates; verify by
    # calling the endpoint and checking the result uses deterministic duration
    # (not PERT samples).
    c = _client(sa_scheduler)
    resp = c.post(f"/api/v1/projects/{suggest_project.pk}/monte-carlo/", format="json")
    assert resp.status_code == 200
    # A withheld (pending) triple must NOT reach the engine: with no variance-bearing
    # task the forecast collapses to a single date (P50 == P80 == P95) and the
    # diagnostic names the pending approval. If the gate broke and the PERT triple
    # leaked in, the band would open (P95 > P50) — status_code alone can't tell the
    # two directions apart, which is the vacuity this test exists to close.
    assert resp.data["p50"] == resp.data["p80"] == resp.data["p95"]
    assert resp.data["forecast_diagnostic"]["reason"] == "estimates_pending_approval"


@pytest.mark.django_db
def test_mc_gate_accepted_estimates_pass_through(
    suggest_project: Project, sa_scheduler: object
) -> None:
    Task.objects.create(
        project=suggest_project,
        name="T",
        duration=5,
        optimistic_duration=3,
        most_likely_duration=5,
        pessimistic_duration=8,
        estimate_status=EstimateStatus.ACCEPTED,
    )
    c = _client(sa_scheduler)
    resp = c.post(f"/api/v1/projects/{suggest_project.pk}/monte-carlo/", format="json")
    assert resp.status_code == 200
    # An ACCEPTED triple (opt 3 / ml 5 / pess 8) passes the gate and reaches the
    # PERT sampler, so the forecast carries a real uncertainty band (P95 > P50) and
    # the diagnostic reports no suppression reason. This is the opposite direction
    # from the pending case above — asserting the band opens is what makes the two
    # tests distinguishable.
    assert date.fromisoformat(resp.data["p95"]) > date.fromisoformat(resp.data["p50"])
    assert resp.data["forecast_diagnostic"]["reason"] is None


# ---------------------------------------------------------------------------
# History: estimate changes and approvals appear in HistoricalTask
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_estimate_change_recorded_in_history(project: Project, task: Task) -> None:
    pm = _make_user("pm_hist")
    _make_membership(project, pm, Role.ADMIN)
    c = _client(pm)
    c.patch(
        f"/api/v1/tasks/{task.pk}/",
        {"optimistic_duration": 3, "most_likely_duration": 5, "pessimistic_duration": 8},
        format="json",
    )
    history = task.history.order_by("-history_date").first()
    assert history is not None
    assert history.optimistic_duration == 3


@pytest.mark.django_db
def test_approve_records_status_change_in_history(
    suggest_project: Project, suggest_task: Task, sa_scheduler: object, sa_contributor: object
) -> None:
    from django.contrib.auth import get_user_model as _get_user_model

    _u = _get_user_model().objects.get(username="sa_contributor")
    suggest_task.assignee = _u
    suggest_task.save(update_fields=["assignee"])

    # Contributor suggests.
    _client(sa_contributor).patch(
        f"/api/v1/tasks/{suggest_task.pk}/",
        {"optimistic_duration": 3, "most_likely_duration": 5, "pessimistic_duration": 8},
        format="json",
    )
    # Scheduler approves.
    _client(sa_scheduler).post(f"/api/v1/tasks/{suggest_task.pk}/approve-estimates/")
    statuses = list(
        suggest_task.history.order_by("-history_date").values_list("estimate_status", flat=True)
    )
    assert EstimateStatus.ACCEPTED in statuses
    assert EstimateStatus.PENDING in statuses


# ---------------------------------------------------------------------------
# Undefended door: a direct PATCH of estimate_status (#2570)
#
# The tests above exercise both *sanctioned* doors — the PERT co-write path and
# the role-gated approve-estimates action. They never attempt the one the code
# only asks callers not to use. A field whose protection is "the caller is not
# supposed to send this" needs a test that sending it is actually rejected, not
# only that the sanctioned path works.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_contributor_cannot_self_approve_via_bare_patch(
    suggest_project: Project, suggest_task: Task, sa_contributor: object
) -> None:
    """A bare ``PATCH {"estimate_status": "accepted"}`` must not stick (#2570).

    ``_apply_estimate_governance`` only normalizes the field when PERT durations
    are co-written, so before the fix an assignee could self-approve by sending
    estimate_status alone — bypassing the Scheduler-gated approve-estimates
    action entirely.
    """
    from django.contrib.auth import get_user_model as _get_user_model

    _u = _get_user_model().objects.get(username="sa_contributor")
    suggest_task.assignee = _u
    suggest_task.estimate_status = EstimateStatus.PENDING
    suggest_task.save(update_fields=["assignee", "estimate_status"])

    c = _client(sa_contributor)
    resp = c.patch(
        f"/api/v1/tasks/{suggest_task.pk}/",
        {"estimate_status": EstimateStatus.ACCEPTED},
        format="json",
    )

    # Read-only fields are silently ignored by DRF, so the request succeeds — what
    # must not happen is the value landing.
    assert resp.status_code == 200
    suggest_task.refresh_from_db()
    assert suggest_task.estimate_status == EstimateStatus.PENDING
    # The response must echo the server's value, not the attacker's.
    assert resp.data["estimate_status"] == EstimateStatus.PENDING


@pytest.mark.django_db
def test_contributor_cannot_self_approve_alongside_pert_write(
    suggest_project: Project, suggest_task: Task, sa_contributor: object
) -> None:
    """Smuggling estimate_status into a legitimate PERT edit still yields pending."""
    from django.contrib.auth import get_user_model as _get_user_model

    _u = _get_user_model().objects.get(username="sa_contributor")
    suggest_task.assignee = _u
    suggest_task.save(update_fields=["assignee"])

    c = _client(sa_contributor)
    resp = c.patch(
        f"/api/v1/tasks/{suggest_task.pk}/",
        {
            "optimistic_duration": 3,
            "most_likely_duration": 5,
            "pessimistic_duration": 8,
            "estimate_status": EstimateStatus.ACCEPTED,
        },
        format="json",
    )
    assert resp.status_code == 200
    suggest_task.refresh_from_db()
    assert suggest_task.estimate_status == EstimateStatus.PENDING


@pytest.mark.django_db
def test_project_manager_cannot_self_approve_via_bare_patch_either(
    suggest_project: Project, suggest_task: Task
) -> None:
    """Read-only is uniform: even a Project Manager must use approve-estimates.

    The action is the single audited write path; allowing a privileged PATCH to
    shortcut it would put the same value in the record by an unlogged route. A
    Project Manager (Role.ADMIN) is used here rather than a Resource Manager because
    can_user_edit_task refuses Role.SCHEDULER on task *content* — so a plain
    Scheduler PATCH is rejected before the serializer is consulted and would prove
    nothing about field-level protection. (That refusal is not absolute: a Scheduler
    who also holds the team's Product Owner facet may edit EPIC/STORY tasks, per
    ADR-0078. Role.ADMIN avoids depending on either branch.)
    """
    pm = _make_user("sa_pm")
    _make_membership(suggest_project, pm, Role.ADMIN)
    suggest_task.estimate_status = EstimateStatus.PENDING
    suggest_task.save(update_fields=["estimate_status"])

    resp = _client(pm).patch(
        f"/api/v1/tasks/{suggest_task.pk}/",
        {"estimate_status": EstimateStatus.ACCEPTED},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    suggest_task.refresh_from_db()
    assert suggest_task.estimate_status == EstimateStatus.PENDING


@pytest.mark.django_db
def test_approve_estimates_action_still_reaches_accepted(
    suggest_project: Project, suggest_task: Task, sa_scheduler: object
) -> None:
    """Regression guard: making the field read-only must not break the legit path.

    ``approve_estimates`` writes the model directly (``task.save(update_fields=…)``),
    so serializer read-only status does not apply to it.
    """
    suggest_task.estimate_status = EstimateStatus.PENDING
    suggest_task.save(update_fields=["estimate_status"])

    resp = _client(sa_scheduler).post(f"/api/v1/tasks/{suggest_task.pk}/approve-estimates/")
    assert resp.status_code == 200
    suggest_task.refresh_from_db()
    assert suggest_task.estimate_status == EstimateStatus.ACCEPTED
    assert resp.data["estimate_status"] == EstimateStatus.ACCEPTED


# ---------------------------------------------------------------------------
# ADR-0766 (#2597): a no-op PERT re-write must not revoke an accepted estimate,
# and a genuine change on an accepted estimate must still downgrade it.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_noop_pert_rewrite_does_not_revoke_accepted(
    suggest_project: Project, suggest_task: Task, sa_contributor: object
) -> None:
    """Re-sending the identical stored value must not flip accepted -> pending.

    This is the debounced blur-PATCH scenario from the issue: EstimatesTab fires
    a PATCH on blur even when the field was never edited.
    """
    from django.contrib.auth import get_user_model as _get_user_model

    _u = _get_user_model().objects.get(username="sa_contributor")
    suggest_task.assignee = _u
    suggest_task.optimistic_duration = 3
    suggest_task.most_likely_duration = 5
    suggest_task.pessimistic_duration = 8
    suggest_task.estimate_status = EstimateStatus.ACCEPTED
    suggest_task.save(
        update_fields=[
            "assignee",
            "optimistic_duration",
            "most_likely_duration",
            "pessimistic_duration",
            "estimate_status",
        ]
    )

    c = _client(sa_contributor)
    resp = c.patch(
        f"/api/v1/tasks/{suggest_task.pk}/",
        # Identical values to what's already stored — a true no-op write.
        {"most_likely_duration": 5},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    suggest_task.refresh_from_db()
    assert suggest_task.estimate_status == EstimateStatus.ACCEPTED
    assert resp.data["estimate_status"] == EstimateStatus.ACCEPTED


@pytest.mark.django_db
def test_genuine_pert_change_still_revokes_accepted(
    suggest_project: Project, suggest_task: Task, sa_contributor: object
) -> None:
    """Regression guard: a real edit must still require re-approval."""
    from django.contrib.auth import get_user_model as _get_user_model

    _u = _get_user_model().objects.get(username="sa_contributor")
    suggest_task.assignee = _u
    suggest_task.optimistic_duration = 3
    suggest_task.most_likely_duration = 5
    suggest_task.pessimistic_duration = 8
    suggest_task.estimate_status = EstimateStatus.ACCEPTED
    suggest_task.save(
        update_fields=[
            "assignee",
            "optimistic_duration",
            "most_likely_duration",
            "pessimistic_duration",
            "estimate_status",
        ]
    )

    c = _client(sa_contributor)
    resp = c.patch(
        f"/api/v1/tasks/{suggest_task.pk}/",
        {"most_likely_duration": 6},  # genuinely different from stored 5
        format="json",
    )
    assert resp.status_code == 200, resp.data
    suggest_task.refresh_from_db()
    assert suggest_task.estimate_status == EstimateStatus.PENDING


@pytest.mark.django_db
def test_pert_field_cleared_to_null_still_revokes_accepted(
    suggest_project: Project, suggest_task: Task, sa_contributor: object
) -> None:
    """Clearing a stored value to null is a real edit, not a no-op."""
    from django.contrib.auth import get_user_model as _get_user_model

    _u = _get_user_model().objects.get(username="sa_contributor")
    suggest_task.assignee = _u
    suggest_task.optimistic_duration = 3
    suggest_task.most_likely_duration = 5
    suggest_task.pessimistic_duration = 8
    suggest_task.estimate_status = EstimateStatus.ACCEPTED
    suggest_task.save(
        update_fields=[
            "assignee",
            "optimistic_duration",
            "most_likely_duration",
            "pessimistic_duration",
            "estimate_status",
        ]
    )

    c = _client(sa_contributor)
    resp = c.patch(
        f"/api/v1/tasks/{suggest_task.pk}/",
        {"pessimistic_duration": None},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    suggest_task.refresh_from_db()
    assert suggest_task.estimate_status == EstimateStatus.PENDING


@pytest.mark.django_db
def test_noop_pert_rewrite_in_open_mode_does_not_touch_stale_status(
    project: Project, task: Task, admin: object
) -> None:
    """A stale non-null estimate_status from a prior mode is only cleared by a
    real edit, not by a no-op re-write, in OPEN/PM_ONLY mode too (ADR-0766)."""
    task.optimistic_duration = 3
    task.most_likely_duration = 5
    task.pessimistic_duration = 8
    # Simulate a stale value left over from a prior SUGGEST_APPROVE window.
    task.estimate_status = EstimateStatus.ACCEPTED
    task.save(
        update_fields=[
            "optimistic_duration",
            "most_likely_duration",
            "pessimistic_duration",
            "estimate_status",
        ]
    )

    resp = _client(admin).patch(
        f"/api/v1/tasks/{task.pk}/",
        {"most_likely_duration": 5},  # identical to stored
        format="json",
    )
    assert resp.status_code == 200, resp.data
    task.refresh_from_db()
    # Untouched by the no-op write — still the stale ACCEPTED value.
    assert task.estimate_status == EstimateStatus.ACCEPTED


@pytest.mark.django_db
def test_mc_band_unchanged_after_noop_pert_patch_on_accepted_task(
    suggest_project: Project, sa_scheduler: object, sa_contributor: object
) -> None:
    """A no-op PERT PATCH on an accepted task must not withhold its triple from MC."""
    from django.contrib.auth import get_user_model as _get_user_model

    _u = _get_user_model().objects.get(username="sa_contributor")
    task = Task.objects.create(
        project=suggest_project,
        name="T",
        duration=5,
        assignee=_u,
        optimistic_duration=3,
        most_likely_duration=5,
        pessimistic_duration=8,
        estimate_status=EstimateStatus.ACCEPTED,
    )

    # Blur-PATCH with the identical stored value — must not revoke.
    resp = _client(sa_contributor).patch(
        f"/api/v1/tasks/{task.pk}/",
        {"most_likely_duration": 5},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    task.refresh_from_db()
    assert task.estimate_status == EstimateStatus.ACCEPTED

    mc_resp = _client(sa_scheduler).post(
        f"/api/v1/projects/{suggest_project.pk}/monte-carlo/", format="json"
    )
    assert mc_resp.status_code == 200
    # Still accepted, so the triple reaches the sampler and the band stays open.
    assert date.fromisoformat(mc_resp.data["p95"]) > date.fromisoformat(mc_resp.data["p50"])
    assert mc_resp.data["forecast_diagnostic"]["reason"] is None


# ---------------------------------------------------------------------------
# ADR-0766 (#2597): withdraw-approval — the Scheduler's symmetric un-approve door
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_scheduler_can_withdraw_approval(
    suggest_project: Project, suggest_task: Task, sa_scheduler: object
) -> None:
    suggest_task.optimistic_duration = 3
    suggest_task.most_likely_duration = 5
    suggest_task.pessimistic_duration = 8
    suggest_task.estimate_status = EstimateStatus.ACCEPTED
    suggest_task.save(
        update_fields=[
            "optimistic_duration",
            "most_likely_duration",
            "pessimistic_duration",
            "estimate_status",
        ]
    )

    resp = _client(sa_scheduler).post(f"/api/v1/tasks/{suggest_task.pk}/withdraw-approval/")
    assert resp.status_code == 200, resp.data
    suggest_task.refresh_from_db()
    assert suggest_task.estimate_status == EstimateStatus.PENDING
    assert resp.data["estimate_status"] == EstimateStatus.PENDING


@pytest.mark.django_db
def test_withdraw_approval_idempotent_when_already_pending(
    suggest_project: Project, suggest_task: Task, sa_scheduler: object
) -> None:
    suggest_task.estimate_status = EstimateStatus.PENDING
    suggest_task.save(update_fields=["estimate_status"])

    resp = _client(sa_scheduler).post(f"/api/v1/tasks/{suggest_task.pk}/withdraw-approval/")
    assert resp.status_code == 200
    suggest_task.refresh_from_db()
    assert suggest_task.estimate_status == EstimateStatus.PENDING


@pytest.mark.django_db
def test_withdraw_approval_idempotent_when_null(
    suggest_project: Project, suggest_task: Task, sa_scheduler: object
) -> None:
    assert suggest_task.estimate_status is None
    resp = _client(sa_scheduler).post(f"/api/v1/tasks/{suggest_task.pk}/withdraw-approval/")
    assert resp.status_code == 200
    suggest_task.refresh_from_db()
    assert suggest_task.estimate_status is None


@pytest.mark.django_db
def test_withdraw_approval_returns_400_for_open_mode(
    project: Project, task: Task, scheduler: object
) -> None:
    c = _client(scheduler)
    resp = c.post(f"/api/v1/tasks/{task.pk}/withdraw-approval/")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_withdraw_approval_forbidden_for_contributor(
    suggest_project: Project, suggest_task: Task, sa_contributor: object
) -> None:
    suggest_task.estimate_status = EstimateStatus.ACCEPTED
    suggest_task.save(update_fields=["estimate_status"])

    resp = _client(sa_contributor).post(f"/api/v1/tasks/{suggest_task.pk}/withdraw-approval/")
    assert resp.status_code == 403
    suggest_task.refresh_from_db()
    # Unauthorized call must not have written anything.
    assert suggest_task.estimate_status == EstimateStatus.ACCEPTED


@pytest.mark.django_db
def test_withdraw_approval_forbidden_for_viewer(
    suggest_project: Project, sa_contributor: object
) -> None:
    u = _make_user("sa_viewer_withdraw")
    _make_membership(suggest_project, u, Role.VIEWER)
    task = Task.objects.create(
        project=suggest_project, name="T3", duration=3, estimate_status=EstimateStatus.ACCEPTED
    )
    resp = _client(u).post(f"/api/v1/tasks/{task.pk}/withdraw-approval/")
    assert resp.status_code == 403
    task.refresh_from_db()
    assert task.estimate_status == EstimateStatus.ACCEPTED


@pytest.mark.django_db
def test_withdraw_approval_forbidden_for_unauthenticated(
    suggest_project: Project, suggest_task: Task
) -> None:
    c = APIClient()
    resp = c.post(f"/api/v1/tasks/{suggest_task.pk}/withdraw-approval/")
    assert resp.status_code == 401


@pytest.mark.django_db
def test_withdraw_approval_forbidden_on_archived_project(
    suggest_project: Project, suggest_task: Task, sa_scheduler: object
) -> None:
    """IsProjectNotArchived blocks the action the same as approve_estimates."""
    suggest_task.estimate_status = EstimateStatus.ACCEPTED
    suggest_task.save(update_fields=["estimate_status"])
    suggest_project.is_archived = True
    suggest_project.save(update_fields=["is_archived"])

    resp = _client(sa_scheduler).post(f"/api/v1/tasks/{suggest_task.pk}/withdraw-approval/")
    assert resp.status_code == 403
    suggest_task.refresh_from_db()
    assert suggest_task.estimate_status == EstimateStatus.ACCEPTED


@pytest.mark.django_db
def test_withdraw_approval_records_status_change_in_history(
    suggest_project: Project, suggest_task: Task, sa_scheduler: object
) -> None:
    suggest_task.estimate_status = EstimateStatus.ACCEPTED
    suggest_task.save(update_fields=["estimate_status"])

    _client(sa_scheduler).post(f"/api/v1/tasks/{suggest_task.pk}/withdraw-approval/")

    statuses = list(
        suggest_task.history.order_by("-history_date").values_list("estimate_status", flat=True)
    )
    assert EstimateStatus.PENDING in statuses
    assert EstimateStatus.ACCEPTED in statuses


@pytest.mark.django_db
def test_withdraw_then_reapprove_round_trip(
    suggest_project: Project, suggest_task: Task, sa_scheduler: object
) -> None:
    """A Scheduler can withdraw their own approval and re-grant it later."""
    suggest_task.estimate_status = EstimateStatus.ACCEPTED
    suggest_task.save(update_fields=["estimate_status"])

    c = _client(sa_scheduler)
    resp1 = c.post(f"/api/v1/tasks/{suggest_task.pk}/withdraw-approval/")
    assert resp1.status_code == 200
    suggest_task.refresh_from_db()
    assert suggest_task.estimate_status == EstimateStatus.PENDING

    resp2 = c.post(f"/api/v1/tasks/{suggest_task.pk}/approve-estimates/")
    assert resp2.status_code == 200
    suggest_task.refresh_from_db()
    assert suggest_task.estimate_status == EstimateStatus.ACCEPTED


# ---------------------------------------------------------------------------
# The general shape (#2570): every server-owned Task field must reject a direct
# client write, not merely document that callers should not send it.
#
# Parametrized over the fields whose value is owned by a gated action or an
# internal service. Each case sets a known server value, PATCHes an attacker
# value as a Member, and asserts the stored value is untouched. Add a row here
# whenever a new field's protection is "the caller is not supposed to send this."
# ---------------------------------------------------------------------------


SERVER_OWNED_TASK_FIELDS: list[tuple[str, object, object]] = [
    # (field, server-set value, attacker-supplied value)
    ("estimate_status", EstimateStatus.PENDING, EstimateStatus.ACCEPTED),
    # ADR-0102: only the sprint accept/reject services may clear this.
    ("sprint_pending", True, False),
    # wbs_path and is_subtask needed create-vs-update asymmetry rather than a plain
    # read_only_fields entry — both are server-managed with their invariants
    # enforced only at create — and are covered separately for exactly that reason:
    # both are now read-only on PATCH (ADR-0743, #2585), asserted in
    # test_task_placement_and_estimate_authority.py and test_task_wbs_auto_assign.py.
]


@pytest.mark.django_db
@pytest.mark.parametrize(("field", "server_value", "attacker_value"), SERVER_OWNED_TASK_FIELDS)
def test_server_owned_task_field_rejects_direct_write(
    suggest_project: Project,
    suggest_task: Task,
    sa_contributor: object,
    field: str,
    server_value: object,
    attacker_value: object,
) -> None:
    from django.contrib.auth import get_user_model as _get_user_model

    _u = _get_user_model().objects.get(username="sa_contributor")
    suggest_task.assignee = _u
    setattr(suggest_task, field, server_value)
    suggest_task.save(update_fields=["assignee", field])

    resp = _client(sa_contributor).patch(
        f"/api/v1/tasks/{suggest_task.pk}/",
        {field: attacker_value},
        format="json",
    )
    assert resp.status_code == 200, resp.data

    suggest_task.refresh_from_db()
    assert getattr(suggest_task, field) == server_value, (
        f"{field} is client-writable: a Member PATCHed it to {attacker_value!r}. "
        "Add it to TaskSerializer.Meta.read_only_fields."
    )
