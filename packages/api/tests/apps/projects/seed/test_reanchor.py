"""Sample date re-anchoring — "Shift dates to today" (#3481, ADR-1175).

The acceptance criterion is coverage of the offset over **every dated model the
loader writes**, so the centrepiece here is
:func:`test_every_dated_loader_field_is_in_exactly_one_tier`: it enumerates the
dated columns of every model the seed package writes and asserts each one is
either shifted, recomputed, or deliberately excluded *with a stated reason*. A
new dated column therefore fails this suite rather than being silently skipped by
a sweep that never knew about it.

The behavioural tests then load the real Atlas fixture, age it, shift it, and
assert the properties the issue actually cares about: the active sprint lands
mid-window, baseline variance is preserved, CPM output is recomputed rather than
moved, and pressing the button twice does nothing the second time.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

import pytest
from django.apps import apps
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    BaselineTask,
    Program,
    Project,
    Sprint,
    SprintState,
    Task,
)
from trueppm_api.apps.projects.seed.reanchor import (
    _CPM_OUTPUT_RECOMPUTED,
    _DELIBERATELY_UNSHIFTED,
    NoAnchorRecorded,
    NotASampleProgram,
    _history_specs,
    _shift_specs,
    shift_sample_dates,
    whole_week_delta,
)
from trueppm_api.apps.projects.seed.samples import load_sample

pytestmark = pytest.mark.django_db

SAMPLE = "atlas-platform-launch"


#: Days of drift every behavioural test uses, and the whole-week offset a shift
#: applies for it. 47 is the UX audit's observed seven-week-old Atlas sample.
AGED_DAYS = 47
SHIFT_DAYS = 49


@pytest.fixture(autouse=True)
def recalc_spy(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Record recalc requests instead of dispatching them.

    The shift asks the scheduler for a CPM pass per project. Letting that reach
    the real ``enqueue_recalculate`` costs ~20 s per call on a developer machine,
    where Valkey is not published to the host — Celery burns its full reconnect
    budget before the outbox falls back to the drain. That fallback is correct
    behaviour (ADR-1175 Durable Execution §1), not something these tests are
    about: the contract here is "one recalc requested per project", which the spy
    checks directly.
    """
    from trueppm_api.apps.scheduling import services

    seen: list[str] = []
    monkeypatch.setattr(
        services,
        "enqueue_recalculate",
        lambda project_id, reason=None: seen.append(str(project_id)),
    )
    return seen


@pytest.fixture
def program(django_user_model: Any) -> Program:
    """A sample loaded today — anchor is today, nothing has drifted."""
    owner = django_user_model.objects.create_user(username="ra-owner", email="ra@example.com")
    return load_sample(SAMPLE, owner=owner, create_users=True)


@pytest.fixture
def aged(django_user_model: Any) -> Program:
    """A sample whose rows genuinely carry dates from ``AGED_DAYS`` ago.

    Built by importing the real fixture with an explicit ``anchor`` (ADR-0114 —
    the seed grammar's own escape hatch for a fixed-date demo) rather than by
    rewinding the stored anchor afterwards. The difference matters: rewinding only
    the anchor leaves every row at today's dates and claims they are stale, so a
    shift moves an already-current demo into the future and the end-state
    assertions read backwards. Here the rows really are seven weeks behind, which
    is the state the UX audit observed.
    """
    import json

    from trueppm_api.apps.projects.seed.importer import import_seed
    from trueppm_api.apps.projects.seed.samples import SAMPLES

    owner = django_user_model.objects.create_user(username="aged-owner", email="ag@example.com")
    payload = json.loads(SAMPLES[SAMPLE].path.read_text(encoding="utf-8"))
    payload["anchor"] = (timezone.localdate() - dt.timedelta(days=AGED_DAYS)).isoformat()
    # A distinct slug so this can coexist with the `program` fixture: both import
    # the same document, and import_seed(replace=True) tears down any live program
    # whose code matches the seed's slug.
    payload["program"]["slug"] = "atlas-aged"
    return import_seed(payload, owner=owner, create_users=True, is_sample=True, replace=True)


