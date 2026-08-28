#!/usr/bin/env python3
"""Generate the "1.0 GA Launch" bundled sample seed (#1151, converged in #3098).

Developer tool (not run at runtime). This pack used to be a 969-line Python
management command (``seed_ga_launch_program``) that built rows directly. That
made it the one sample story nobody could download, hash, inspect, round-trip,
or load from Settings → System → Demo data — and it was not what the "Load demo
data" button served. #3098 converged it into the same schema every other pack
uses.

What the pack is for: a program of four workstreams shipping **one** outcome,
where **shared people** and **cross-project dependencies** create coordination
pressure a standalone project cannot show.

- **A — Platform Hardening & Scale** (waterfall)
- **B — SOC 2 Type II Readiness** (waterfall, gated governance)
- **C — Security Pen-Test & Remediation** (hybrid; remediation Kanban with WIP limits)
- **D — GA Marketing & Launch** (agile; two sprints)

Three **cross-project** edges form a program-true critical path: ``C5 → B3``,
``A5 → D5``, ``C5 → D5``. Seeded ``Dependency`` rows land at
``pending_acceptance=False``, so the program-scoped CPM pass treats them as
modeled constraints rather than a per-project illusion.

    python scripts/seeds/build_ga_launch.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Anchor-relative dates (ADR-0114). The Python seeder pinned 2026-07-06, so the
# pack aged into a museum piece the moment the date passed; every JSON pack is
# anchor-relative so "today" always lands mid-program. 45 puts the execution
# front on the security remediation (C3) and inside the second marketing sprint.
ANCHOR_OFFSET = 45


def d(offset: int) -> str:
    return f"A{offset - ANCHOR_OFFSET:+d}"


def ts(offset: int, hour: int = 10, minute: int = 0) -> str:
    """An anchor-relative event timestamp. Keep ``offset <= ANCHOR_OFFSET``."""
    return f"{d(offset)}T{hour:02d}:{minute:02d}"


def _ev(
    at: str, action: str, target: str = "", actor: str = "", **extra: object
) -> dict:
    event: dict = {"at": at, "action": action}
    if target:
        event["target"] = target
    if actor:
        event["actor"] = actor
    event.update(extra)
    return event


def board_columns(wip: dict[str, int] | None = None) -> list[dict[str, object]]:
    """A five-status board config; ``wip`` sets a limit per status."""
    wip = wip or {}
    labels = {
        "BACKLOG": "Backlog",
        "NOT_STARTED": "Not started",
        "IN_PROGRESS": "In progress",
        "REVIEW": "Review",
        "COMPLETE": "Complete",
    }
    out: list[dict[str, object]] = []
    for status, label in labels.items():
        column: dict[str, object] = {"status": status, "label": label, "visible": True}
        if status in wip:
            column["wip_limit"] = wip[status]
        out.append(column)
    return out


# (slug, display, program role, job role, max_units)
PERSONAS = [
    ("dana", "Dana Okafor", "OWNER", "Program Manager", 1.0),
    ("malcolm", "Malcolm Reed", "ADMIN", "Platform Engineer", 1.0),
    ("janus", "Janus Vela", "MEMBER", "InfoSec Engineer", 1.0),
    ("bob", "Bob Tran", "MEMBER", "Compliance Officer", 1.0),
    ("jane", "Jane Castellano", "MEMBER", "Marketing Lead", 1.0),
    # The pack's part-time capacity: a shared technical writer split across the
    # SOC 2 policy work and the launch content, which is why she is the person
    # both workstreams end up waiting on.
    ("lena", "Lena Fischer", "MEMBER", "Technical Writer", 0.6),
    ("sam", "Sam Ortiz", "VIEWER", "Backend Engineer", 1.0),
]


def _accounts() -> list[dict]:
    return [
        {
            "slug": slug,
            "username": f"ga-{slug}",
            "email": f"ga-{slug}@trueppm.demo",
            "display_name": display,
            "role": role,
        }
        for slug, display, role, _job, _units in PERSONAS
    ]


def _resources() -> list[dict]:
    return [
        {
            "slug": slug,
            "name": display,
            "job_role": job,
            "max_units": units,
            "account": slug,
            "calendar": "standard",
        }
        for slug, display, _role, job, units in PERSONAS
    ]


LABELS = [
    {"slug": "critical-path", "name": "Critical path", "color": "rose", "position": 0},
    {
        "slug": "cross-workstream",
        "name": "Cross-workstream",
        "color": "purple",
        "position": 1,
    },
    {"slug": "gate", "name": "Release gate", "color": "amber", "position": 2},
    {
        "slug": "compliance",
        "name": "Compliance evidence",
        "color": "teal",
        "position": 3,
    },
]


def build_ga_launch() -> dict:
    """Assemble the whole pack."""
    # (wbs, name, day, duration, status, pct, labels, assignee, [(resource, units)])
    # Milestones carry duration 0 and no allocation.
    platform = [
        (
            "1",
            "Capacity baseline & load test",
            0,
            5,
            "COMPLETE",
            None,
            ["critical-path"],
            "malcolm",
            [("malcolm", 1.0), ("sam", 1.0)],
        ),
        (
            "2",
            "Autoscaling & HA rollout",
            7,
            8,
            "COMPLETE",
            None,
            ["critical-path"],
            "malcolm",
            [("malcolm", 1.0)],
        ),
        (
            "3",
            "DB failover hardening",
            7,
            6,
            "COMPLETE",
            None,
            [],
            "sam",
            [("sam", 1.0)],
        ),
        (
            "4",
            "Observability & alerting",
            7,
            4,
            "COMPLETE",
            None,
            [],
            "malcolm",
            [("malcolm", 0.5)],
        ),
        ("5", "Platform GA-ready", 23, 0, "COMPLETE", None, ["gate"], "malcolm", []),
    ]
    soc2 = [
        (
            "1",
            "Control gap assessment",
            0,
            5,
            "COMPLETE",
            None,
            ["compliance"],
            "bob",
            [("bob", 1.0)],
        ),
        (
            "2",
            "Policy authoring",
            7,
            8,
            "COMPLETE",
            None,
            ["compliance"],
            "bob",
            [("bob", 1.0), ("lena", 0.5), ("janus", 0.5)],
        ),
        (
            "3",
            "Evidence collection",
            56,
            6,
            "NOT_STARTED",
            None,
            ["compliance", "cross-workstream"],
            "bob",
            [("bob", 1.0), ("janus", 0.5)],
        ),
        (
            "4",
            "Internal readiness review",
            64,
            3,
            "NOT_STARTED",
            None,
            [],
            "bob",
            [("bob", 1.0)],
        ),
        ("5", "Audit-ready", 68, 0, "NOT_STARTED", None, ["gate"], "bob", []),
    ]
    security = [
        (
            "1",
            "Pen-test execution",
            24,
            5,
            "COMPLETE",
            None,
            ["critical-path"],
            "janus",
            [("janus", 1.0)],
        ),
        (
            "2",
            "Findings triage",
            31,
            2,
            "COMPLETE",
            None,
            [],
            "janus",
            [("janus", 1.0)],
        ),
        # The execution front. Re-estimated 5 -> 7 once triage sized the criticals,
        # which is the drift the GA plan baseline reads against.
        (
            "3",
            "Remediate critical findings",
            40,
            7,
            "IN_PROGRESS",
            65.0,
            ["critical-path"],
            "janus",
            [("janus", 1.0), ("malcolm", 0.5), ("sam", 0.5)],
        ),
        (
            "4",
            "Re-test & verification",
            50,
            3,
            "NOT_STARTED",
            None,
            [],
            "janus",
            [("janus", 1.0)],
        ),
        (
            "5",
            "Security sign-off",
            54,
            0,
            "NOT_STARTED",
            None,
            ["gate", "cross-workstream"],
            "janus",
            [],
        ),
    ]
    marketing = [
        (
            "1",
            "Messaging & positioning",
            0,
            3,
            "COMPLETE",
            None,
            [],
            "jane",
            [("jane", 1.0)],
        ),
        (
            "2",
            "Website & landing pages",
            4,
            5,
            "COMPLETE",
            None,
            [],
            "jane",
            [("jane", 1.0), ("lena", 0.5)],
        ),
        (
            "3",
            "Launch blog & docs",
            40,
            3,
            "IN_PROGRESS",
            60.0,
            [],
            "lena",
            [("lena", 0.5)],
        ),
        (
            "4",
            "Press & analyst outreach",
            44,
            3,
            "NOT_STARTED",
            None,
            [],
            "jane",
            [("jane", 1.0)],
        ),
        (
            "5",
            "GA announcement go-live",
            58,
            0,
            "NOT_STARTED",
            None,
            ["gate", "critical-path", "cross-workstream"],
            "jane",
            [],
        ),
    ]

    story_points = {"1": 5, "2": 8, "3": 5, "4": 5}
    sprint_of = {"1": "ga-s1", "2": "ga-s1", "3": "ga-s2", "4": "ga-s2", "5": "ga-s2"}
    remaining = {"3": 2}

    def _tasks(rows: list, *, agile: bool = False) -> list[dict]:
        out: list[dict] = []
        for wbs, name, day, dur, status, pct, labels, assignee, allocs in rows:
            task: dict = {
                "wbs_path": wbs,
                "name": name,
                "status": status,
                "planned_start": d(day),
                "assignee": assignee,
                "governance_class": "gated" if "gate" in labels else "flow",
            }
            if dur == 0:
                task["is_milestone"] = True
                task["delivery_mode"] = "milestone"
            else:
                task["duration"] = dur
                task["delivery_mode"] = "scrum" if agile else "waterfall"
            if agile:
                task["type"] = "story" if dur else "task"
                if wbs in story_points:
                    task["story_points"] = story_points[wbs]
                task["sprint"] = sprint_of[wbs]
                if wbs in remaining:
                    task["remaining_points"] = remaining[wbs]
            if status == "COMPLETE":
                task["percent_complete"] = 100.0
            elif pct is not None:
                task["percent_complete"] = pct
            if labels:
                task["labels"] = labels
            if allocs:
                task["assignments"] = [{"resource": r, "units": u} for r, u in allocs]
            out.append(task)
        return out

    def _deps(pairs: list[tuple[str, str, str]]) -> list[dict]:
        return [
            {"predecessor": p, "successor": s, "dep_type": t, "lag": 0}
            for p, s, t in pairs
        ]

    platform_project = {
        "slug": "ga-platform",
        "name": "Platform Hardening & Scale",
        "description": "Make the platform carry GA load: capacity, autoscaling, failover, "
        "and the observability to prove it.",
        "methodology": "WATERFALL",
        "start_date": d(0),
        "calendar": "standard",
        "lead": "malcolm",
        "default_view": "SCHEDULE",
        "labels": LABELS,
        "tasks": _tasks(platform),
        # A2 SS A4: observability spins up alongside the rollout rather than after it.
        "dependencies": _deps(
            [
                ("1", "2", "FS"),
                ("1", "3", "FS"),
                ("2", "4", "SS"),
                ("2", "5", "FS"),
                ("3", "5", "FS"),
                ("4", "5", "FS"),
            ]
        ),
        "members": [
            {"account": "malcolm", "role": "OWNER"},
            {"account": "dana", "role": "ADMIN"},
            {"account": "sam", "role": "MEMBER"},
            {"account": "janus", "role": "VIEWER"},
        ],
        "risks": [
            {
                "slug": "load-ceiling",
                "title": "Autoscaling ceiling below the GA load projection",
                "status": "RESOLVED",
                "probability": 3,
                "impact": 5,
                "category": "TECHNICAL",
                "response": "MITIGATE",
                "owner": "malcolm",
                "trigger": "Load test sustains under 3x current peak without horizontal recovery.",
                "contingency": "Pre-warm a second node pool for launch week and cap "
                "signup throughput until the autoscaler is proven.",
                "notes": "Closed by the capacity baseline: held at 5x peak with recovery "
                "inside 90 seconds.",
                "tasks": ["1", "2"],
            },
            {
                "slug": "failover-untested",
                "title": "DB failover never exercised under write load",
                "status": "OPEN",
                "probability": 2,
                "impact": 5,
                "category": "TECHNICAL",
                "response": "MITIGATE",
                "owner": "sam",
                "trigger": "A failover drill has not run against production-shaped write volume "
                "within 30 days of GA.",
                "contingency": "Declare GA with a documented manual failover runbook and a "
                "named on-call owner, rather than an untested automatic path.",
                "tasks": ["3"],
            },
        ],
    }

    soc2_project = {
        "slug": "ga-soc2",
        "name": "SOC 2 Type II Readiness",
        "description": "Reach audit-ready: control gaps closed, policies written, evidence "
        "collected, and an internal readiness review passed.",
        "methodology": "WATERFALL",
        "start_date": d(0),
        "calendar": "standard",
        "lead": "bob",
        "default_view": "SCHEDULE",
        "labels": LABELS,
        "tasks": _tasks(soc2),
        # The SOC 2 evidence window waits on the security sign-off across the
        # workstream boundary — one of the three cross-project edges that make
        # the program critical path program-true rather than a per-project
        # illusion. Declared on the successor side, which is where the schema
        # resolves a "<project>:<wbs>" predecessor ref from.
        "dependencies": _deps(
            [
                ("1", "2", "FS"),
                ("2", "3", "FS"),
                ("3", "4", "FS"),
                ("4", "5", "FS"),
                ("ga-security:5", "3", "FS"),
            ]
        ),
        "members": [
            {"account": "bob", "role": "OWNER"},
            {"account": "dana", "role": "ADMIN"},
            {"account": "lena", "role": "MEMBER"},
            {"account": "janus", "role": "MEMBER"},
        ],
        "risks": [
            {
                "slug": "evidence-window",
                "title": "Evidence window opens after the audit date is booked",
                "description": "Evidence collection is gated on security sign-off across the "
                "workstream boundary, so any slip in remediation lands directly on the audit.",
                "status": "MITIGATING",
                "probability": 4,
                "impact": 4,
                "category": "ORGANIZATIONAL",
                "response": "MITIGATE",
                "owner": "bob",
                "mitigation_due_date": d(50),
                "trigger": "Security sign-off (ga-security:5) forecasts later than day 54.",
                "contingency": "Collect the control evidence that does not depend on the "
                "pen-test remediation first, and hold only the security controls for the "
                "sign-off — splitting the dependency rather than waiting on all of it.",
                "tasks": ["3"],
            },
            {
                "slug": "writer-contention",
                "title": "Shared technical writer is the constraint on two workstreams",
                "status": "OPEN",
                "probability": 4,
                "impact": 3,
                "category": "ORGANIZATIONAL",
                "response": "ACCEPT",
                "owner": "dana",
                "trigger": "Policy authoring and launch content need the writer in the same week.",
                "contingency": "Launch content wins; the policy narrative is drafted by the "
                "control owners and edited after GA.",
                "notes": "Accepted deliberately: Lena is at 0.6 capacity across both, and "
                "backfilling a writer mid-program costs more ramp than it returns.",
                "tasks": ["2"],
            },
        ],
    }

    security_project = {
        "slug": "ga-security",
        "name": "Security Pen-Test & Remediation",
        "description": "Third-party pen test, triage, remediation of the criticals, and a "
        "verified sign-off the launch and the audit both gate on.",
        "methodology": "HYBRID",
        "start_date": d(0),
        "calendar": "standard",
        "lead": "janus",
        "default_view": "BOARD",
        "labels": LABELS,
        "tasks": _tasks(security),
        "dependencies": _deps(
            [("1", "2", "FS"), ("2", "3", "FS"), ("3", "4", "FS"), ("4", "5", "FS")]
        ),
        # The remediation flow runs as Kanban with real WIP limits — three items in
        # progress, two in review — so the board teaches the constraint rather than
        # just displaying columns.
        "board_columns": board_columns(wip={"IN_PROGRESS": 3, "REVIEW": 2}),
        "members": [
            {"account": "janus", "role": "OWNER"},
            {"account": "dana", "role": "ADMIN"},
            {"account": "malcolm", "role": "SCHEDULER"},
            {"account": "sam", "role": "MEMBER"},
            {"account": "bob", "role": "VIEWER"},
        ],
        "baselines": [
            {
                "name": "GA plan baseline",
                "is_active": True,
                "captured_at": d(20),
                # Captured before triage sized the criticals. Remediation was
                # planned at 5 days and is running at 7 — the variance the whole
                # program's finish is currently reading against.
                "tasks": [
                    {"task": "1", "start": d(24), "finish": d(29), "duration": 5},
                    {"task": "2", "start": d(31), "finish": d(33), "duration": 2},
                    {"task": "3", "start": d(35), "finish": d(40), "duration": 5},
                    {"task": "4", "start": d(45), "finish": d(48), "duration": 3},
                ],
            }
        ],
        "risks": [
            {
                "slug": "critical-findings",
                "title": "Pen test surfaces more criticals than the window absorbs",
                "status": "MITIGATING",
                "probability": 4,
                "impact": 5,
                "category": "TECHNICAL",
                "response": "MITIGATE",
                "owner": "janus",
                "mitigation_due_date": d(50),
                "trigger": "More than five critical findings, or any critical needing an "
                "architectural change rather than a patch.",
                "contingency": "Ship GA with the criticals fixed and the highs documented as "
                "known issues with compensating controls, rather than moving the date.",
                "notes": "Realized in triage: seven criticals against a plan sized for four. "
                "Remediation re-estimated 5 days to 7 — the variance the GA plan baseline shows.",
                "tasks": ["2", "3"],
            },
            {
                "slug": "retest-capacity",
                "title": "Re-test slot depends on the external tester's calendar",
                "status": "OPEN",
                "probability": 3,
                "impact": 4,
                "category": "EXTERNAL",
                "response": "TRANSFER",
                "owner": "janus",
                "trigger": "The tester cannot confirm a re-test slot within five working days "
                "of remediation completing.",
                "contingency": "The retainer carries a contractual 5-day re-test SLA with a "
                "fee credit; the fallback is an internal verification pass signed by the "
                "security lead, which the auditor accepts as interim evidence.",
                "notes": "The schedule exposure is transferred by contract, not removed — a "
                "credit does not buy back the launch date, which is why this stays open.",
                "tasks": ["4", "5"],
            },
        ],
    }

    marketing_project = {
        "slug": "ga-marketing",
        "name": "GA Marketing & Launch",
        "description": "Positioning, the launch site, blog and docs, press outreach, and the "
        "go-live itself — gated on the platform and the security sign-off.",
        "methodology": "AGILE",
        "start_date": d(0),
        "calendar": "standard",
        "lead": "jane",
        "default_view": "BOARD",
        "labels": LABELS,
        "tasks": _tasks(marketing, agile=True),
        # GA go-live gates on BOTH the platform milestone and the security
        # sign-off — the convergence the whole program is organized around.
        "dependencies": _deps(
            [
                ("1", "3", "FS"),
                ("1", "4", "FS"),
                ("ga-platform:5", "5", "FS"),
                ("ga-security:5", "5", "FS"),
            ]
        ),
        "board_columns": board_columns(),
        "members": [
            {"account": "jane", "role": "OWNER"},
            {"account": "dana", "role": "ADMIN"},
            {"account": "lena", "role": "MEMBER"},
            {"account": "bob", "role": "VIEWER"},
        ],
        "sprints": [
            {
                "slug": "ga-s1",
                "name": "Launch Readiness",
                "goal": "Land the messaging and the launch site so everything after this is "
                "content, not positioning.",
                "state": "COMPLETED",
                "start_date": d(0),
                "finish_date": d(11),
                # Committed the blog/docs story too; it did not land and was
                # carried into Launch Week, which is the gap between 18 and 13.
                "capacity_points": 18,
                "committed_points": 18,
                "completed_points": 13,
            },
            {
                "slug": "ga-s2",
                "name": "Launch Week",
                "goal": "Finish the launch content and execute the GA go-live behind the "
                "platform and security gates.",
                "state": "ACTIVE",
                "start_date": d(40),
                "finish_date": d(51),
                "capacity_points": 12,
                "committed_points": 10,
                "target_milestone": "5",
            },
        ],
        "risks": [
            {
                "slug": "announce-before-signoff",
                "title": "Announcement date set before the security gate clears",
                "status": "MITIGATING",
                "probability": 3,
                "impact": 5,
                "category": "PROJECT_MANAGEMENT",
                "response": "AVOID",
                "owner": "jane",
                "trigger": "Press embargo time is committed to an outlet before security "
                "sign-off is forecast to clear.",
                "contingency": "Avoided by construction rather than managed: the go-live "
                "milestone is a hard successor of both the platform and security gates, so "
                "the date cannot be promised ahead of them without breaking the schedule.",
                "tasks": ["5"],
            }
        ],
    }

    def a(wbs: str) -> str:
        return f"task:ga-platform:{wbs}"

    def c(wbs: str) -> str:
        return f"task:ga-security:{wbs}"

    def m(wbs: str) -> str:
        return f"task:ga-marketing:{wbs}"

    events: list[dict] = [
        # --- Platform: the load-test result that closed the ceiling risk -------
        _ev(ts(3, 9, 0), "task.status", a("1"), "malcolm", to="IN_PROGRESS"),
        _ev(
            ts(5, 16, 0),
            "task.comment",
            a("1"),
            "malcolm",
            body="Capacity baseline is in: we held 5x observed peak with autoscaler "
            "recovery inside 90 seconds. That is well past the GA projection.",
        ),
        _ev(
            ts(5, 16, 30),
            "risk.note",
            "risk:load-ceiling",
            "malcolm",
            body="Load test cleared the ceiling we were worried about. Closing this — the "
            "remaining platform exposure is failover, not scale.",
        ),
        _ev(ts(5, 17, 0), "risk.status", "risk:load-ceiling", "malcolm", to="RESOLVED"),
        _ev(ts(6, 9, 0), "task.status", a("1"), "malcolm", to="COMPLETE"),
        _ev(ts(20, 11, 0), "risk.status", "risk:failover-untested", "sam", to="OPEN"),
        _ev(
            ts(23, 15, 0),
            "task.comment",
            a("5"),
            "malcolm",
            body="Platform is GA-ready: autoscaling, failover hardening and alerting are all "
            "in. The go-live milestone can stop waiting on us.",
        ),
        # --- SOC 2: the writer contention Dana decides not to fix --------------
        _ev(
            ts(12, 10, 0),
            "task.comment",
            "task:ga-soc2:2",
            "bob",
            body="Policy authoring needs Lena for the control narratives, but launch content "
            "needs her the same week. Flagging it rather than quietly double-booking.",
        ),
        _ev(ts(12, 14, 0), "task.assign", "task:ga-soc2:2", "dana", assignee="bob"),
        _ev(
            ts(13, 9, 30),
            "risk.note",
            "risk:writer-contention",
            "dana",
            body="Decision: launch content wins the week. Control owners draft their own "
            "narratives and Lena edits after GA. Backfilling a writer now costs more "
            "ramp than it buys — accepting this rather than pretending we solved it.",
        ),
        _ev(ts(13, 10, 0), "risk.status", "risk:writer-contention", "dana", to="OPEN"),
        # --- Security: the triage that re-estimated remediation ---------------
        _ev(ts(24, 9, 0), "task.status", c("1"), "janus", to="IN_PROGRESS"),
        _ev(ts(29, 17, 0), "task.status", c("1"), "janus", to="COMPLETE"),
        _ev(ts(31, 9, 0), "task.status", c("2"), "janus", to="IN_PROGRESS"),
        _ev(
            ts(32, 16, 0),
            "task.comment",
            c("2"),
            "janus",
            body="Triage done: seven criticals, not the four we planned for. Two of them are "
            "auth-path issues that need a real fix, not a patch.",
        ),
        _ev(
            ts(32, 16, 30),
            "risk.note",
            "risk:critical-findings",
            "janus",
            body="Re-estimating remediation from 5 days to 7. The GA plan baseline keeps the "
            "5 so the slip stays visible instead of becoming the plan.",
        ),
        _ev(
            ts(32, 17, 0),
            "risk.status",
            "risk:critical-findings",
            "janus",
            to="MITIGATING",
        ),
        _ev(ts(33, 9, 0), "task.status", c("2"), "janus", to="COMPLETE"),
        _ev(ts(40, 9, 0), "task.status", c("3"), "janus", to="IN_PROGRESS"),
        # Malcolm gets pulled across the boundary — the contention the program
        # exists to show. He is at 1.0 on the platform rollout already.
        _ev(
            ts(41, 9, 0),
            "task.comment",
            c("3"),
            "dana",
            body="Pulling Malcolm onto the auth-path criticals at half time. He is still "
            "carrying the platform rollout, so this is a real over-allocation, not a "
            "spare-capacity reassignment — it is the trade we are choosing.",
        ),
        _ev(ts(41, 9, 30), "task.assign", c("3"), "dana", assignee="janus"),
        _ev(
            ts(43, 15, 0),
            "task.comment",
            c("3"),
            "janus",
            body="Five of seven criticals closed and verified locally. The two auth-path "
            "fixes are in review.",
        ),
        _ev(
            ts(44, 10, 0), "risk.status", "risk:evidence-window", "bob", to="MITIGATING"
        ),
        _ev(
            ts(44, 10, 30),
            "risk.note",
            "risk:evidence-window",
            "bob",
            body="Splitting evidence collection: everything that does not depend on the "
            "pen-test result starts now, and only the security controls wait for "
            "sign-off. That takes the audit date off the remediation critical path.",
        ),
        # --- Marketing: sprint 1 closes short, sprint 2 runs -------------------
        _ev(ts(0, 9, 0), "sprint.activate", "sprint:ga-marketing:ga-s1", "jane"),
        _ev(ts(2, 10, 0), "task.status", m("1"), "jane", to="IN_PROGRESS"),
        _ev(ts(4, 16, 0), "task.status", m("1"), "jane", to="COMPLETE"),
        _ev(ts(5, 9, 0), "task.status", m("2"), "jane", to="IN_PROGRESS"),
        _ev(
            ts(9, 15, 0),
            "task.comment",
            m("3"),
            "lena",
            body="Blog and docs are not going to land this sprint — the policy narratives "
            "took the days. Carrying it to Launch Week.",
        ),
        _ev(ts(10, 17, 0), "task.status", m("2"), "jane", to="COMPLETE"),
        _ev(
            ts(11, 17, 0),
            "sprint.close",
            "sprint:ga-marketing:ga-s1",
            "jane",
            goal_outcome="MET",
        ),
        _ev(
            ts(11, 17, 30),
            "retro.action",
            "sprint:ga-marketing:ga-s1",
            "jane",
            body="Stop committing Lena's stories at full points while she is split across "
            "two workstreams — size them at her real availability.",
        ),
        _ev(
            ts(11, 17, 45),
            "retro.action",
            "sprint:ga-marketing:ga-s1",
            "lena",
            body="Draft the launch blog against the messaging doc before the site copy is "
            "final, so the two are not serialized.",
        ),
        _ev(ts(40, 9, 0), "sprint.activate", "sprint:ga-marketing:ga-s2", "jane"),
        _ev(ts(40, 9, 30), "task.status", m("3"), "lena", to="IN_PROGRESS"),
        # A mid-sprint injection that is accepted: the security disclosure note
        # is not optional once the pen test found criticals.
        _ev(
            ts(42, 11, 0),
            "task.comment",
            m("4"),
            "dana",
            body="Adding a security-disclosure paragraph to press outreach — with seven "
            "criticals found and fixed, the announcement has to say so.",
        ),
        _ev(ts(42, 11, 15), "sprint.scope_inject", m("4"), "dana", goal_impact=False),
        _ev(
            ts(42, 11, 30),
            "sprint.scope_resolve",
            m("4"),
            "jane",
            to="ACCEPTED",
            body="Accepted. It is a paragraph, not a story, and shipping the announcement "
            "without it would be the bigger problem.",
        ),
        _ev(
            ts(44, 14, 0),
            "task.comment",
            m("3"),
            "lena",
            body="Blog draft is up and the docs diff is open for review. Two points left.",
        ),
        _ev(
            ts(45, 9, 0),
            "task.comment",
            m("5"),
            "dana",
            body="Go-live still gates on both the platform milestone (clear) and security "
            "sign-off (in remediation). Holding the embargo time until sign-off forecasts.",
        ),
    ]

    return {
        "schema_version": "2.0",
        "program": {
            "slug": "ga-launch",
            "name": "1.0 GA Launch",
            "description": "Ship 1.0 to GA: platform scale, security sign-off, SOC 2 "
            "audit-readiness, and a coordinated launch — four workstreams, one outcome, "
            "joined by cross-project dependencies and shared people.",
            "methodology": "HYBRID",
            "color": "#7C3AED",
            "lead": "dana",
        },
        "accounts": _accounts(),
        "calendars": [
            {
                "slug": "standard",
                "name": "Standard 5-day",
                "working_days": 31,
                "hours_per_day": 8.0,
                "timezone": "UTC",
                # One company holiday, so calendar-aware scheduling and lag are
                # exercised across every workstream at once.
                "exceptions": [
                    {
                        "exc_start": d(44),
                        "exc_end": d(44),
                        "description": "Company holiday",
                    }
                ],
            }
        ],
        "resources": _resources(),
        "risks": [
            {
                "slug": "gate-convergence",
                "title": "Three gates converge on one launch date",
                "description": "GA go-live is a hard successor of both Platform GA-ready and "
                "Security sign-off, and SOC 2 evidence is gated on security sign-off as well. "
                "One slip in remediation moves the launch and the audit together.",
                "status": "MITIGATING",
                "probability": 4,
                "impact": 5,
                "category": "ORGANIZATIONAL",
                "response": "MITIGATE",
                "owner": "dana",
                "mitigation_due_date": d(54),
                "trigger": "Security sign-off forecasts past day 54 on the program pass.",
                "contingency": "Decouple what can be decoupled — evidence collection splits "
                "off the non-security controls — and hold the press embargo rather than the "
                "engineering date.",
                "tasks": ["ga-security:5", "ga-marketing:5", "ga-soc2:3"],
            },
            {
                "slug": "shared-people",
                "title": "The same three people carry all four workstreams",
                "status": "OPEN",
                "probability": 4,
                "impact": 3,
                "category": "ORGANIZATIONAL",
                "response": "ACCEPT",
                "owner": "dana",
                "trigger": "Any named person exceeds 100% allocation for more than one week.",
                "contingency": "Sequence rather than staff: the program has no bench, so "
                "contention is resolved by moving a workstream right, not by adding people.",
                "notes": "Visible on the team view: Malcolm runs the platform rollout at 1.0 "
                "while carrying security remediation at 0.5, and Lena is split across policy "
                "authoring and launch content at 0.6 total capacity.",
                "tasks": ["ga-platform:2", "ga-security:3"],
            },
        ],
        "projects": [
            platform_project,
            soc2_project,
            security_project,
            marketing_project,
        ],
        "events": events,
    }


def main() -> int:
    repo_root = Path(__file__).resolve().parents[2]
    api_src = repo_root / "packages" / "api" / "src"
    sys.path.insert(0, str(api_src))
    from trueppm_api.apps.projects.seed.validation import (  # noqa: E402
        SeedValidationError,
        validate_seed,
    )

    out_dir = api_src / "trueppm_api" / "apps" / "projects" / "fixtures" / "seeds"
    out_dir.mkdir(parents=True, exist_ok=True)
    seed = build_ga_launch()
    try:
        validate_seed(seed)
    except SeedValidationError as exc:
        print(f"ga-launch.json FAILED validation:\n{exc}", file=sys.stderr)
        return 1
    (out_dir / "ga-launch.json").write_text(
        json.dumps(seed, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    tasks = sum(len(p.get("tasks", [])) for p in seed["projects"])
    print(f"Wrote ga-launch.json — {tasks} tasks, validation OK.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
