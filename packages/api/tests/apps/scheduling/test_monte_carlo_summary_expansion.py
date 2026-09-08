"""Monte Carlo must schedule the LEAF network, not the phase rows (#3527).

Summary (phase) rows are grouping nodes, not schedulable work: ADR-0105 excludes
them from the CPM pass and derives their dates by rolling up their leaves. Every
Monte Carlo path used to skip that shaping step. A summary carries
``percent_complete = 0`` in the database (the 100% the UI shows is the read-time
``percent_complete_rollup`` annotation, never a stored value) and carries no
dependencies of its own, so each phase entered the simulation as a large,
never-started, unconstrained block floored at the data date, and the longest one
became the simulated project finish. The forecast was flat, unrelated to the
network, inflated by reading a summary's calendar-day span as working days, and
pushed *further out* by recording real progress. (#3530 has since made that stored
span working days, removing the inflation but not the phantom — a summary is still
not schedulable work.)

Every project with phases was affected; a flat-WBS project was not, which is why
the existing Monte Carlo suites did not catch it. So each test here builds a phase
whose stored duration is far longer than the work beneath it — the exact shape that
makes the phantom dominate — and asserts against the date the leaves imply.

Covers all three call sites that shared the defect: the forecast endpoint, the
what-if endpoint, and the derivation builder.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    EstimateStatus,
    EstimationMode,
    Project,
    Task,
)
from trueppm_api.apps.scheduling.models import MonteCarloRun
from trueppm_api.apps.scheduling.services import (
    FORECAST_ALL_COMPLETE,
    FORECAST_ESTIMATES_PENDING_APPROVAL,
)

User = get_user_model()

# Project start is Mon 2026-01-05; status_date is pinned to it so the ADR-0752 §4
# today-floor never moves these exact-date assertions.
START = date(2026, 1, 5)

# What the leaves imply: the longest leaf is 3 working days from Mon Jan 5.
LEAF_FINISH = "2026-01-07"

# What the phantom implied: the phase's own stored 60-day duration, floored at the
# data date. Never asserted as an expected value — it is the wrong answer these
# tests exist to exclude — but named so the numbers below are readable.
PHANTOM_PHASE_DURATION_DAYS = 60

# The all-complete spine fixture below: its leaves finish here, so this is both the
# deterministic finish and the end of the phase's rolled-up span.
COMPLETE_FINISH = date(2026, 2, 27)

# A data date placed mid-flight, deliberately later than the phase's start. Since
# #3530 a summary stores the working days of its own span, so a phase that starts on
# the data date now stores exactly the distance from the data date to its finish —
# and the phantom (that span, floored at the data date) lands *on* the real finish
# instead of past it. Offsetting the data date is what keeps the two distinguishable;
# see the negative control in TestForecastMatchesTheDeterministicSpine.
MIDFLIGHT_DATA_DATE = date(2026, 2, 2)


def working_days_between(start: date, end: date) -> int:
    """Working days from ``start`` to ``end`` inclusive of both endpoints.

    Mirrors the engine's duration convention (``_finish_from_start(start, 1) ==
    start``) on the Mon-Fri `calendar` fixture, which declares no exceptions.
    """
    day, count = start, 0
    while day <= end:
        if day.weekday() < 5:
            count += 1
        day += timedelta(days=1)
    return count


@pytest.fixture(autouse=True)
def _clear_cache() -> object:
    """The mc_latest cache and the what-if throttle history both live in LocMem;
    clear them around each test so neither bleeds into the next."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="mc_summary_user", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Phased Project",
        start_date=START,
        status_date=START,
        calendar=calendar,
    )


