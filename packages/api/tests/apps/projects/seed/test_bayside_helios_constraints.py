"""The constraint and mitigation depth #3097 asked Bayside and Helios for.

Bayside is the constraint pack and declared no calendar exceptions at all, on a
site whose entire premise is weather. Helios is the entry-level hybrid and ran
its sprints without goals, so the PARTIAL close on Sprint 1 was an outcome
against nothing.

Every assertion here is about *substance*. A test that only checked "the site
calendar declares an exception" would pass against a window placed anywhere at
all — including one landing on the framing phase, which carries ~50 days of
float and would swallow it whole. So each exception is pinned to what it
actually moves, and — just as importantly — to what it does not: the crane
window is asserted NOT to move the certificate of occupancy, because claiming
otherwise would be the same decorative-constraint bug wearing a passing test.
"""

import json
from pathlib import Path

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    CalendarException,
    Project,
    Sprint,
    Task,
)
from trueppm_api.apps.projects.seed.importer import import_seed

FIXDIR = Path(__file__).resolve().parents[4] / "src/trueppm_api/apps/projects/fixtures/seeds"
CRANE = "Tower crane unavailable"
ALLOWANCE = "Winter weather allowance"


def _doc(stem: str, *, drop: str | None = None) -> dict:
    doc = json.loads((FIXDIR / f"{stem}.json").read_text())
    if drop is not None:
        for cal in doc.get("calendars", []):
            cal["exceptions"] = [
                e for e in cal.get("exceptions", []) if drop not in e["description"]
            ]
    return doc


@pytest.fixture
def owner(db):
    return get_user_model().objects.create_user(
        username="c3097-owner", email="c3097@example.com", password="pw"
    )


def _import_and_schedule(doc, owner):
    from trueppm_api.apps.scheduling.tasks import _run_program_schedule

    program = import_seed(doc, owner=owner, create_users=True, replace=True)
    _run_program_schedule(str(program.id))
    return program


def _task(program, project_name: str, wbs: str) -> Task:
    return Task.objects.get(
        project=Project.objects.get(program=program, name=project_name), wbs_path=wbs
    )


def _finishes(program) -> tuple:
    """(certificate of occupancy, floor decking) early finishes."""
    return (
        _task(program, "Building & Fit-out", "3").early_finish,
        _task(program, "Sitework & Structure", "3.2").early_finish,
    )


def _isolated(doc, owner):
    """Import into a clean calendar state and return the two finish dates.

    ``replace=True`` reconciles CalendarException rows by *content* and does not
    delete rows a later payload drops, so importing the stripped document over
    the full one silently keeps the exception under test and both arms come back
    identical — a vacuously passing comparison. The explicit delete is what makes
    the two arms independent.
    """
    CalendarException.objects.all().delete()
    return _finishes(_import_and_schedule(doc, owner))


# --- Bayside: constraints that bite -----------------------------------------


def test_weather_allowance_moves_the_certificate_of_occupancy(owner):
    # The one exception that reaches the program finish. Final inspection &
    # handover carries 2 days of total float — the least of anything upstream of
    # the CO — and the allowance window always removes more working days than
    # that, on whatever weekday the pack happens to be imported.
    with_it, _ = _isolated(_doc("bayside-civic-center"), owner)
    without, _ = _isolated(_doc("bayside-civic-center", drop=ALLOWANCE), owner)
    assert with_it > without, (
        f"the winter weather allowance moved nothing: CO finishes {with_it} with it "
        f"and {without} without it — it is being absorbed by float"
    )


def test_crane_window_stretches_decking_but_is_absorbed_before_the_finish(owner):
    # The honest half of the pair, and the reason both directions are asserted.
    # The stand-down lands on floor decking and visibly stretches it; framing
    # carries ~50 days of float, so the effect dies before the gate and never
    # reaches the certificate of occupancy. Claiming it moved the finish would be
    # false, and claiming only that the exception exists would be worthless — the
    # pair is what makes either claim mean anything.
    with_it_co, with_it_decking = _isolated(_doc("bayside-civic-center"), owner)
    without_co, without_decking = _isolated(_doc("bayside-civic-center", drop=CRANE), owner)
    stretch = (with_it_decking - without_decking).days
    # Not just ">": floor decking has no float of its own, so a single token
    # non-working day would also move it and a bare inequality would call that a
    # pass. A crane going back to the yard is a week-scale stand-down or it is
    # not the constraint the note claims it is.
    assert stretch >= 7, (
        f"the crane stand-down moved floor decking by {stretch} days: it finishes "
        f"{with_it_decking} with the window and {without_decking} without it"
    )
    assert with_it_co == without_co, (
        "the crane stand-down reached the certificate of occupancy — framing was "
        "supposed to have the float to absorb it, so either the note on the "
        "exception or the schedule is now wrong"
    )


def test_both_windows_reach_the_schedule(owner):
    program = _import_and_schedule(_doc("bayside-civic-center"), owner)
    descriptions = set(
        CalendarException.objects.filter(
            calendar__in=[p.calendar_id for p in Project.objects.filter(program=program)]
        ).values_list("description", flat=True)
    )
    for marker in (CRANE, ALLOWANCE):
        assert any(marker in d for d in descriptions), (
            f"{marker!r} never materialized as a CalendarException row"
        )


# --- Bayside: the realized risk ---------------------------------------------


