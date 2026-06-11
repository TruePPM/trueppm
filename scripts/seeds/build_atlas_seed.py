#!/usr/bin/env python3
"""Generate the "Atlas Platform Launch" hybrid-large sample seed (issue #620).

This is a developer tool, NOT run at runtime. It emits a committed, canonical
JSON seed file (validated against ADR-0109's schema) that the sample loader
(#375) ships. Re-run it to regenerate the fixture after a schema change:

    python scripts/seeds/build_atlas_seed.py

The sample is the launch demo: one program, three projects spanning the
methodology mix (agile / waterfall / hybrid), cross-project dependencies,
three-point estimates feeding program Monte Carlo, baselines for variance, a
populated risk register, and a realistic resource roster across two calendars.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Anchor-relative dates (ADR-0114, seed v2). Every date is emitted as an offset
# from the import-day anchor "A", so the demo always reads as a program in flight
# rather than a fixed-date museum piece — the importer resolves "A" to today.
# ANCHOR_OFFSET places "today" partway through the program: day-0 kickoff work is
# ~120 days in the past, late GTM work is still ahead. The event-replay importer
# then synthesizes the history (backdated status moves, burndown) up to "today".
ANCHOR_OFFSET = 120


def d(offset_days: int) -> str:
    return f"A{offset_days - ANCHOR_OFFSET:+d}"


# --- people & capacity -----------------------------------------------------

ACCOUNTS = [
    ("alex", "alex", "Alex Rivera", "alex@atlas.example", "OWNER"),
    ("priya", "priya", "Priya Nair", "priya@atlas.example", "ADMIN"),
    ("jordan", "jordan", "Jordan Blake", "jordan@atlas.example", "ADMIN"),
    ("sam", "sam", "Sam Okafor", "sam@atlas.example", "SCHEDULER"),
    ("mei", "mei", "Mei Tanaka", "mei@atlas.example", "MEMBER"),
    ("diego", "diego", "Diego Santos", "diego@atlas.example", "MEMBER"),
    ("nadia", "nadia", "Nadia Hassan", "nadia@atlas.example", "MEMBER"),
    ("tom", "tom", "Tom Becker", "tom@atlas.example", "MEMBER"),
    ("yuki", "yuki", "Yuki Sato", "yuki@atlas.example", "MEMBER"),
    ("omar", "omar", "Omar Aziz", "omar@atlas.example", "MEMBER"),
    ("lena", "lena", "Lena Vogel", "lena@atlas.example", "MEMBER"),
    ("raj", "raj", "Raj Mehta", "raj@atlas.example", "MEMBER"),
    ("clara", "clara", "Clara Mendes", "clara@atlas.example", "MEMBER"),
    ("ivan", "ivan", "Ivan Petrov", "ivan@atlas.example", "MEMBER"),
    ("ada", "ada", "Ada Boyega", "ada@atlas.example", "VIEWER"),
]

# resource slug -> (name account, job role, max_units, calendar slug)
RESOURCES = [
    ("alex", "Program Manager", 0.5, "standard"),
    ("priya", "Engineering Lead", 1.0, "standard"),
    ("jordan", "Product Owner", 1.0, "standard"),
    ("sam", "Project Scheduler", 1.0, "standard"),
    ("mei", "Senior Engineer", 1.0, "standard"),
    ("diego", "Senior Engineer", 1.0, "standard"),
    ("nadia", "Engineer", 1.0, "standard"),
    ("tom", "Engineer", 1.0, "standard"),
    ("yuki", "Data Engineer", 1.0, "standard"),
    ("omar", "Data Engineer", 1.0, "standard"),
    ("lena", "QA Engineer", 1.0, "standard"),
    ("raj", "DevOps Engineer", 0.8, "standard"),
    ("clara", "Content Strategist", 1.0, "gtm-regional"),
    ("ivan", "Solutions Architect", 0.2, "standard"),
    ("ada", "Executive Sponsor", 0.1, "standard"),
]

CALENDARS = [
    {
        "slug": "standard",
        "name": "Atlas Standard (5-day)",
        "working_days": 31,
        "hours_per_day": 8.0,
    },
    # GTM team observes a regional holiday calendar (still Mon-Fri here, but a
    # distinct calendar so the demo shows calendar assignment per project).
    {
        "slug": "gtm-regional",
        "name": "GTM Regional (5-day, holidays)",
        "working_days": 31,
        "hours_per_day": 7.5,
    },
]


def three_point(most_likely: int) -> dict:
    """A plausible optimistic/most-likely/pessimistic spread around a midpoint."""
    optimistic = max(1, round(most_likely * 0.7))
    pessimistic = round(most_likely * 1.8)
    return {
        "optimistic": optimistic,
        "most_likely": most_likely,
        "pessimistic": pessimistic,
    }


# --- Project 1: Platform Core (agile) --------------------------------------

PC_EPICS = [
    (
        "Identity & access",
        [
            "SSO login",
            "MFA enrollment",
            "Role management",
            "Session hardening",
            "Audit log",
        ],
    ),
    (
        "Core API",
        [
            "Tenant model",
            "Rate limiting",
            "Webhook delivery",
            "API key rotation",
            "OpenAPI export",
        ],
    ),
    (
        "Data platform",
        [
            "Event pipeline",
            "Warehouse sync",
            "Schema registry",
            "Backfill tool",
            "PII scrubber",
        ],
    ),
    (
        "Billing",
        [
            "Plan catalog",
            "Usage metering",
            "Invoice render",
            "Dunning flow",
            "Tax engine",
        ],
    ),
    (
        "Notifications",
        ["Email service", "In-app inbox", "Digest scheduler", "Preference center"],
    ),
]
PC_DEVS = ["mei", "diego", "nadia", "tom", "yuki", "omar"]


def build_platform_core() -> dict:
    tasks: list[dict] = []
    sprints: list[dict] = []

    # 8 two-week sprints: 4 completed, 2 active, 2 planned.
    states = [
        "COMPLETED",
        "COMPLETED",
        "COMPLETED",
        "COMPLETED",
        "ACTIVE",
        "ACTIVE",
        "PLANNED",
        "PLANNED",
    ]
    velocities = [28, 31, 26, 34, None, None, None, None]  # completed points
    for i, (state, vel) in enumerate(zip(states, velocities)):
        start = i * 14
        committed = 32
        sprint = {
            "slug": f"pc-sprint-{i + 1}",
            "name": f"Sprint {i + 1}",
            "goal": f"Increment {i + 1} of the platform core.",
            "state": state,
            "start_date": d(start),
            "finish_date": d(start + 13),
            "capacity_points": 34,
        }
        if state in ("COMPLETED", "ACTIVE"):
            sprint["committed_points"] = committed
        if state == "COMPLETED":
            sprint["completed_points"] = vel
        sprints.append(sprint)

    # Epics as grouping nodes (excluded from CPM); stories beneath them.
    epic_paths: dict[str, str] = {}
    for e_idx, (epic_name, stories) in enumerate(PC_EPICS, start=1):
        epic_wbs = str(e_idx)
        epic_paths[epic_name] = epic_wbs
        tasks.append(
            {
                "wbs_path": epic_wbs,
                "name": epic_name,
                "type": "epic",
                "delivery_mode": "scrum",
                "governance_class": "flow",
            }
        )

    # Distribute stories across sprints; assign points + status by sprint state.
    sprint_of_state = {i: s for i, s in enumerate(states)}
    story_counter = 0
    points_cycle = [3, 5, 8, 5, 3, 8, 2, 13]
    for e_idx, (epic_name, stories) in enumerate(PC_EPICS, start=1):
        for s_idx, story in enumerate(stories, start=1):
            sprint_idx = story_counter % 8
            state = sprint_of_state[sprint_idx]
            status = {
                "COMPLETED": "COMPLETE",
                "ACTIVE": "IN_PROGRESS",
                "PLANNED": "BACKLOG",
            }[state]
            pct = {"COMPLETE": 100.0, "IN_PROGRESS": 45.0, "BACKLOG": 0.0}[status]
            tasks.append(
                {
                    "wbs_path": f"{e_idx}.{s_idx}",
                    "name": story,
                    "type": "story",
                    "status": status,
                    "percent_complete": pct,
                    "story_points": points_cycle[story_counter % len(points_cycle)],
                    "parent_epic": epic_paths[epic_name],
                    "assignee": PC_DEVS[story_counter % len(PC_DEVS)],
                    "sprint": f"pc-sprint-{sprint_idx + 1}",
                    "delivery_mode": "scrum",
                    "governance_class": "flow",
                }
            )
            story_counter += 1

    # Public-launch milestone for Platform Core (target of last sprint).
    tasks.append(
        {
            "wbs_path": "9",
            "name": "Platform Core GA",
            "is_milestone": True,
            "delivery_mode": "milestone",
            "planned_start": d(8 * 14),
        }
    )
    sprints[-1]["target_milestone"] = "9"

    return {
        "slug": "platform-core",
        "name": "Platform Core",
        "description": "The agile build stream — the platform itself, delivered sprint by sprint.",
        "methodology": "AGILE",
        "start_date": d(0),
        "calendar": "standard",
        "default_view": "BOARD",
        "agile_features": True,
        "board_columns": ["Backlog", "To Do", "In Progress", "In Review", "Done"],
        "tasks": tasks,
        "sprints": sprints,
        "baselines": [
            {
                "name": "Sprint-0 baseline",
                "is_active": True,
                "tasks": [
                    {"task": t["wbs_path"], "story_points": t.get("story_points")}
                    for t in tasks
                    if t.get("type") == "story"
                ][:20],
            }
        ],
        "risks": [
            {
                "slug": "pc-velocity-dip",
                "title": "Velocity dip after team expansion",
                "description": "Onboarding three new engineers mid-program may dip velocity for 2 sprints.",
                "status": "MITIGATING",
                "probability": 3,
                "impact": 3,
                "category": "ORGANIZATIONAL",
                "response": "MITIGATE",
                "owner": "priya",
                "tasks": ["2.1"],
            },
            {
                "slug": "pc-scope-creep",
                "title": "Billing scope creep",
                "description": "Tax-engine requirements are still firming up and may expand the billing epic.",
                "status": "OPEN",
                "probability": 4,
                "impact": 3,
                "category": "PROJECT_MANAGEMENT",
                "response": "MITIGATE",
                "owner": "jordan",
                "tasks": ["4.5"],
            },
        ],
    }


# --- Project 2: Migration Tooling (waterfall) ------------------------------

# (phase name, [(task, most_likely_days, [dep wbs within project], dep_type)])
MT_PHASES = [
    (
        "Assess",
        [
            ("Inventory legacy schemas", 5, [], None),
            ("Profile data quality", 4, ["1.1"], "FS"),
            ("Map field semantics", 6, ["1.1"], "SS"),
            ("Risk & cutover plan", 3, ["1.2", "1.3"], "FS"),
        ],
    ),
    (
        "Build",
        [
            ("ETL framework", 8, ["1.4"], "FS"),
            ("Schema transformer", 7, ["2.1"], "SS"),
            ("Validation harness", 6, ["2.1"], "FS"),
            ("Reconciliation reports", 4, ["2.3"], "FS"),
        ],
    ),
    (
        "Migrate",
        [
            ("Dry-run migration", 5, ["2.2", "2.3"], "FS"),
            ("Performance tuning", 4, ["3.1"], "FS"),
            ("Delta sync", 6, ["3.1"], "SS"),
            ("Production rehearsal", 5, ["3.2", "3.3"], "FS"),
        ],
    ),
    (
        "Validate",
        [
            ("Row-count reconciliation", 3, ["3.4"], "FS"),
            ("Business sign-off pack", 4, ["4.1"], "FS"),
            ("Rollback drill", 3, ["3.4"], "FS"),
        ],
    ),
    (
        "Cutover",
        [
            ("Freeze window prep", 2, ["4.2", "4.3"], "FS"),
            ("Final cutover", 3, ["5.1"], "FS"),
            ("Decommission legacy", 4, ["5.2"], "FS"),
        ],
    ),
]
MT_DEVS = ["yuki", "omar", "raj", "tom"]


def build_migration_tooling() -> dict:
    tasks: list[dict] = []
    deps: list[dict] = []
    baseline_rows: list[dict] = []
    cursor = 0  # working-day cursor for planned_start

    for p_idx, (phase, items) in enumerate(MT_PHASES, start=1):
        tasks.append(
            {
                "wbs_path": str(p_idx),
                "name": phase,
                "type": "task",
                "governance_class": "gated",
                "delivery_mode": "waterfall",
            }
        )
        for t_idx, (name, ml, dep_paths, dep_type) in enumerate(items, start=1):
            wbs = f"{p_idx}.{t_idx}"
            start = cursor
            done = p_idx <= 2  # first two phases complete
            in_progress = p_idx == 3
            status = (
                "COMPLETE"
                if done
                else ("IN_PROGRESS" if in_progress else "NOT_STARTED")
            )
            pct = 100.0 if done else (40.0 if in_progress else 0.0)
            tasks.append(
                {
                    "wbs_path": wbs,
                    "name": name,
                    "type": "task",
                    "status": status,
                    "percent_complete": pct,
                    "duration": ml,
                    "planned_start": d(start * 2),  # spread along the calendar
                    "estimate": three_point(ml),
                    "assignee": MT_DEVS[(p_idx + t_idx) % len(MT_DEVS)],
                    "governance_class": "gated",
                    "delivery_mode": "waterfall",
                }
            )
            baseline_rows.append(
                {
                    "task": wbs,
                    "start": d(start * 2),
                    "finish": d(start * 2 + ml),
                    "duration": ml,
                }
            )
            for dep in dep_paths:
                deps.append(
                    {
                        "predecessor": dep,
                        "successor": wbs,
                        "dep_type": dep_type,
                        "lag": 0,
                    }
                )
            cursor += ml

    # Cutover milestone.
    tasks.append(
        {
            "wbs_path": "6",
            "name": "Migration complete",
            "is_milestone": True,
            "delivery_mode": "milestone",
            "planned_start": d(cursor * 2),
        }
    )
    deps.append({"predecessor": "5.3", "successor": "6", "dep_type": "FS", "lag": 0})

    return {
        "slug": "migration-tooling",
        "name": "Migration Tooling",
        "description": "The waterfall stream — CPM-scheduled data migration with three-point estimates.",
        "methodology": "WATERFALL",
        "start_date": d(0),
        "calendar": "standard",
        "default_view": "SCHEDULE",
        "tasks": tasks,
        "dependencies": deps,
        "baselines": [
            {"name": "Kickoff baseline", "is_active": True, "tasks": baseline_rows}
        ],
        "risks": [
            {
                "slug": "mt-data-quality",
                "title": "Legacy data quality worse than profiled",
                "description": "Undocumented nulls and encoding issues could expand the transform effort.",
                "status": "OPEN",
                "probability": 4,
                "impact": 4,
                "category": "TECHNICAL",
                "response": "MITIGATE",
                "owner": "yuki",
                "tasks": ["1.2", "2.2"],
            },
            {
                "slug": "mt-cutover-window",
                "title": "Cutover window too short",
                "description": "The approved freeze window may not absorb a failed first cutover.",
                "status": "MITIGATING",
                "probability": 3,
                "impact": 5,
                "category": "EXTERNAL",
                "response": "MITIGATE",
                "owner": "sam",
                "tasks": ["5.2"],
            },
            {
                "slug": "mt-perf",
                "title": "Migration throughput below target",
                "description": "Delta-sync throughput may not keep pace with production write volume.",
                "status": "OPEN",
                "probability": 3,
                "impact": 4,
                "category": "TECHNICAL",
                "response": "ACCEPT",
                "owner": "omar",
                "tasks": ["3.3"],
            },
        ],
    }


# --- Project 3: GTM Readiness (hybrid) -------------------------------------


def build_gtm_readiness() -> dict:
    tasks: list[dict] = []
    deps: list[dict] = []

    # Planning gates (waterfall) ...
    planning = [
        ("Positioning & messaging", 4, []),
        ("Pricing & packaging sign-off", 3, ["1.1"]),
        ("Launch gate review", 2, ["1.2"]),
    ]
    cursor = 0
    for i, (name, ml, dep_paths) in enumerate(planning, start=1):
        wbs = f"1.{i}"
        if i == 1:
            tasks.append(
                {
                    "wbs_path": "1",
                    "name": "Launch planning",
                    "governance_class": "gated",
                    "delivery_mode": "waterfall",
                }
            )
        tasks.append(
            {
                "wbs_path": wbs,
                "name": name,
                "duration": ml,
                "planned_start": d(cursor * 3),
                "estimate": three_point(ml),
                "status": "COMPLETE" if i == 1 else "IN_PROGRESS",
                "percent_complete": 100.0 if i == 1 else 30.0,
                "governance_class": "gated",
                "delivery_mode": "waterfall",
                "assignee": "jordan",
            }
        )
        for dep in dep_paths:
            deps.append(
                {"predecessor": dep, "successor": wbs, "dep_type": "FS", "lag": 0}
            )
        cursor += ml

    # Enablement work (agile / flow) under one sprint.
    tasks.append(
        {
            "wbs_path": "2",
            "name": "Enablement",
            "governance_class": "flow",
            "delivery_mode": "kanban",
        }
    )
    enablement = [
        "Sales deck",
        "Demo script",
        "Pricing FAQ",
        "Onboarding guide",
        "Launch blog",
        "Webinar prep",
        "Support runbook",
        "Release notes",
    ]
    for i, name in enumerate(enablement, start=1):
        tasks.append(
            {
                "wbs_path": f"2.{i}",
                "name": name,
                "type": "story",
                "status": "BACKLOG",
                "story_points": [2, 3, 5][i % 3],
                "assignee": "clara",
                "governance_class": "flow",
                "delivery_mode": "kanban",
            }
        )

    # Public-launch milestone (gated by both planning and Migration completion).
    tasks.append(
        {
            "wbs_path": "3",
            "name": "Public launch",
            "is_milestone": True,
            "delivery_mode": "milestone",
            "planned_start": d(120),
        }
    )
    deps.append({"predecessor": "1.3", "successor": "3", "dep_type": "FS", "lag": 2})
    # cross-project: Migration must complete before public launch
    deps.append(
        {
            "predecessor": "migration-tooling:6",
            "successor": "3",
            "dep_type": "FS",
            "lag": 3,
        }
    )

    return {
        "slug": "gtm-readiness",
        "name": "GTM Readiness",
        "description": "The hybrid stream — gated launch planning with agile enablement content.",
        "methodology": "HYBRID",
        "start_date": d(40),
        "calendar": "gtm-regional",
        "default_view": "OVERVIEW",
        "agile_features": True,
        "tasks": tasks,
        "dependencies": deps,
        "risks": [
            {
                "slug": "gtm-launch-slip",
                "title": "Launch slips past fiscal quarter",
                "description": "A migration slip cascades to the public-launch milestone and misses the quarter.",
                "status": "OPEN",
                "probability": 3,
                "impact": 4,
                "category": "EXTERNAL",
                "response": "MITIGATE",
                "owner": "alex",
                "tasks": ["3"],
            }
        ],
    }


def build_atlas() -> dict:
    pc = build_platform_core()
    # Cross-project dependency: a Platform Core API story gates Migration build.
    mt = build_migration_tooling()
    mt["dependencies"].append(
        {
            "predecessor": "platform-core:2.1",
            "successor": "2.1",
            "dep_type": "FS",
            "lag": 5,
        }
    )
    gtm = build_gtm_readiness()

    return {
        "schema_version": "2.0",
        "program": {
            "slug": "atlas-platform-launch",
            "name": "Atlas Platform Launch",
            "description": "Fictional B2B SaaS launch program — the hybrid bridge demo. "
            "One program, three projects spanning agile, waterfall, and hybrid delivery.",
            "methodology": "HYBRID",
            "color": "#2E5AAC",
            "lead": "alex",
        },
        "accounts": [
            # Usernames are namespaced (``atlas-<slug>``) so loading the demo can
            # never reuse — and silently grant membership to — a real account that
            # happens to share a common first name. The display name stays human.
            {
                "slug": s,
                "username": f"atlas-{s}",
                "display_name": dn,
                "email": e,
                "role": r,
            }
            for (s, _u, dn, e, r) in ACCOUNTS
        ],
        "calendars": CALENDARS,
        "resources": [
            {
                "slug": s,
                "name": dict((a[0], a[2]) for a in ACCOUNTS)[s],
                "job_role": role,
                "max_units": units,
                "calendar": cal,
                "account": s,
            }
            for (s, role, units, cal) in RESOURCES
        ],
        "risks": [
            {
                "slug": "prog-cross-team-dependency",
                "title": "Cross-team dependency stalls the critical path",
                "description": "Platform Core API delays ripple into Migration and then the public launch.",
                "status": "MITIGATING",
                "probability": 4,
                "impact": 5,
                "category": "ORGANIZATIONAL",
                "response": "MITIGATE",
                "owner": "alex",
                "tasks": [
                    "platform-core:2.1",
                    "migration-tooling:2.1",
                    "gtm-readiness:3",
                ],
            },
            {
                "slug": "prog-budget",
                "title": "Program budget pressure",
                "description": "A contractor rate increase threatens the back half of the program.",
                "status": "OPEN",
                "probability": 2,
                "impact": 4,
                "category": "EXTERNAL",
                "response": "ACCEPT",
                "owner": "ada",
                "tasks": ["platform-core:9"],
            },
        ],
        "projects": [pc, mt, gtm],
    }


def main() -> int:
    seed = build_atlas()

    # Validate against the canonical schema before writing.
    repo_root = Path(__file__).resolve().parents[2]
    api_src = repo_root / "packages" / "api" / "src"
    sys.path.insert(0, str(api_src))
    from trueppm_api.apps.projects.seed.validation import (  # noqa: E402
        SeedValidationError,
        validate_seed,
    )

    try:
        validate_seed(seed)
    except SeedValidationError as exc:
        print("Generated Atlas seed FAILED validation:\n" + str(exc), file=sys.stderr)
        return 1

    out = (
        api_src
        / "trueppm_api"
        / "apps"
        / "projects"
        / "fixtures"
        / "seeds"
        / "atlas-platform-launch.json"
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(seed, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    task_count = sum(len(p.get("tasks", [])) for p in seed["projects"])
    print(f"Wrote {out} — 3 projects, {task_count} tasks, validation OK.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
