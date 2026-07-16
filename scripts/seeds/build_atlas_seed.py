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

Coherence invariants (#1784): sprint aggregates reconcile exactly with member
story points, FS successors never start before their predecessor completes,
in-flight work never has a future start, baselines differ from the current plan
(realized slip / scope growth), and the event timeline runs right up to import
day. ``test_sample_content.py`` locks all of this against regression.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Anchor-relative dates (ADR-0114, seed v2). Every date is emitted as an offset
# from the import-day anchor "A", so the demo always reads as a program in flight
# rather than a fixed-date museum piece — the importer resolves "A" to today.
# ANCHOR_OFFSET places "today" so the *active* work brackets it: Platform Core's
# four completed sprints sit in the recent past, exactly one sprint straddles
# "today", and Migration Tooling's in-flight phase straddles it too (its earlier
# phases are done, the cutover is ahead). The event-replay importer then replays
# the authored timeline — backdated status moves, reassignments, comments,
# burndown — up to "today". Tuned from 120 to 90 so neither stream reads as a
# museum piece (#1253).
ANCHOR_OFFSET = 90


def d(offset_days: int) -> str:
    return f"A{offset_days - ANCHOR_OFFSET:+d}"


def da(anchor_days: int) -> str:
    """An anchor-relative seed date literal (``A±N``) — offset from import day.

    Unlike :func:`d` (which is project-timeline based, shifted by ANCHOR_OFFSET),
    ``da`` expresses a date directly relative to "today" — the natural frame for
    PTO and forecast-history parameters (#376), which are anchored on the demo's
    present, not a project's day zero.
    """
    return f"A{anchor_days:+d}"


def ts(offset_days: int, hour: int = 10, minute: int = 0) -> str:
    """An anchor-relative event timestamp (``A±NTHH:MM``); never weekend-snapped.

    Keep ``offset_days <= ANCHOR_OFFSET`` so a beat is never forward-dated.
    """
    return f"{d(offset_days)}T{hour:02d}:{minute:02d}"


def _ev(
    at: str, action: str, target: str = "", actor: str = "", **extra: object
) -> dict:
    """One timeline event; ``target`` qualifies what is mutated, ``actor`` names
    the account the backdated history row is attributed to."""
    event: dict = {"at": at, "action": action}
    if target:
        event["target"] = target
    if actor:
        event["actor"] = actor
    event.update(extra)
    return event


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
        # PTO the capacity-reality view (#369) reads: one past leave block on the
        # main calendar. Ranges also remove those days from date snapping (#376).
        "exceptions": [
            {"exc_start": da(-45), "exc_end": da(-43), "description": "Diego — PTO"},
        ],
    },
    # GTM team observes a regional holiday calendar (still Mon-Fri here, but a
    # distinct calendar so the demo shows calendar assignment per project).
    {
        "slug": "gtm-regional",
        "name": "GTM Regional (5-day, holidays)",
        "working_days": 31,
        "hours_per_day": 7.5,
        # A current PTO block (spans today) plus a past one, so the capacity view
        # shows both live and historical time off.
        "exceptions": [
            {
                "exc_start": da(-1),
                "exc_end": da(2),
                "description": "Clara — PTO (vacation)",
            },
            {
                "exc_start": da(-30),
                "exc_end": da(-28),
                "description": "Clara — PTO (conference)",
            },
        ],
    },
]

# Per-project forecast-history backfill parameters (#376, ADR-0211). The loader
# synthesizes one ProjectForecastSnapshot per day across `days`, drifting the CPM
# finish and Monte Carlo band right while `commitment_finish` holds — so the
# forecast-trend chart (#368) shows a real slip and total-float pressure going
# negative on day one. Keyed by project slug. Endpoints are aligned with each
# project's current plan: Platform Core's sprint runway ends ~A+49 (GA A+51),
# Migration completes ~A+74 after the realized slip, GTM launches ~A+80.
FORECAST_HISTORY = {
    "platform-core": {
        "days": 60,
        "commitment_finish": da(45),
        "cpm_start": da(38),
        "cpm_end": da(52),
        "p50_start": da(42),
        "p50_end": da(56),
        "p80_start": da(48),
        "p80_end": da(64),
        "p95_start": da(54),
        "p95_end": da(76),
        "mc_iterations": 2000,
        "completion_ratio": 0.5,
    },
    "migration-tooling": {
        "days": 60,
        "commitment_finish": da(67),
        "cpm_start": da(60),
        "cpm_end": da(74),
        "p50_start": da(64),
        "p50_end": da(78),
        "p80_start": da(70),
        "p80_end": da(86),
        "p95_start": da(76),
        "p95_end": da(96),
        "mc_iterations": 2000,
        "completion_ratio": 0.35,
    },
    "gtm-readiness": {
        "days": 60,
        "commitment_finish": da(76),
        "cpm_start": da(70),
        "cpm_end": da(82),
        "p50_start": da(74),
        "p50_end": da(86),
        "p80_start": da(80),
        "p80_end": da(92),
        "p95_start": da(86),
        "p95_end": da(102),
        "mc_iterations": 2000,
        "completion_ratio": 0.35,
    },
}


def three_point(most_likely: int, risk: float = 1.0) -> dict:
    """A plausible optimistic/most-likely/pessimistic spread around a midpoint.

    ``risk`` widens the pessimistic (right) tail for high-uncertainty work while
    leaving the optimistic side anchored — the honest shape of migration/cutover
    risk, where activities slip late but rarely finish early. ``risk=1.0`` (the
    default) reproduces the original centered spread byte-for-byte, so every
    estimate that does not opt in is unchanged. The tail is capped at 3x the
    most-likely so even the riskiest task stays a believable three-point range
    rather than a runaway outlier. Concentrating this widened spread on the
    *incomplete* critical path is what lets Monte Carlo demonstrate a real band:
    a COMPLETE task is pinned to zero variance by the engine (#1827), so a wide
    estimate on already-done work never reaches the finish distribution (#1891).
    """
    optimistic = max(1, round(most_likely * 0.7))
    pessimistic = round(most_likely * min(3.0, 1.8 + 1.2 * (risk - 1.0)))
    return {
        "optimistic": optimistic,
        "most_likely": most_likely,
        "pessimistic": pessimistic,
    }


# --- Project 1: Platform Core (agile) --------------------------------------

