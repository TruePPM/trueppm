"""``Task.duration`` on a summary row is WORKING days, on every write-back (#3530).

``_apply_cpm_results`` used to overwrite every summary/phase task's ``duration``
with ``(early_finish - early_start).days`` — a raw **calendar-day** span — into a
column whose ``help_text`` reads "Duration in working days" and which every other
consumer reads as such (the MSPDI exporter multiplies it by
``HOURS_PER_WORKING_DAY``, ``project_span_days`` sums it, ``build_sched_tasks``
feeds it back to the engine as ``timedelta(days=…)``). It ran on both the
single-project and the program write-back, on every recompute, and 49 of 50 summary
rows in the dev database carried the ~1.4x inflation.

Every test here spans at least one weekend on purpose: that is the only shape where
a calendar-day span and a working-day span differ, so a revert of the fix fails
these rather than passing a tautology. The engine's duration convention is
INCLUSIVE (``_finish_from_start(start, 1) == start``), so a summary running Mon→Fri
is 5 working days, not 4.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    CalendarException,
    Dependency,
    Program,
    Project,
    Task,
)

User = get_user_model()

#: Monday. Every fixture anchors here so the weekend positions are readable.
MONDAY = date(2026, 1, 5)


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    # status_date pinned to start_date (ADR-0752 §4) so the today-floor cannot move
    # these exact-date assertions — same rationale as test_summary_rollup.py.
    return Project.objects.create(
        name="Field Contract",
        start_date=MONDAY,
        status_date=MONDAY,
        calendar=calendar,
    )


def _recalc(project_id: object) -> None:
    from trueppm_api.apps.scheduling.tasks import _run_schedule

    _run_schedule(str(project_id), tracker=None)


def _calendar_span_days(task: Task) -> int:
    """What the pre-#3530 write-back stored: the raw calendar-day difference."""
    assert task.early_start is not None and task.early_finish is not None
    return max(1, (task.early_finish - task.early_start).days)