@pytest.fixture
def admin_client(user: object, project: Project) -> APIClient:
    # Admin clears the Scheduler+ bar that `_persist_mc_run_if_authorized` requires,
    # so the persisted MonteCarloRun row is available to assert on.
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def phase(project: Project) -> Task:
    """A phase row whose stored duration dwarfs the work beneath it.

    That is not a contrived value: the CPM write-back sets a summary's `duration` to
    its rolled-up span, so a phase spanning a quarter of real work stores ~40-90 while
    its leaves store a handful of days each — the phantom dominates on span alone.

    Until #3530 that span was stored in *calendar* days and then read back as working
    days, inflating the phantom another ~1.4x. Tests in this file that set the phase's
    duration by hand still exercise the same shape; the one that runs the deterministic
    pass (TestForecastMatchesTheDeterministicSpine) lost that margin and carries its
    own note on what replaced it.
    """
    return Task.objects.create(
        project=project, name="1 Migrate", duration=PHANTOM_PHASE_DURATION_DAYS, wbs_path="1"
    )


@pytest.fixture
def leaves(project: Project, phase: Task) -> list[Task]:
    """Two leaves under the phase: 3 working days and 2 working days from START."""
    return [
        Task.objects.create(project=project, name="1.1 Cutover", duration=3, wbs_path="1.1"),
        Task.objects.create(project=project, name="1.2 Verify", duration=2, wbs_path="1.2"),
    ]


def _run_deterministic_schedule(project: Project) -> None:
    """Run the CPM pass synchronously, bypassing the Celery queue — the same seam
    `test_summary_rollup.py` uses. Populates the stored `early_*` columns the
    forecast response reads `cpm_finish` from, and rewrites each summary's duration
    to its calendar-day span.
    """
    from trueppm_api.apps.scheduling.tasks import _run_schedule

    _run_schedule(str(project.pk), tracker=None)


def run_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/monte-carlo/"


def whatif_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/monte-carlo/whatif/"


def derivation_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/schedule/derivation/"


# ---------------------------------------------------------------------------
# The forecast endpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestForecastSchedulesLeavesOnly:
    def test_forecast_lands_on_the_leaf_finish_not_the_phase_span(
        self, admin_client: APIClient, project: Project, phase: Task, leaves: list[Task]
    ) -> None:
        """The simulated finish is the longest LEAF, not the phase's stored span.

        As shipped this returned 2026-03-27 — START plus the phase's own 60 working
        days — for a project whose entire content is five days of work.
        """
        res = admin_client.post(run_url(project), {"n_simulations": 200}, format="json")
        assert res.status_code == 200, res.data
        assert res.data["p50"] == LEAF_FINISH
        assert res.data["p80"] == LEAF_FINISH
        assert res.data["p95"] == LEAF_FINISH

    def test_a_dependency_from_a_phase_still_constrains_its_successor(
        self, admin_client: APIClient, project: Project, phase: Task, leaves: list[Task]
    ) -> None:
        """Summary edges are fanned down to leaves, not dropped along with the row.

        Removing a summary without expanding its edges would leave the successor
        unconstrained and forecast it at the project start — wrong in the opposite
        direction from the phantom, and just as invisible.
        """
        successor = Task.objects.create(
            project=project, name="2 Decommission", duration=4, wbs_path="2"
        )
        Dependency.objects.create(predecessor=phase, successor=successor, dep_type="FS", lag=0)

        res = admin_client.post(run_url(project), {"n_simulations": 200}, format="json")
        assert res.status_code == 200, res.data
        # Latest leaf finishes Wed Jan 7; the successor's 4 working days then run
        # Thu 8, Fri 9, Mon 12, Tue 13. Unconstrained it would finish Jan 8.
        assert res.data["p95"] == "2026-01-13"

    def test_completing_the_long_leaf_pulls_the_forecast_IN(
        self, admin_client: APIClient, project: Project, phase: Task
    ) -> None:
        """Recording truthful progress must improve the forecast, never degrade it.

        This is the symptom that prompted the report: because the phantom's duration
        was the phase's rolled-up *span* and it was floored at the data date, closing
        a task stretched the span and pushed the forecast further out.
        """
        long_leaf = Task.objects.create(
            project=project,
            name="1.1 Cutover",
            duration=10,
            wbs_path="1.1",
            optimistic_duration=8,
            most_likely_duration=10,
            pessimistic_duration=20,
        )
        Task.objects.create(project=project, name="1.2 Verify", duration=2, wbs_path="1.2")

        before = admin_client.post(run_url(project), {"n_simulations": 300}, format="json")
        assert before.status_code == 200, before.data

        long_leaf.percent_complete = 100
        long_leaf.actual_start = START
        long_leaf.actual_finish = START
        long_leaf.save(update_fields=["percent_complete", "actual_start", "actual_finish"])

        after = admin_client.post(run_url(project), {"n_simulations": 300}, format="json")
        assert after.status_code == 200, after.data
        assert after.data["p80"] < before.data["p80"]
        # Only the 2-day leaf is left outstanding: Mon Jan 5 + 2 working days.
        assert after.data["p80"] == "2026-01-06"

    def test_persisted_run_counts_the_simulated_network(
        self, admin_client: APIClient, project: Project, phase: Task, leaves: list[Task]
    ) -> None:
        """`task_count` describes the run's input, so it excludes the phases the
        engine never saw — 2 leaves here, not 3 committed rows."""
        res = admin_client.post(run_url(project), {"n_simulations": 100}, format="json")
        assert res.status_code == 200, res.data

        run = MonteCarloRun.objects.filter(project=project).first()
        assert run is not None
        assert run.task_count == 2


