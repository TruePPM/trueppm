"""Sprint cadence generation — the bulk stand-up of an iteration series (#2968).

Standing up a year of iterations one ``POST /sprints/`` at a time is data entry,
not planning. This module computes a whole cadence in one pass and commits it in
one transaction.

Three properties are load-bearing and each is here rather than in the view so
they are testable without HTTP:

**Calendar-aware.** Sprint length is counted in *working days* against the
project's composed calendar (``compose_project_calendar`` — the same fold CPM,
Monte Carlo, and the program pass use, so a cadence can never disagree with the
schedule about what a working day is). A holiday inside a window pushes the
finish date out rather than silently shrinking the iteration; a fixed 14-calendar-day
cadence would keep *calling* it a two-week sprint while quietly deleting two days
of the team's capacity, and that is exactly the kind of number that misleads
planning.

**Idempotent on name.** ``Sprint`` carries no unique constraint on
``(project, name)`` — duplicate names are legal and some projects have them — so
idempotency is enforced here: a candidate whose name already exists in the project
is reported as ``exists`` and never re-created. A double submit therefore creates
one set, not two. :func:`commit_cadence` re-reads the existing names *inside* the
transaction while holding a row lock on the project, so two concurrent requests
serialize rather than racing past each other's absence check.

**Capacity is a planning aid, never a cap.** :func:`capacity_hint` returns a
suggestion derived from the team's own closed sprints, and generation *never*
writes it to ``Sprint.capacity_points`` on its own. A capacity is only stored when
the caller explicitly passes one, and then only onto the first sprint — a
throughput figure projected onto sprint twelve is fiction. Sprint commitment
belongs to the team (ADR-0073 / ADR-0113); a generator that stamps a ceiling onto
a year of iterations is a cadence tool dictating what a team commits to.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass
from datetime import date, timedelta
from typing import TYPE_CHECKING, Any

from django.db import transaction

if TYPE_CHECKING:  # pragma: no cover - typing only
    from trueppm_api.apps.projects.models import Project, Sprint

# Bulk-size bound (#2968). The endpoint is reachable by an MCP/agent caller, so
# "how many rows can one call create" is a containment question, not a UX one.
# 52 is a year of weekly iterations — past that a caller wants a second call and
# a look at the preview, not a bigger number.
MAX_GENERATED_SPRINTS = 52
# A single iteration longer than six working weeks is not a sprint; the bound
# exists so `count * length` cannot be used to walk the calendar scan out to the
# date ceiling.
MAX_SPRINT_LENGTH_DAYS = 30
# Two, not one: `Sprint.Meta` carries `CheckConstraint(finish_date__gt=start_date)`
# — strictly greater — so a single-working-day iteration is illegal at the
# database level and would surface as an IntegrityError (a 500), not a 400.
MIN_SPRINT_LENGTH_DAYS = 2
# Two Mon–Fri weeks. Deliberately *not* `services._typical_sprint_length_days`,
# which derives the team's cadence from the last sprint's span in **calendar**
# days; this module counts **working** days, and silently mixing the two units
# would make a two-week default land as a two-and-a-half-week sprint.
DEFAULT_SPRINT_LENGTH_DAYS = 10
MAX_FIRST_INDEX = 999
NAME_TOKEN = "{n}"

# Guard against a degenerate composed calendar. `compose_project_calendar`
# AND-folds every applied mask, so two overlays with disjoint working days
# compose to "no working day ever" — a walk that would otherwise spin to the
# `date` ceiling and surface as an opaque OverflowError mid-request. Mirrors
# the scheduler engine's own MAX_CALENDAR_SCAN_DAYS guard, scaled to the span a
# cadence can legitimately need.
MAX_CALENDAR_SCAN_DAYS = 366 * 5

# Rolling window for the capacity suggestion. Matches the window the velocity
# panel and `scheduler_velocity_inputs` already read, so the number the wizard
# shows and the number the velocity surfaces show are derived from the same set.
CAPACITY_HINT_WINDOW = 6

# The one string that carries the ADR-0073 sovereignty rule onto the wire. Every
# client that renders the hint renders this sentence with it, so a UI cannot
# quietly re-label a suggestion as a limit.
CAPACITY_HINT_NOTE = (
    "A starting point drawn from this team's own closed iterations — not a limit. "
    "The team decides what it commits to."
)
CAPACITY_HINT_NOTE_NO_HISTORY = (
    "No closed iterations to draw from yet, so there is no suggestion to make. "
    "The team decides what it commits to."
)


class CadenceError(ValueError):
    """A cadence request that cannot be satisfied (degenerate calendar, bad span).

    Raised by the pure functions here so they stay usable outside DRF; the view
    translates it into a 400.
    """


@dataclass(frozen=True)
class CadenceRow:
    """One proposed iteration in a generated cadence.

    ``exists`` is the idempotency verdict: a row whose name already belongs to a
    live sprint in this project is never created, in preview or on commit.

    ``non_working_days_skipped`` counts **every** non-working day the window
    spans — weekends included, not holidays only. That is deliberate: it is the
    calendar evidence behind the finish date, so a window lengthened by a
    shutdown reads as a deliberate skip in the preview rather than an
    unexplained date jump, and a reader can check ``working_days +
    non_working_days_skipped`` against the span.
    """

    name: str
    start_date: date
    finish_date: date
    working_days: int
    non_working_days_skipped: int
    exists: bool


def render_sprint_name(pattern: str, index: int) -> str:
    """Substitute ``{n}`` in a cadence name pattern.

    Deliberately a literal replace rather than :meth:`str.format`: the pattern is
    user input, and ``format`` on user input is an attribute-traversal primitive
    (``{0.__class__}``) plus a KeyError surface for every unrecognized brace.
    Replacing one known token leaves every other brace as the literal the author
    typed.
    """
    return pattern.replace(NAME_TOKEN, str(index))


def _next_working_day(cal: Any, d: date) -> date:
    """``d`` itself when it is a working day, else the first working day after it."""
    scanned = 0
    while not cal.is_working_day(d):
        if scanned >= MAX_CALENDAR_SCAN_DAYS:
            raise CadenceError(
                "This project's calendar has no working day within "
                f"{MAX_CALENDAR_SCAN_DAYS} days of the requested start. Check the "
                "project's working-day mask and its holiday overlays."
            )
        d += timedelta(days=1)
        scanned += 1
    return d


def _window_from_start(cal: Any, start: date, length_days: int) -> tuple[date, int]:
    """The window that holds exactly ``length_days`` working days from ``start``.

    ``start`` must already be a working day. Returns the inclusive finish date
    and the count of non-working days that fell inside the window — the number
    the preview shows so a holiday-lengthened sprint reads as deliberate.
    """
    counted = 1  # `start` is a working day and is day one
    cursor = start
    skipped = 0
    scanned = 0
    while counted < length_days:
        cursor += timedelta(days=1)
        scanned += 1
        if scanned >= MAX_CALENDAR_SCAN_DAYS:
            raise CadenceError(
                f"This project's calendar cannot fit {length_days} working days "
                f"within {MAX_CALENDAR_SCAN_DAYS} days of {start.isoformat()}. "
                "Check the project's working-day mask and its holiday overlays."
            )
        if cal.is_working_day(cursor):
            counted += 1
        else:
            skipped += 1
    return cursor, skipped


def working_days_in_window(cal: Any, start: date, finish: date) -> tuple[int, int]:
    """``(working, non_working)`` day counts across the inclusive ``[start, finish]``.

    Used for rows the operator edited in the preview: the dates are theirs, but
    the calendar read-out stays server-computed so an edited row reports the same
    kind of fact a generated one does.
    """
    # Strictly greater, matching the model's own CheckConstraint — a same-day
    # window is rejected here rather than at INSERT time as an IntegrityError.
    # (The serializer rejects it first; the guard keeps the helper honest for
    # non-HTTP callers.)
    if finish <= start:
        raise CadenceError("finish_date must be after start_date.")
    span = (finish - start).days + 1
    if span > MAX_CALENDAR_SCAN_DAYS:
        raise CadenceError(f"An iteration may not span more than {MAX_CALENDAR_SCAN_DAYS} days.")
    working = sum(1 for i in range(span) if cal.is_working_day(start + timedelta(days=i)))
    return working, span - working


def existing_sprint_names(project: Project) -> set[str]:
    """Every live sprint name in the project — the idempotency key set.

    Exact, case-sensitive match. A name differing only in case is a different
    name, and silently folding them would make the generator refuse to create a
    sprint the operator can see is missing.
    """
    from trueppm_api.apps.projects.models import Sprint

    return set(
        Sprint.objects.filter(project=project, is_deleted=False).values_list("name", flat=True)
    )


def build_cadence(
    project: Project,
    *,
    count: int,
    start_date: date,
    length_days: int,
    name_pattern: str,
    first_index: int,
    taken_names: set[str] | None = None,
) -> list[CadenceRow]:
    """Compute ``count`` back-to-back iterations from ``start_date``.

    Each iteration starts on the first working day at or after the cursor, holds
    exactly ``length_days`` working days, and hands the cursor to the day after
    its finish — so the series is contiguous with no manufactured gap, and every
    boundary lands on a working day.

    Args:
        project: The project whose composed calendar governs the walk.
        count: How many iterations to lay out (bounded by the serializer).
        start_date: Requested start of the first iteration; snapped forward.
        length_days: Working days per iteration.
        name_pattern: Name template containing ``{n}``.
        first_index: Value substituted for ``{n}`` in the first iteration.
        taken_names: Pre-read existing names; re-read from the DB when omitted.

    Returns:
        One :class:`CadenceRow` per iteration, in chronological order.
    """
    from trueppm_api.apps.scheduling.calendars import compose_project_calendar

    cal = compose_project_calendar(project)
    taken = existing_sprint_names(project) if taken_names is None else taken_names

    rows: list[CadenceRow] = []
    cursor = start_date
    for offset in range(count):
        start = _next_working_day(cal, cursor)
        finish, skipped = _window_from_start(cal, start, length_days)
        name = render_sprint_name(name_pattern, first_index + offset)
        rows.append(
            CadenceRow(
                name=name,
                start_date=start,
                finish_date=finish,
                working_days=length_days,
                non_working_days_skipped=skipped,
                exists=name in taken,
            )
        )
        cursor = finish + timedelta(days=1)
    return rows


def annotate_edited_rows(
    project: Project,
    edits: list[dict[str, Any]],
    *,
    taken_names: set[str] | None = None,
) -> list[CadenceRow]:
    """Turn operator-edited preview rows into :class:`CadenceRow` records.

    The operator owns the dates and names once they have edited the preview —
    this is the "editable preview" half of the contract, and re-deriving the
    window from the generator's rules would silently undo their edit. What stays
    server-owned is the calendar read-out and the idempotency verdict.
    """
    from trueppm_api.apps.scheduling.calendars import compose_project_calendar

    cal = compose_project_calendar(project)
    taken = existing_sprint_names(project) if taken_names is None else taken_names

    rows: list[CadenceRow] = []
    for edit in edits:
        start = edit["start_date"]
        finish = edit["finish_date"]
        working, skipped = working_days_in_window(cal, start, finish)
        rows.append(
            CadenceRow(
                name=edit["name"],
                start_date=start,
                finish_date=finish,
                working_days=working,
                non_working_days_skipped=skipped,
                exists=edit["name"] in taken,
            )
        )
    return rows


def capacity_hint(project: Project) -> dict[str, Any]:
    """A suggested first-iteration points figure, with the sentence that bounds it.

    Drawn from :func:`velocity_eligible_sprints` — the canonical "counts toward
    velocity" set (ADR-0113), so a Sprint 0 the team excluded is excluded here
    too. Returns ``points=None`` when the team has no closed iteration to draw
    from, rather than inventing a default: a made-up ceiling is worse than none.

    This is a *suggestion*. Nothing in this module writes it anywhere; see the
    module docstring.
    """
    from trueppm_api.apps.projects.services import velocity_eligible_sprints

    samples = [
        float(s.completed_points)
        for s in velocity_eligible_sprints(project.pk)[:CAPACITY_HINT_WINDOW]
        if s.completed_points is not None
    ]
    if not samples:
        return {
            "points": None,
            "basis": "no_history",
            "sprints_sampled": 0,
            "note": CAPACITY_HINT_NOTE_NO_HISTORY,
        }
    return {
        "points": round(statistics.fmean(samples)),
        "basis": "velocity_average",
        "sprints_sampled": len(samples),
        "note": CAPACITY_HINT_NOTE,
    }


@transaction.atomic
def commit_cadence(
    project: Project,
    rows: list[CadenceRow],
    *,
    created_by: Any,
    first_sprint_capacity_points: int | None = None,
) -> tuple[list[Sprint], list[CadenceRow]]:
    """Persist every row that does not already exist, in one transaction.

    Returns ``(created, final_rows)`` where ``final_rows`` carries the
    re-evaluated ``exists`` verdict — the caller echoes those back so the client
    can see exactly which names were skipped.

    Two deliberate choices:

    - **A row lock on the project, not a unique constraint.** ``Sprint`` has no
      ``(project, name)`` uniqueness and cannot grow one without rejecting the
      duplicate names some projects already hold. Taking ``select_for_update``
      on the project row serializes concurrent generate calls for that project,
      so the second caller's existence re-read sees the first caller's inserts
      and skips them. Two browser tabs submitting at once therefore produce one
      cadence.
    - **``save()`` in a loop, not ``bulk_create``.** ``Sprint.save()`` allocates
      the per-project ``short_id`` from the shared object sequence, and
      ``VersionedModel`` bumps ``server_version`` for the sync delta;
      ``bulk_create`` bypasses both and would emit sprints that offline clients
      never pull and that collide on short id. The loop is bounded by
      :data:`MAX_GENERATED_SPRINTS`.
    """
    from trueppm_api.apps.projects.models import Project as ProjectModel
    from trueppm_api.apps.projects.models import Sprint, SprintState

    # Serializes concurrent generate calls for this project (see docstring).
    ProjectModel.objects.select_for_update().get(pk=project.pk)
    taken = existing_sprint_names(project)

    created: list[Sprint] = []
    final_rows: list[CadenceRow] = []
    for row in rows:
        if row.name in taken:
            final_rows.append(
                CadenceRow(
                    name=row.name,
                    start_date=row.start_date,
                    finish_date=row.finish_date,
                    working_days=row.working_days,
                    non_working_days_skipped=row.non_working_days_skipped,
                    exists=True,
                )
            )
            continue
        sprint = Sprint(
            project=project,
            name=row.name,
            start_date=row.start_date,
            finish_date=row.finish_date,
            state=SprintState.PLANNED,
            created_by=created_by,
        )
        # Only the first iteration ever receives a stored capacity, and only when
        # the caller passed one explicitly. Projecting today's throughput onto
        # iteration twelve would be fiction dressed as a plan.
        if not created and first_sprint_capacity_points is not None:
            sprint.capacity_points = first_sprint_capacity_points
        sprint.save()
        taken.add(row.name)
        created.append(sprint)
        final_rows.append(row)
    return created, final_rows
