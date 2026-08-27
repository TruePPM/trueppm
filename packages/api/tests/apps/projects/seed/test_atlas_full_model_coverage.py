"""The dependency, baseline, calendar and health coverage #3095 asked Atlas for.

Every assertion here is about *substance* rather than presence. A test that only
checked "the standard calendar declares an exception" would have passed against
the first draft of this work, whose exception spanned a weekend, removed a single
working day, and was absorbed whole by the migration milestone's float — the pack
would have shipped claiming a calendar exception that moved nothing.
"""

import json
from pathlib import Path

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.projects.models import (
    Baseline,
    CalendarException,
    Dependency,
    Project,
    Task,
)
from trueppm_api.apps.projects.seed import export_program, validate_seed
from trueppm_api.apps.projects.seed.importer import import_seed

FIXTURE = (
    Path(__file__).resolve().parents[4]
    / "src/trueppm_api/apps/projects/fixtures/seeds/atlas-platform-launch.json"
)
SHUTDOWN = "Company shutdown"


def _doc(*, strip_shutdown: bool = False) -> dict:
    doc = json.loads(FIXTURE.read_text())
    if strip_shutdown:
        for cal in doc["calendars"]:
            cal["exceptions"] = [
                e for e in cal.get("exceptions", []) if SHUTDOWN not in e["description"]
            ]
    return doc


