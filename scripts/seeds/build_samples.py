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
# event-replay importer replays the authored event timeline (and synthesizes the
# unauthored fill) so the backdated history — status moves, reassignments,
# comments, burndown, velocity — reads up to "today". A per-sample anchor places
# "today" so the *active* work straddles it: completed sprints/phases sit in the
# recent past, the in-flight sprint/phase brackets today, and planned work is
# ahead. A sample whose "active" sprint resolves entirely into the past reads as
# a museum piece, not a live program — the anchor is tuned to avoid that (#1253).
ANCHOR_OFFSET = 90


def d(offset: int, anchor: int = ANCHOR_OFFSET) -> str:
    return f"A{offset - anchor:+d}"


def ts(
    offset: int, hour: int = 10, minute: int = 0, anchor: int = ANCHOR_OFFSET
) -> str:
    """An anchor-relative event timestamp (``A±NTHH:MM``); never weekend-snapped.

    Keep ``offset <= anchor`` so a beat never lands in the future relative to the
    import-day "today" — backdated history only, never forward-dated.
    """
    return f"{d(offset, anchor)}T{hour:02d}:{minute:02d}"


def _ev(
    at: str, action: str, target: str = "", actor: str = "", **extra: object
) -> dict:
    """One timeline event. ``target`` qualifies what is mutated; ``actor`` is the
    account slug whose name the backdated history row is attributed to."""
    event: dict = {"at": at, "action": action}
    if target:
        event["target"] = target
    if actor:
        event["actor"] = actor
    event.update(extra)
    return event


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
        ("raj", "Raj Mehta", "SCHEDULER"),
        ("mei", "Mei Tanaka", "MEMBER"),
        ("diego", "Diego Santos", "MEMBER"),
        ("nadia", "Nadia Hassan", "MEMBER"),
        ("tom", "Tom Becker", "MEMBER"),
        ("clara", "Clara Mendes", "MEMBER"),
        ("ada", "Ada Boyega", "VIEWER"),
    ]
    devs = ["mei", "diego", "nadia", "tom"]

    # Anchor placed inside the active sprint (#1253): two completed sprints in the
    # recent past, Sprint 3 bracketing "today", Sprint 4 ahead. 14-day sprints, so
    # Sprint 3 starts on day 28 and "today" at day 35 lands a week into it.
    anchor = 35

    def D(offset: int) -> str:
        return d(offset, anchor)

    def T(offset: int, hour: int = 10, minute: int = 0) -> str:
        return ts(offset, hour, minute, anchor)

    sprints = []
    states = ["COMPLETED", "COMPLETED", "ACTIVE", "PLANNED"]
    # A realistic ramp: the team under-delivered its first sprint (20 of 26
    # committed → goal partially met) then found its stride (27). The closed
    # sprints carry an honest goal_outcome, set on the authored sprint.close beats.
    completed = [20, 27, None, None]
    for i, (state, vel) in enumerate(zip(states, completed)):
        sp = {
            "slug": f"au-sprint-{i + 1}",
            "name": f"Sprint {i + 1}",
            "goal": f"Mobile increment {i + 1}.",
            "state": state,
            "start_date": D(i * 14),
            "finish_date": D(i * 14 + 13),
            "capacity_points": 28,
        }
        if state in ("COMPLETED", "ACTIVE"):
            sp["committed_points"] = 26
        if vel is not None:
            sp["completed_points"] = vel
        sprints.append(sp)

    # The backlog is grouped into epics so the board and timeline read as themed
    # initiatives, not a flat 30-story list — the epic → story hierarchy an agile
    # team actually plans in (#617). Stories keep their original order, so a global
    # story index (identical to the old flat index) still drives sprint / point /
    # assignee placement and the authored event timeline below lands on the right
    # work. Epics are grouping nodes only — excluded from velocity and CPM.
    epics = [
        (
            "Core app experience",
            [
                "Onboarding flow",
                "Push notifications",
                "Offline cache",
                "Dark mode",
                "Biometric login",
            ],
        ),
        (
            "Profile & social",
            ["Profile editor", "Search", "Share sheet", "In-app chat", "Settings sync"],
        ),
        (
            "Media & navigation",
            [
                "Photo upload",
                "Map view",
                "Calendar widget",
                "Deep links",
                "Crash reporting",
            ],
        ),
        (
            "Platform polish",
            [
                "Localization",
                "Accessibility pass",
                "Tablet layout",
                "Widget gallery",
                "App rating prompt",
            ],
        ),
        (
            "Growth & monetization",
            [
                "Referral program",
                "Payment sheet",
                "Receipt export",
                "Activity feed",
                "Bookmark sync",
            ],
        ),
        (
            "Delight & interactions",
            [
                "Voice search",
                "Haptics",
                "Pull-to-refresh",
                "Skeleton loaders",
                "Empty states",
            ],
        ),
    ]
    tasks: list[dict] = []
    # Story name -> wbs_path, so the event/risk authoring below references a story
    # by name and stays correct regardless of how the epic grouping is sliced.
    wbs: dict[str, str] = {}
    points = [2, 3, 5, 8, 3, 5, 2, 8]
    story_idx = 0
    for e_idx, (epic_name, feats) in enumerate(epics, start=1):
        epic_wbs = str(e_idx)
        tasks.append(
            {
                "wbs_path": epic_wbs,
                "name": epic_name,
                "type": "epic",
                "delivery_mode": "scrum",
                "governance_class": "flow",
            }
        )
        for s_idx, name in enumerate(feats, start=1):
            sprint_idx = story_idx % 4
            state = states[sprint_idx]
            status = {
                "COMPLETED": "COMPLETE",
                "ACTIVE": "IN_PROGRESS",
                "PLANNED": "BACKLOG",
            }[state]
            story_wbs = f"{e_idx}.{s_idx}"
            wbs[name] = story_wbs
            tasks.append(
                {
                    "wbs_path": story_wbs,
                    "name": name,
                    "type": "story",
                    "status": status,
                    "percent_complete": {
                        "COMPLETE": 100.0,
                        "IN_PROGRESS": 50.0,
                        "BACKLOG": 0.0,
                    }[status],
                    "story_points": points[story_idx % len(points)],
                    "parent_epic": epic_wbs,
                    # Spread each sprint's stories across the whole team rather than
                    # one dev per sprint (story_idx // 4 advances once per sprint-row,
                    # so the four devs round-robin *within* every sprint). The event
                    # timeline then reassigns a few of these as the program plays out.
                    "assignee": devs[(story_idx // len(devs)) % len(devs)],
                    "sprint": f"au-sprint-{sprint_idx + 1}",
                    "delivery_mode": "scrum",
                    "governance_class": "flow",
                    "dor": "ready" if state != "PLANNED" else "idea",
                }
            )
            story_idx += 1

    # --- event timeline ----------------------------------------------------
    # Authored beats layer the human story on top of the synthesizer's status
    # fill: dated reassignments, review rework, standup comments, a mid-sprint
    # scope injection, sprint goal verdicts, and risk-status lifecycles. Targets
    # are project-qualified (``task:aurora:<wbs>``). Offsets stay <= the anchor
    # (35) so nothing is forward-dated.
    def task(path: str) -> str:
        return f"task:aurora:{path}"

    def sprint(slug: str) -> str:
        return f"sprint:aurora:{slug}"

    events: list[dict] = [
        # Sprint 1 — activate, run, and close with an honest "partially met".
        _ev(T(0, 9, 0), "sprint.activate", sprint("au-sprint-1"), "sam"),
        # Hero: Onboarding flow (wbs 1, Mei) takes a non-linear path the linear
        # synthesizer can't produce — built, reviewed, bounced for a real defect,
        # reworked, re-reviewed, shipped. Tom reviews without taking ownership.
        _ev(
            T(1, 9, 30),
            "task.comment",
            task(wbs["Onboarding flow"]),
            "mei",
            body="Starting onboarding — carousel plus the first-run empty state.",
        ),
        _ev(
            T(2, 10, 0),
            "task.status",
            task(wbs["Onboarding flow"]),
            "mei",
            to="IN_PROGRESS",
        ),
        _ev(
            T(5, 15, 0),
            "task.comment",
            task(wbs["Onboarding flow"]),
            "mei",
            body="PR up for review (!142). First-run flow is feature-complete.",
        ),
        _ev(
            T(5, 15, 30),
            "task.status",
            task(wbs["Onboarding flow"]),
            "mei",
            to="REVIEW",
        ),
        _ev(
            T(6, 11, 0),
            "task.comment",
            task(wbs["Onboarding flow"]),
            "tom",
            body="Review: the skip button doesn't persist the 'seen' flag on a cold "
            "start, so onboarding re-shows. Sending it back.",
        ),
        _ev(
            T(6, 11, 30),
            "task.status",
            task(wbs["Onboarding flow"]),
            "tom",
            to="IN_PROGRESS",
        ),
        _ev(
            T(8, 14, 0),
            "task.comment",
            task(wbs["Onboarding flow"]),
            "mei",
            body="Fixed — onboarding-complete now persists to secure storage. "
            "Re-requesting review.",
        ),
        _ev(
            T(8, 14, 30),
            "task.status",
            task(wbs["Onboarding flow"]),
            "mei",
            to="REVIEW",
        ),
        _ev(
            T(9, 16, 0),
            "task.comment",
            task(wbs["Onboarding flow"]),
            "tom",
            body="QA pass on iOS and Android. Merging.",
        ),
        _ev(
            T(9, 16, 30),
            "task.status",
            task(wbs["Onboarding flow"]),
            "tom",
            to="COMPLETE",
        ),
        # Reassignment: Biometric login (wbs 5) started with Diego, but the
        # secure-enclave expertise sits with Mei — the key-person risk in action.
        _ev(
            T(2, 9, 0),
            "task.comment",
            task(wbs["Biometric login"]),
            "diego",
            body="Spiking biometric auth; the secure-enclave path is unfamiliar to me.",
        ),
        _ev(
            T(4, 13, 0),
            "task.comment",
            task(wbs["Biometric login"]),
            "priya",
            body="Biometric know-how is concentrated in Mei — reassigning so we don't "
            "bottleneck a launch-critical story on a single spike.",
        ),
        _ev(
            T(4, 13, 5),
            "task.assign",
            task(wbs["Biometric login"]),
            "priya",
            assignee="mei",
        ),
        _ev(
            T(7, 10, 0),
            "task.comment",
            task(wbs["Biometric login"]),
            "mei",
            body="Took over biometrics — Face ID and fingerprint enrolled behind a flag.",
        ),
        _ev(
            T(13, 17, 0),
            "sprint.close",
            sprint("au-sprint-1"),
            "sam",
            goal_outcome="PARTIAL",
        ),
        # Sprint 2 — vendor outage and a coverage reassignment while Mei is out.
        _ev(T(14, 9, 0), "sprint.activate", sprint("au-sprint-2"), "sam"),
        _ev(
            T(16, 9, 0),
            "task.comment",
            task(wbs["Push notifications"]),
            "mei",
            body="Push vendor had an overnight outage — integration tests are flaky. "
            "Watching their status page before I trust the happy path.",
        ),
        _ev(T(16, 12, 0), "risk.status", "risk:external-api", "sam", to="MITIGATING"),
        _ev(
            T(19, 10, 0),
            "task.comment",
            task(wbs["Push notifications"]),
            "sam",
            body="Mei is out for two days — Nadia to cover push notifications so the "
            "increment goal holds.",
        ),
        _ev(
            T(19, 10, 5),
            "task.assign",
            task(wbs["Push notifications"]),
            "sam",
            assignee="nadia",
        ),
        _ev(
            T(23, 14, 0),
            "task.comment",
            task(wbs["Push notifications"]),
            "nadia",
            body="Vendor is back; added retry with backoff so a future outage degrades "
            "gracefully instead of failing sends. Handing back to Mei.",
        ),
        _ev(
            T(23, 14, 5),
            "task.assign",
            task(wbs["Push notifications"]),
            "nadia",
            assignee="mei",
        ),
        # Store-review risk resolves over the sprint as the checklist lands.
        _ev(T(15, 11, 0), "risk.status", "risk:store-review", "sam", to="MITIGATING"),
        _ev(T(26, 16, 0), "risk.status", "risk:store-review", "sam", to="RESOLVED"),
        _ev(
            T(27, 17, 0),
            "sprint.close",
            sprint("au-sprint-2"),
            "sam",
            goal_outcome="MET",
        ),
        # Sprint 3 (active) — a mid-sprint scope injection the PO pulls in and the
        # team accepts after protecting the goal. Wires the SprintScopeChange audit.
        _ev(
            T(30, 9, 30),
            "task.comment",
            task(wbs["Widget gallery"]),
            "priya",
            body="Marketing needs the widget gallery in this increment for launch — "
            "pulling it into the sprint.",
        ),
        _ev(
            T(30, 9, 35),
            "sprint.scope_inject",
            task(wbs["Widget gallery"]),
            "priya",
            goal_impact=True,
        ),
        _ev(
            T(31, 11, 0),
            "task.comment",
            task(wbs["Widget gallery"]),
            "sam",
            body="Talked it through at standup — we'll drop a lower-priority story to "
            "protect the goal. Accepting the injection.",
        ),
        _ev(
            T(31, 11, 5),
            "sprint.scope_resolve",
            task(wbs["Widget gallery"]),
            "sam",
            to="ACCEPTED",
        ),
        _ev(T(31, 12, 0), "risk.status", "risk:scope-creep", "priya", to="MITIGATING"),
    ]

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
        "calendars": [
            {"slug": "aurora-core", "name": "Aurora core hours", "working_days": 31},
            {
                "slug": "aurora-flex",
                "name": "Aurora advisor (Mon/Wed/Fri)",
                "working_days": 21,
                "hours_per_day": 6.0,
            },
        ],
        # Capacity profiles (#621): full-time devs, a part-time Scrum Master, and
        # a 10% advisor on a non-default 3-day calendar.
        "resources": [
            {
                "slug": s,
                "name": dn,
                "job_role": role,
                "max_units": u,
                "calendar": cal,
                "account": s,
            }
            for s, dn, role, u, cal in [
                ("priya", "Priya Nair", "Product Owner", 1.0, "aurora-core"),
                ("sam", "Sam Okafor", "Scrum Master", 0.5, "aurora-core"),
                ("raj", "Raj Mehta", "Delivery Scheduler", 1.0, "aurora-core"),
                ("mei", "Mei Tanaka", "Engineer", 1.0, "aurora-core"),
                ("diego", "Diego Santos", "Engineer", 1.0, "aurora-core"),
                ("nadia", "Nadia Hassan", "Engineer", 1.0, "aurora-core"),
                ("tom", "Tom Becker", "QA Engineer", 1.0, "aurora-core"),
                ("ada", "Ada Boyega", "Accessibility Advisor", 0.1, "aurora-flex"),
            ]
        ],
        "projects": [
            {
                "slug": "aurora",
                "name": "Aurora App",
                "methodology": "AGILE",
                "start_date": D(0),
                "calendar": "aurora-core",
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
                "risks": [
                    {
                        "slug": "scope-creep",
                        "title": "Stakeholder scope creep on the launch increment",
                        "description": "New 'must-have' stories keep arriving mid-sprint, threatening the goal.",
                        "status": "OPEN",
                        "probability": 4,
                        "impact": 3,
                        "category": "ORGANIZATIONAL",
                        "response": "MITIGATE",
                        "owner": "priya",
                        "tasks": [wbs["Share sheet"], wbs["Widget gallery"]],
                    },
                    {
                        "slug": "external-api",
                        "title": "Push/notifications vendor API instability",
                        "description": "The third-party messaging API has had two outages this quarter.",
                        "status": "MITIGATING",
                        "probability": 3,
                        "impact": 4,
                        "category": "EXTERNAL",
                        "response": "MITIGATE",
                        "owner": "sam",
                        "tasks": [wbs["Push notifications"], wbs["Map view"]],
                    },
                    {
                        "slug": "key-person",
                        "title": "Biometric-auth expertise concentrated in one engineer",
                        "status": "OPEN",
                        "probability": 2,
                        "impact": 4,
                        "category": "ORGANIZATIONAL",
                        "response": "ACCEPT",
                        "owner": "priya",
                        "tasks": [wbs["Biometric login"]],
                    },
                    {
                        "slug": "store-review",
                        "title": "App-store review rejection delays release",
                        # Declared at its starting state; the risk.status timeline
                        # walks it OPEN → MITIGATING → RESOLVED so its History reads
                        # as a lifecycle, not a single frozen verdict (#1253).
                        "status": "OPEN",
                        "probability": 2,
                        "impact": 3,
                        "category": "EXTERNAL",
                        "response": "MITIGATE",
                        "owner": "sam",
                        "notes": "Pre-review checklist added; first submission approved on time.",
                        "tasks": [wbs["App rating prompt"]],
                    },
                ],
            }
        ],
        "events": events,
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

    # --- event timeline ----------------------------------------------------
    # Waterfall history: an inspection-fail-and-rework loop the synthesizer can't
    # produce, a crew reassignment, permit/weather field notes, and dated risk
    # lifecycles. Offsets are in days from project start (planned_start is
    # ``d(cursor*2)``); all stay <= the anchor (90 = "today").
    def task(wbs: str) -> str:
        return f"task:bayside:{wbs}"

    events: list[dict] = [
        # Permit gates the site-prep sign-off (1.4) — a field note plus the risk
        # moving from identified to actively mitigated.
        _ev(
            ts(22, 9, 0),
            "task.comment",
            task("1.4"),
            "tom",
            body="Survey package is ready, but the municipal permit is still in "
            "review — that's gating the site-prep sign-off.",
        ),
        _ev(ts(24, 10, 0), "risk.status", "risk:permit-delay", "sam", to="MITIGATING"),
        # Soil risk surfaces and is closed out by the geotech survey during excavation.
        _ev(
            ts(31, 9, 0),
            "task.comment",
            task("2.1"),
            "tom",
            body="Hit a soft layer at the east footing — ordering a geotech survey "
            "before we set rebar.",
        ),
        _ev(
            ts(31, 9, 30), "risk.status", "risk:soil-conditions", "tom", to="MITIGATING"
        ),
        _ev(ts(38, 14, 0), "risk.status", "risk:soil-conditions", "tom", to="CLOSED"),
        # Hero: Rebar & formwork (2.2) fails inspection on bar spacing, is re-tied,
        # and passes re-inspection — a non-linear Review → rework → Review path.
        _ev(
            ts(40, 8, 0),
            "task.comment",
            task("2.2"),
            "diego",
            body="Rebar cage and formwork up for the east footing.",
        ),
        _ev(ts(40, 9, 0), "task.status", task("2.2"), "diego", to="IN_PROGRESS"),
        _ev(
            ts(43, 15, 0),
            "task.comment",
            task("2.2"),
            "diego",
            body="Tied and shimmed. Calling for inspection.",
        ),
        _ev(ts(43, 15, 30), "task.status", task("2.2"), "diego", to="REVIEW"),
        _ev(
            ts(44, 10, 0),
            "task.comment",
            task("2.2"),
            "omar",
            body="Inspection: bar spacing on the north face is out of tolerance per "
            "the spec. Failing it — needs a re-tie.",
        ),
        _ev(ts(44, 10, 30), "task.status", task("2.2"), "omar", to="IN_PROGRESS"),
        _ev(
            ts(46, 14, 0),
            "task.comment",
            task("2.2"),
            "diego",
            body="Re-tied to spec and re-shot the spacing. Ready for re-inspection.",
        ),
        _ev(ts(46, 14, 30), "task.status", task("2.2"), "diego", to="REVIEW"),
        _ev(
            ts(47, 9, 0),
            "task.comment",
            task("2.2"),
            "omar",
            body="Re-inspection passed. Cleared to pour.",
        ),
        _ev(ts(47, 9, 30), "task.status", task("2.2"), "omar", to="COMPLETE"),
        # Weather note on the pour window.
        _ev(
            ts(50, 7, 0),
            "task.comment",
            task("2.3"),
            "diego",
            body="Rain moving in for the pour window — coordinating to pour ahead of "
            "the front so we don't lose the day.",
        ),
        # Reassignment: the west pour was booked to the MEP lead by mistake; it
        # belongs to the concrete foreman.
        _ev(
            ts(56, 8, 0),
            "task.comment",
            task("2.4"),
            "diego",
            body="The pours belong with the concrete crew — moving the west pour to Tom.",
        ),
        _ev(ts(56, 8, 5), "task.assign", task("2.4"), "diego", assignee="tom"),
        # Crane risk booked and resolved ahead of the structural phase.
        _ev(
            ts(70, 9, 0),
            "risk.status",
            "risk:crane-availability",
            "tom",
            to="MITIGATING",
        ),
        _ev(
            ts(78, 9, 0), "risk.status", "risk:crane-availability", "tom", to="RESOLVED"
        ),
        # In-flight framing phase: steel up, owner change-order in play.
        _ev(
            ts(74, 9, 0),
            "task.comment",
            task("3.1"),
            "diego",
            body="Steel is going up. Owner is still weighing a mezzanine design "
            "change — holding the final connections until it's resolved.",
        ),
        _ev(
            ts(76, 11, 0), "risk.status", "risk:design-change", "diego", to="MITIGATING"
        ),
    ]

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
                    ("raj", "Raj Mehta", "SCHEDULER"),
                    ("tom", "Tom Becker", "MEMBER"),
                    ("nadia", "Nadia Hassan", "MEMBER"),
                    ("omar", "Omar Aziz", "MEMBER"),
                    ("ada", "Ada Boyega", "VIEWER"),
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
            {
                "slug": "raj",
                "name": "Raj Mehta",
                "job_role": "Project Scheduler",
                "max_units": 1.0,
                "account": "raj",
                "calendar": "site",
            },
            {
                "slug": "ada",
                "name": "Ada Boyega",
                "job_role": "Owner's Rep (advisor)",
                "max_units": 0.1,
                "account": "ada",
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
                    {
                        "slug": "permit-delay",
                        "title": "Building permit approval slips",
                        "description": "The municipal permit office is running 3 weeks behind; gates site prep sign-off.",
                        # Starting state; risk.status walks it to MITIGATING (#1253).
                        "status": "OPEN",
                        "probability": 3,
                        "impact": 5,
                        "category": "EXTERNAL",
                        "response": "MITIGATE",
                        "owner": "sam",
                        "tasks": ["1.4"],
                    },
                    {
                        "slug": "design-change",
                        "title": "Owner-requested design change order",
                        "status": "OPEN",
                        "probability": 3,
                        "impact": 4,
                        "category": "PROJECT_MANAGEMENT",
                        "response": "MITIGATE",
                        "owner": "diego",
                        "tasks": ["3.1"],
                    },
                    {
                        "slug": "soil-conditions",
                        "title": "Unexpected soil conditions at excavation",
                        # Starting state; risk.status walks it OPEN → MITIGATING →
                        # CLOSED as the geotech survey clears it (#1253).
                        "status": "OPEN",
                        "probability": 2,
                        "impact": 4,
                        "category": "TECHNICAL",
                        "response": "ACCEPT",
                        "owner": "tom",
                        "notes": "Geotech survey confirmed bearing capacity; no remediation needed.",
                        "tasks": ["2.1"],
                    },
                    {
                        "slug": "subcontractor-default",
                        "title": "MEP subcontractor financial risk",
                        "description": "Primary MEP sub is over-extended; default would strand the rough-in.",
                        "status": "OPEN",
                        "probability": 2,
                        "impact": 5,
                        "category": "EXTERNAL",
                        "response": "TRANSFER",
                        "owner": "sam",
                        "tasks": ["4.4"],
                    },
                    {
                        "slug": "electrical-inspection",
                        "title": "Electrical rough-in inspection rework",
                        "status": "MITIGATING",
                        "probability": 3,
                        "impact": 3,
                        "category": "TECHNICAL",
                        "response": "MITIGATE",
                        "owner": "nadia",
                        "tasks": ["4.2"],
                    },
                    {
                        "slug": "material-escalation",
                        "title": "Steel & concrete price escalation",
                        "status": "ACCEPTED",
                        "probability": 4,
                        "impact": 3,
                        "category": "EXTERNAL",
                        "response": "ACCEPT",
                        "owner": "omar",
                        "tasks": ["3.2"],
                    },
                    {
                        "slug": "crane-availability",
                        "title": "Tower crane scheduling conflict",
                        # Starting state; risk.status walks it OPEN → MITIGATING →
                        # RESOLVED as the crane window is booked (#1253).
                        "status": "OPEN",
                        "probability": 2,
                        "impact": 3,
                        "category": "ORGANIZATIONAL",
                        "response": "MITIGATE",
                        "owner": "tom",
                        "notes": "Crane window booked and confirmed for the structural phase.",
                        "tasks": ["3.3"],
                    },
                    {
                        "slug": "commissioning-delay",
                        "title": "Building-systems commissioning slips occupancy",
                        "status": "OPEN",
                        "probability": 3,
                        "impact": 4,
                        "category": "TECHNICAL",
                        "response": "MITIGATE",
                        "owner": "diego",
                        "tasks": ["5.2"],
                    },
                ],
            }
        ],
        "events": events,
    }


