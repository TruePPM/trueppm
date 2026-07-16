"""Content assertions for the bundled sample seeds (#621, #622).

Pure — no database. Reads each committed fixture and asserts the resource/RBAC
(#621) and risk-register (#622) story an evaluator should feel is actually
present, and that every sample is a valid v2 document.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from trueppm_api.apps.projects.seed import validate_seed

_SEEDS_DIR = (
    Path(__file__).resolve().parents[4]
    / "src"
    / "trueppm_api"
    / "apps"
    / "projects"
    / "fixtures"
    / "seeds"
)

# (fixture stem, min risks, max risks)
SAMPLES = [
    ("aurora-mobile-app", 3, 5),
    ("bayside-civic-center", 10, 15),
    ("helios-crm-replacement", 5, 5),
    ("atlas-platform-launch", 20, 20),
]

ALL_ROLES = {"OWNER", "ADMIN", "SCHEDULER", "MEMBER", "VIEWER"}

# Samples that run sprints — they must exercise the sprint scope/goal vocabulary.
AGILE_SAMPLES = ["aurora-mobile-app", "helios-crm-replacement", "atlas-platform-launch"]


def _load(stem: str) -> dict:
    return json.loads((_SEEDS_DIR / f"{stem}.json").read_text(encoding="utf-8"))


def _events(doc: dict) -> list[dict]:
    return doc.get("events", [])


def _risks(doc: dict) -> list[dict]:
    return [r for p in doc["projects"] for r in p.get("risks", [])] + doc.get("risks", [])


@pytest.mark.parametrize("stem,_min,_max", SAMPLES)
def test_sample_is_valid_v2(stem: str, _min: int, _max: int) -> None:
    doc = _load(stem)
    assert doc["schema_version"] == "2.0"
    validate_seed(doc)  # does not raise


@pytest.mark.parametrize("stem,lo,hi", SAMPLES)
def test_risk_register_meets_target(stem: str, lo: int, hi: int) -> None:
    risks = _risks(_load(stem))
    assert lo <= len(risks) <= hi, f"{stem}: {len(risks)} risks, want {lo}-{hi}"
    # Status mix is exercised, not a single state repeated.
    statuses = {r["status"] for r in risks}
    assert len(statuses) >= 2, f"{stem}: risk statuses are all {statuses}"


def test_atlas_has_schedule_driving_risks_for_monte_carlo() -> None:
    # Several Atlas risks must be high probability*impact so toggling them in the
    # Monte Carlo modal visibly shifts P80 (#622).
    risks = _risks(_load("atlas-platform-launch"))
    driving = [r for r in risks if r["probability"] * r["impact"] >= 12]
    assert len(driving) >= 5


def test_all_five_roles_demonstrated_across_programs() -> None:
    seen: set[str] = set()
    for stem, *_ in SAMPLES:
        seen |= {a["role"] for a in _load(stem).get("accounts", []) if a.get("role")}
    assert seen >= ALL_ROLES


@pytest.mark.parametrize("stem,_min,_max", SAMPLES)
def test_capacity_profiles_present(stem: str, _min: int, _max: int) -> None:
    # Not everyone is full-time: each sample shows < 1.0 capacity somewhere.
    units = {float(r.get("max_units", 1.0)) for r in _load(stem).get("resources", [])}
    assert any(u < 1.0 for u in units), f"{stem}: no part-time/advisor capacity"


@pytest.mark.parametrize(
    "stem", ["aurora-mobile-app", "bayside-civic-center", "helios-crm-replacement"]
)
def test_non_default_calendar_attached_to_a_resource(stem: str) -> None:
    doc = _load(stem)
    non_default = {c["slug"] for c in doc.get("calendars", []) if c.get("working_days", 31) != 31}
    assert non_default, f"{stem}: no non-default working calendar"
    on_resource = {r.get("calendar") for r in doc.get("resources", [])}
    assert non_default & on_resource, f"{stem}: non-default calendar not attached to a resource"


@pytest.mark.parametrize("stem,_min,_max", SAMPLES)
def test_sample_authors_an_event_timeline(stem: str, _min: int, _max: int) -> None:
    # Every sample tells a *life*, not a snapshot: dated reassignments, comments,
    # status moves, and risk-status lifecycles are all authored (#1253), not left
    # to the synthesizer (which only walks status forward by the final assignee).
    actions = {e["action"] for e in _events(_load(stem))}
    required = {"task.assign", "task.comment", "task.status", "risk.status"}
    missing = required - actions
    assert not missing, f"{stem}: event timeline missing {sorted(missing)}"


@pytest.mark.parametrize("stem", AGILE_SAMPLES)
def test_agile_sample_exercises_scope_and_goal_outcomes(stem: str) -> None:
    events = _events(_load(stem))
    actions = {e["action"] for e in events}
    assert {"sprint.scope_inject", "sprint.scope_resolve"} <= actions, (
        f"{stem}: no mid-sprint scope injection + resolution"
    )
    closes = [e for e in events if e["action"] == "sprint.close"]
    assert closes, f"{stem}: no authored sprint close"
    assert all(e.get("goal_outcome") for e in closes), (
        f"{stem}: a closed sprint carries no goal_outcome"
    )


def test_an_agile_sample_rejects_an_injection() -> None:
    # The scope audit isn't always a rubber stamp: at least one sample shows a
    # mid-sprint injection that the team *rejects* and defers (Helios).
    rejected = []
    for stem in AGILE_SAMPLES:
        for e in _events(_load(stem)):
            if e["action"] == "sprint.scope_resolve" and e.get("to") == "REJECTED":
                rejected.append(stem)
    assert rejected, "no sample demonstrates a rejected mid-sprint injection"


# --- coherence invariants (#1784) -------------------------------------------
#
# The audits behind #1784 found the samples contradicting themselves: sprints
# declared ACTIVE weeks after they ended, sprint aggregates unreconciled with
# member points, FS successors finished before their predecessors, in-progress
# tasks with future start dates, and baselines identical to the current plan.
# These invariants lock the *story consistency* of every bundled sample so a
# regenerated fixture cannot silently regress into a museum piece again.

_REL_DATE = re.compile(r"^A([+-]\d+)(!)?(?:T\d{2}:\d{2})?$")

# Statuses meaning "work on this task has started" — an FS successor in any of
# these states requires its predecessor to be COMPLETE.
_STARTED = {"IN_PROGRESS", "REVIEW", "COMPLETE"}


def _rel(value: str | None) -> int | None:
    """Anchor offset of a seed date/timestamp, or None for absolute dates."""
    if not isinstance(value, str):
        return None
    m = _REL_DATE.match(value)
    return int(m.group(1)) if m else None


def _members(project: dict, sprint_slug: str) -> list[dict]:
    return [t for t in project["tasks"] if t.get("sprint") == sprint_slug]


def _task_index(doc: dict) -> dict[tuple[str, str], dict]:
    return {(p["slug"], t["wbs_path"]): t for p in doc["projects"] for t in p.get("tasks", [])}


def _resolve_ref(ref: str, project_slug: str) -> tuple[str, str]:
    if ":" in ref:
        slug, _, wbs = ref.partition(":")
        return slug, wbs
    return project_slug, ref


@pytest.mark.parametrize("stem,_min,_max", SAMPLES)
def test_sprint_states_track_the_anchor(stem: str, _min: int, _max: int) -> None:
    # The demo must land the evaluator in a live sprint: exactly one ACTIVE
    # sprint per sprint-bearing project, straddling import day; COMPLETED
    # sprints ended in the past; PLANNED sprints start in the future.
    for project in _load(stem)["projects"]:
        sprints = project.get("sprints", [])
        if not sprints:
            continue
        active = [s for s in sprints if s["state"] == "ACTIVE"]
        assert len(active) == 1, (
            f"{stem}/{project['slug']}: {len(active)} ACTIVE sprints, want exactly 1"
        )
        for sprint in sprints:
            start, finish = _rel(sprint["start_date"]), _rel(sprint["finish_date"])
            assert start is not None and finish is not None, (
                f"{stem}/{sprint['slug']}: sprint dates must be anchor-relative"
            )
            if sprint["state"] == "ACTIVE":
                assert start <= 0 <= finish, (
                    f"{stem}/{sprint['slug']}: ACTIVE sprint ({start}..{finish}) "
                    "does not straddle import day"
                )
            elif sprint["state"] == "COMPLETED":
                assert finish < 0, f"{stem}/{sprint['slug']}: COMPLETED sprint ends in the future"
            elif sprint["state"] == "PLANNED":
                assert start > 0, f"{stem}/{sprint['slug']}: PLANNED sprint already started"


@pytest.mark.parametrize("stem,_min,_max", SAMPLES)
def test_sprint_points_reconcile_with_member_stories(stem: str, _min: int, _max: int) -> None:
    # The velocity chart (sprint aggregates) and the board (member stories) must
    # tell the same story. completed == sum of COMPLETE member points; committed
    # may exceed completed only by carryover, never the reverse; capacity bounds
    # commitment; a PLANNED sprint is not silently over-stuffed.
    for project in _load(stem)["projects"]:
        for sprint in project.get("sprints", []):
            members = _members(project, sprint["slug"])
            member_points = sum(t.get("story_points") or 0 for t in members)
            committed = sprint.get("committed_points")
            completed = sprint.get("completed_points")
            capacity = sprint.get("capacity_points")
            label = f"{stem}/{sprint['slug']}"
            if sprint["state"] == "COMPLETED":
                done = sum(
                    t.get("story_points") or 0 for t in members if t.get("status") == "COMPLETE"
                )
                assert completed == done, (
                    f"{label}: completed_points={completed} but member COMPLETE points={done}"
                )
                assert committed is not None and committed >= completed, (
                    f"{label}: committed {committed} < completed {completed}"
                )
                not_done = [t["wbs_path"] for t in members if t.get("status") != "COMPLETE"]
                assert not not_done, f"{label}: COMPLETED sprint has unfinished members {not_done}"
            if sprint["state"] == "ACTIVE":
                assert committed is not None, f"{label}: ACTIVE sprint has no committed_points"
                statuses = {t.get("status") for t in members}
                assert len(statuses) >= 2, (
                    f"{label}: ACTIVE sprint members all {statuses} — no mid-sprint movement"
                )
            if sprint["state"] == "PLANNED" and capacity is not None:
                assert member_points <= capacity, (
                    f"{label}: PLANNED sprint holds {member_points} pts over capacity {capacity}"
                )
            if committed is not None and capacity is not None:
                assert committed <= capacity, (
                    f"{label}: committed {committed} > capacity {capacity}"
                )


@pytest.mark.parametrize("stem,_min,_max", SAMPLES)
def test_fs_dependencies_consistent_with_statuses(stem: str, _min: int, _max: int) -> None:
    # A finish-to-start successor cannot have started while its predecessor is
    # unfinished — including across projects. (Only FS is directional enough to
    # assert from static statuses; SS/FF/SF orderings need computed dates.)
    doc = _load(stem)
    index = _task_index(doc)
    for project in doc["projects"]:
        for dep in project.get("dependencies", []):
            if dep["dep_type"] != "FS":
                continue
            pred = index.get(_resolve_ref(dep["predecessor"], project["slug"]))
            succ = index.get(_resolve_ref(dep["successor"], project["slug"]))
            assert pred is not None and succ is not None
            if succ.get("status") in _STARTED and "status" in pred:
                assert pred["status"] == "COMPLETE", (
                    f"{stem}: {dep['successor']} is {succ['status']} but FS predecessor "
                    f"{dep['predecessor']} is {pred['status']}"
                )


@pytest.mark.parametrize("stem,_min,_max", SAMPLES)
def test_no_started_task_with_future_start(stem: str, _min: int, _max: int) -> None:
    for project in _load(stem)["projects"]:
        for task in project["tasks"]:
            offset = _rel(task.get("planned_start"))
            if offset is not None and task.get("status") in _STARTED:
                assert offset <= 0, (
                    f"{stem}:{task['wbs_path']} is {task['status']} but starts A{offset:+d}"
                )


@pytest.mark.parametrize("stem,_min,_max", SAMPLES)
def test_phase_parents_are_pure_rollups(stem: str, _min: int, _max: int) -> None:
    # Mirrors the #1753 API locks: a task with structural children is a phase —
    # a pure rollup that carries no status/estimate/assignee/sprint/points.
    for project in _load(stem)["projects"]:
        paths = {t["wbs_path"] for t in project["tasks"]}
        parents = {
            t["wbs_path"]: t
            for t in project["tasks"]
            if any(p != t["wbs_path"] and p.startswith(t["wbs_path"] + ".") for p in paths)
        }
        for wbs, task in parents.items():
            forbidden = {
                "status",
                "estimate",
                "assignee",
                "sprint",
                "story_points",
                "remaining_points",
                "percent_complete",
            } & task.keys()
            assert not forbidden, (
                f"{stem}:{wbs} is a phase (has children) but carries {sorted(forbidden)}"
            )


@pytest.mark.parametrize("stem,_min,_max", SAMPLES)
def test_baselines_show_variance(stem: str, _min: int, _max: int) -> None:
    # A baseline identical to the current plan renders a flat variance story —
    # the whole point of capturing one is to see drift.
    for project in _load(stem)["projects"]:
        for baseline in project.get("baselines", []):
            tasks = {t["wbs_path"]: t for t in project["tasks"]}
            drifted = [
                row["task"]
                for row in baseline["tasks"]
                if (
                    ("start" in row and row["start"] != tasks[row["task"]].get("planned_start"))
                    or ("duration" in row and row["duration"] != tasks[row["task"]].get("duration"))
                    or (
                        "story_points" in row
                        and row["story_points"] != tasks[row["task"]].get("story_points")
                    )
                )
            ]
            assert drifted, (
                f"{stem}/{baseline['name']}: baseline identical to current plan — no variance"
            )


@pytest.mark.parametrize("stem,_min,_max", SAMPLES)
def test_timeline_reaches_the_present(stem: str, _min: int, _max: int) -> None:
    # The demo must feel alive on import day: no forward-dated beats, and the
    # latest authored beat lands within the final week before "today".
    offsets = [_rel(e["at"]) for e in _events(_load(stem))]
    assert offsets and all(o is not None for o in offsets)
    assert max(o for o in offsets if o is not None) >= -5, (
        f"{stem}: newest event is stale — demo goes silent before import day"
    )
    assert all(o <= 0 for o in offsets if o is not None), f"{stem}: forward-dated event"


@pytest.mark.parametrize("stem", AGILE_SAMPLES)
def test_sprint_samples_tell_a_retro_story(stem: str) -> None:
    actions = {e["action"] for e in _events(_load(stem))}
    assert "retro.action" in actions, f"{stem}: no retro action items after closed sprints"


def test_a_sample_promotes_a_retro_action() -> None:
    promoted = [
        stem
        for stem in AGILE_SAMPLES
        if any(e["action"] == "retro.promote" for e in _events(_load(stem)))
    ]
    assert promoted, "no sample demonstrates promoting a retro action to the backlog"


def test_atlas_hybrid_project_runs_sprints() -> None:
    # The HYBRID project must actually be hybrid: a gated waterfall lane AND a
    # sprint cadence over its flow lane — not a decorative static backlog.
    doc = _load("atlas-platform-launch")
    gtm = next(p for p in doc["projects"] if p["methodology"] == "HYBRID")
    assert len(gtm.get("sprints", [])) >= 2, "atlas: hybrid project has no sprint cadence"
    assert any(t.get("estimate") for t in gtm["tasks"]), "atlas: hybrid project lost its gated lane"


def test_atlas_uses_on_hold_for_gated_work() -> None:
    tasks = [t for p in _load("atlas-platform-launch")["projects"] for t in p["tasks"]]
    assert any(t.get("status") == "ON_HOLD" for t in tasks), (
        "atlas: nothing ON_HOLD — the cross-project gate story has no visible blocked work"
    )


def test_aurora_has_a_real_unassigned_backlog() -> None:
    proj = _load("aurora-mobile-app")["projects"][0]
    backlog = [
        t
        for t in proj["tasks"]
        if t.get("type") == "story" and not t.get("sprint") and t.get("story_points")
    ]
    assert len(backlog) >= 3, "aurora: every story is sprint-assigned — the Backlog view is empty"


def test_bayside_exercises_lag_and_all_dep_types() -> None:
    # Bayside is a two-project waterfall PROGRAM (#2003): the four dependency types
    # and both lead/lag are exercised across the program, not within one project —
    # in particular the negative-lag lead lives on a cross-project MEP edge.
    doc = _load("bayside-civic-center")
    deps = [d for p in doc["projects"] for d in p.get("dependencies", [])]
    assert {d["dep_type"] for d in deps} == {"FS", "SS", "FF", "SF"}
    assert any((d.get("lag") or 0) > 0 for d in deps), "bayside: no positive lag anywhere"
    assert any((d.get("lag") or 0) < 0 for d in deps), "bayside: no lead (negative lag) anywhere"
    # The program must actually be cross-project: at least one accepted edge whose
    # predecessor is qualified with a different project slug.
    cross = [d for d in deps if ":" in str(d.get("predecessor", ""))]
    assert cross, "bayside: no cross-project dependency — the two-waterfall story is missing"


def test_bayside_is_a_two_waterfall_program() -> None:
    doc = _load("bayside-civic-center")
    projects = doc["projects"]
    assert len(projects) == 2, f"bayside: {len(projects)} projects, want a two-project program"
    assert all(p["methodology"] == "WATERFALL" for p in projects), (
        "bayside: both projects must be waterfall"
    )


def test_bayside_demonstrates_a_rebaseline() -> None:
    # The change-order story needs an original baseline preserved (superseded) plus
    # an active rebaseline — the plan-vs-plan record a claim relies on.
    doc = _load("bayside-civic-center")
    baselines = [b for p in doc["projects"] for b in p.get("baselines", [])]
    active = [b for b in baselines if b.get("is_active")]
    superseded = [b for b in baselines if not b.get("is_active")]
    assert superseded, "bayside: no superseded baseline — the rebaseline story is missing"
    assert active, "bayside: no active baseline"
    # Some project carries both an active and a superseded baseline (the rebaseline).
    by_project = {}
    for p in doc["projects"]:
        states = {b.get("is_active", False) for b in p.get("baselines", [])}
        by_project[p["slug"]] = states
    assert any(states >= {True, False} for states in by_project.values()), (
        "bayside: no single project holds both a superseded and an active baseline"
    )


def test_helios_populates_the_program_rollup() -> None:
    # Without a baseline the rollup's variance KPIs render blank, without
    # milestones milestone_health is "unknown", and without forecast_history the
    # trend chart is empty — the hybrid tour must light all three up.
    proj = _load("helios-crm-replacement")["projects"][0]
    assert proj.get("baselines"), "helios: no baseline — variance KPIs blank"
    assert any(t.get("is_milestone") for t in proj["tasks"]), "helios: no milestones"
    assert proj.get("forecast_history"), "helios: no forecast_history — trend chart empty"
    assert any(s.get("target_milestone") for s in proj.get("sprints", [])), (
        "helios: no sprint→milestone bridge"
    )


@pytest.mark.parametrize("stem,_min,_max", SAMPLES)
def test_in_flight_percentages_are_varied(stem: str, _min: int, _max: int) -> None:
    # Uniform percent_complete across a project's in-progress tasks reads as
    # synthetic; real execution fronts are ragged.
    for project in _load(stem)["projects"]:
        pcts = [
            t["percent_complete"]
            for t in project["tasks"]
            if t.get("status") == "IN_PROGRESS" and "percent_complete" in t
        ]
        if len(pcts) >= 3:
            assert len(set(pcts)) >= 2, (
                f"{stem}/{project['slug']}: all in-progress tasks at {pcts[0]}%"
            )


@pytest.mark.parametrize("stem", AGILE_SAMPLES)
def test_in_flight_sprint_stories_carry_remaining_points(stem: str) -> None:
    # Burndown should read mid-descent on import day, not a cliff of synthesized
    # completions: at least one active-sprint story is partially burned.
    for project in _load(stem)["projects"]:
        actives = [s["slug"] for s in project.get("sprints", []) if s["state"] == "ACTIVE"]
        if not actives:
            continue
        members = _members(project, actives[0])
        partially_burned = [
            t
            for t in members
            if t.get("remaining_points") is not None
            and t.get("story_points")
            and 0 < t["remaining_points"] < t["story_points"]
        ]
        assert partially_burned, (
            f"{stem}/{project['slug']}: no active-sprint story is partially burned"
        )


def test_agile_only_sample_groups_stories_under_epics() -> None:
    # The agile-only flagship (#617) must read like a real backlog — stories
    # grouped under epics, each carrying points — not a flat list. Atlas Platform
    # Core also ships epics; Aurora is the *dedicated* agile-only showcase, so the
    # epic → story hierarchy an agile team plans in is asserted here against the
    # #613 "golden" bar.
    proj = _load("aurora-mobile-app")["projects"][0]
    tasks = proj["tasks"]
    epics = {t["wbs_path"] for t in tasks if t.get("type") == "epic"}
    stories = [t for t in tasks if t.get("type") == "story"]
    assert len(epics) >= 3, f"aurora: {len(epics)} epics — backlog is not grouped"
    assert stories, "aurora: no stories"
    assert all(s.get("story_points") for s in stories), "aurora: a story has no points"
    unparented = [s["wbs_path"] for s in stories if s.get("parent_epic") not in epics]
    assert not unparented, f"aurora: stories not rolled up to an epic: {unparented}"