# ---------------------------------------------------------------------------
# Single-project write-back
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSingleProjectWriteBack:
    def test_summary_spanning_a_weekend_stores_working_days(self, project: Project) -> None:
        """A 10-working-day leaf spans two weekends; the phase must store 10, not 18.

        Mon Jan 5 + 10 working days → Fri Jan 16. Calendar span is 11 days, working
        span is 10. The broken write-back stored 11.
        """
        phase = Task.objects.create(project=project, name="Assess", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="Work", duration=10, wbs_path="1.1")

        _recalc(project.pk)
        phase.refresh_from_db()

        assert phase.early_start == MONDAY
        assert phase.early_finish == date(2026, 1, 16)
        assert phase.duration == 10
        # The invariant the issue asks for: a summary's duration is not the raw
        # calendar span of its own early dates.
        assert phase.duration != _calendar_span_days(phase)

    def test_summary_duration_matches_its_widest_leaf(self, project: Project) -> None:
        """The phase and its longest child are expressed in the same unit.

        Two parallel leaves of 3 and 8 working days from the same start: the phase's
        span IS the 8-day leaf's span, so the two rows must read 8 and 8. Under the
        calendar-day write-back the phase read 9 while its own widest child read 8 —
        a summary that looks longer than everything inside it (the #314 class,
        reintroduced in the stored value rather than the bar).
        """
        phase = Task.objects.create(project=project, name="Build", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="Short", duration=3, wbs_path="1.1")
        widest = Task.objects.create(project=project, name="Long", duration=8, wbs_path="1.2")

        _recalc(project.pk)
        phase.refresh_from_db()
        widest.refresh_from_db()

        assert phase.early_start == widest.early_start
        assert phase.early_finish == widest.early_finish
        assert phase.duration == widest.duration == 8
        assert phase.duration != _calendar_span_days(phase)

    def test_holiday_inside_the_span_is_not_counted(
        self, project: Project, calendar: Calendar
    ) -> None:
        """The project's COMPOSED calendar decides, not a weekday-only rule.

        A one-day shutdown on Wed Jan 7 pushes a 5-working-day leaf from Fri Jan 9
        out to Mon Jan 12, but the work is still 5 working days. A fix that counted
        weekdays instead of consulting the calendar would store 6 here.
        """
        CalendarException.objects.create(
            calendar=calendar,
            exc_start=date(2026, 1, 7),
            exc_end=date(2026, 1, 7),
            description="Company shutdown",
        )
        phase = Task.objects.create(project=project, name="Migrate", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="Work", duration=5, wbs_path="1.1")

        _recalc(project.pk)
        phase.refresh_from_db()

        assert phase.early_start == MONDAY
        assert phase.early_finish == date(2026, 1, 12)
        assert phase.duration == 5
        assert phase.duration != _calendar_span_days(phase)

    def test_nested_summaries_are_all_working_days(self, project: Project) -> None:
        """A phase over a sub-phase: BOTH levels get the working-day span.

        Nesting is where the calendar-day value did real second-order damage — the
        ``percent_complete_rollup`` annotation weights direct children by
        ``c.duration``, so an inner summary's inflated value skewed its parent's
        completion percentage as well as its own duration cell.
        """
        outer = Task.objects.create(project=project, name="Program", duration=1, wbs_path="1")
        inner = Task.objects.create(project=project, name="Phase", duration=1, wbs_path="1.1")
        Task.objects.create(project=project, name="Work", duration=7, wbs_path="1.1.1")

        _recalc(project.pk)
        outer.refresh_from_db()
        inner.refresh_from_db()

        # Mon Jan 5 + 7 working days → Tue Jan 13; calendar span 8, working span 7.
        assert inner.early_finish == date(2026, 1, 13)
        assert inner.duration == 7
        assert outer.duration == 7
        assert outer.duration != _calendar_span_days(outer)
        assert inner.duration != _calendar_span_days(inner)

    def test_a_weekend_actual_finish_does_not_add_a_phantom_day(self, project: Project) -> None:
        """A summary's ``early_finish`` can land on a NON-working day.

        A completed task pinned to its actuals (ADR-0136) contributes its recorded
        ``actual_finish`` to the rollup's max, and the engine names this shape in
        ``_gather_successor_constraints``' own docstring ("a completed task's weekend
        ``actual_finish``"). Working days are counted over the half-open
        ``[start, finish)`` interval, so a duration — which is inclusive of its
        finish day — adds the finish back only when the finish is workable. An
        unconditional ``+ 1`` reports the phase as a day longer than the work in it.

        Here the sole leaf ran Mon Jan 5 → Sat Jan 10: five working days, and the
        Saturday is not a sixth.
        """
        phase = Task.objects.create(project=project, name="Cutover", duration=1, wbs_path="1")
        Task.objects.create(
            project=project,
            name="Weekend push",
            duration=5,
            wbs_path="1.1",
            actual_start=MONDAY,
            actual_finish=date(2026, 1, 10),  # a Saturday
            percent_complete=100.0,
        )

        _recalc(project.pk)
        phase.refresh_from_db()

        assert phase.early_finish == date(2026, 1, 10)
        assert phase.early_finish.weekday() == 5, "fixture premise: the finish is a Saturday"
        assert phase.duration == 5

    def test_leaf_duration_is_still_never_overwritten(self, project: Project) -> None:
        """The write-back touches summary rows only — a leaf keeps its authored value."""
        Task.objects.create(project=project, name="Phase", duration=1, wbs_path="1")
        leaf = Task.objects.create(project=project, name="Work", duration=9, wbs_path="1.1")

        _recalc(project.pk)
        leaf.refresh_from_db()

        assert leaf.duration == 9

    def test_recompute_is_idempotent(self, project: Project) -> None:
        """Running CPM twice must not drift the stored value.

        The old write-back was self-consistent (its input was the dates, not the
        previous duration), and the new one must stay that way — a duration derived
        from a duration would ratchet on every recompute, and this pass runs on
        every task edit.
        """
        phase = Task.objects.create(project=project, name="Assess", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="Work", duration=10, wbs_path="1.1")

        _recalc(project.pk)
        phase.refresh_from_db()
        first = phase.duration

        _recalc(project.pk)
        phase.refresh_from_db()

        assert phase.duration == first == 10