# Categorical label palette (ADR-0400): color is a stable enum key, never hex.
# The agile stream tags work by cross-cutting theme so the board's label filter
# has something real to slice on.
PC_LABELS = [
    {"slug": "security", "name": "Security", "color": "rose", "position": 0},
    {"slug": "tech-debt", "name": "Tech debt", "color": "slate", "position": 1},
    {
        "slug": "customer-request",
        "name": "Customer request",
        "color": "blue",
        "position": 2,
    },
    {"slug": "spike", "name": "Spike", "color": "purple", "position": 3},
    {"slug": "compliance", "name": "Compliance", "color": "amber", "position": 4},
]
# wbs -> label slugs. Kept small and meaningful — a few themed stories, not a
# label on every card.
PC_STORY_LABELS = {
    "1.1": ["security"],  # SSO login — the CSRF finding lives here
    "1.2": ["security"],  # MFA enrollment
    "1.5": ["security", "compliance"],  # Audit log
    "2.6": ["tech-debt"],  # cross-project cutover hook, parked ON_HOLD
    "3.8": ["spike"],  # Anomaly detection spike
    "4.1": ["compliance"],  # Plan catalog (billing → regulatory gate)
    "4.5": ["customer-request"],  # Tax engine — firming-up requirements
    "4.9": ["customer-request"],  # Usage-based invoicing v2
}
# Informational task-to-task relations (ADR-0455). Non-scheduling "see also" /
# dedupe cross-references, distinct from the CPM dependencies below. Kept few and
# meaningful. wbs -> [{target, link_type, note}].
PC_STORY_LINKS = {
    # The cutover hook's human "see also" pointer at its cross-project predecessor
    # (also a hard FS dependency — the relation is the readable cross-reference).
    "2.6": [
        {
            "target": "migration-tooling:3.2",
            "link_type": "relates_to",
            "note": "Gated on the migration team's Performance tuning — the cross-project "
            "predecessor that must land before this hook can cut over.",
        }
    ],
    # Audit log records the SSO auth events, so the two identity stories reference
    # each other for context.
    "1.5": [
        {
            "target": "1.1",
            "link_type": "relates_to",
            "note": "Audit log captures the authentication events emitted by SSO login.",
        }
    ],
    # A near-duplicate backlog item: the email-sequence work overlaps the core
    # dunning flow — flagged for dedupe before it is picked up.
    "4.8": [
        {
            "target": "4.4",
            "link_type": "duplicates",
            "note": "Email-sequence scope overlaps the dunning flow story — consolidate "
            "before Sprint 7 pickup.",
        }
    ],
}

# Epic grouping nodes (wbs "1".."5"); stories live beneath them.
PC_EPICS = [
    "Identity & access",
    "Core API",
    "Data platform",
    "Billing",
    "Notifications",
]

# 8 sprints on a 13-day cadence starting ~4 weeks after project start (the
# inception runway: backlog shaping, environments, team onboarding). Exactly one
# sprint is ACTIVE and straddles import day (A-6..A+7); four closed in the
# recent past; three are planned ahead.
PC_SPRINT_START = 28  # project day Sprint 1 begins (start_date + 4 weeks)
PC_SPRINT_LEN = 14  # 13-day window, contiguous cadence

# (state, committed_points, completed_points, goal). Capacity is 34 throughout.
# committed > completed only via carryover (never the reverse):
#   Sprint 1: committed 30, done 28 — the 2-pt "API key rotation" carried to s2.
#   Sprint 3: committed 32, done 26 — two 3-pt stories carried to s4 (PARTIAL).
# Sprint 5's committed 26 excludes the mid-sprint injected "Backfill tool" (8).
PC_SPRINTS = [
    ("COMPLETED", 30, 28, "Stand up identity and the tenant core."),
    ("COMPLETED", 31, 31, "Access control and the public API surface."),
    ("COMPLETED", 32, 26, "Data platform foundations and the billing catalog."),
    ("COMPLETED", 34, 34, "Billing pipeline end to end."),
    ("ACTIVE", 26, None, "Audit trail, dunning, and the warehouse backfill."),
    ("PLANNED", None, None, "Self-serve auth and data retention."),
    ("PLANNED", None, None, "Usage analytics and export depth."),
    ("PLANNED", None, None, "Partner surface and invoicing v2."),
]

# (wbs, name, points, sprint 1-8, status, assignee, percent, remaining_points).
# Sprint aggregates reconcile exactly with these rows (#1784):
#   s1 COMPLETE members: 5+5+8+8+2  = 28   s2: 5+5+8+2+8+3      = 31
#   s3 COMPLETE members: 5+8+8+5    = 26   s4: 5+2+8+5+5+3+3+3  = 34
#   s5 (ACTIVE) mixed statuses: one COMPLETE, one REVIEW, two IN_PROGRESS at
#   varied percents with partial burndown, one NOT_STARTED, plus the ON_HOLD
#   cross-project gate (2.6) and the injected 3.4.
PC_STORIES = [
    ("1.1", "SSO login", 5, 1, "COMPLETE", "mei", None, None),
    ("1.2", "MFA enrollment", 5, 1, "COMPLETE", "diego", None, None),
    ("1.3", "Role management", 5, 2, "COMPLETE", "nadia", None, None),
    ("1.4", "Session hardening", 5, 3, "COMPLETE", "mei", None, None),
    ("1.5", "Audit log", 5, 5, "COMPLETE", "mei", None, None),
    ("1.6", "Service accounts", 5, 4, "COMPLETE", "diego", None, None),
    ("1.7", "Passwordless login", 8, 6, "BACKLOG", "mei", None, None),
    ("1.8", "Access reviews", 5, 7, "BACKLOG", "diego", None, None),
    ("1.9", "Delegated admin", 5, 8, "BACKLOG", "nadia", None, None),
    ("2.1", "Tenant model", 8, 1, "COMPLETE", "omar", None, None),
    ("2.2", "Rate limiting", 5, 2, "COMPLETE", "tom", None, None),
    ("2.3", "Webhook delivery", 8, 2, "COMPLETE", "diego", None, None),
    # Committed in Sprint 1 (its committed 30 counts these 2 points) but finished
    # in Sprint 2 — the carryover lives in the sprint it completed in.
    ("2.4", "API key rotation", 2, 2, "COMPLETE", "tom", None, None),
    ("2.5", "OpenAPI export", 8, 3, "COMPLETE", "yuki", None, None),
    ("2.6", "Tenant data cutover hook", 5, 5, "ON_HOLD", "omar", None, None),
    ("2.7", "Idempotency keys", 2, 4, "COMPLETE", "tom", None, None),
    ("2.8", "Webhook retries dashboard", 3, 6, "BACKLOG", "tom", None, None),
    ("2.9", "API usage analytics", 8, 7, "BACKLOG", "omar", None, None),
    ("2.10", "Partner API keys", 5, 8, "BACKLOG", "diego", None, None),
    ("3.1", "Event pipeline", 8, 1, "COMPLETE", "yuki", None, None),
    ("3.2", "Warehouse sync", 8, 2, "COMPLETE", "omar", None, None),
    ("3.3", "Schema registry", 8, 3, "COMPLETE", "yuki", None, None),
    # Injected into the ACTIVE sprint mid-flight (sprint.scope_inject) and grown
    # 5 -> 8 (task.points); Sprint 5's committed 26 excludes it. Baselined at 5.
    ("3.4", "Backfill tool", 8, 5, "IN_PROGRESS", "yuki", 30.0, 6),
    ("3.5", "PII scrubber", 8, 4, "COMPLETE", "omar", None, None),
    ("3.6", "Data retention policies", 5, 6, "BACKLOG", "yuki", None, None),
    ("3.7", "Streaming exports", 8, 7, "BACKLOG", "omar", None, None),
    ("3.8", "Anomaly detection spike", 3, 8, "BACKLOG", "yuki", None, None),
    ("4.1", "Plan catalog", 5, 3, "COMPLETE", "nadia", None, None),
    ("4.2", "Usage metering", 5, 4, "COMPLETE", "tom", None, None),
    ("4.3", "Invoice render", 5, 4, "COMPLETE", "nadia", None, None),
    ("4.4", "Dunning flow", 5, 5, "REVIEW", "nadia", 85.0, None),
    ("4.5", "Tax engine", 8, 5, "NOT_STARTED", "tom", None, None),
    # Committed in Sprint 3 (with 5.5 — the 6-pt shortfall behind its PARTIAL
    # verdict) but finished in Sprint 4.
    ("4.6", "Credit memo flow", 3, 4, "COMPLETE", "nadia", None, None),
    ("4.7", "Revenue recognition export", 8, 6, "BACKLOG", "nadia", None, None),
    ("4.8", "Dunning email sequences", 3, 7, "BACKLOG", "tom", None, None),
    ("4.9", "Usage-based invoicing v2", 13, 8, "BACKLOG", "nadia", None, None),
    ("5.1", "Email service", 2, 1, "COMPLETE", "tom", None, None),
    ("5.2", "In-app inbox", 3, 2, "COMPLETE", "diego", None, None),
    ("5.3", "Digest scheduler", 3, 5, "IN_PROGRESS", "diego", 65.0, 1),
    ("5.4", "Preference center", 3, 4, "COMPLETE", "mei", None, None),
    ("5.5", "Notification templates", 3, 4, "COMPLETE", "diego", None, None),
    ("5.6", "Mobile push channel", 5, 6, "BACKLOG", "mei", None, None),
    ("5.7", "Quiet hours", 2, 7, "BACKLOG", "diego", None, None),
    ("5.8", "Digest personalization", 3, 8, "BACKLOG", "mei", None, None),
]

