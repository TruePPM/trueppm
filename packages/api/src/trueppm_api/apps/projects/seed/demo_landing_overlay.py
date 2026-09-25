"""The demo-only landing overlay applied after the sample import (#4050 Part B).

The hosted interactive demo (ADR-1197) seeds the Atlas Platform Launch sample and
lands a first-time visitor on **Migration Tooling**. That project is *deliberately*
unhealthy in the fixture — health overridden to ``AT_RISK``, a P80 nineteen days
past the commitment, a slipping dry run, an unconfirmed gate, a pile of unscheduled
rows — because it is a *teaching* fixture for a PM exploring a plan under pressure,
and several docs pages and #3095's coverage tests describe exactly that shape.

On a first visit it reads as a product that does not work.

So the fix is **not** to edit ``atlas-platform-launch.json``. Editing it would break
#3095's coverage tests (including the export/import round-trip), invalidate the docs
that describe the fixture, and take the teaching shape away from every *other*
consumer of the sample — the local demo compose file, `load_sample_project` on a
self-hosted install, the downloadable fixture. Instead the demo reset applies this
small overlay **after** ``import_seed`` and **before** a final Monte Carlo run, and
only on a deployment that is actually a read-only demo.

**What it changes, and why each one.** Every item is an *indicator a first-time
visitor reads as a fault*:

===========================  =========================================================
Seed indicator               Overlay
===========================  =========================================================
Health ``AT_RISK``           Override cleared to ``AUTO`` — the chip reads "On track".
P80 after the commitment     A final run lands P80 a few days AHEAD of the commitment.
"Edited since this run"      Monte Carlo runs LAST, so the run outlives every edit.
Unconfirmed milestone        "Migration complete" is confirmed (``edited_at`` stamped).
Dry-run slip                 Dry-run migration is 100% and complete.
Unscheduled pile             Trimmed to at most two plausible post-cutover rows.
**Kept, deliberately**       **Performance tuning** stays ~2 days behind plan.
===========================  =========================================================

**The one signal that stays is the point.** A plan with nothing wrong on it is not a
demo of a scheduling tool, it is a screenshot. Performance tuning sits on the
critical path at 40% against ~50% planned, with float to the commitment absorbing
it — a real project's ordinary Tuesday. It is also the task the landing hint asks
the visitor to drag, and the web resolves it by that schedule *position* rather than
by name, so this overlay and the hint cannot drift apart over a rename.

**Fixture-coupled on purpose, and loud about it.** The rows are resolved by name
within the landing project. That is a real coupling to ``atlas-platform-launch.json``
and it is why a missing row **raises** instead of being skipped: a half-applied
overlay is a demo that looks *partly* broken, with nothing in the job log saying so,
and the reset job's exit status is the only thing watching.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import TYPE_CHECKING

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from trueppm_api.apps.projects.models import Health, Program, Project, Task, TaskStatus
from trueppm_api.apps.scheduling.models import MonteCarloRun

if TYPE_CHECKING:  # pragma: no cover - typing only
    from collections.abc import Iterable

#: The project a first-time demo visitor lands on.
LANDING_PROJECT_NAME = "Migration Tooling"

#: The one indicator the overlay deliberately leaves standing (see the module docstring).
BEHIND_PLAN_TASK_NAME = "Performance tuning"

#: The gate a visitor should not be asked to confirm on their first screen.
CONFIRMED_MILESTONE_NAME = "Migration complete"

#: The in-flight task whose slip reads as "this plan is already failing".
DRY_RUN_TASK_NAME = "Dry-run migration"

#: How far behind its straight-line plan the kept signal sits, in percentage points.
#: The design's own framing — "40% complete against 50% planned" — held as a *gap*
#: rather than as a literal 40, because where today falls inside the task's span is a
#: function of the reset date and cannot be authored.
BEHIND_PLAN_GAP_POINTS = 10.0

#: Half the kept signal's span, in calendar days. Today sits in the middle of it, so
#: the straight-line expectation is exactly 50% and the progress the overlay writes is
#: exactly the design's 40% — the two numbers the mock puts on that bar.
KEPT_SIGNAL_HALF_SPAN_DAYS = 7

#: Working days the kept signal is declared to take. Two weeks of calendar span at a
#: five-day week; stated rather than derived so the duration chip and the bar agree.
KEPT_SIGNAL_DURATION_DAYS = 10

#: Days of headroom between the final P80 and the project's commitment date. Small on
#: purpose: a forecast comfortably early is as unrealistic as one comfortably late,
#: and the visitor is meant to read "on track", not "sandbagged".
P80_HEADROOM_DAYS = 4

#: The most unscheduled rows the landing project keeps. Two reads as a backlog; the
#: fixture's full set reads as work somebody lost.
MAX_UNSCHEDULED = 2

#: Simulation count recorded on the final run. Matches the fixture's own
#: ``forecast_history.mc_iterations`` so the demo's run history is self-consistent.
FINAL_RUN_SIMULATIONS = 2000


class DemoOverlayRefused(RuntimeError):
    """The overlay was asked to run somewhere it must not.

    Raised — rather than returning quietly — because every caller is a seed job
    whose exit status is the only supervision the demo has. A silent no-op on a
    deployment that *is* a demo would ship the unfixed landing; a silent success on
    one that is *not* would rewrite a real project's health and milestones.
    """


class DemoOverlayFixtureMismatch(RuntimeError):
    """A row the overlay is written against is not in the imported seed."""


@dataclass(frozen=True)
class DemoLandingOverlayResult:
    """What the overlay did, for the caller to report and for tests to assert."""

    project_id: str
    #: The task left behind plan — the landing hint's target. Exposed so a caller can
    #: log it, and so the acceptance test can name it without re-deriving the rule.
    behind_plan_task_id: str
    behind_plan_task_wbs_path: str
    monte_carlo_run_id: str
    p80: dt.date
    commitment_finish: dt.date
    unscheduled_removed: int
    #: True when this run found every seed indicator already dealt with — the second
    #: and every later nightly reset over an already-overlaid database. The kept
    #: signal's window and the forecast row are re-asserted on every run regardless
    #: (the CPM pass re-derives the first, and the second must stay newer than it), so
    #: neither counts toward this.
    was_noop: bool


def _landing_project(program: Program) -> Project:
    project = Project.objects.filter(
        program=program, name=LANDING_PROJECT_NAME, is_deleted=False
    ).first()
    if project is None:
        raise DemoOverlayFixtureMismatch(
            f"The demo landing project {LANDING_PROJECT_NAME!r} is not in program "
            f"{program.name!r}. The overlay is written against "
            "atlas-platform-launch.json; if the fixture renamed it, update "
            "LANDING_PROJECT_NAME rather than letting the overlay skip."
        )
    return project


def _live_tasks(project: Project) -> list[Task]:
    return list(Task.objects.filter(project=project, is_deleted=False).order_by("wbs_path"))


def _summary_ids(tasks: Iterable[Task]) -> set[object]:
    """Ids of rows that have at least one live structural descendant.

    ``is_summary`` is derived, not stored (``resources.services.task_is_summary``
    runs an ltree descendancy probe per task), so it cannot appear in a queryset
    filter. Derived here from the ltree paths already in memory: the overlay loads
    the project's two dozen rows once, and one pass over them answers the question
    for all of them without a query each.
    """
    paths = [str(t.wbs_path) for t in tasks if t.wbs_path]
    out: set[object] = set()
    for task in tasks:
        path = str(task.wbs_path) if task.wbs_path else ""
        if not path:
            continue
        if any(other.startswith(path + ".") for other in paths if other != path):
            out.add(task.pk)
    return out


def _task(project: Project, name: str) -> Task:
    task = Task.objects.filter(project=project, name=name, is_deleted=False).first()
    if task is None:
        raise DemoOverlayFixtureMismatch(
            f"The demo overlay expected a task named {name!r} in {project.name!r} and "
            "found none. See this module's docstring on why this raises."
        )
    return task


def _commitment_finish(project: Project, tasks: Iterable[Task]) -> dt.date:
    """The date the plan is measured against.

    Taken from the latest finish among the project's scheduled rows rather than from
    the fixture's ``forecast_history.commitment_finish`` literal: the seed re-anchors
    every relative date to the import day (ADR-1175), so the literal is not a date at
    all until the importer has resolved it, and re-resolving it here would be a second
    implementation of the same rule (feedback: two derivations of one fact drift).
    """
    finishes = [t.early_finish for t in tasks if t.early_finish is not None]
    if not finishes:
        raise DemoOverlayFixtureMismatch(
            f"{project.name!r} has no scheduled task finish to measure a forecast "
            "against; the seed import did not produce a usable schedule."
        )
    return max(finishes)


def _schedule_program(program: Program) -> None:
    """Run the program-true CPM pass so the rows carry real dates.

    Imported inside the function: ``scheduling.tasks`` imports the projects app's
    models, so a module-level import here would close an import cycle at Django
    start-up. This is the same entry point the program scheduler's own tests drive
    (``_run_program_schedule``), rather than a second, overlay-only way of
    scheduling — the demo must be looking at the schedule the product computes.
    """
    from trueppm_api.apps.scheduling.tasks import _run_program_schedule

    _run_program_schedule(str(program.id))


def _clear_health_override(project: Project) -> bool:
    """Drop the ``AT_RISK`` override. Returns whether anything changed."""
    if project.health == Health.AUTO:
        return False
    # AUTO, not ON_TRACK. The issue says "override cleared", and that is the honest
    # act: a PM override asserts a human judgment, and there is no human here. With
    # the override gone the chip renders the computed state, which on this plan — one
    # task modestly behind, float absorbing it — is "On track".
    project.health = Health.AUTO
    project.save(update_fields=["health"])
    return True


def _confirm_milestone(project: Project) -> bool:
    """Mark the closing gate as looked-at.

    "Unconfirmed" is not a field: it is ``TaskManager.untouched_seeded`` — a seeded
    row no person has touched (``edited_at IS NULL``). So confirming it means giving
    it an ``edited_at``, which an ordinary ``save()`` does, because ``Task.save``
    treats a write as human unless it says otherwise (ADR-0786 §4). That default is
    exactly right here: a visitor should see a gate somebody has agreed to.
    """
    milestone = _task(project, CONFIRMED_MILESTONE_NAME)
    if milestone.edited_at is not None:
        return False
    milestone.save(update_fields=["edited_at"])
    return True


def _finish_dry_run(project: Project) -> bool:
    """Dry-run migration is done and on plan."""
    task = _task(project, DRY_RUN_TASK_NAME)
    if task.percent_complete >= 100.0 and task.status == TaskStatus.COMPLETE:
        return False
    task.percent_complete = 100.0
    task.status = TaskStatus.COMPLETE
    task.save(update_fields=["percent_complete", "status"])
    return True


def _place_the_kept_signal(project: Project) -> bool:
    """Put the kept signal in flight, straddling today, with a window we control.

    The fixture starts Performance tuning at ``A+11`` — eleven days *after* the reset,
    i.e. in the future — and a task that has not begun cannot be behind anything.

    **The window is written directly rather than coaxed out of the engine, and that is
    a deliberate call.** Two rounds of trying the other way say why: a `planned_start`
    in the past is a *constraint*, and CPM still takes the max of it and the
    predecessor-driven early start, so the task kept landing wherever the network put
    it; and `scheduled_start` is derived from progress (ADR-0752), so the span moved
    every time the percentage did. Both are correct engine behaviour and neither can
    be steered into "today sits halfway through this bar", which is the one property
    the landing needs. So the overlay states the span, and `_keep_one_behind_plan`
    measures the percentage against the span it just stated — one direction of
    derivation instead of a loop.

    Nothing recomputes CPM afterwards, which is what makes that safe: these dates are
    the ones the demo serves, and the deployment refuses every write that could
    disturb them.
    """
    task = _task(project, BEHIND_PLAN_TASK_NAME)
    today = timezone.localdate()
    started = today - dt.timedelta(days=KEPT_SIGNAL_HALF_SPAN_DAYS)
    finishing = today + dt.timedelta(days=KEPT_SIGNAL_HALF_SPAN_DAYS)
    if (
        task.actual_start == started
        and task.scheduled_start == started
        and task.early_finish == finishing
        and task.status == TaskStatus.IN_PROGRESS
    ):
        return False
    task.actual_start = started
    task.planned_start = started
    task.scheduled_start = started
    task.early_start = started
    task.early_finish = finishing
    task.duration = KEPT_SIGNAL_DURATION_DAYS
    task.status = TaskStatus.IN_PROGRESS
    task.save(
        update_fields=[
            "actual_start",
            "planned_start",
            "scheduled_start",
            "early_start",
            "early_finish",
            "duration",
            "status",
        ]
    )
    return True


def _keep_one_behind_plan(project: Project) -> Task:
    """Leave exactly one realistic signal standing, and make sure it is the only one.

    Two separate acts, and the **second** is the one that makes the acceptance
    criterion true. Setting Performance tuning behind plan is easy; "exactly one
    behind-plan task" is a statement about every *other* row, so each of them is
    brought up to its own straight-line expectation rather than left wherever the
    fixture put it.

    Called after the CPM pass, and nothing recomputes CPM afterwards. That is
    deliberate and it is what the ordering buys: progress consumes remaining duration
    (ADR-0752), so re-running the engine here would move the very dates these
    percentages were measured against — and, worse, would stamp ``recalculated_at``
    after the forecast run and make the demo report its own forecast stale.
    """
    today = timezone.localdate()
    target = _task(project, BEHIND_PLAN_TASK_NAME)
    expected = _expected_percent(target, today)
    if expected is not None:
        behind = round(expected - BEHIND_PLAN_GAP_POINTS, 1)
        if target.percent_complete != behind:
            target.percent_complete = behind
            target.save(update_fields=["percent_complete"])

    tasks = _live_tasks(project)
    summaries = _summary_ids(tasks)
    for task in tasks:
        if task.pk == target.pk or task.pk in summaries or task.is_milestone:
            continue
        expected = _expected_percent(task, today)
        if expected is None:
            continue
        if (task.percent_complete or 0.0) >= expected:
            continue
        task.percent_complete = expected
        if expected >= 100.0:
            task.status = TaskStatus.COMPLETE
        elif expected > 0.0 and task.status == TaskStatus.NOT_STARTED:
            task.status = TaskStatus.IN_PROGRESS
        task.save(update_fields=["percent_complete", "status"])
    return target


def _expected_percent(task: Task, today: dt.date) -> float | None:
    """Straight-line expected completion for ``task`` at ``today``.

    Measured over the task's **span** — ``scheduled_start`` to ``early_finish``
    (ADR-0752) — not over ``early_start``, which for an in-progress task names the
    *remaining-work* window and therefore begins at the data date. Measuring against
    that would report every started task as 0% expected, i.e. never behind, which is
    the trap `project_2621_2623_remaining_duration_semantics` records. It is also the
    window the canvas bar is drawn from and the one the web's hint-target picker
    reads (``features/schedule/demoHintTarget.ts``), so all three agree by
    construction rather than by coincidence.
    """
    start = task.scheduled_start or task.early_start
    finish = task.early_finish
    if start is None or finish is None or finish <= start:
        return None
    if today <= start:
        return 0.0
    if today >= finish:
        return 100.0
    return round((today - start).days / (finish - start).days * 100.0, 1)


def _trim_unscheduled(project: Project) -> int:
    """Leave at most two unscheduled rows. Returns how many were removed."""
    tasks = _live_tasks(project)
    summaries = _summary_ids(tasks)
    unscheduled = [
        t
        for t in tasks
        if t.pk not in summaries and t.planned_start is None and t.early_start is None
    ]
    surplus = unscheduled[MAX_UNSCHEDULED:]
    for task in surplus:
        task.soft_delete()
    return len(surplus)


def _run_monte_carlo_last(
    project: Project, *, commitment: dt.date, cpm_finish: dt.date
) -> MonteCarloRun:
    """Record the final forecast, after every other write.

    **The ordering is the fix, not a detail.** "Edited since this run" is
    ``plan_version < plan_version_current`` or ``recalculated_at > taken_at``
    (``scheduling/forecast_staleness.py``). A run recorded before the overlay's edits
    is stale *by construction*, and the demo would carry a staleness warning that is
    both true and entirely self-inflicted. So this is the last thing that happens, it
    reads ``last_sync_version`` after the edits, and its ``taken_at`` (``auto_now_add``)
    is therefore later than every one of them.

    The percentiles are authored rather than simulated. Running the real engine here
    would produce whatever the fixture's three-point estimates imply — which is the
    A+86-vs-A+67 overshoot this overlay exists to remove — so simulating and then
    overwriting the answer would be a more expensive way to write the same row while
    pretending it was derived. The fixture's own backfilled history is synthesized the
    same way and for the same reason (``forecast_backfill``, ADR-0211).
    """
    p80 = commitment - dt.timedelta(days=P80_HEADROOM_DAYS)
    return MonteCarloRun.objects.create(
        project=project,
        triggered_by=None,
        p50=p80 - dt.timedelta(days=5),
        p80=p80,
        p95=p80 + dt.timedelta(days=6),
        cpm_finish=cpm_finish,
        n_simulations=FINAL_RUN_SIMULATIONS,
        task_count=Task.objects.filter(project=project, is_deleted=False).count(),
        status_date=timezone.localdate(),
        # Read AFTER every edit above — this is what makes the run current rather
        # than merely recent.
        plan_version=Project.objects.values_list("last_sync_version", flat=True).get(pk=project.pk),
    )


@transaction.atomic
def apply_demo_landing_overlay(program: Program) -> DemoLandingOverlayResult:
    """Apply the demo-only landing overlay to ``program``'s landing project.

    Idempotent in the sense the nightly reset needs: a second call over an
    already-overlaid database reaches the same state, and ``was_noop`` says that every
    seed indicator was already dealt with. Two things are re-asserted on every run by
    design — the kept signal's window (the CPM pass re-derives it each time) and the
    forecast row (it has to stay newer than whatever this run wrote).

    Raises:
        DemoOverlayRefused: ``settings.DEMO_READ_ONLY`` is not on. The overlay
            rewrites project health, task progress and milestone confirmation, and a
            deployment people actually work in must never have that done to it by a
            seed job.
        DemoOverlayFixtureMismatch: the imported seed does not carry a row this
            overlay is written against.
    """
    if not settings.DEMO_READ_ONLY:
        raise DemoOverlayRefused(
            "The demo landing overlay refuses to run while TRUEPPM_DEMO_READ_ONLY is "
            "off. It clears a project's health override, completes tasks, confirms a "
            "milestone and soft-deletes unscheduled rows — none of which may happen "
            "to a deployment people work in. See ADR-1197."
        )

    project = _landing_project(program)

    # CPM FIRST, because every measurement below is against `early_start` /
    # `early_finish`, and `import_seed` does not schedule — it writes
    # `planned_start` + `duration` and leaves the engine to derive dates. Without
    # this the overlay has no window to measure "behind plan" against, and the one
    # signal it is supposed to leave standing would be left standing by accident.
    _schedule_program(program)

    changed = _clear_health_override(project)
    changed |= _confirm_milestone(project)
    changed |= _finish_dry_run(project)
    removed = _trim_unscheduled(project)
    changed |= removed > 0

    # …and again, because completing the dry run, starting the kept signal and
    # trimming the unscheduled pile all change the network. The percentages below are
    # measured against THESE dates, and nothing recomputes after them — see
    # `_keep_one_behind_plan`.
    _schedule_program(program)

    # After the last CPM pass, never before it: this writes the kept signal's dates
    # outright, and a later engine run would take them back — which is also why it is
    # NOT folded into `changed`. The CPM pass above re-derives that window on every
    # run, so re-asserting it is what every reset does, not evidence that the previous
    # reset left something undone. `was_noop` answers "were the seed's INDICATORS
    # already dealt with", which is the question an operator reading the job log has.
    _place_the_kept_signal(project)
    target = _keep_one_behind_plan(project)

    commitment = _commitment_finish(project, _live_tasks(project))
    run = _run_monte_carlo_last(project, commitment=commitment, cpm_finish=commitment)

    return DemoLandingOverlayResult(
        project_id=str(project.pk),
        behind_plan_task_id=str(target.pk),
        behind_plan_task_wbs_path=str(target.wbs_path),
        monte_carlo_run_id=str(run.pk),
        p80=run.p80,  # type: ignore[arg-type]  # set unconditionally above
        commitment_finish=commitment,
        unscheduled_removed=removed,
        was_noop=not changed,
    )