def test_soil_risk_is_realized_and_cost_the_schedule(owner):
    # A register in which every risk either never fires or is closed by its
    # mitigation teaches a PM nothing. Exactly one risk here was mitigated,
    # failed anyway, and cost real days — and those days have to be visible as
    # variance rather than quietly folded into the plan.
    program = _import_and_schedule(_doc("bayside-civic-center"), owner)
    project = Project.objects.get(program=program, name="Sitework & Structure")
    risk = project.risks.get(title="Unsuitable bearing material at excavation")

    assert risk.trigger, "the realized risk has no trigger condition"
    assert risk.contingency, "the realized risk has no contingency"
    assert "REALIZED" in (risk.notes or ""), "the risk never records that it fired"

    excavate = _task(program, "Sitework & Structure", "2.1")
    contract = Baseline.objects.get(project=project, name="Contract baseline")
    planned = BaselineTask.objects.get(baseline=contract, task_id=excavate.pk).duration
    assert excavate.duration > planned, (
        f"the contingency cost nothing: excavation is {excavate.duration} days against "
        f"a contract baseline of {planned} — a realized risk with no variance is a "
        f"note, not an outcome"
    )


def test_the_transfer_response_says_what_was_transferred(owner):
    # The only TRANSFER in any bundled pack. Unexplained, it reads as a fourth
    # enum value nobody could act on.
    program = _import_and_schedule(_doc("bayside-civic-center"), owner)
    risk = Project.objects.get(program=program, name="Building & Fit-out").risks.get(
        title="MEP subcontractor financial risk"
    )
    assert risk.response == "TRANSFER"
    assert risk.trigger, "the TRANSFER response has no trigger condition"
    assert "bond" in (risk.contingency or "").lower(), (
        "the contingency does not say what happens when the transfer is called on"
    )
    notes = (risk.notes or "").lower()
    assert "bond" in notes, (
        "the TRANSFER response names no instrument — what was transferred, and to whom?"
    )
    # The half that makes TRANSFER worth teaching: it moves the money, not the
    # schedule. Without this the register reads as though the bond made the risk
    # go away, which is the misconception the response type usually creates.
    assert "schedule" in notes, (
        "the notes never say what the transfer does NOT cover — a bond that reads "
        "as covering everything is worse than no explanation"
    )
    assert risk.status == "OPEN", (
        "transferring the financial exposure closed the risk, but the schedule "
        "exposure of replacing a defaulted sub does not transfer with the bond"
    )


def test_contract_baseline_and_rebaseline_are_months_apart(owner):
    # #3093 made captured_at land; this pins the story it was hiding. Both
    # baselines used to record the moment somebody clicked "Load demo data",
    # collapsing the change-order interval every planned-vs-actual view reads.
    program = _import_and_schedule(_doc("bayside-civic-center"), owner)
    project = Project.objects.get(program=program, name="Sitework & Structure")
    contract = Baseline.objects.get(project=project, name="Contract baseline")
    rebaseline = Baseline.objects.get(project=project, name="Rebaseline — mezzanine change order")
    gap = (rebaseline.created_at.date() - contract.created_at.date()).days
    assert gap > 60, f"contract baseline and rebaseline are {gap} days apart"
    assert rebaseline.is_active and not contract.is_active


# --- Helios: goals and a mitigation with a task behind it -------------------


def test_every_helios_sprint_states_a_goal(owner):
    program = _import_and_schedule(_doc("helios-crm-replacement"), owner)
    goalless = [
        s.name
        for s in Sprint.objects.filter(project__program=program)
        if not (s.goal or "").strip()
    ]
    assert not goalless, f"sprints closing against no stated goal: {goalless}"


def test_migration_risk_has_a_scheduled_mitigation_task(owner):
    # A mitigation nobody scheduled is a sentence in a register. This one is a
    # real story, in a real sprint, linked back to the risk it answers.
    program = _import_and_schedule(_doc("helios-crm-replacement"), owner)
    project = Project.objects.get(program=program, name="Helios CRM")
    risk = project.risks.get(title="Legacy data migration fidelity")

    assert risk.mitigation_due_date, "the mitigation arc has no due date"
    assert risk.trigger and risk.contingency
    assert risk.status == "MITIGATING", (
        f"the risk never moved off OPEN (is {risk.status}) — the mitigation was "
        f"scheduled but the register does not know it"
    )

    harness = Task.objects.get(project=project, name="Migration dry-run harness")
    assert harness.sprint is not None, "the mitigation task is not in any sprint"
    assert harness.pk in {t.pk for t in risk.tasks.all()}, (
        "the mitigation task is not linked to the risk it mitigates"
    )


def test_the_mitigation_task_displaced_scope_rather_than_inflating_the_sprint(owner):
    # Mitigation costs somebody else's scope; a sprint that simply absorbs it is
    # the fiction this pack should not be teaching.
    program = _import_and_schedule(_doc("helios-crm-replacement"), owner)
    project = Project.objects.get(program=program, name="Helios CRM")
    sprint = Sprint.objects.get(project=project, name="Build Sprint 3")
    committed = sum(
        t.story_points or 0 for t in Task.objects.filter(project=project, sprint=sprint)
    )
    assert committed <= sprint.capacity_points, (
        f"Sprint 3 holds {committed} points against capacity "
        f"{sprint.capacity_points} — the mitigation task was added without paying "
        f"for it"
    )
    displaced = Task.objects.get(project=project, name="Custom fields")
    assert displaced.sprint is None, (
        "Custom fields was supposed to move to the backlog to make room for the "
        "dry-run harness, but it is still committed"
    )
