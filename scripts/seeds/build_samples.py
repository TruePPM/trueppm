#!/usr/bin/env python3
"""Generate the remaining bundled sample seeds (#617/#618/#619).

Developer tool (not run at runtime). Emits three committed, schema-validated
JSON seeds alongside Atlas (#620):

- Aurora Mobile App — agile-only (sprints, velocity, board; no CPM/estimates).
- Bayside Civic Center — waterfall-only (CPM, all 4 dep types, three-point
  estimates, a baseline, a resource calendar, a risk register).
- Helios CRM Replacement — hybrid-small (a completed waterfall planning phase +
  an agile build phase, with a cross-phase dependency).

    python scripts/seeds/build_samples.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Anchor-relative dates (ADR-0114, seed v2). Dates are emitted as offsets from
# the import-day anchor "A" so each demo always reads as a program in flight; the
# event-replay importer synthesizes the backdated history (status moves, burndown,
# velocity) up to "today". ANCHOR_OFFSET places "today" ~90 days in: early work is
# done, later work is still ahead. These samples span ~100 days.
ANCHOR_OFFSET = 90


def d(offset: int) -> str:
    return f"A{offset - ANCHOR_OFFSET:+d}"


def three_point(ml: int) -> dict:
    return {
        "optimistic": max(1, round(ml * 0.7)),
        "most_likely": ml,
        "pessimistic": round(ml * 1.9),
    }


def _accounts(rows: list[tuple[str, str, str]]) -> list[dict]:
    # rows: (slug, display, role). Usernames are namespaced so loading a demo
    # never reuses a real account sharing a common first name.
    return [
        {
            "slug": s,
            "username": f"{ns}-{s}",
            "display_name": dn,
            "email": f"{s}@{ns}.example",
            "role": r,
        }
        for ns, (s, dn, r) in ((ns, row) for ns, row in rows)
    ]


# ---------------------------------------------------------------------------
# #617 Aurora Mobile App — agile-only
# ---------------------------------------------------------------------------


def build_aurora() -> dict:
    ns = "aurora"
    people = [
        ("priya", "Priya Nair", "OWNER"),
        ("sam", "Sam Okafor", "ADMIN"),
        ("mei", "Mei Tanaka", "MEMBER"),
        ("diego", "Diego Santos", "MEMBER"),
        ("nadia", "Nadia Hassan", "MEMBER"),
        ("tom", "Tom Becker", "MEMBER"),
        ("clara", "Clara Mendes", "MEMBER"),
    ]
    devs = ["mei", "diego", "nadia", "tom"]

    sprints = []
    states = ["COMPLETED", "COMPLETED", "ACTIVE", "PLANNED"]
    completed = [22, 27, None, None]
    for i, (state, vel) in enumerate(zip(states, completed)):
        sp = {
            "slug": f"au-sprint-{i + 1}",
            "name": f"Sprint {i + 1}",
            "goal": f"Mobile increment {i + 1}.",
            "state": state,
            "start_date": d(i * 14),
            "finish_date": d(i * 14 + 13),
            "capacity_points": 28,
        }
        if state in ("COMPLETED", "ACTIVE"):
            sp["committed_points"] = 26
        if vel is not None:
            sp["completed_points"] = vel
        sprints.append(sp)

    features = [
        "Onboarding flow",
        "Push notifications",
        "Offline cache",
        "Dark mode",
        "Biometric login",
        "Profile editor",
        "Search",
        "Share sheet",
        "In-app chat",
        "Settings sync",
        "Photo upload",
        "Map view",
        "Calendar widget",
        "Deep links",
        "Crash reporting",
        "Localization",
        "Accessibility pass",
        "Tablet layout",
        "Widget gallery",
        "App rating prompt",
        "Referral program",
        "Payment sheet",
        "Receipt export",
        "Activity feed",
        "Bookmark sync",
        "Voice search",
        "Haptics",
        "Pull-to-refresh",
        "Skeleton loaders",
        "Empty states",
    ]
    tasks = []
    points = [2, 3, 5, 8, 3, 5, 2, 8]
    for i, name in enumerate(features):
        sprint_idx = i % 4
        state = states[sprint_idx]
        status = {
            "COMPLETED": "COMPLETE",
            "ACTIVE": "IN_PROGRESS",
            "PLANNED": "BACKLOG",
        }[state]
        tasks.append(
            {
                "wbs_path": str(i + 1),
                "name": name,
                "type": "story",
                "status": status,
                "percent_complete": {
                    "COMPLETE": 100.0,
                    "IN_PROGRESS": 50.0,
                    "BACKLOG": 0.0,
                }[status],
                "story_points": points[i % len(points)],
                "assignee": devs[i % len(devs)],
                "sprint": f"au-sprint-{sprint_idx + 1}",
                "delivery_mode": "scrum",
                "governance_class": "flow",
                "dor": "ready" if state != "PLANNED" else "idea",
            }
        )

    return {
        "schema_version": "2.0",
        "program": {
            "slug": "aurora-mobile-app",
            "name": "Aurora Mobile App",
            "description": "Agile-only sample — a mobile product team running the sprint lifecycle.",
            "methodology": "AGILE",
            "color": "#7A3FB0",
            "lead": "priya",
        },
        "accounts": _accounts([(ns, p) for p in people]),
        "resources": [
            {"slug": s, "name": dn, "job_role": role, "max_units": 1.0, "account": s}
            for s, dn, role in [
                ("priya", "Priya Nair", "Product Owner"),
                ("sam", "Sam Okafor", "Scrum Master"),
                ("mei", "Mei Tanaka", "Engineer"),
                ("diego", "Diego Santos", "Engineer"),
                ("nadia", "Nadia Hassan", "Engineer"),
                ("tom", "Tom Becker", "QA Engineer"),
            ]
        ],
        "projects": [
            {
                "slug": "aurora",
                "name": "Aurora App",
                "methodology": "AGILE",
                "start_date": d(0),
                "default_view": "BOARD",
                "agile_features": True,
                "board_columns": [
                    "Backlog",
                    "To Do",
                    "In Progress",
                    "In Review",
                    "Done",
                ],
                "tasks": tasks,
                "sprints": sprints,
            }
        ],
    }


# ---------------------------------------------------------------------------
# #618 Bayside Civic Center — waterfall-only
# ---------------------------------------------------------------------------


def build_bayside() -> dict:
    ns = "bayside"
    # phase -> [(task, most_likely, [(dep_wbs, dep_type)])]
    phases = [
        (
            "Site Prep",
            [
                ("Mobilize site", 4, []),
                ("Clear & grade", 6, [("1.1", "FS")]),
                ("Temporary utilities", 3, [("1.1", "SS")]),
                ("Site survey sign-off", 2, [("1.2", "FS"), ("1.3", "FS")]),
            ],
        ),
        (
            "Foundation",
            [
                ("Excavate footings", 5, [("1.4", "FS")]),
                ("Rebar & formwork", 6, [("2.1", "FS")]),
                ("Pour east footing", 3, [("2.2", "FS")]),
                ("Pour west footing", 3, [("2.2", "SS")]),  # parallel pours
                (
                    "Cure & strip forms",
                    4,
                    [("2.3", "FF"), ("2.4", "FF")],
                ),  # finish together
            ],
        ),
        (
            "Framing",
            [
                ("Steel erection", 8, [("2.5", "FS")]),
                ("Floor decking", 6, [("3.1", "FS")]),
                ("Roof structure", 7, [("3.1", "FS")]),
                ("Framing inspection", 2, [("3.2", "FF"), ("3.3", "FF")]),
            ],
        ),
        (
            "MEP",
            [
                ("Rough-in electrical", 7, [("3.4", "FS")]),
                ("Rough-in plumbing", 6, [("3.4", "FS")]),
                ("HVAC ductwork", 8, [("3.4", "FS")]),
                ("MEP equipment delivery", 5, []),
                ("MEP inspection", 3, [("4.1", "FS"), ("4.2", "FS"), ("4.3", "FS")]),
            ],
        ),
        (
            "Finish-out",
            [
                ("Drywall & paint", 8, [("4.5", "FS")]),
                ("Flooring", 6, [("5.1", "FS")]),
                ("Fixtures & casework", 5, [("5.1", "FS")]),
                (
                    "Commissioning start",
                    0,
                    [("5.2", "SF")],
                ),  # SF: start no later than flooring finish
                ("Final inspection & handover", 3, [("5.2", "FS"), ("5.3", "FS")]),
            ],
        ),
    ]
    crew = ["diego", "tom", "nadia", "omar"]
    tasks, deps, baseline_rows = [], [], []
    cursor = 0
    for p_idx, (phase, items) in enumerate(phases, start=1):
        tasks.append(
            {
                "wbs_path": str(p_idx),
                "name": phase,
                "governance_class": "gated",
                "delivery_mode": "waterfall",
            }
        )
        for t_idx, (name, ml, dep_list) in enumerate(items, start=1):
            wbs = f"{p_idx}.{t_idx}"
            done = p_idx <= 2
            in_prog = p_idx == 3
            status = (
                "COMPLETE" if done else ("IN_PROGRESS" if in_prog else "NOT_STARTED")
            )
            is_ms = ml == 0
            task = {
                "wbs_path": wbs,
                "name": name,
                "status": status,
                "percent_complete": 100.0 if done else (35.0 if in_prog else 0.0),
                "governance_class": "gated",
                "delivery_mode": "waterfall",
                "assignee": crew[(p_idx + t_idx) % len(crew)],
            }
            if is_ms:
                task["is_milestone"] = True
                task["delivery_mode"] = "milestone"
            else:
                task["duration"] = ml
                task["planned_start"] = d(cursor * 2)
                task["estimate"] = three_point(ml)
                baseline_rows.append(
                    {
                        "task": wbs,
                        "start": d(cursor * 2),
                        "finish": d(cursor * 2 + ml),
                        "duration": ml,
                    }
                )
            task = {k: v for k, v in task.items() if v is not None}
            tasks.append(task)
            for dep_wbs, dep_type in dep_list:
                deps.append(
                    {
                        "predecessor": dep_wbs,
                        "successor": wbs,
                        "dep_type": dep_type,
                        "lag": 0,
                    }
                )
            cursor += max(ml, 1)

    return {
        "schema_version": "2.0",
        "program": {
            "slug": "bayside-civic-center",
            "name": "Bayside Civic Center Construction",
            "description": "Waterfall-only sample — CPM with all four dependency types, "
            "three-point estimates, a baseline, and a resource calendar.",
            "methodology": "WATERFALL",
            "color": "#B5651D",
            "lead": "sam",
        },
        "accounts": _accounts(
            [
                (ns, p)
                for p in [
                    ("sam", "Sam Okafor", "OWNER"),
                    ("diego", "Diego Santos", "ADMIN"),
                    ("tom", "Tom Becker", "MEMBER"),
                    ("nadia", "Nadia Hassan", "MEMBER"),
                    ("omar", "Omar Aziz", "MEMBER"),
                ]
            ]
        ),
        "calendars": [
            {
                "slug": "site",
                "name": "Site Standard (5-day)",
                "working_days": 31,
                "hours_per_day": 8.0,
            },
            # concrete crew works a 4-day week (Mon-Thu = 1+2+4+8 = 15), weather-dependent
            {
                "slug": "concrete-crew",
                "name": "Concrete Crew (4-day)",
                "working_days": 15,
                "hours_per_day": 10.0,
            },
        ],
        "resources": [
            {
                "slug": "sam",
                "name": "Sam Okafor",
                "job_role": "Project Manager",
                "max_units": 1.0,
                "account": "sam",
                "calendar": "site",
            },
            {
                "slug": "diego",
                "name": "Diego Santos",
                "job_role": "Site Superintendent",
                "max_units": 1.0,
                "account": "diego",
                "calendar": "site",
            },
            {
                "slug": "tom",
                "name": "Tom Becker",
                "job_role": "Concrete Foreman",
                "max_units": 1.0,
                "account": "tom",
                "calendar": "concrete-crew",
            },
            {
                "slug": "nadia",
                "name": "Nadia Hassan",
                "job_role": "MEP Lead",
                "max_units": 1.0,
                "account": "nadia",
                "calendar": "site",
            },
            {
                "slug": "omar",
                "name": "Omar Aziz",
                "job_role": "Inspector",
                "max_units": 0.5,
                "account": "omar",
                "calendar": "site",
            },
        ],
        "projects": [
            {
                "slug": "bayside",
                "name": "Bayside Civic Center",
                "methodology": "WATERFALL",
                "start_date": d(0),
                "calendar": "site",
                "default_view": "SCHEDULE",
                "tasks": tasks,
                "dependencies": deps,
                "baselines": [
                    {
                        "name": "Contract baseline",
                        "is_active": True,
                        "tasks": baseline_rows,
                    }
                ],
                "risks": [
                    {
                        "slug": "weather",
                        "title": "Weather delays outdoor phases",
                        "status": "OPEN",
                        "probability": 4,
                        "impact": 3,
                        "category": "EXTERNAL",
                        "response": "MITIGATE",
                        "owner": "sam",
                        "tasks": ["2.3", "2.4"],
                    },
                    {
                        "slug": "supply-chain",
                        "title": "MEP equipment supply delay",
                        "status": "MITIGATING",
                        "probability": 3,
                        "impact": 5,
                        "category": "EXTERNAL",
                        "response": "MITIGATE",
                        "owner": "nadia",
                        "tasks": ["4.4"],
                    },
                    {
                        "slug": "inspection-fail",
                        "title": "Framing inspection rework",
                        "status": "OPEN",
                        "probability": 2,
                        "impact": 4,
                        "category": "TECHNICAL",
                        "response": "ACCEPT",
                        "owner": "diego",
                        "tasks": ["3.4"],
                    },
                    {
                        "slug": "labor",
                        "title": "Concrete crew availability",
                        "status": "OPEN",
                        "probability": 3,
                        "impact": 3,
                        "category": "ORGANIZATIONAL",
                        "response": "MITIGATE",
                        "owner": "tom",
                        "tasks": ["2.3"],
                    },
                ],
            }
        ],
    }


# ---------------------------------------------------------------------------
# #619 Helios CRM Replacement — hybrid-small
# ---------------------------------------------------------------------------


def build_helios() -> dict:
    ns = "helios"
    tasks, deps = [], []

    # Planning phase (waterfall) — already COMPLETE.
    planning = [
        ("Discovery interviews", 6),
        ("Current-state analysis", 5),
        ("Target architecture", 7),
        ("Vendor selection", 5),
        ("Data model design", 6),
        ("Tooling & environments", 4),
    ]
    tasks.append(
        {
            "wbs_path": "1",
            "name": "Planning",
            "governance_class": "gated",
            "delivery_mode": "waterfall",
        }
    )
    cursor = 0
    prev = None
    for i, (name, ml) in enumerate(planning, start=1):
        wbs = f"1.{i}"
        tasks.append(
            {
                "wbs_path": wbs,
                "name": name,
                "status": "COMPLETE",
                "percent_complete": 100.0,
                "duration": ml,
                "planned_start": d(cursor),
                "estimate": three_point(ml),
                "governance_class": "gated",
                "delivery_mode": "waterfall",
                "assignee": "ivan",
            }
        )
        if prev:
            deps.append(
                {"predecessor": prev, "successor": wbs, "dep_type": "FS", "lag": 0}
            )
        prev = wbs
        cursor += ml

    # Build phase (agile) — 3 sprints, 1 closed / 1 active / 1 planned.
    tasks.append(
        {
            "wbs_path": "2",
            "name": "Build",
            "governance_class": "flow",
            "delivery_mode": "scrum",
        }
    )
    stories = [
        "Account import",
        "Contact dedupe",
        "Lead pipeline",
        "Email sync",
        "Dashboards",
        "Role permissions",
        "Activity timeline",
        "Mobile app",
        "Reporting export",
        "Workflow rules",
        "Custom fields",
        "Bulk edit",
        "Audit log",
        "SSO integration",
        "Notification center",
        "Search & filters",
        "Data migration run",
        "Cutover rehearsal",
    ]
    sprints = [
        {
            "slug": "he-sprint-1",
            "name": "Build Sprint 1",
            "state": "COMPLETED",
            "start_date": d(60),
            "finish_date": d(73),
            "committed_points": 30,
            "completed_points": 28,
            "capacity_points": 32,
        },
        {
            "slug": "he-sprint-2",
            "name": "Build Sprint 2",
            "state": "ACTIVE",
            "start_date": d(74),
            "finish_date": d(87),
            "committed_points": 32,
            "capacity_points": 32,
        },
        {
            "slug": "he-sprint-3",
            "name": "Build Sprint 3",
            "state": "PLANNED",
            "start_date": d(88),
            "finish_date": d(101),
            "capacity_points": 32,
        },
    ]
    states = ["COMPLETED", "ACTIVE", "PLANNED"]
    for i, name in enumerate(stories, start=1):
        sidx = i % 3
        state = states[sidx]
        status = {
            "COMPLETED": "COMPLETE",
            "ACTIVE": "IN_PROGRESS",
            "PLANNED": "BACKLOG",
        }[state]
        story = {
            "wbs_path": f"2.{i}",
            "name": name,
            "type": "story",
            "status": status,
            "percent_complete": {
                "COMPLETE": 100.0,
                "IN_PROGRESS": 40.0,
                "BACKLOG": 0.0,
            }[status],
            "story_points": [3, 5, 8][i % 3],
            "assignee": "mei",
            "sprint": f"he-sprint-{sidx + 1}",
            "delivery_mode": "scrum",
            "governance_class": "flow",
        }
        tasks.append(story)
    # cross-phase dependency: the data-migration story depends on the planning data-model task
    deps.append({"predecessor": "1.5", "successor": "2.17", "dep_type": "FS", "lag": 0})

    return {
        "schema_version": "2.0",
        "program": {
            "slug": "helios-crm-replacement",
            "name": "Helios CRM Replacement",
            "description": "Hybrid-small sample — a completed waterfall planning phase feeding an "
            "agile build phase, with a cross-phase dependency.",
            "methodology": "HYBRID",
            "color": "#2E8B8B",
            "lead": "jordan",
        },
        "accounts": _accounts(
            [
                (ns, p)
                for p in [
                    ("jordan", "Jordan Blake", "OWNER"),
                    ("ivan", "Ivan Petrov", "ADMIN"),
                    ("mei", "Mei Tanaka", "MEMBER"),
                    ("nadia", "Nadia Hassan", "MEMBER"),
                ]
            ]
        ),
        "resources": [
            # the architect is full-time in planning, then a 10% advisor in build
            {
                "slug": "ivan",
                "name": "Ivan Petrov",
                "job_role": "Solutions Architect",
                "max_units": 1.0,
                "account": "ivan",
            },
            {
                "slug": "jordan",
                "name": "Jordan Blake",
                "job_role": "Product Owner",
                "max_units": 1.0,
                "account": "jordan",
            },
            {
                "slug": "mei",
                "name": "Mei Tanaka",
                "job_role": "Engineer",
                "max_units": 1.0,
                "account": "mei",
            },
        ],
        "projects": [
            {
                "slug": "helios",
                "name": "Helios CRM",
                "methodology": "HYBRID",
                "start_date": d(0),
                "default_view": "OVERVIEW",
                "agile_features": True,
                "tasks": tasks,
                "dependencies": deps,
                "sprints": sprints,
                "risks": [
                    {
                        "slug": "vendor-lockin",
                        "title": "Vendor lock-in (identified in planning)",
                        "status": "MITIGATING",
                        "probability": 3,
                        "impact": 4,
                        "category": "EXTERNAL",
                        "response": "MITIGATE",
                        "owner": "ivan",
                        "tasks": ["1.4", "2.14"],
                    },
                    {
                        "slug": "migration-risk",
                        "title": "Legacy data migration fidelity",
                        "status": "OPEN",
                        "probability": 3,
                        "impact": 4,
                        "category": "TECHNICAL",
                        "response": "MITIGATE",
                        "owner": "mei",
                        "tasks": ["2.17"],
                    },
                ],
            }
        ],
    }


def main() -> int:
    repo_root = Path(__file__).resolve().parents[2]
    api_src = repo_root / "packages" / "api" / "src"
    sys.path.insert(0, str(api_src))
    from trueppm_api.apps.projects.seed.validation import (
        SeedValidationError,
        validate_seed,
    )  # noqa: E402

    out_dir = api_src / "trueppm_api" / "apps" / "projects" / "fixtures" / "seeds"
    out_dir.mkdir(parents=True, exist_ok=True)

    builders = {
        "aurora-mobile-app.json": build_aurora,
        "bayside-civic-center.json": build_bayside,
        "helios-crm-replacement.json": build_helios,
    }
    for filename, builder in builders.items():
        seed = builder()
        try:
            validate_seed(seed)
        except SeedValidationError as exc:
            print(f"{filename} FAILED validation:\n{exc}", file=sys.stderr)
            return 1
        (out_dir / filename).write_text(
            json.dumps(seed, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        tasks = sum(len(p.get("tasks", [])) for p in seed["projects"])
        print(f"Wrote {filename} — {tasks} tasks, validation OK.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