@pytest.mark.django_db
class TestForecastDiagnosticDescribesTheSimulatedSet:
    def test_all_complete_is_reached_when_every_LEAF_is_complete(
        self, admin_client: APIClient, project: Project, phase: Task
    ) -> None:
        """A phase's stored `percent_complete` is always 0, so counting phases kept a
        finished project from ever reaching `all_complete` — the diagnostic reported a
        missing-estimates reason for work that had none left to estimate."""
        for name, path in (("1.1 Cutover", "1.1"), ("1.2 Verify", "1.2")):
            Task.objects.create(
                project=project,
                name=name,
                duration=2,
                wbs_path=path,
                percent_complete=100,
                actual_start=START,
                actual_finish=START,
            )

        res = admin_client.post(run_url(project), {"n_simulations": 100}, format="json")
        assert res.status_code == 200, res.data
        diagnostic = res.data["forecast_diagnostic"]
        assert diagnostic["tasks_total"] == 2
        assert diagnostic["reason"] == FORECAST_ALL_COMPLETE

    def test_a_phase_does_not_inflate_tasks_pending_approval(
        self, admin_client: APIClient, project: Project, phase: Task
    ) -> None:
        """SUGGEST_APPROVE withholds an un-accepted estimate from the engine, and the
        diagnostic counts those separately. A phase has no estimate to withhold, so
        counting it here would misreport how much work is actually waiting on an
        approval — the same over-counting as `tasks_total`, on a different field."""
        project.estimation_mode = EstimationMode.SUGGEST_APPROVE
        project.save(update_fields=["estimation_mode"])
        Task.objects.create(
            project=project,
            name="1.1 Cutover",
            duration=5,
            wbs_path="1.1",
            optimistic_duration=3,
            most_likely_duration=5,
            pessimistic_duration=12,
            estimate_status=EstimateStatus.PENDING,
        )

        res = admin_client.post(run_url(project), {"n_simulations": 100}, format="json")
        assert res.status_code == 200, res.data
        diagnostic = res.data["forecast_diagnostic"]
        assert diagnostic["tasks_total"] == 1
        assert diagnostic["tasks_pending_approval"] == 1
        assert diagnostic["reason"] == FORECAST_ESTIMATES_PENDING_APPROVAL