# ---------------------------------------------------------------------------
# The acceptance criterion: every dated model the loader writes
# ---------------------------------------------------------------------------

#: Models the seed package writes rows for. Derived from the imports in
#: importer.py / replay.py / forecast_backfill.py / samples.py — the loader IS
#: the authority on this list, per the issue.
_LOADER_WRITTEN_MODELS = [
    "projects.Project",
    "projects.Task",
    "projects.Sprint",
    "projects.Baseline",
    "projects.BaselineTask",
    "projects.CalendarException",
    "projects.AcceptanceCriterion",
    "projects.BacklogItem",
    "projects.Risk",
    "projects.RiskComment",
    "projects.Dependency",
    "projects.TaskComment",
    "projects.TaskNote",
    "projects.TaskLabel",
    "projects.TaskAttachment",
    "projects.TaskRelation",
    "projects.TaskRecurrenceRule",
    "projects.CommentReaction",
    "projects.CommentAcknowledgement",
    "projects.SprintRetro",
    "projects.SprintScopeChange",
    "projects.RetroActionItem",
    "projects.CeremonyTemplate",
    "projects.Label",
    "projects.Program",
    "timetracking.TimeEntry",
    "timetracking.TimesheetSubmission",
    "scheduling.MonteCarloRun",
    "scheduling.ProjectForecastSnapshot",
    # Written by importer._record_sample_agent_actions on the sample path only
    # (ADR-0114 §2.1). Hash-chained, so deliberately Tier 3 — but it IS a dated
    # model the loader writes, so it has to be classified rather than forgotten.
    "agents.AgentAction",
]


def _dated_fields(label: str) -> list[str]:
    model = apps.get_model(label)
    return [
        f.name
        for f in model._meta.get_fields()
        if getattr(f, "get_internal_type", None)
        and f.get_internal_type() in ("DateField", "DateTimeField")
    ]


def test_every_dated_loader_field_is_in_exactly_one_tier() -> None:
    """The coverage obligation from the issue's acceptance criteria.

    Every dated column on every model the loader writes must be classified:
    Tier 1 (shifted), Tier 2 (CPM output, recomputed), or Tier 3 (deliberately
    excluded, with a reason). An unclassified column is a silent gap — exactly
    what "covers the offset over every dated model the loader writes" forbids.
    """
    shifted: dict[str, set[str]] = {}
    for spec in _shift_specs():
        shifted.setdefault(spec.label, set()).update(spec.fields)

    unclassified: list[str] = []
    for label in _LOADER_WRITTEN_MODELS:
        for field in _dated_fields(label):
            key = f"{label}.{field}"
            in_tier1 = field in shifted.get(label, set())
            in_tier2 = label == "projects.Task" and field in _CPM_OUTPUT_RECOMPUTED
            in_tier3 = key in _DELIBERATELY_UNSHIFTED
            if not (in_tier1 or in_tier2 or in_tier3):
                unclassified.append(key)

    assert not unclassified, (
        "These dated columns are written by the loader but belong to no tier. "
        "Add each to a DateShift spec, to _CPM_OUTPUT_RECOMPUTED, or to "
        "_DELIBERATELY_UNSHIFTED with a reason:\n  " + "\n  ".join(sorted(unclassified))
    )


def test_no_tier_claims_a_field_that_does_not_exist() -> None:
    """The inverse: a tier entry naming a column that was renamed or dropped.

    Without this, a rename leaves a spec silently shifting nothing — the sweep
    reports success having updated zero rows, which is the failure mode that
    looks most like a pass.
    """
    stale: list[str] = []
    for spec in _shift_specs():
        real = set(_dated_fields(spec.label))
        stale += [f"{spec.label}.{f} (in a DateShift)" for f in spec.fields if f not in real]
    for key in _DELIBERATELY_UNSHIFTED:
        label, _, field = key.rpartition(".")
        if field not in _dated_fields(label):
            stale.append(f"{key} (in _DELIBERATELY_UNSHIFTED)")
    for field in _CPM_OUTPUT_RECOMPUTED:
        if field not in _dated_fields("projects.Task"):
            stale.append(f"projects.Task.{field} (in _CPM_OUTPUT_RECOMPUTED)")

    assert not stale, "Tier entries naming columns that no longer exist:\n  " + "\n  ".join(stale)