@pytest.fixture
def owner(db):
    return get_user_model().objects.create_user(
        username="atlas-coverage-owner", email="coverage@example.com", password="pw"
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


@pytest.mark.django_db
def test_the_shutdown_exception_moves_the_program_finish(owner):
    """The exception has to bite, not merely exist.

    Imported *without* the shutdown first, then with it. The intervening delete
    is not decoration: the importer reconciles calendar exceptions by content and
    does not remove rows that a later payload drops, so re-importing a stripped
    document over a full one silently keeps the exception and makes the whole
    comparison vacuous — which is exactly how the first version of this test
    passed while proving nothing.
    """
    program = _import_and_schedule(_doc(strip_shutdown=True), owner)
    baseline_finish = _task(program, "Migration Tooling", "6").early_finish
    baseline_launch = _task(program, "GTM Readiness", "3").early_finish

    CalendarException.objects.all().delete()

    program = _import_and_schedule(_doc(), owner)
    assert CalendarException.objects.filter(description__contains=SHUTDOWN).exists()
    shifted_finish = _task(program, "Migration Tooling", "6").early_finish
    shifted_launch = _task(program, "GTM Readiness", "3").early_finish

    # The migration milestone carries float, so the window is sized to exceed it.
    assert shifted_finish > baseline_finish, (
        f"the shutdown left the migration finish at {baseline_finish}"
    )
    # ...and the FS+3 edge has to carry that into the public launch, or the
    # exception moved a task nobody is looking at.
    assert shifted_launch > baseline_launch, (
        f"the shutdown never reached the public launch ({baseline_launch})"
    )


@pytest.mark.django_db
def test_atlas_demonstrates_all_four_dependency_types_and_a_lead(owner):
    program = _import_and_schedule(_doc(), owner)
    edges = Dependency.objects.filter(successor__project__program=program)

    kinds = set(edges.values_list("dep_type", flat=True))
    assert kinds == {"FS", "SS", "FF", "SF"}, f"missing dependency types: {kinds}"

    leads = edges.filter(lag__lt=0)
    assert leads.exists(), "no negative lag anywhere in the flagship pack"

    # The lead has to fast-track a real gate, not sit on an inert pair.
    lead = leads.get()
    assert lead.predecessor.name == "Pricing & packaging sign-off"
    assert lead.successor.name == "Launch gate review"


@pytest.mark.django_db
def test_the_ff_and_sf_edges_are_cycle_free_and_land_on_leaves(owner):
    """An SF edge pointed at a task that feeds the planning chain would cycle."""
    program = _import_and_schedule(_doc(), owner)
    for dep_type in ("FF", "SF"):
        edge = Dependency.objects.get(successor__project__program=program, dep_type=dep_type)
        assert not Dependency.objects.filter(predecessor=edge.successor).exists(), (
            f"the {dep_type} successor {edge.successor.name!r} has its own "
            "successors, so this edge can close a cycle"
        )


@pytest.mark.django_db
def test_gtm_has_a_baseline_covering_both_lanes_with_real_variance(owner):
    program = _import_and_schedule(_doc(), owner)
    gtm = Project.objects.get(program=program, name="GTM Readiness")

    baseline = Baseline.objects.get(project=gtm, is_active=True)
    rows = {r.task_name: r for r in baseline.tasks.all()}

    # Both lanes: dated rows for the gated planning tasks, point rows for the
    # enablement backlog. A baseline over one lane of a hybrid project would
    # leave half the burn-up without a commitment line.
    assert "Pricing & packaging sign-off" in rows
    assert "Sales deck" in rows
    assert rows["Sales deck"].story_points is not None

    # The point of a baseline is variance. If the baseline start equals the
    # current planned start on every row, the Schedule view shows a flat zero.
    drifted = [
        name
        for name, row in rows.items()
        if row.start
        and (task := Task.objects.filter(project=gtm, name=name).first())
        and task.planned_start
        and row.start != task.planned_start
    ]
    assert drifted, "every GTM baseline row matches the current plan exactly"


@pytest.mark.django_db
def test_migration_keeps_the_kickoff_baseline_and_activates_the_replan(owner):
    program = _import_and_schedule(_doc(), owner)
    mt = Project.objects.get(program=program, name="Migration Tooling")

    kickoff = Baseline.objects.get(project=mt, name="Kickoff baseline")
    replan = Baseline.objects.get(project=mt, name="Post-dry-run re-plan")
    assert not kickoff.is_active
    assert replan.is_active

    kickoff_rows = {r.task_name: r for r in kickoff.tasks.all()}
    replan_rows = {r.task_name: r for r in replan.tasks.all()}
    assert set(kickoff_rows) == set(replan_rows), "the re-plan dropped tasks"

    # Completed work is identical in both; the slipped tail is not. Asserting
    # only "two baselines exist" would pass against two identical snapshots,
    # which would show a re-plan that re-planned nothing.
    assert kickoff_rows["Inventory legacy schemas"].start == (
        replan_rows["Inventory legacy schemas"].start
    )
    assert replan_rows["Dry-run migration"].start > kickoff_rows["Dry-run migration"].start


@pytest.mark.django_db
def test_exactly_one_project_carries_a_manual_health_override(owner):
    program = _import_and_schedule(_doc(), owner)
    by_name = {p.name: p.health for p in Project.objects.filter(program=program)}
    assert by_name["Migration Tooling"] == "AT_RISK"
    # The override is only legible as a judgment because the others defer to the
    # rollup — three manual chips would read as a global setting.
    assert by_name["Platform Core"] == "AUTO"
    assert by_name["GTM Readiness"] == "AUTO"


@pytest.mark.django_db
def test_platform_core_baseline_covers_the_day_zero_backlog(owner):
    """Scope that existed on day 3 is baselined; genuinely later scope is not."""
    program = _import_and_schedule(_doc(), owner)
    pc = Project.objects.get(program=program, name="Platform Core")
    names = {r.task_name for r in Baseline.objects.get(project=pc).tasks.all()}

    assert {"Digest personalization", "Notification templates"} & names, (
        "the day-zero Notifications backlog is missing from the baseline"
    )
    # ...and the honest exclusions stay excluded, or the baseline claims to have
    # committed to work that did not exist yet.
    assert "Service accounts" not in names
    assert "Fallback IdP spike" not in names


@pytest.mark.django_db
def test_the_health_override_survives_an_export_import_round_trip(owner):
    """The key has three implementations and all three have to agree.

    Schema, importer and exporter are separate readers of the same key, and a
    key that imports but does not export is invisible until someone downloads a
    pack, re-imports it, and quietly loses the override. Exporting an AUTO
    project would be the mirror failure — it turns "defers to the rollup" into
    "pinned to AUTO", which is a different claim on re-import.
    """
    program = _import_and_schedule(_doc(), owner)
    exported = export_program(program)
    validate_seed(exported)

    by_slug = {p["slug"]: p for p in exported["projects"]}
    assert by_slug["migration-tooling"]["health"] == "AT_RISK"
    assert "health" not in by_slug["platform-core"]
    assert "health" not in by_slug["gtm-readiness"]

    reimported = import_seed(exported, owner=owner, create_users=True, replace=True)
    round_tripped = {p.name: p.health for p in Project.objects.filter(program=reimported)}
    assert round_tripped["Migration Tooling"] == "AT_RISK"
    assert round_tripped["Platform Core"] == "AUTO"