@pytest.mark.django_db
class TestForecastMatchesTheDeterministicSpine:
    """The report's own acceptance criterion, run against real persisted CPM output.

    Unlike the tests above these do not hand-set the phase's duration: they run the
    deterministic pass first, which writes each summary's `duration` as the working
    days of its rolled-up span (#3530) exactly as production does. So the phantom under
    test is the one the product actually manufactures, not a stand-in for it.
    """

    def test_p50_equals_cpm_finish_when_every_leaf_is_complete(
        self, admin_client: APIClient, project: Project, phase: Task
    ) -> None:
        """For a project with no work left, the engine's documented invariant is a
        forecast identical to the deterministic finish — nothing can vary."""
        Task.objects.create(
            project=project,
            name="1.1 Cutover",
            duration=40,
            wbs_path="1.1",
            percent_complete=100,
            actual_start=START,
            actual_finish=COMPLETE_FINISH,
        )
        Task.objects.create(
            project=project,
            name="1.2 Verify",
            duration=2,
            wbs_path="1.2",
            percent_complete=100,
            actual_start=START,
            actual_finish=date(2026, 1, 6),
        )
        # Move the data date off the phase's start before scheduling. With both on
        # START the phantom is indistinguishable from the right answer — see
        # MIDFLIGHT_DATA_DATE.
        project.status_date = MIDFLIGHT_DATA_DATE
        project.save(update_fields=["status_date"])

        _run_deterministic_schedule(project)

        # Negative control: feeding the phase back into the network as a real task
        # would finish it at the data date plus its stored duration. That has to land
        # clear of the leaf finish, or this test would pass with the #3527 defect
        # reintroduced and prove nothing.
        #
        # Before #3530 the phase stored its *calendar*-day span, so `>= 50` expressed
        # this: 54 calendar days read as working days overshot the finish by a month.
        # A summary now stores working days, so the comparison has to be against the
        # distance the phantom actually has to cover — the working days from the data
        # date to the finish — not a constant that silently became satisfiable by the
        # correct answer.
        phase.refresh_from_db()
        assert phase.duration > working_days_between(MIDFLIGHT_DATA_DATE, COMPLETE_FINISH)

        res = admin_client.post(run_url(project), {"n_simulations": 200}, format="json")
        assert res.status_code == 200, res.data
        assert res.data["cpm_finish"] == COMPLETE_FINISH.isoformat()
        assert res.data["p50"] == res.data["cpm_finish"]
        assert res.data["p80"] == res.data["cpm_finish"]
        assert res.data["p95"] == res.data["cpm_finish"]


@pytest.mark.django_db
class TestInvalidGraphSurfacesAsA400:
    """Shaping the graph on the request path introduced a new way for these
    endpoints to raise, and the engine raises `InvalidScheduleInput` — a plain
    `ValueError` subclass. The project's exception handler reclassifies only
    malformed-UUID ValueErrors, so anything unguarded here is a 500.

    A Start-to-Start link *from* a summary is the cheapest way to reach it: ADR-0024
    rejects it because the leaf cross-product would fan the edge to every leaf and
    turn the successor's `max()` into "wait for the last-starting leaf". The
    deterministic pass has always refused it; before #3527 the forecast endpoints
    never expanded, so they never saw it at all.
    """

    @pytest.fixture
    def summary_ss_link(self, project: Project, phase: Task, leaves: list[Task]) -> Task:
        successor = Task.objects.create(
            project=project, name="2 Decommission", duration=4, wbs_path="2"
        )
        Dependency.objects.create(predecessor=phase, successor=successor, dep_type="SS", lag=0)
        return successor

    def test_forecast_returns_400_not_500(
        self, admin_client: APIClient, project: Project, summary_ss_link: Task
    ) -> None:
        res = admin_client.post(run_url(project), {"n_simulations": 100}, format="json")
        assert res.status_code == 400, res.data
        assert "summary task" in res.data["detail"]

    def test_whatif_returns_400_not_500(
        self, admin_client: APIClient, project: Project, summary_ss_link: Task
    ) -> None:
        res = admin_client.get(
            whatif_url(project),
            {"task_id": str(summary_ss_link.pk), "duration_delta": 2, "n_simulations": 50},
        )
        assert res.status_code == 400, res.data

    def test_derivation_returns_400_not_500(
        self, admin_client: APIClient, project: Project, summary_ss_link: Task
    ) -> None:
        res = admin_client.get(
            derivation_url(project),
            {"task_id": str(summary_ss_link.pk), "quantity": "early_finish"},
        )
        assert res.status_code == 400, res.data