def test_every_exclusion_states_a_reason() -> None:
    blank = [k for k, v in _DELIBERATELY_UNSHIFTED.items() if not v.strip()]
    assert not blank, f"Tier-3 exclusions with no stated reason: {blank}"


def test_cpm_output_is_never_in_a_shift_spec() -> None:
    """Tier 2 and Tier 1 must not overlap.

    early_start/early_finish are the REMAINING-work window, not the planned span,
    and utilization reads them — offsetting them would silently change computed
    load. This is the trap that makes the naive "offset every date field"
    implementation wrong.
    """
    for spec in _shift_specs():
        if spec.label != "projects.Task":
            continue
        overlap = set(spec.fields) & _CPM_OUTPUT_RECOMPUTED
        assert not overlap, f"CPM output must be recomputed, not offset: {overlap}"


@pytest.mark.parametrize("spec_source", [_shift_specs, _history_specs])
def test_every_spec_scope_resolves(program: Program, spec_source: Any) -> None:
    """Each scope callable must produce a runnable queryset against a real sample.

    A typo in a join path (``task__project__program`` vs ``task__program``) raises
    FieldError here rather than at the moment an owner presses the button.
    """
    for spec in spec_source():
        queryset = spec.scope(program)
        assert queryset.count() >= 0, spec.label


# ---------------------------------------------------------------------------
# The quantum
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw_days", "expected"),
    [
        (0, 0),
        (3, 0),  # rounds down — under half a week is not worth a rewrite
        (4, 7),
        (7, 7),
        (47, 49),  # the issue's own 7-week scenario
        (-5, 0),  # an anchor in the future never shifts backwards
    ],
)
def test_whole_week_delta(raw_days: int, expected: int) -> None:
    today = dt.date(2026, 9, 15)
    assert whole_week_delta(today - dt.timedelta(days=raw_days), today) == expected


def test_shift_preserves_weekday_alignment(aged: Program) -> None:
    """The reason the quantum is a week and not a day.

    The seed resolver snaps plan dates onto working days, so a sprint starts on a
    Monday because the fixture means it to. An arbitrary offset would restart it
    mid-week and drop task bars onto weekends.
    """
    before = {
        s.pk: s.start_date.weekday()
        for s in Sprint.objects.filter(project__program=aged, start_date__isnull=False)
    }
    assert before, "fixture should author sprints with start dates"

    shift_sample_dates(aged)

    for sprint in Sprint.objects.filter(pk__in=before):
        assert sprint.start_date.weekday() == before[sprint.pk], (
            f"{sprint.name} moved off its weekday — the offset was not a whole week"
        )


# ---------------------------------------------------------------------------
# Behaviour
# ---------------------------------------------------------------------------


def test_shift_does_not_walk_a_row_through_a_forbidden_intermediate_state(
    aged: Program,
) -> None:
    """Regression: every column of a model must move in ONE statement.

    Shifting Sprint.start_date in its own UPDATE puts start *after* finish until
    the second statement lands, and `sprint_finish_after_start` is checked on the
    first one. The whole sweep then dies with an IntegrityError naming a row it
    was halfway through moving.
    """
    windows = {
        s.pk: (s.start_date, s.finish_date) for s in Sprint.objects.filter(project__program=aged)
    }
    assert windows

    shift_sample_dates(aged)  # must not raise

    offset = dt.timedelta(days=SHIFT_DAYS)
    for sprint in Sprint.objects.filter(pk__in=windows):
        start, finish = windows[sprint.pk]
        assert (sprint.start_date, sprint.finish_date) == (start + offset, finish + offset)
        assert sprint.finish_date > sprint.start_date


