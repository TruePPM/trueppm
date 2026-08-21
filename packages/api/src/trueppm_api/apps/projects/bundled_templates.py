"""The starter templates that ship with the install (#2909, ADR-0789).

Why these exist at all: **Template** is one of three peer ways in on the Start
sheet, and on every fresh install it was empty — the only row-creation site was
the publish action, and no publish UI existed. A way-in that is empty on first
contact is worse than no way-in, because the user has already chosen it.

They also carry the product's own argument. `createdProjectDestination` sends an
**AGILE + template** project straight to a seeding Product Backlog rather than to
an empty Schedule, which is the "this is a sprint tool, not a Gantt with a board
bolted on" signal a delivery lead is looking for — and until now that path could
not be walked, because it needed a template that did not exist.

Deliberately small. A starter is a **shape to argue with**, not a plan: enough
structure that the phases and the dependency spine are visible, few enough rows
that deleting the half that does not apply is a minute's work. A 140-row starter
reads as somebody else's project.

They are `COMMUNITY` provenance, which is what the gallery labels "Bundled" and
sorts last — on a workspace that has published its own shapes, the local ones are
the ones worth reading first.
"""

from __future__ import annotations

from typing import Any

#: Names are the identity: the seeding migration is idempotent on them, so
#: renaming one here creates a second row rather than editing the first.
SCRUM_TEAM = "Scrum product team"
STAGE_GATE = "Stage-gate delivery"
HYBRID_RELEASE = "Regulated release"

BUNDLED_TEMPLATE_NAMES = (SCRUM_TEAM, STAGE_GATE, HYBRID_RELEASE)


def _node(
    ref: str,
    name: str,
    path: str,
    *,
    duration: int | None = 5,
    milestone: bool = False,
    mode: str = "waterfall",
    governance: str = "flow",
    task_type: str = "task",
    notes: str = "",
) -> dict[str, Any]:
    return {
        "ref": ref,
        "name": name,
        "wbs_path": path,
        "duration": 0 if milestone else duration,
        "is_milestone": milestone,
        "delivery_mode": "milestone" if milestone else mode,
        "governance_class": governance,
        "type": task_type,
        "is_subtask": False,
        "notes": notes,
    }


def _document(
    methodology: str,
    tasks: list[dict[str, Any]],
    dependencies: list[dict[str, Any]],
    *,
    sprint_length: int | None = None,
) -> dict[str, Any]:
    """Wrap nodes in the structure envelope `validate_structure` accepts.

    ``extracted_at`` is deliberately absent: these were not extracted from any
    project, and stamping a time would imply a provenance they do not have. The
    field is optional in the envelope for exactly this case.
    """
    carries = ["structure"]
    if dependencies:
        carries.append("dependencies")
    if any(t["duration"] for t in tasks):
        carries.append("durations")
    if any(t["is_milestone"] for t in tasks):
        carries.append("milestones")
    carries.append("delivery_modes")
    if sprint_length:
        carries.append("sprint_length")
    return {
        "version": 1,
        "methodology": methodology,
        "sprint_length_days": sprint_length,
        "tasks": tasks,
        "dependencies": dependencies,
        "carries": carries,
    }


def _fs(pred: str, succ: str, lag: int = 0) -> dict[str, Any]:
    return {"predecessor": pred, "successor": succ, "dep_type": "FS", "lag": lag}


def scrum_product_team() -> dict[str, Any]:
    """A squad's first two sprints, plus the discovery that precedes them."""
    tasks = [
        _node("dsc", "Discovery", "1", duration=10, mode="scrum"),
        _node("dsc-1", "Frame the problem and the users", "1.1", duration=3, mode="scrum"),
        _node("dsc-2", "Shape the first slice", "1.2", duration=4, mode="scrum"),
        _node("dsc-3", "Size and order the backlog", "1.3", duration=3, mode="scrum"),
        _node("rdy", "Backlog ready", "1.4", milestone=True),
        _node("s1", "Sprint 1 — walking skeleton", "2", duration=10, mode="scrum"),
        _node("s1-1", "Thinnest end-to-end path", "2.1", duration=5, mode="scrum"),
        _node("s1-2", "Make it demonstrable", "2.2", duration=3, mode="scrum"),
        _node("s1-3", "Sprint review and retro", "2.3", duration=1, mode="scrum"),
        _node("s2", "Sprint 2 — the first real slice", "3", duration=10, mode="scrum"),
        _node("s2-1", "Build the slice", "3.1", duration=6, mode="scrum"),
        _node("s2-2", "Harden and instrument", "3.2", duration=3, mode="scrum"),
        _node("s2-3", "Sprint review and retro", "3.3", duration=1, mode="scrum"),
    ]
    deps = [_fs("dsc", "s1"), _fs("s1", "s2"), _fs("dsc-3", "rdy")]
    return _document("AGILE", tasks, deps, sprint_length=10)