# ---------------------------------------------------------------------------
# The what-if endpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestWhatIfSchedulesLeavesOnly:
    def test_baseline_is_the_leaf_network(
        self, admin_client: APIClient, project: Project, phase: Task, leaves: list[Task]
    ) -> None:
        """The what-if's `current` block is the same forecast the real endpoint gives —
        a what-if answered against a phantom-phase network answers about nothing."""
        res = admin_client.get(
            whatif_url(project),
            {"task_id": str(leaves[0].pk), "duration_delta": 0, "n_simulations": 100},
        )
        assert res.status_code == 200, res.data
        assert res.data["current"]["cpm_finish"] == LEAF_FINISH
        assert res.data["current"]["p95"] == LEAF_FINISH

    def test_perturbing_a_leaf_under_a_phase_moves_the_forecast(
        self, admin_client: APIClient, project: Project, phase: Task, leaves: list[Task]
    ) -> None:
        """The critical leaf's delta reaches the finish; as shipped the phantom phase
        was the critical path, so every leaf perturbation returned a zero delta."""
        res = admin_client.get(
            whatif_url(project),
            {"task_id": str(leaves[0].pk), "duration_delta": 5, "n_simulations": 100},
        )
        assert res.status_code == 200, res.data
        assert res.data["delta_vs_current"]["cpm_finish"] > 0

    def test_perturbing_a_phase_is_refused(
        self, admin_client: APIClient, project: Project, phase: Task, leaves: list[Task]
    ) -> None:
        """A summary has no duration of its own — its span is rolled up from its
        leaves — so it is absent from the simulated network and a perturbation on it
        would change nothing. Refuse rather than return an unmoved forecast as though
        the delta had been applied."""
        res = admin_client.get(
            whatif_url(project),
            {"task_id": str(phase.pk), "duration_delta": 5, "n_simulations": 100},
        )
        assert res.status_code == 400, res.data
        assert "summary task" in res.data["detail"]


# ---------------------------------------------------------------------------
# The derivation builder
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestDerivationExplainsTheLeafNetwork:
    def test_a_derivation_downstream_of_a_phase_cites_a_LEAF(
        self, admin_client: APIClient, project: Project, phase: Task, leaves: list[Task]
    ) -> None:
        """Explain a value the phantom actually moved, and check *what it names*.

        Deriving a leaf's own early_finish proves nothing: with no predecessor its
        value is start + its own duration either way, so that assertion passes on
        the broken build too (it was one of only two that did). The successor of a
        phase edge is the honest probe — its value is driven by the thing on the
        other end of that edge, so the number changes AND the cited source task
        changes from the phase to a real leaf.
        """
        successor = Task.objects.create(
            project=project, name="2 Decommission", duration=4, wbs_path="2"
        )
        Dependency.objects.create(predecessor=phase, successor=successor, dep_type="FS", lag=0)

        res = admin_client.get(
            derivation_url(project),
            {"task_id": str(successor.pk), "quantity": "early_finish"},
        )
        assert res.status_code == 200, res.data
        # Driven by the latest leaf (Jan 7), not the phase's 60-day span (Mar 27).
        assert res.data["value"] == "2026-01-13"

        # The explanation must name a leaf. Naming the phase would mean the
        # derivation is still describing the phantom network. A contribution with a
        # null source_task_id is a non-dependency constraint (project start / data
        # date), not a predecessor citation, so it is filtered rather than asserted on.
        cited = {c["source_task_id"] for c in res.data["contributions"]}
        cited_tasks = {c for c in cited if c is not None}
        assert cited_tasks, res.data["contributions"]
        assert str(phase.pk) not in cited_tasks
        assert cited_tasks <= {str(t.pk) for t in leaves}

    def test_a_phase_has_no_derivation(
        self, admin_client: APIClient, project: Project, phase: Task, leaves: list[Task]
    ) -> None:
        """A summary's dates are a rollup of its leaves, so no CPM pass computed them
        and there is nothing to explain. 404 is the honest answer; as shipped this
        returned a full derivation of a network that should never have existed."""
        res = admin_client.get(
            derivation_url(project),
            {"task_id": str(phase.pk), "quantity": "early_finish"},
        )
        assert res.status_code == 404, res.data