# ---------------------------------------------------------------------------
# Program write-back — the second writer the issue names
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestProgramWriteBack:
    def test_program_pass_writes_working_days_too(self, calendar: Calendar) -> None:
        """``recalculate_program_schedule`` shares ``_apply_cpm_results``.

        Both write-back paths are the class this issue covers, and the program pass
        is the one nothing else in the suite pins for duration. A cross-project
        accepted edge is what escalates a recompute onto it.
        """
        from trueppm_api.apps.scheduling.tasks import _run_program_schedule

        program = Program.objects.create(name="Migration")
        proj_a = Project.objects.create(
            name="A", start_date=MONDAY, status_date=MONDAY, calendar=calendar, program=program
        )
        proj_b = Project.objects.create(
            name="B", start_date=MONDAY, status_date=MONDAY, calendar=calendar, program=program
        )

        phase_a = Task.objects.create(project=proj_a, name="Assess", duration=1, wbs_path="1")
        a_leaf = Task.objects.create(project=proj_a, name="Survey", duration=10, wbs_path="1.1")
        phase_b = Task.objects.create(project=proj_b, name="Cutover", duration=1, wbs_path="1")
        b_leaf = Task.objects.create(project=proj_b, name="Switch", duration=4, wbs_path="1.1")

        Dependency.objects.create(
            predecessor=a_leaf,
            successor=b_leaf,
            dep_type="FS",
            lag=0,
            pending_acceptance=False,
            accepted_at=timezone.now(),
        )

        _run_program_schedule(str(program.pk))

        phase_a.refresh_from_db()
        phase_b.refresh_from_db()

        # A: Mon Jan 5 + 10 working days → Fri Jan 16 (calendar span 11).
        assert phase_a.early_finish == date(2026, 1, 16)
        assert phase_a.duration == 10
        assert phase_a.duration != _calendar_span_days(phase_a)

        # B: pushed behind A by the accepted cross edge — Mon Jan 19 + 4 → Thu Jan 22
        # (calendar span 3, working span 4: the calendar-day value was SHORTER here,
        # which is why "it always inflates" is the wrong mental model to test on).
        assert phase_b.early_start == date(2026, 1, 19)
        assert phase_b.duration == 4
        assert phase_b.duration != _calendar_span_days(phase_b)


# ---------------------------------------------------------------------------
# Read side — what a client actually receives
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestReadSide:
    def test_api_serves_working_days_and_unchanged_bar_dates(self, project: Project) -> None:
        """The Gantt must not regress.

        The write-back's original justification was "so the API returns a meaningful
        Gantt duration". It does not need to: the renderer draws ``barLeft`` from
        ``scheduled_start``/``early_start`` and ``barRight`` from ``early_finish``
        (``GanttRenderer.drawBar``), and ``duration`` is read only for the *label*
        and for the pre-CPM leaf fallback. So this pins both halves — the dates the
        bar is built from are untouched, and the number beside it is now the same
        unit as every leaf's.
        """
        user = User.objects.create_user(username="reader", password="pw")
        ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)

        phase = Task.objects.create(project=project, name="Assess", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="Work", duration=10, wbs_path="1.1")

        _recalc(project.pk)
        phase.refresh_from_db()

        client = APIClient()
        client.force_authenticate(user=user)
        resp = client.get(f"/api/v1/tasks/{phase.pk}/")
        assert resp.status_code == 200

        body = resp.json()
        assert body["is_summary"] is True
        # The label the Σ cell renders as "10d".
        assert body["duration"] == 10
        # The geometry the bar is actually built from — unchanged by this fix.
        assert body["early_start"] == "2026-01-05"
        assert body["early_finish"] == "2026-01-16"
        assert body["scheduled_start"] == "2026-01-05"
        assert body["scheduled_finish"] == "2026-01-16"

    def test_msproject_export_no_longer_inflates_the_phase(self, project: Project) -> None:
        """The exporter reads ``duration`` as working days and always has.

        ``_days_to_duration`` emits ``days * HOURS_PER_WORKING_DAY``, so the
        calendar-day value shipped an 88-hour phase where the plan holds 80 hours of
        work — a wrong number inside a file a PM opens in MS Project.
        """
        from trueppm_api.apps.msproject.exporter import export_project_xml

        phase = Task.objects.create(project=project, name="Assess", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="Work", duration=10, wbs_path="1.1")

        _recalc(project.pk)
        phase.refresh_from_db()

        xml = export_project_xml(str(project.pk)).decode()
        assert "PT80H0M0S" in xml
        # 11 calendar days x 8h — what the broken write-back produced for this phase.
        assert "PT88H0M0S" not in xml