def stage_gate_delivery() -> dict[str, Any]:
    """Five gated phases with a hold point at each — the classic waterfall spine."""
    tasks = [
        _node("ini", "Initiate", "1", duration=10, governance="gated"),
        _node("ini-1", "Charter and scope", "1.1", duration=5, governance="gated"),
        _node("ini-2", "Stakeholders and constraints", "1.2", duration=5, governance="gated"),
        _node("g1", "Gate 1 — approved to plan", "1.3", milestone=True, governance="gated"),
        _node("pln", "Plan", "2", duration=15, governance="gated"),
        _node("pln-1", "Work breakdown", "2.1", duration=7, governance="gated"),
        _node("pln-2", "Schedule and resource plan", "2.2", duration=8, governance="gated"),
        _node("g2", "Gate 2 — approved to execute", "2.3", milestone=True, governance="gated"),
        _node("exe", "Execute", "3", duration=40, governance="gated"),
        _node("exe-1", "Build", "3.1", duration=25, governance="gated"),
        _node("exe-2", "Integrate", "3.2", duration=15, governance="gated"),
        _node("ver", "Verify", "4", duration=15, governance="gated"),
        _node("ver-1", "Test and defect burn-down", "4.1", duration=10, governance="gated"),
        _node("ver-2", "Acceptance", "4.2", duration=5, governance="gated"),
        _node("g3", "Gate 3 — approved to release", "4.3", milestone=True, governance="gated"),
        _node("clo", "Close", "5", duration=10, governance="gated"),
        _node("clo-1", "Handover and documentation", "5.1", duration=6, governance="gated"),
        _node("clo-2", "Lessons learned", "5.2", duration=4, governance="gated"),
        _node("g4", "Gate 4 — closed", "5.3", milestone=True, governance="gated"),
    ]
    deps = [
        _fs("ini", "pln"),
        _fs("pln", "exe"),
        _fs("exe", "ver"),
        _fs("ver", "clo"),
        _fs("ini-2", "g1"),
        _fs("pln-2", "g2"),
        _fs("ver-2", "g3"),
        _fs("clo-2", "g4"),
        _fs("exe-1", "exe-2"),
    ]
    return _document("WATERFALL", tasks, deps)


def regulated_release() -> dict[str, Any]:
    """A gated validation branch beside a sprint-driven build branch.

    The shape hybrid exists for: the build runs in sprints and the evidence trail
    runs on gates, and they converge once rather than interleaving.
    """
    tasks = [
        _node("pre", "Preparation", "1", duration=10, governance="hybrid"),
        _node("pre-1", "Scope and regulatory basis", "1.1", duration=5, governance="gated"),
        _node("pre-2", "Backlog and release goal", "1.2", duration=5, mode="scrum"),
        _node("bld", "Build", "2", duration=30, mode="scrum"),
        _node("bld-1", "Sprint 1", "2.1", duration=10, mode="scrum"),
        _node("bld-2", "Sprint 2", "2.2", duration=10, mode="scrum"),
        _node("bld-3", "Sprint 3", "2.3", duration=10, mode="scrum"),
        _node("val", "Validation", "3", duration=20, governance="gated"),
        _node("val-1", "Protocol and traceability", "3.1", duration=8, governance="gated"),
        _node("val-2", "Execute and record evidence", "3.2", duration=12, governance="gated"),
        _node("gv", "Validation gate", "3.3", milestone=True, governance="gated"),
        _node("rel", "Release", "4", duration=8, governance="gated"),
        _node("rel-1", "Release notes and sign-off", "4.1", duration=5, governance="gated"),
        _node("rel-2", "Deploy", "4.2", duration=3, governance="gated"),
        _node("gr", "Released", "4.3", milestone=True, governance="gated"),
    ]
    deps = [
        _fs("pre", "bld"),
        _fs("pre-1", "val-1"),
        _fs("bld-1", "bld-2"),
        _fs("bld-2", "bld-3"),
        _fs("bld", "val-2"),
        _fs("val-2", "gv"),
        _fs("gv", "rel"),
        _fs("rel-2", "gr"),
    ]
    return _document("HYBRID", tasks, deps, sprint_length=10)


#: ``(name, description, structure_builder)`` — one starter per methodology, so
#: whichever way in a new team picks, the gallery has something for it.
BUNDLED_TEMPLATES: tuple[tuple[str, str, Any], ...] = (
    (
        SCRUM_TEAM,
        "Discovery, then two sprints that build a walking skeleton before a real "
        "slice. For a squad with no history yet.",
        scrum_product_team,
    ),
    (
        STAGE_GATE,
        "Five gated phases with a hold point at each. Heavy on milestones, light "
        "on tasks — the spine, not the plan.",
        stage_gate_delivery,
    ),
    (
        HYBRID_RELEASE,
        "A gated validation branch beside a sprint-driven build branch, converging "
        "once at release. For work that ships iteratively and must evidence itself.",
        regulated_release,
    ),
)