def test_shift_moves_plan_dates_forward_by_the_delta(aged: Program) -> None:
    before = {
        t.pk: t.planned_start
        for t in Task.objects.filter(project__program=aged, planned_start__isnull=False)
    }
    assert before

    report = shift_sample_dates(aged)

    assert report.shifted is True
    assert report.days == SHIFT_DAYS
    assert report.rows_shifted > 0
    for task in Task.objects.filter(pk__in=before):
        assert task.planned_start == before[task.pk] + dt.timedelta(days=SHIFT_DAYS)


def test_shift_preserves_baseline_variance_exactly(aged: Program) -> None:
    """Baselines move WITH the plan.

    A baseline is a frozen plan and baseline-vs-actual variance is a relative
    quantity. Pinning baselines while the plan moves would manufacture a
    fabricated 49-day slip on every task — the "demo shows an overdue program"
    defect this feature exists to remove.
    """
    rows = list(
        BaselineTask.objects.filter(
            baseline__project__program=aged, start__isnull=False
        ).values_list("pk", "start")
    )
    assert rows, "the Atlas fixture should author baselines"

    shift_sample_dates(aged)

    for pk, original in rows:
        assert BaselineTask.objects.get(pk=pk).start == original + dt.timedelta(days=SHIFT_DAYS)


def test_shift_nulls_recalculated_at_and_leaves_cpm_output_to_the_engine(
    aged: Program,
) -> None:
    before = {
        t.pk: t.early_start
        for t in Task.objects.filter(project__program=aged, early_start__isnull=False)
    }

    shift_sample_dates(aged)

    # recalculated_at nulled → the Schedule view shows its "recalculating" badge
    # (#1053) rather than rendering pre-shift CPM columns as though they were fresh.
    assert not Project.objects.filter(program=aged, recalculated_at__isnull=False).exists()
    # The CPM columns were NOT offset by the shift. The engine owns them.
    for task in Task.objects.filter(pk__in=before):
        assert task.early_start == before[task.pk], (
            "early_start is remaining-work output — the shift must not move it"
        )


def test_shift_does_not_touch_wbs_path(aged: Program) -> None:
    """The bulk rewrite must never reach structure.

    Task.wbs_path is the only parenthood in the system and nothing enforces its
    integrity; a duplicate corrupts the next rewrite_level and an orphan renders
    at root.
    """
    before = dict(Task.objects.filter(project__program=aged).values_list("pk", "wbs_path"))

    shift_sample_dates(aged)

    after = dict(Task.objects.filter(project__program=aged).values_list("pk", "wbs_path"))
    assert after == before


def test_shift_moves_synthesized_history(aged: Program) -> None:
    """Backdated history moves with the plan it describes (ADR-0114)."""
    rows = list(
        Task.history.filter(project__program=aged).values_list("history_id", "history_date")[:50]
    )
    assert rows, "the replayer should have written backdated history"

    shift_sample_dates(aged)

    for history_id, original in rows:
        moved = Task.history.get(history_id=history_id).history_date
        assert moved == original + dt.timedelta(days=SHIFT_DAYS)


def test_shift_moves_forecast_trend_preserving_its_shape(aged: Program) -> None:
    from trueppm_api.apps.scheduling.models import ProjectForecastSnapshot

    rows = list(
        ProjectForecastSnapshot.objects.filter(project__program=aged)
        .order_by("captured_at")
        .values_list("pk", "captured_at", "mc_p80_finish")[:30]
    )
    assert rows

    shift_sample_dates(aged)

    offset = dt.timedelta(days=SHIFT_DAYS)
    for pk, captured, p80 in rows:
        row = ProjectForecastSnapshot.objects.get(pk=pk)
        assert row.captured_at == captured + offset
        if p80 is not None:
            # The gap between capture and forecast — the shape the chart draws —
            # is unchanged.
            assert row.mc_p80_finish == p80 + offset