# Stories that existed when the Sprint-0 baseline was captured. Later scope —
# the carryover fillers (4.6, 5.5), Sprint-4's late additions (1.6, 2.7), the
# planned-sprint backlog, and the cross-project cutover hook (2.6) — did not,
# so the baseline honestly reflects the day-zero backlog.
PC_BASELINE_WBS = {
    "1.1",
    "1.2",
    "1.3",
    "1.4",
    "1.5",
    "2.1",
    "2.2",
    "2.3",
    "2.4",
    "2.5",
    "3.1",
    "3.2",
    "3.3",
    "3.4",
    "3.5",
    "4.1",
    "4.2",
    "4.3",
    "4.4",
    "4.5",
    "5.1",
    "5.2",
    "5.3",
    "5.4",
}


def build_platform_core() -> dict:
    tasks: list[dict] = []
    sprints: list[dict] = []

    for i, (state, committed, completed, goal) in enumerate(PC_SPRINTS):
        start = PC_SPRINT_START + i * PC_SPRINT_LEN
        sprint = {
            "slug": f"pc-sprint-{i + 1}",
            "name": f"Sprint {i + 1}",
            "goal": goal,
            "state": state,
            "start_date": d(start),
            "finish_date": d(start + 13),
            "capacity_points": 34,
        }
        if committed is not None:
            sprint["committed_points"] = committed
        if completed is not None:
            sprint["completed_points"] = completed
        sprints.append(sprint)

    # Epics as grouping nodes (excluded from CPM); stories beneath them.
    for e_idx, epic_name in enumerate(PC_EPICS, start=1):
        tasks.append(
            {
                "wbs_path": str(e_idx),
                "name": epic_name,
                "type": "epic",
                "delivery_mode": "scrum",
                "governance_class": "flow",
            }
        )

    for wbs, name, points, sprint_no, status, assignee, pct, remaining in PC_STORIES:
        story: dict = {
            "wbs_path": wbs,
            "name": name,
            "type": "story",
            "status": status,
        }
        if status == "COMPLETE":
            story["percent_complete"] = 100.0
        elif pct is not None:
            story["percent_complete"] = pct
        story["story_points"] = points
        if remaining is not None:
            story["remaining_points"] = remaining
        story.update(
            {
                "parent_epic": wbs.partition(".")[0],
                "assignee": assignee,
                "sprint": f"pc-sprint-{sprint_no}",
                "delivery_mode": "scrum",
                "governance_class": "flow",
            }
        )
        if wbs in PC_STORY_LABELS:
            story["labels"] = PC_STORY_LABELS[wbs]
        if wbs in PC_STORY_LINKS:
            story["links"] = PC_STORY_LINKS[wbs]
        if wbs == "2.6":
            # Near-infeasible commitment (#372): committed to the ACTIVE sprint
            # but gated by a cross-project FS predecessor — Migration Tooling's
            # "Performance tuning" (mt:3.2) — whose planned window lands *after*
            # this sprint closes. Once the program CPM pass runs, its early_start
            # is pushed past the sprint boundary, so the dependency-reality
            # at-risk indicator fires; the team parked it ON_HOLD.
            story["notes"] = (
                "Committed to the active sprint but gated on the migration team's "
                "Performance tuning task — a cross-project predecessor whose finish "
                "lands after this sprint closes. Demonstrates the dependency-reality "
                "at-risk indicator (#372)."
            )
        tasks.append(story)

    # GA milestone lands just after the Sprint 8 runway (target of last sprint).
    tasks.append(
        {
            "wbs_path": "9",
            "name": "Platform Core GA",
            "is_milestone": True,
            "delivery_mode": "milestone",
            "planned_start": d(PC_SPRINT_START + 8 * PC_SPRINT_LEN + 1),
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
        "forecast_history": FORECAST_HISTORY["platform-core"],
        "board_columns": ["Backlog", "To Do", "In Progress", "In Review", "Done"],
        "labels": PC_LABELS,
        "tasks": tasks,
        "dependencies": [
            # Cross-project seam driving the at-risk sprint commitment (see task 2.6).
            {
                "predecessor": "migration-tooling:3.2",
                "successor": "2.6",
                "dep_type": "FS",
            }
        ],
        "sprints": sprints,
        "baselines": [
            {
                "name": "Sprint-0 baseline",
                "is_active": True,
                # Captured a few days into the project — before the 3.4 scope
                # growth (baselined 5, current 8 via task.points) and before the
                # later-added stories existed, so the variance view has a story.
                "captured_at": d(3),
                "tasks": [
                    {
                        "task": wbs,
                        "story_points": 5 if wbs == "3.4" else points,
                    }
                    for (wbs, _n, points, *_rest) in PC_STORIES
                    if wbs in PC_BASELINE_WBS
                ],
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
            {
                "slug": "pc-sso-vendor",
                "title": "SSO/identity vendor integration risk",
                "description": "The chosen IdP's enterprise SSO certification is on the critical path.",
                "status": "MITIGATING",
                "probability": 3,
                "impact": 4,
                "category": "EXTERNAL",
                "response": "MITIGATE",
                "owner": "mei",
                "tasks": ["1.1"],
            },
            {
                "slug": "pc-data-platform",
                "title": "Data platform schema churn",
                "status": "OPEN",
                "probability": 3,
                "impact": 4,
                "category": "TECHNICAL",
                "response": "MITIGATE",
                "owner": "yuki",
                "tasks": ["3.1", "3.2"],
            },
            {
                "slug": "pc-notif-throttle",
                "title": "Notification provider rate limits",
                # Starting state; risk.status walks it to RESOLVED (#1253).
                "status": "OPEN",
                "probability": 2,
                "impact": 2,
                "category": "TECHNICAL",
                "response": "ACCEPT",
                "owner": "tom",
                "notes": "Batching + backoff implemented; load test passed.",
                "tasks": ["5.1"],
            },
        ],
    }


# --- Project 2: Migration Tooling (waterfall) ------------------------------

# (phase, [(task, most_likely_days, [dep wbs], dep_type, original_start, slip, risk)])
#
# `original_start` is the project-day the Kickoff baseline recorded for the
# task; `slip` is the realized slip on the *current* plan. Phases 1-2 executed
# to plan (slip 0, all COMPLETE). The dry-run findings pushed phases 3-5 right
# by +6..+8 days while the baseline holds the original dates — so the
# baseline-vs-current variance in the Schedule view shows a real drift.
# Execution front: 3.1 is mid-flight (55%), everything after it NOT_STARTED
# with future planned starts. 3.2 ("Performance tuning") starts A+11 — after
# Platform Core's active sprint closes (A+7), the #372 at-risk arrangement.
#
# `risk` (#1891) right-skews the three-point pessimistic tail on the *incomplete*
# critical path so, once the finish is driven by that work (see the unpinned
# milestone below), Monte Carlo shows a demonstrable P50->P95 band. Completed
# tasks keep risk=1.0 (their estimate is inert — the engine pins a COMPLETE task
# to zero variance, #1827), so their seeded values are unchanged; only phases 3-5
# opt into a wider tail. Values are calibrated per task: high for first-time /
# irreversible steps (dry-run, delta sync, final cutover ~3x), modest for routine
# ones (freeze prep, sign-off). NB: widening estimates alone does nothing while
# the finish is a pinned milestone — the intervening float absorbs the variance;
# unpinning the milestone is the primary fix, this is the amplitude.
MT_PHASES = [
    (
        "Assess",
        [
            ("Inventory legacy schemas", 5, [], None, 0, 0, 1.0),
            ("Profile data quality", 4, ["1.1"], "FS", 7, 0, 1.0),
            ("Map field semantics", 6, ["1.1"], "SS", 2, 0, 1.0),
            ("Risk & cutover plan", 3, ["1.2", "1.3"], "FS", 13, 0, 1.0),
        ],
    ),
    (
        "Build",
        [
            # Waits on Platform Core's Tenant model (cross-project FS, Sprint 1)
            # — hence the gap after Assess closed out around day 16.
            ("ETL framework", 8, ["1.4"], "FS", 44, 0, 1.0),
            ("Schema transformer", 7, ["2.1"], "SS", 48, 0, 1.0),
            ("Validation harness", 6, ["2.1"], "FS", 54, 0, 1.0),
            ("Reconciliation reports", 4, ["2.3"], "FS", 62, 0, 1.0),
        ],
    ),
    (
        "Migrate",
        [
            ("Dry-run migration", 5, ["2.2", "2.3"], "FS", 72, 7, 2.0),
            ("Performance tuning", 4, ["3.1"], "FS", 94, 7, 1.9),
            ("Delta sync", 6, ["3.1"], "SS", 84, 7, 2.0),
            ("Production rehearsal", 5, ["3.2", "3.3"], "FS", 101, 7, 1.9),
        ],
    ),
    (
        "Validate",
        [
            ("Row-count reconciliation", 3, ["3.4"], "FS", 116, 6, 1.4),
            ("Business sign-off pack", 4, ["4.1"], "FS", 121, 6, 1.3),
            ("Rollback drill", 3, ["3.4"], "FS", 118, 6, 1.7),
        ],
    ),
    (
        "Cutover",
        [
            # The freeze window opens late (the approved maintenance slot), so the
            # cutover tail runs right up to the committed go-live — its variance,
            # not a pinned date, is what the milestone forecast now reflects (#1891).
            ("Freeze window prep", 2, ["4.2", "4.3"], "FS", 145, 6, 1.4),
            # slip=None -> no SNET floor: FS-driven so the freeze/cutover/decommission
            # tail compounds its three-point variance into the finish milestone.
            ("Final cutover", 3, ["5.1"], "FS", 150, None, 3.0),
            ("Decommission legacy", 4, ["5.2"], "FS", 153, None, 2.6),
        ],
    ),
]
MT_DEVS = ["yuki", "omar", "raj", "tom"]

# Waterfall-stream label palette + attachments (ADR-0400).
MT_LABELS = [
    {"slug": "critical-path", "name": "Critical path", "color": "rose", "position": 0},
    {"slug": "cutover", "name": "Cutover", "color": "amber", "position": 1},
    {"slug": "data-quality", "name": "Data quality", "color": "cyan", "position": 2},
    {"slug": "rollback", "name": "Rollback", "color": "purple", "position": 3},
    {"slug": "dry-run", "name": "Dry run", "color": "slate", "position": 4},
]
MT_TASK_LABELS = {
    "1.2": ["data-quality"],  # Profile data quality
    "2.2": ["data-quality"],  # Schema transformer
    "3.1": ["dry-run", "critical-path"],  # Dry-run migration
    "3.2": ["critical-path"],  # Performance tuning
    "3.4": ["cutover"],  # Production rehearsal
    "4.3": ["rollback"],  # Rollback drill
    "5.2": ["cutover", "critical-path"],  # Final cutover
    "5.3": ["cutover"],  # Decommission legacy
}
# Informational relations (ADR-0455). The final cutover is the human blocker on
# the program's public launch — a readable cross-project "blocks" pointer that
# complements the CPM chain (migration-tooling:6 -> gtm-readiness:3).
MT_TASK_LINKS = {
    "5.2": [
        {
            "target": "gtm-readiness:3",
            "link_type": "blocks",
            "note": "Public launch cannot proceed until the production cutover completes.",
        }
    ],
}


def build_migration_tooling() -> dict:
    tasks: list[dict] = []
    deps: list[dict] = []
    baseline_rows: list[dict] = []

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
        for t_idx, (name, ml, dep_paths, dep_type, original, slip, risk) in enumerate(
            items, start=1
        ):
            wbs = f"{p_idx}.{t_idx}"
            done = p_idx <= 2  # first two phases complete
            in_progress = wbs == "3.1"  # the execution front
            task: dict = {
                "wbs_path": wbs,
                "name": name,
                "type": "task",
                "status": (
                    "COMPLETE"
                    if done
                    else ("IN_PROGRESS" if in_progress else "NOT_STARTED")
                ),
            }
            if done:
                task["percent_complete"] = 100.0
            elif in_progress:
                task["percent_complete"] = 55.0
            task.update(
                {
                    "duration": ml,
                    "estimate": three_point(ml, risk),
                    "assignee": MT_DEVS[(p_idx + t_idx) % len(MT_DEVS)],
                    "governance_class": "gated",
                    "delivery_mode": "waterfall",
                }
            )
            # slip is None -> no SNET floor: the task is purely FS-driven by its
            # predecessor, so predecessor variance chains straight through it to
            # the finish. Used for the tail cutover tasks (#1891) so the last two
            # steps compound their three-point variance into the milestone instead
            # of each being decoupled by its own fixed planned_start.
            if slip is not None:
                task["planned_start"] = d(original + slip)
            if wbs in MT_TASK_LABELS:
                task["labels"] = MT_TASK_LABELS[wbs]
            if wbs in MT_TASK_LINKS:
                task["links"] = MT_TASK_LINKS[wbs]
            tasks.append(task)
            # The baseline keeps the ORIGINAL (pre-slip) window.
            baseline_rows.append(
                {
                    "task": wbs,
                    "start": d(original),
                    "finish": d(original + ml),
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

    # Cutover milestone. Deliberately carries NO planned_start pin: a fixed SNET
    # floor here would clamp the project finish to a constant date, and because
    # the migrate/validate/cutover chain finishes with ~2 weeks of float before
    # the old pin, every task's sampled duration was absorbed by that float —
    # Monte Carlo collapsed to a flat P50=P80=P95 (#1891). Driving the milestone
    # off its FS predecessor (5.3, Decommission legacy) lets the incomplete
    # cutover chain's three-point variance reach the finish, so the forecast
    # shows a real P50->P95 band whose top driver is the remaining cutover work.
    tasks.append(
        {
            "wbs_path": "6",
            "name": "Migration complete",
            "is_milestone": True,
            "delivery_mode": "milestone",
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
        "forecast_history": FORECAST_HISTORY["migration-tooling"],
        "labels": MT_LABELS,
        "tasks": tasks,
        "dependencies": deps,
        "baselines": [
            {
                "name": "Kickoff baseline",
                "is_active": True,
                "captured_at": d(3),
                "tasks": baseline_rows,
            }
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
            {
                "slug": "mt-rollback",
                "title": "No tested rollback for a failed cutover",
                "description": "A failed production cutover without a rehearsed rollback strands the migration.",
                "status": "OPEN",
                "probability": 2,
                "impact": 5,
                "category": "TECHNICAL",
                "response": "MITIGATE",
                "owner": "sam",
                "tasks": ["5.3"],
            },
            {
                "slug": "mt-mapping",
                "title": "Field-mapping ambiguity in legacy schema",
                # Starting state; risk.status walks it to MITIGATING (#1253).
                "status": "OPEN",
                "probability": 3,
                "impact": 3,
                "category": "TECHNICAL",
                "response": "MITIGATE",
                "owner": "omar",
                "tasks": ["1.3"],
            },
        ],
    }


# --- Project 3: GTM Readiness (hybrid) -------------------------------------

# Hybrid-stream label palette + attachments (ADR-0400).
GTM_LABELS = [
    {
        "slug": "launch-blocker",
        "name": "Launch blocker",
        "color": "rose",
        "position": 0,
    },
    {"slug": "content", "name": "Content", "color": "teal", "position": 1},
    {"slug": "pricing", "name": "Pricing", "color": "amber", "position": 2},
]
GTM_TASK_LABELS = {
    "1.2": ["pricing", "launch-blocker"],  # Pricing & packaging sign-off (long pole)
    "1.3": ["launch-blocker"],  # Launch gate review
    "2.1": ["content"],  # Sales deck
    "2.5": ["content"],  # Launch blog
    "2.7": ["content"],  # Support runbook
}

# The hybrid stream is genuinely hybrid: a gated waterfall planning lane AND a
# real sprint cadence over the enablement lane (a 1-2 person content team, so
# capacity is 14, not 34). Three sprints mirror Platform Core's rhythm: one
# closed (A-20..A-7), one ACTIVE straddling import day, one planned.
GTM_SPRINTS = [
    ("gtm-sprint-1", "Enablement 1", "COMPLETED", 70, 13, 13, "Core selling kit."),
    (
        "gtm-sprint-2",
        "Enablement 2",
        "ACTIVE",
        84,
        13,
        None,
        "Onboarding and launch content.",
    ),
    (
        "gtm-sprint-3",
        "Enablement 3",
        "PLANNED",
        98,
        None,
        None,
        "Support readiness and release notes.",
    ),
]

# (wbs minor, name, points, sprint 1-3, status, assignee, percent, remaining).
# gtm-sprint-1 members: 5+3+5 = 13 (all COMPLETE = completed_points).
# gtm-sprint-2 members: 13 committed, mixed statuses incl. a partial burn.
GTM_ENABLEMENT = [
    (1, "Sales deck", 5, 1, "COMPLETE", "clara", None, None),
    (2, "Demo script", 3, 1, "COMPLETE", "clara", None, None),
    (3, "Pricing FAQ", 5, 1, "COMPLETE", "jordan", None, None),
    (4, "Onboarding guide", 5, 2, "COMPLETE", "clara", None, None),
    (5, "Launch blog", 3, 2, "IN_PROGRESS", "clara", 40.0, 2),
    (6, "Webinar prep", 5, 2, "NOT_STARTED", "clara", None, None),
    (7, "Support runbook", 5, 3, "BACKLOG", "clara", None, None),
    (8, "Release notes", 3, 3, "BACKLOG", "clara", None, None),
]


def build_gtm_readiness() -> dict:
    tasks: list[dict] = []
    deps: list[dict] = []

    # Planning gates (waterfall lane). 1.1 shipped; 1.2 is the in-flight long
    # pole (Finance review dragging); 1.3 has NOT started — a gate review cannot
    # begin while its FS predecessor is still open.
    tasks.append(
        {
            "wbs_path": "1",
            "name": "Launch planning",
            "governance_class": "gated",
            "delivery_mode": "waterfall",
        }
    )
    planning = [
        ("Positioning & messaging", 4, [], 42, "COMPLETE", 100.0),
        ("Pricing & packaging sign-off", 3, ["1.1"], 81, "IN_PROGRESS", 60.0),
        ("Launch gate review", 2, ["1.2"], 96, "NOT_STARTED", None),
    ]
    for i, (name, ml, dep_paths, start_day, status, pct) in enumerate(
        planning, start=1
    ):
        wbs = f"1.{i}"
        task: dict = {
            "wbs_path": wbs,
            "name": name,
            "duration": ml,
            "planned_start": d(start_day),
            "estimate": three_point(ml),
            "status": status,
        }
        if pct is not None:
            task["percent_complete"] = pct
        task.update(
            {
                "governance_class": "gated",
                "delivery_mode": "waterfall",
                "assignee": "jordan",
            }
        )
        if wbs in GTM_TASK_LABELS:
            task["labels"] = GTM_TASK_LABELS[wbs]
        tasks.append(task)
        for dep in dep_paths:
            deps.append(
                {"predecessor": dep, "successor": wbs, "dep_type": "FS", "lag": 0}
            )

    # Enablement work (agile / flow) running a real sprint cadence.
    tasks.append(
        {
            "wbs_path": "2",
            "name": "Enablement",
            "governance_class": "flow",
            "delivery_mode": "scrum",
        }
    )
    for (
        minor,
        name,
        points,
        sprint_no,
        status,
        assignee,
        pct,
        remaining,
    ) in GTM_ENABLEMENT:
        story: dict = {
            "wbs_path": f"2.{minor}",
            "name": name,
            "type": "story",
            "status": status,
        }
        if status == "COMPLETE":
            story["percent_complete"] = 100.0
        elif pct is not None:
            story["percent_complete"] = pct
        story["story_points"] = points
        if remaining is not None:
            story["remaining_points"] = remaining
        story.update(
            {
                "assignee": assignee,
                "sprint": f"gtm-sprint-{sprint_no}",
                "governance_class": "flow",
                "delivery_mode": "scrum",
            }
        )
        if f"2.{minor}" in GTM_TASK_LABELS:
            story["labels"] = GTM_TASK_LABELS[f"2.{minor}"]
        tasks.append(story)

    sprints: list[dict] = []
    for slug, name, state, start, committed, completed, goal in GTM_SPRINTS:
        sprint = {
            "slug": slug,
            "name": name,
            "goal": goal,
            "state": state,
            "start_date": d(start),
            "finish_date": d(start + 13),
            "capacity_points": 14,
        }
        if committed is not None:
            sprint["committed_points"] = committed
        if completed is not None:
            sprint["completed_points"] = completed
        sprints.append(sprint)

    # Public-launch milestone (gated by both planning and Migration completion).
    # A+80: respects the migration-complete milestone (A+74 after the realized
    # slip) plus its FS+3 lag.
    tasks.append(
        {
            "wbs_path": "3",
            "name": "Public launch",
            "is_milestone": True,
            "delivery_mode": "milestone",
            "planned_start": d(170),
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
        "forecast_history": FORECAST_HISTORY["gtm-readiness"],
        "labels": GTM_LABELS,
        "tasks": tasks,
        "dependencies": deps,
        "sprints": sprints,
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
            },
            {
                "slug": "gtm-pricing",
                "title": "Pricing & packaging not signed off",
                "status": "OPEN",
                "probability": 3,
                "impact": 4,
                "category": "ORGANIZATIONAL",
                "response": "MITIGATE",
                "owner": "jordan",
                "tasks": ["1.2"],
            },
            {
                "slug": "gtm-enablement",
                "title": "Sales enablement lag at launch",
                "status": "ACCEPTED",
                "probability": 2,
                "impact": 3,
                "category": "ORGANIZATIONAL",
                "response": "ACCEPT",
                "owner": "clara",
                "tasks": ["2.1"],
            },
            {
                "slug": "gtm-analyst",
                "title": "Analyst-briefing embargo conflict",
                # Starting state; risk.status walks it OPEN → MITIGATING → CLOSED
                # as the embargo dates are aligned (#1253).
                "status": "OPEN",
                "probability": 2,
                "impact": 2,
                "category": "EXTERNAL",
                "response": "ACCEPT",
                "owner": "ada",
                "notes": "Embargo dates aligned with the launch gate; closed.",
                "tasks": ["1.3"],
            },
        ],
    }


def build_atlas() -> dict:
    pc = build_platform_core()
    # Cross-project dependency: Platform Core's Tenant model (a Sprint 1 story,
    # COMPLETE well before the ETL work begins) gates Migration's Build phase.
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

    # --- event timeline ----------------------------------------------------
    # The program's life across all three streams, in chronological order: four
    # sprint open/close cycles with honest verdicts (Sprint 3 PARTIAL, its retro
    # producing action items, one promoted to the backlog), a security-review
    # bounce on SSO, carryover narration, an inspection-style rework and a
    # reassignment on the waterfall stream, GTM's own sprint cadence, dated risk
    # lifecycles, and a dense final stretch (A-3..A-1) of mid-sprint movement so
    # the demo is alive on import day. Targets are project-qualified; offsets
    # stay <= 90 so no beat is forward-dated.
    def pc_task(wbs: str) -> str:
        return f"task:platform-core:{wbs}"

    def pc_sprint(slug: str) -> str:
        return f"sprint:platform-core:{slug}"

    def mt_task(wbs: str) -> str:
        return f"task:migration-tooling:{wbs}"

    def gtm_task(wbs: str) -> str:
        return f"task:gtm-readiness:{wbs}"

    def gtm_sprint(slug: str) -> str:
        return f"sprint:gtm-readiness:{slug}"

    events: list[dict] = [
        # --- Sprint 1 (A-62..A-49): identity + the tenant core ------------
        _ev(ts(28, 9, 0), "sprint.activate", pc_sprint("pc-sprint-1"), "sam"),
        # Hero: SSO login (1.1) is built, fails security review on a real CSRF
        # hole, is reworked, and ships — a non-linear path, with the finding
        # logged as the program security-audit risk.
        _ev(
            ts(29, 9, 0),
            "task.comment",
            pc_task("1.1"),
            "mei",
            body="Starting SSO — OIDC discovery and the login callback.",
        ),
        _ev(ts(30, 10, 0), "task.status", pc_task("1.1"), "mei", to="IN_PROGRESS"),
        # Coverage reassignment: Omar is pulled onto the migration assessment.
        _ev(
            ts(32, 9, 0),
            "task.comment",
            pc_task("2.1"),
            "priya",
            body="Omar's pulled onto the migration assessment — moving Tenant "
            "model to Diego.",
        ),
        _ev(ts(32, 9, 5), "task.assign", pc_task("2.1"), "priya", assignee="diego"),
        _ev(
            ts(34, 15, 0),
            "task.comment",
            pc_task("1.1"),
            "mei",
            body="SSO login works against the IdP sandbox. PR up for review.",
        ),
        _ev(ts(34, 15, 30), "task.status", pc_task("1.1"), "mei", to="REVIEW"),
        _ev(
            ts(35, 11, 0),
            "task.comment",
            pc_task("1.1"),
            "priya",
            body="Security review: the state param isn't validated on the callback — "
            "that's a login CSRF hole. Sending it back, and logging it as an "
            "audit finding.",
        ),
        _ev(ts(35, 11, 30), "task.status", pc_task("1.1"), "priya", to="IN_PROGRESS"),
        _ev(
            ts(35, 12, 0),
            "risk.status",
            "risk:prog-security-audit",
            "priya",
            to="MITIGATING",
        ),
        _ev(ts(36, 10, 0), "risk.status", "risk:pc-sso-vendor", "mei", to="MITIGATING"),
        _ev(
            ts(38, 14, 0),
            "task.comment",
            pc_task("1.1"),
            "mei",
            body="Validated state and nonce on the callback and added a regression "
            "test. Re-review please.",
        ),
        _ev(ts(38, 14, 30), "task.status", pc_task("1.1"), "mei", to="REVIEW"),
        _ev(
            ts(39, 16, 0),
            "task.comment",
            pc_task("1.1"),
            "priya",
            body="Solid now. Approving.",
        ),
        _ev(ts(39, 16, 30), "task.status", pc_task("1.1"), "priya", to="COMPLETE"),
        # Carryover: 2.4 was committed to Sprint 1 (committed 30 vs done 28) but
        # rides Sprint 2 to completion.
        _ev(
            ts(41, 16, 30),
            "task.comment",
            pc_task("2.4"),
            "tom",
            body="API key rotation slipped behind the SSO rework — carrying it "
            "into Sprint 2.",
        ),
        _ev(
            ts(41, 17, 0),
            "sprint.close",
            pc_sprint("pc-sprint-1"),
            "sam",
            goal_outcome="MET",
        ),
        # --- Sprint 2 (A-48..A-35) ----------------------------------------
        _ev(ts(42, 9, 0), "sprint.activate", pc_sprint("pc-sprint-2"), "sam"),
        # The exec-sponsor transition plays out and is reconfirmed.
        _ev(
            ts(45, 9, 0),
            "risk.status",
            "risk:prog-exec-sponsor",
            "ada",
            to="MITIGATING",
        ),
        _ev(
            ts(46, 10, 0),
            "task.comment",
            gtm_task("1.2"),
            "jordan",
            body="Positioning is locked; the pricing review with Finance is the long "
            "pole now.",
        ),
        # Hero: Schema transformer (2.2) fails review on a lossy enum mapping, is
        # split and reconciled, and passes — the mapping risk moving to mitigated.
        _ev(
            ts(48, 9, 0),
            "task.comment",
            mt_task("2.2"),
            "yuki",
            body="Schema transformer scaffolded; wiring the field-mapping table.",
        ),
        _ev(ts(49, 10, 0), "task.status", mt_task("2.2"), "yuki", to="IN_PROGRESS"),
        _ev(ts(52, 10, 0), "risk.status", "risk:gtm-analyst", "ada", to="MITIGATING"),
        _ev(
            ts(55, 15, 0),
            "task.comment",
            mt_task("2.2"),
            "yuki",
            body="Transform passes on the sample extract. Ready for review.",
        ),
        _ev(ts(55, 15, 30), "task.status", mt_task("2.2"), "yuki", to="REVIEW"),
        _ev(
            ts(55, 17, 0),
            "sprint.close",
            pc_sprint("pc-sprint-2"),
            "sam",
            goal_outcome="MET",
        ),
        # --- Sprint 3 (A-34..A-21): the PARTIAL sprint ----------------------
        _ev(ts(56, 9, 0), "sprint.activate", pc_sprint("pc-sprint-3"), "sam"),
        _ev(
            ts(56, 11, 0),
            "task.comment",
            mt_task("2.2"),
            "omar",
            body="Review: the account-type enum maps three legacy codes to one, which "
            "silently drops a distinction Finance relies on. Sending it back.",
        ),
        _ev(ts(56, 11, 30), "task.status", mt_task("2.2"), "omar", to="IN_PROGRESS"),
        _ev(ts(56, 12, 0), "risk.status", "risk:mt-mapping", "omar", to="MITIGATING"),
        _ev(
            ts(59, 14, 0),
            "task.comment",
            mt_task("2.2"),
            "yuki",
            body="Split the enum mapping and added a reconciliation check. Re-review.",
        ),
        _ev(ts(59, 14, 30), "task.status", mt_task("2.2"), "yuki", to="REVIEW"),
        _ev(
            ts(60, 9, 0), "risk.status", "risk:prog-exec-sponsor", "ada", to="RESOLVED"
        ),
        _ev(
            ts(60, 16, 0),
            "task.comment",
            mt_task("2.2"),
            "omar",
            body="Reconciles now. Approved.",
        ),
        _ev(ts(60, 16, 30), "task.status", mt_task("2.2"), "omar", to="COMPLETE"),
        _ev(ts(64, 10, 0), "risk.status", "risk:gtm-analyst", "ada", to="CLOSED"),
        # Carryover behind the PARTIAL verdict: both 3-pointers move to Sprint 4.
        _ev(
            ts(69, 16, 0),
            "task.comment",
            pc_task("4.6"),
            "nadia",
            body="Billing sandbox access blocked both 3-pointers — carrying Credit "
            "memo flow and Notification templates into Sprint 4.",
        ),
        _ev(
            ts(69, 17, 0),
            "sprint.close",
            pc_sprint("pc-sprint-3"),
            "sam",
            goal_outcome="PARTIAL",
        ),
        # --- Sprint 4 (A-20..A-7) + the Sprint 3 retro ----------------------
        _ev(ts(70, 9, 0), "sprint.activate", pc_sprint("pc-sprint-4"), "sam"),
        _ev(ts(70, 9, 30), "sprint.activate", gtm_sprint("gtm-sprint-1"), "jordan"),
        _ev(
            ts(70, 10, 0),
            "retro.action",
            pc_sprint("pc-sprint-3"),
            "priya",
            body="Cap review WIP at 2",
        ),
        _ev(
            ts(70, 10, 5),
            "retro.action",
            pc_sprint("pc-sprint-3"),
            "sam",
            body="Split stories larger than 8 points",
        ),
        _ev(
            ts(71, 9, 30),
            "retro.promote",
            pc_sprint("pc-sprint-3"),
            "jordan",
            body="Split stories larger than 8 points",
        ),
        _ev(
            ts(72, 10, 0),
            "risk.status",
            "risk:pc-notif-throttle",
            "tom",
            to="MITIGATING",
        ),
        _ev(
            ts(79, 9, 0),
            "task.comment",
            mt_task("3.1"),
            "yuki",
            body="Kicking off the dry-run against the full production extract.",
        ),
        _ev(ts(79, 9, 30), "task.status", mt_task("3.1"), "yuki", to="IN_PROGRESS"),
        _ev(
            ts(83, 17, 0),
            "sprint.close",
            pc_sprint("pc-sprint-4"),
            "sam",
            goal_outcome="MET",
        ),
        _ev(
            ts(83, 17, 30),
            "sprint.close",
            gtm_sprint("gtm-sprint-1"),
            "jordan",
            goal_outcome="MET",
        ),
        # --- Sprint 5 (ACTIVE, A-6..A+7): mid-sprint movement ---------------
        _ev(ts(84, 9, 0), "sprint.activate", pc_sprint("pc-sprint-5"), "sam"),
        _ev(ts(84, 9, 30), "sprint.activate", gtm_sprint("gtm-sprint-2"), "jordan"),
        _ev(ts(85, 10, 0), "task.status", pc_task("1.5"), "mei", to="IN_PROGRESS"),
        _ev(ts(85, 11, 0), "task.status", pc_task("4.4"), "nadia", to="IN_PROGRESS"),
        _ev(ts(85, 14, 0), "task.status", gtm_task("2.4"), "clara", to="IN_PROGRESS"),
        # In-flight migrate phase: a reassignment to the data-platform specialist.
        _ev(
            ts(86, 9, 0),
            "task.comment",
            mt_task("3.3"),
            "sam",
            body="Delta sync needs deeper data-platform knowledge — moving it from "
            "Raj to Omar.",
        ),
        _ev(ts(86, 9, 5), "task.assign", mt_task("3.3"), "sam", assignee="omar"),
        # The cross-project gate bites: 2.6 is parked ON_HOLD.
        _ev(
            ts(86, 10, 0),
            "task.comment",
            pc_task("2.6"),
            "omar",
            body="Blocked: Migration's performance tuning now lands after this "
            "sprint closes — parking the cutover hook until the tuned pipeline "
            "exists.",
        ),
        _ev(ts(86, 10, 5), "task.status", pc_task("2.6"), "omar", to="ON_HOLD"),
        # Tax engine's acceptance criteria are agreed — the story is ready.
        _ev(ts(86, 11, 0), "task.ac_met", pc_task("4.5"), "jordan"),
        _ev(
            ts(86, 15, 0), "risk.status", "risk:pc-notif-throttle", "tom", to="RESOLVED"
        ),
        # Mid-sprint scope injection: Backfill tool pulled into the active sprint.
        _ev(
            ts(87, 9, 30),
            "task.comment",
            pc_task("3.4"),
            "jordan",
            body="Warehouse schema churn means we need an extra backfill pass this "
            "sprint — pulling Backfill tool into the sprint.",
        ),
        _ev(
            ts(87, 9, 35),
            "sprint.scope_inject",
            pc_task("3.4"),
            "jordan",
            goal_impact=True,
        ),
        _ev(ts(87, 11, 0), "task.status", pc_task("1.5"), "mei", to="REVIEW"),
        _ev(ts(87, 16, 0), "task.status", pc_task("1.5"), "priya", to="COMPLETE"),
        _ev(
            ts(88, 10, 0),
            "task.comment",
            gtm_task("2.5"),
            "clara",
            body="Launch blog drafted through the pricing section.",
        ),
        _ev(ts(88, 10, 5), "task.status", gtm_task("2.5"), "clara", to="IN_PROGRESS"),
        _ev(
            ts(88, 11, 0),
            "task.comment",
            pc_task("3.4"),
            "priya",
            body="We'll protect the sprint goal by deferring lower-priority work. "
            "Accepting the injection — and it's bigger than we thought: "
            "re-pointing from 5 to 8.",
        ),
        _ev(
            ts(88, 11, 5),
            "sprint.scope_resolve",
            pc_task("3.4"),
            "priya",
            to="ACCEPTED",
        ),
        _ev(ts(88, 11, 10), "task.points", pc_task("3.4"), "priya", points=8),
        _ev(ts(88, 11, 30), "task.status", pc_task("3.4"), "yuki", to="IN_PROGRESS"),
        _ev(
            ts(88, 14, 0),
            "task.comment",
            pc_task("4.4"),
            "nadia",
            body="Dunning flow ready for review — retry ladder and grace periods "
            "are in.",
        ),
        _ev(ts(88, 14, 5), "task.status", pc_task("4.4"), "nadia", to="REVIEW"),
        _ev(
            ts(88, 15, 0),
            "task.comment",
            mt_task("3.1"),
            "yuki",
            body="Dry-run is halfway through; the tenant shard fan-out is the hot "
            "spot.",
        ),
        # Phase-3 re-estimation off the dry-run findings.
        _ev(
            ts(88, 15, 10),
            "task.comment",
            mt_task("3.2"),
            "sam",
            body="Re-estimating performance tuning off the dry-run findings — "
            "4 days was optimistic.",
        ),
        _ev(
            ts(88, 15, 15),
            "task.estimate",
            mt_task("3.2"),
            "sam",
            estimate={"optimistic": 4, "most_likely": 6, "pessimistic": 12},
        ),
        _ev(ts(88, 16, 0), "task.status", gtm_task("2.4"), "clara", to="COMPLETE"),
        _ev(
            ts(88, 16, 5),
            "task.comment",
            gtm_task("2.4"),
            "clara",
            body="Onboarding guide is live in the docs hub.",
        ),
        _ev(
            ts(89, 9, 30),
            "task.comment",
            pc_task("5.3"),
            "diego",
            body="Digest batching is in; the preference fan-out is what's left.",
        ),
        _ev(
            ts(89, 10, 0),
            "task.comment",
            gtm_task("2.5"),
            "jordan",
            body="Draft launch blog is with brand review; hero image still open.",
        ),
        _ev(
            ts(89, 11, 0),
            "risk.status",
            "risk:pc-data-platform",
            "priya",
            to="MITIGATING",
        ),
    ]

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
            {
                "slug": "prog-regulatory",
                "title": "Regulatory sign-off gates billing + cutover",
                "description": "A compliance review must clear before billing go-live and the production cutover.",
                "status": "OPEN",
                "probability": 2,
                "impact": 5,
                "category": "EXTERNAL",
                "response": "MITIGATE",
                "owner": "alex",
                "tasks": ["platform-core:4.1", "migration-tooling:5.2"],
            },
            {
                "slug": "prog-security-audit",
                "title": "Third-party security audit findings on SSO",
                "status": "MITIGATING",
                "probability": 3,
                "impact": 4,
                "category": "TECHNICAL",
                "response": "MITIGATE",
                "owner": "priya",
                "tasks": ["platform-core:1.1"],
            },
            {
                "slug": "prog-resource-contention",
                "title": "Shared engineers contended across projects",
                "status": "OPEN",
                "probability": 4,
                "impact": 3,
                "category": "ORGANIZATIONAL",
                "response": "MITIGATE",
                "owner": "sam",
                "tasks": ["platform-core:3.1", "gtm-readiness:2.1"],
            },
            {
                "slug": "prog-exec-sponsor",
                "title": "Executive sponsor transition mid-program",
                # Starting state; risk.status walks it OPEN → MITIGATING →
                # RESOLVED as the new sponsor is onboarded (#1253).
                "status": "OPEN",
                "probability": 2,
                "impact": 4,
                "category": "ORGANIZATIONAL",
                "response": "ACCEPT",
                "owner": "ada",
                "notes": "New sponsor onboarded; launch funding reconfirmed.",
                "tasks": ["gtm-readiness:1.3"],
            },
        ],
        "projects": [pc, mt, gtm],
        "events": events,
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