# ---------------------------------------------------------------------------
# #619 Helios CRM Replacement — hybrid-small
# ---------------------------------------------------------------------------


def build_helios() -> dict:
    ns = "helios"
    tasks, deps = [], []

    # Anchor placed inside the active build sprint (#1253): the planning phase and
    # Build Sprint 1 sit in the past, Build Sprint 2 (days 74-87) brackets "today"
    # at day 81, and Build Sprint 3 is ahead.
    anchor = 81

    def D(offset: int) -> str:
        return d(offset, anchor)

    def T(offset: int, hour: int = 10, minute: int = 0) -> str:
        return ts(offset, hour, minute, anchor)

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
                "planned_start": D(cursor),
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
            "start_date": D(60),
            "finish_date": D(73),
            "committed_points": 30,
            "completed_points": 28,
            "capacity_points": 32,
        },
        {
            "slug": "he-sprint-2",
            "name": "Build Sprint 2",
            "state": "ACTIVE",
            "start_date": D(74),
            "finish_date": D(87),
            "committed_points": 32,
            "capacity_points": 32,
        },
        {
            "slug": "he-sprint-3",
            "name": "Build Sprint 3",
            "state": "PLANNED",
            "start_date": D(88),
            "finish_date": D(101),
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
        points = [3, 5, 8][i % 3]
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
            "story_points": points,
            # A working-day duration so the story has real width on the schedule
            # once the sprint-window floor (ADR-0168) positions it — without one a
            # story defaults to a 1-day sliver. Scaled ~points/2 and kept inside the
            # ~10-working-day sprint so the parallel stories all fit their window.
            "duration": {3: 2, 5: 3, 8: 5}[points],
            # Two engineers share the build; the timeline then load-balances a
            # couple of stories between them as sprints fill up.
            "assignee": ["mei", "nadia"][i % 2],
            "sprint": f"he-sprint-{sidx + 1}",
            "delivery_mode": "scrum",
            "governance_class": "flow",
        }
        tasks.append(story)
    # cross-phase dependency: the data-migration story depends on the planning data-model task
    deps.append({"predecessor": "1.5", "successor": "2.17", "dep_type": "FS", "lag": 0})

    # --- event timeline ----------------------------------------------------
    # Hybrid history: the finished waterfall plan hands off to the agile build, a
    # build story takes a non-linear review path, the two engineers load-balance,
    # a mid-sprint injection is *rejected* (deferred to a later release), and the
    # build-phase risks resolve as defects are found and fixed. ``anchor`` = 81.
    def task(wbs: str) -> str:
        return f"task:helios:{wbs}"

    def sprint(slug: str) -> str:
        return f"sprint:helios:{slug}"

    events: list[dict] = [
        # The plan-to-build bridge: the data model from planning is the contract
        # the migration story will build against.
        _ev(
            T(75, 9, 0),
            "task.comment",
            task("2.17"),
            "ivan",
            body="The data model from planning (1.5) is the contract for the migration "
            "run — freezing it before Sprint 3 picks this up.",
        ),
        # Build Sprint 1 — activate, a hero story with a real review bounce, close.
        _ev(T(60, 9, 0), "sprint.activate", sprint("he-sprint-1"), "jordan"),
        _ev(
            T(61, 9, 0),
            "task.comment",
            task("2.3"),
            "nadia",
            body="Starting the lead pipeline — stages, transitions, and the rollup.",
        ),
        _ev(T(62, 10, 0), "task.status", task("2.3"), "nadia", to="IN_PROGRESS"),
        _ev(
            T(66, 15, 0),
            "task.comment",
            task("2.3"),
            "nadia",
            body="Pipeline and stage automation done. PR up.",
        ),
        _ev(T(66, 15, 30), "task.status", task("2.3"), "nadia", to="REVIEW"),
        _ev(
            T(67, 11, 0),
            "task.comment",
            task("2.3"),
            "mei",
            body="Review: stage transitions don't fire the activity hook, so the "
            "timeline misses them. Sending it back.",
        ),
        _ev(T(67, 11, 30), "task.status", task("2.3"), "mei", to="IN_PROGRESS"),
        _ev(
            T(70, 14, 0),
            "task.comment",
            task("2.3"),
            "nadia",
            body="Wired stage transitions into the activity stream. Re-review please.",
        ),
        _ev(T(70, 14, 30), "task.status", task("2.3"), "nadia", to="REVIEW"),
        _ev(
            T(71, 16, 0),
            "task.comment",
            task("2.3"),
            "mei",
            body="Looks good now. Merged.",
        ),
        _ev(T(71, 16, 30), "task.status", task("2.3"), "mei", to="COMPLETE"),
        # Integration defects: found and fixed during the sprint (the realized risk).
        _ev(
            T(64, 10, 0),
            "risk.status",
            "risk:integration-defects",
            "mei",
            to="MITIGATING",
        ),
        _ev(
            T(72, 16, 0),
            "risk.status",
            "risk:integration-defects",
            "mei",
            to="RESOLVED",
        ),
        _ev(
            T(73, 17, 0),
            "sprint.close",
            sprint("he-sprint-1"),
            "jordan",
            goal_outcome="MET",
        ),
        # Build Sprint 2 (active) — a load-balancing reassignment and a *rejected*
        # mid-sprint injection that the team defers to protect the goal.
        _ev(
            T(78, 9, 0),
            "task.comment",
            task("2.7"),
            "ivan",
            body="Nadia's carrying three active stories — moving Activity timeline to "
            "Mei to keep the sprint flowing.",
        ),
        _ev(T(78, 9, 5), "task.assign", task("2.7"), "ivan", assignee="mei"),
        _ev(
            T(76, 9, 0),
            "task.comment",
            task("2.16"),
            "jordan",
            body="Sales is asking for Search & filters now — pulling it into the sprint.",
        ),
        _ev(
            T(76, 9, 5), "sprint.scope_inject", task("2.16"), "jordan", goal_impact=True
        ),
        _ev(T(77, 10, 0), "task.status", task("2.16"), "mei", to="IN_PROGRESS"),
        _ev(
            T(79, 15, 0),
            "task.comment",
            task("2.16"),
            "ivan",
            body="This pushes us well past capacity and risks the sprint goal. "
            "Deferring it to the next release.",
        ),
        _ev(T(79, 15, 5), "sprint.scope_resolve", task("2.16"), "ivan", to="REJECTED"),
        _ev(T(79, 15, 10), "task.status", task("2.16"), "mei", to="BACKLOG"),
        _ev(
            T(79, 15, 30),
            "risk.status",
            "risk:scope-injection",
            "jordan",
            to="MITIGATING",
        ),
    ]

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
                    ("raj", "Raj Mehta", "SCHEDULER"),
                    ("mei", "Mei Tanaka", "MEMBER"),
                    ("nadia", "Nadia Hassan", "MEMBER"),
                    ("ada", "Ada Boyega", "VIEWER"),
                ]
            ]
        ),
        "calendars": [
            {"slug": "helios-core", "name": "Helios core hours", "working_days": 31},
            {
                "slug": "helios-advisor",
                "name": "Helios advisor (Tue/Thu)",
                "working_days": 10,
                "hours_per_day": 6.0,
            },
        ],
        # Capacity profiles (#621): full-time engineers, a part-time architect who
        # advises through build, and a 10% executive advisor on a 2-day calendar.
        "resources": [
            {
                "slug": "ivan",
                "name": "Ivan Petrov",
                "job_role": "Solutions Architect",
                "max_units": 0.5,
                "account": "ivan",
                "calendar": "helios-core",
            },
            {
                "slug": "jordan",
                "name": "Jordan Blake",
                "job_role": "Product Owner",
                "max_units": 1.0,
                "account": "jordan",
                "calendar": "helios-core",
            },
            {
                "slug": "raj",
                "name": "Raj Mehta",
                "job_role": "Delivery Scheduler",
                "max_units": 1.0,
                "account": "raj",
                "calendar": "helios-core",
            },
            {
                "slug": "mei",
                "name": "Mei Tanaka",
                "job_role": "Engineer",
                "max_units": 1.0,
                "account": "mei",
                "calendar": "helios-core",
            },
            {
                "slug": "nadia",
                "name": "Nadia Hassan",
                "job_role": "Engineer",
                "max_units": 1.0,
                "account": "nadia",
                "calendar": "helios-core",
            },
            {
                "slug": "ada",
                "name": "Ada Boyega",
                "job_role": "Executive Advisor",
                "max_units": 0.1,
                "account": "ada",
                "calendar": "helios-advisor",
            },
        ],
        "projects": [
            {
                "slug": "helios",
                "name": "Helios CRM",
                "methodology": "HYBRID",
                "start_date": D(0),
                "calendar": "helios-core",
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
                    {
                        "slug": "integration-defects",
                        "title": "CRM integration mapping defects (realized)",
                        "description": "Realized in the build phase: the integration suite found mapping defects.",
                        # Starting state; risk.status walks it OPEN → MITIGATING →
                        # RESOLVED as the defects are found and fixed mid-sprint.
                        "status": "OPEN",
                        "probability": 4,
                        "impact": 4,
                        "category": "TECHNICAL",
                        "response": "MITIGATE",
                        "owner": "mei",
                        "notes": "Realized: 3 field-mapping defects found in sprint 2; fixed, cost ~4 days of rework.",
                        "tasks": ["2.8"],
                    },
                    {
                        "slug": "scope-injection",
                        "title": "Late requirements injected into the build sprints",
                        "status": "OPEN",
                        "probability": 3,
                        "impact": 3,
                        "category": "PROJECT_MANAGEMENT",
                        "response": "MITIGATE",
                        "owner": "jordan",
                        "tasks": ["2.16"],
                    },
                    {
                        "slug": "team-ramp",
                        "title": "Build-team ramp-up on the new stack",
                        "status": "ACCEPTED",
                        "probability": 2,
                        "impact": 3,
                        "category": "ORGANIZATIONAL",
                        "response": "ACCEPT",
                        "owner": "ivan",
                        "tasks": ["2.1"],
                    },
                ],
            }
        ],
        "events": events,
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