def test_active_sprint_is_mid_window_after_the_shift(aged: Program) -> None:
    """The issue's headline acceptance criterion.

    Before: an "Active" sprint that "Completed Jul 20", "Day 14 of 14 · 0 days
    left". After: today falls inside the active sprint's window.
    """
    shift_sample_dates(aged)

    today = timezone.localdate()
    active = Sprint.objects.filter(
        project__program=aged, state=SprintState.ACTIVE, is_deleted=False
    )
    assert active.exists(), "the Atlas fixture should carry an active sprint"
    for sprint in active:
        assert sprint.start_date <= today <= sprint.finish_date, (
            f"{sprint.name} runs {sprint.start_date}..{sprint.finish_date}, "
            f"which does not contain {today}"
        )


def test_overdue_tasks_return_to_the_seeds_intended_state(aged: Program, program: Program) -> None:
    """The second half of the headline criterion: overdue counts come back down.

    Aged seven weeks, the fixture shows tasks overdue purely from drift. The only
    honest oracle for "what the seed intended" is the SAME document imported
    today — hence both fixtures.

    Asserted with a small tolerance rather than exact equality: the shift quantum
    is a whole week, so a sample aged 47 days moves 49 and lands two days ahead of
    a fresh import. A task whose planned start sits inside that residual can
    legitimately fall on the other side of "today" in one and not the other.
    """
    intended = _incomplete_past_due(program)
    drifted = _incomplete_past_due(aged)
    assert drifted > intended, "an aged sample should show MORE overdue work than a fresh one"

    shift_sample_dates(aged)

    after = _incomplete_past_due(aged)
    assert abs(after - intended) <= 3, (
        f"after the shift {after} tasks are past due; a fresh import shows {intended}"
    )
    assert after < drifted, "the shift should have reduced the drift-induced overdue count"


def _incomplete_past_due(program: Program) -> int:
    from trueppm_api.apps.projects.models import TaskStatus

    return (
        Task.objects.filter(project__program=program, is_deleted=False)
        .exclude(status=TaskStatus.COMPLETE)
        .filter(planned_start__lt=timezone.localdate())
        .count()
    )


# ---------------------------------------------------------------------------
# Idempotency and refusals
# ---------------------------------------------------------------------------


def test_second_shift_is_a_no_op(aged: Program) -> None:
    """Idempotent by construction — the anchor advances with the rows."""
    first = shift_sample_dates(aged)
    assert first.shifted is True

    snapshot = dict(Task.objects.filter(project__program=aged).values_list("pk", "planned_start"))

    second = shift_sample_dates(aged)

    assert second.shifted is False
    assert second.days == 0
    assert second.rows_shifted == 0
    assert (
        dict(Task.objects.filter(project__program=aged).values_list("pk", "planned_start"))
        == snapshot
    )


def test_a_fresh_sample_does_not_shift(program: Program) -> None:
    """Just-loaded: the anchor is today, the residual is zero."""
    report = shift_sample_dates(program)
    assert report.shifted is False
    assert report.days == 0


def test_anchor_advances_by_the_applied_offset_not_to_today(aged: Program) -> None:
    """The anchor tracks what was APPLIED, so the residual is never lost.

    Advancing it to `today` instead would silently discard the sub-week remainder
    and let a sample drift a few days further on every shift.
    """
    anchor_before = aged.sample_anchor_date
    report = shift_sample_dates(aged)
    aged.refresh_from_db()

    assert aged.sample_anchor_date == anchor_before + dt.timedelta(days=report.days)


def test_refuses_a_program_that_is_not_sample_data(django_user_model: Any) -> None:
    """Asserted from the DEFAULT state, at the SERVICE — a view can gate what its
    service does not, and any non-view caller would reopen the hole."""
    owner = django_user_model.objects.create_user(username="real-owner", email="r@example.com")
    from trueppm_api.apps.access.services import create_program

    real = create_program(name="Real Work", description="", methodology="HYBRID", created_by=owner)
    Program.objects.filter(pk=real.pk).update(sample_anchor_date=dt.date(2026, 1, 1))
    real.refresh_from_db()

    with pytest.raises(NotASampleProgram):
        shift_sample_dates(real)


def test_refuses_a_sample_loaded_before_the_anchor_existed(aged: Program) -> None:
    Program.objects.filter(pk=aged.pk).update(sample_anchor_date=None)
    aged.refresh_from_db()

    with pytest.raises(NoAnchorRecorded):
        shift_sample_dates(aged)


def test_importer_stamps_the_anchor_on_a_sample(program: Program) -> None:
    assert program.sample_anchor_date == timezone.localdate()


def test_importer_stamps_an_explicit_anchor_rather_than_import_day(aged: Program) -> None:
    """A fixture pinning its own `anchor` (ADR-0114) is recorded as authored.

    Stamping import day regardless would make every such sample look current the
    moment it loaded, and the drift the banner reports would be a fiction.
    """
    assert aged.sample_anchor_date == timezone.localdate() - dt.timedelta(days=AGED_DAYS)
    assert aged.sample_days_stale == AGED_DAYS


def test_sample_days_stale_is_never_negative(aged: Program) -> None:
    Program.objects.filter(pk=aged.pk).update(
        sample_anchor_date=timezone.localdate() + dt.timedelta(days=3)
    )
    aged.refresh_from_db()
    assert aged.sample_days_stale == 0


def test_sample_days_stale_is_none_for_a_non_sample(django_user_model: Any) -> None:
    from trueppm_api.apps.access.services import create_program

    owner = django_user_model.objects.create_user(username="ns-owner", email="ns@example.com")
    real = create_program(name="Real", description="", methodology="HYBRID", created_by=owner)
    assert real.sample_anchor_date is None
    assert real.sample_days_stale is None


def test_a_caller_authored_import_gets_no_anchor(django_user_model: Any) -> None:
    """Only the sample path stamps an anchor.

    Stamping a real import would advertise a shift action that would bulk-rewrite
    real work — and the service refuses on is_sample anyway, so the field would be
    promising something the server will not do.
    """
    import json

    from trueppm_api.apps.projects.seed.importer import import_seed
    from trueppm_api.apps.projects.seed.samples import SAMPLES

    owner = django_user_model.objects.create_user(username="ca-owner", email="ca@example.com")
    payload = json.loads(SAMPLES[SAMPLE].path.read_text(encoding="utf-8"))
    # Strip the sample-only sections a non-sample import rejects (ADR-0114 §2.1).
    for section in ("agent_actions",):
        payload.get("program", {}).pop(section, None)
    for project in payload.get("projects", []):
        project.pop("share_links", None)
    payload["program"]["slug"] = "ca-import"

    imported = import_seed(payload, owner=owner, create_users=True, is_sample=False)

    assert imported.sample_anchor_date is None


def test_shift_enqueues_a_recalculation_for_every_project(
    aged: Program, recalc_spy: list[str]
) -> None:
    report = shift_sample_dates(aged)

    # The engine owns Tier 2, so the shift must ask for a pass on each project.
    assert report.projects > 0
    expected = {
        str(pk)
        for pk in Project.objects.filter(program=aged, is_deleted=False).values_list(
            "id", flat=True
        )
    }
    assert expected == set(recalc_spy)
    assert len(recalc_spy) == len(expected), "each project should be requested exactly once"


def test_a_no_op_shift_does_not_request_a_recalculation(
    program: Program, recalc_spy: list[str]
) -> None:
    """Nothing moved, so nothing needs recomputing.

    Without this, a repeatedly-pressed button would queue a full CPM pass per
    project per press while writing no rows at all.
    """
    assert shift_sample_dates(program).shifted is False
    assert recalc_spy == []


def test_null_dates_stay_null(aged: Program) -> None:
    """NULL + interval is NULL; the sweep must not invent a date for an unset column."""
    unset = list(
        Task.objects.filter(project__program=aged, actual_finish__isnull=True).values_list(
            "pk", flat=True
        )[:25]
    )
    assert unset, "the fixture should leave some tasks unfinished"

    shift_sample_dates(aged)

    assert Task.objects.filter(pk__in=unset, actual_finish__isnull=False).count() == 0, (
        "the shift invented an actual_finish for a task that has none"
    )
