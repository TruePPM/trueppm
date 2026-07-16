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

    # Categorical label palette (ADR-0400) + attachments by story name.
    labels_catalog = [
        {"slug": "must-have", "name": "Must-have", "color": "rose", "position": 0},
        {"slug": "growth", "name": "Growth", "color": "green", "position": 1},
        {"slug": "polish", "name": "Polish", "color": "teal", "position": 2},
        {"slug": "a11y", "name": "Accessibility", "color": "blue", "position": 3},
    ]
    story_labels = {
        "Biometric login": ["must-have"],
        "Push notifications": ["must-have"],
        "Offline cache": ["must-have"],
        "Payment sheet": ["growth"],
        "Referral program": ["growth"],
        "Accessibility pass": ["a11y"],
        "Dark mode": ["polish"],
        "Haptics": ["polish"],
        "Widget gallery": ["polish"],
    }

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
    # A realistic ramp with reconciled aggregates (#1784): Sprint 1 closed
    # PARTIAL — 20 of 25 committed points landed and Profile editor (5 pts)
    # carried into Sprint 2, where it finished (sprint membership is final, so
    # its `sprint` field reads au-sprint-2; the carry is narrated in events).
    # Sprint 2 delivered its full 27, carry included. Sprint 3's commitment (21)
    # is the activation-time membership — the injected Widget gallery (5 pts)
    # sits outside it. The closed sprints carry an honest goal_outcome, set on
    # the authored sprint.close beats.
    committed = [25, 27, 21, None]
    completed = [20, 27, None, None]
    for i, (state, com, vel) in enumerate(zip(states, committed, completed)):
        sp = {
            "slug": f"au-sprint-{i + 1}",
            "name": f"Sprint {i + 1}",
            "goal": f"Mobile increment {i + 1}.",
            "state": state,
            "start_date": D(i * 14),
            "finish_date": D(i * 14 + 13),
            "capacity_points": 28,
        }
        if com is not None:
            sp["committed_points"] = com
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
    # Final-state overrides by story name (#1784), applied on top of the formula
    # placement so the sprint aggregates reconcile with their member stories:
    # - Sprint 2 trims to 27 pts (== committed == completed, carry included).
    # - Sprint 3 (ACTIVE) reads as a mid-flight board: a completed story, one in
    #   review, in-progress work at ragged percentages with partially-burned
    #   remaining points, and untouched starts.
    # - Sprint 4 (PLANNED) varies its points and fits the 28-pt capacity.
    overrides: dict[str, dict[str, object]] = {
        # Sprint 2 rebalance.
        "Payment sheet": {"story_points": 3},
        "Empty states": {"story_points": 2},
        # Sprint 3 mixed statuses.
        "Offline cache": {"status": "COMPLETE", "percent_complete": 100.0},
        "Search": {"percent_complete": 40.0, "remaining_points": 1},
        "Photo upload": {
            "status": "REVIEW",
            "percent_complete": 80.0,
            "remaining_points": 1,
        },
        "Crash reporting": {"status": "NOT_STARTED", "percent_complete": 0.0},
        "Widget gallery": {"percent_complete": 30.0, "remaining_points": 4},
        "Receipt export": {"status": "NOT_STARTED", "percent_complete": 0.0},
        "Haptics": {"percent_complete": 60.0, "remaining_points": 2},
        # Sprint 4 varied points (sum 26 <= capacity 28).
        "Dark mode": {"story_points": 5},
        "Share sheet": {"story_points": 3},
        "Map view": {"story_points": 5},
        "Localization": {"story_points": 3},
        "App rating prompt": {"story_points": 2},
        "Activity feed": {"story_points": 5},
        "Pull-to-refresh": {"story_points": 3},
    }
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
            story = {
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
            story.update(overrides.get(name, {}))
            if name in story_labels:
                story["labels"] = story_labels[name]
            tasks.append(story)
            story_idx += 1

    # A real unassigned backlog (#1784): stories refined under their epics but
    # committed to no sprint and owned by nobody yet, so the Backlog view has
    # actual intake to groom instead of rendering empty.
    for epic_wbs, slot, name, pts, dor in [
        ("1", 6, "App shortcuts", 3, "refine"),
        ("2", 6, "Contact import", 5, "refine"),
        ("3", 6, "Video capture", 8, "idea"),
        ("5", 6, "Promo codes", 3, "idea"),
        ("6", 6, "Sound design", 2, "idea"),
    ]:
        story_wbs = f"{epic_wbs}.{slot}"
        wbs[name] = story_wbs
        tasks.append(
            {
                "wbs_path": story_wbs,
                "name": name,
                "type": "story",
                "status": "BACKLOG",
                "percent_complete": 0.0,
                "story_points": pts,
                "parent_epic": epic_wbs,
                "delivery_mode": "scrum",
                "governance_class": "flow",
                "dor": dor,
            }
        )

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

    # retro.promote matches a retro action item by exact body text, so the
    # promoted item's wording lives in one place.
    promoted_action = (
        "Spike unfamiliar integrations before committing them — the biometric "
        "work stalled two days on the secure-enclave path."
    )

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
        # Sprint 1 closes PARTIAL: Profile editor (5 pts, Diego, finishing in
        # Sprint 2) misses the boundary — the shortfall behind 20-of-25.
        _ev(
            T(13, 16, 0),
            "task.comment",
            task(wbs["Profile editor"]),
            "diego",
            body="The avatar cropper is still fighting me — this won't clear "
            "review before the boundary. Carrying it into Sprint 2.",
        ),
        _ev(
            T(13, 17, 0),
            "sprint.close",
            sprint("au-sprint-1"),
            "sam",
            goal_outcome="PARTIAL",
        ),
        # Retro after the PARTIAL close: one action about the carryover, one the
        # team later promotes into a real backlog story (the retro -> task loop).
        _ev(
            T(13, 17, 30),
            "retro.action",
            sprint("au-sprint-1"),
            "sam",
            body="Right-size sprint commitments to recent velocity — Profile "
            "editor carried after we committed 25 against a 20-point run rate.",
        ),
        _ev(
            T(13, 17, 40),
            "retro.action",
            sprint("au-sprint-1"),
            "sam",
            body=promoted_action,
        ),
        _ev(
            T(14, 10, 0),
            "retro.promote",
            sprint("au-sprint-1"),
            "priya",
            body=promoted_action,
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
        # Sprint 3 (active) — activated on its start day; a mid-sprint scope
        # injection the PO pulls in and the team accepts after protecting the
        # goal (wires the SprintScopeChange audit); and authored arcs that leave
        # the board mid-flight on import day.
        _ev(T(28, 9, 0), "sprint.activate", sprint("au-sprint-3"), "sam"),
        _ev(
            T(29, 9, 0),
            "task.comment",
            task(wbs["Offline cache"]),
            "mei",
            body="Cache invalidation strategy settled — wiring the sync journal now.",
        ),
        _ev(
            T(29, 9, 30),
            "task.status",
            task(wbs["Offline cache"]),
            "mei",
            to="IN_PROGRESS",
        ),
        _ev(
            T(30, 10, 0),
            "task.status",
            task(wbs["Photo upload"]),
            "nadia",
            to="IN_PROGRESS",
        ),
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
        # Recent beats — the timeline reaches import day mid-sprint (#1784):
        # a story completes, another lands in review, and a standup note posts
        # the day before "today".
        _ev(
            T(32, 15, 0),
            "task.comment",
            task(wbs["Offline cache"]),
            "mei",
            body="Offline cache is green on the device farm. Merging.",
        ),
        _ev(
            T(32, 15, 30),
            "task.status",
            task(wbs["Offline cache"]),
            "mei",
            to="COMPLETE",
        ),
        _ev(
            T(33, 14, 0),
            "task.comment",
            task(wbs["Photo upload"]),
            "nadia",
            body="Upload pipeline with EXIF scrubbing is ready — PR up for review.",
        ),
        _ev(
            T(33, 14, 30),
            "task.status",
            task(wbs["Photo upload"]),
            "nadia",
            to="REVIEW",
        ),
        _ev(
            T(34, 9, 30),
            "task.comment",
            task(wbs["Haptics"]),
            "nadia",
            body="Haptics feel right on iOS; tuning Android amplitude curves next.",
        ),
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
                "labels": labels_catalog,
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
                        # Linked to the vendor's blast radius: push delivery and
                        # the in-app chat that rides the same messaging API.
                        "tasks": [wbs["Push notifications"], wbs["In-app chat"]],
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
    """Bayside Civic Center — a two-project waterfall PROGRAM (#2003).

    Split from a single project into a program of two phased waterfall projects
    joined by hard cross-project dependencies — the pure-waterfall cross-project
    showcase:

    - **Sitework & Structure** (``bayside-sitework``): Site Prep → Foundation →
      Framing, ending at the "Structure topped out" milestone. The execution
      front lives here (steel erection is in flight).
    - **Building & Fit-out** (``bayside-building``): MEP → Finish-out → the
      "Certificate of occupancy" milestone. Every interior task is gated on the
      structure passing framing inspection, so the whole project is future work
      whose start floats against the sitework critical path.

    The program exercises all four dependency types and both lead/lag: FS/SS/FF
    within a project, an SF and a negative-lag *lead* on the cross-project MEP
    mobilization, and a +7 curing lag on the foundation. It also tells a real
    baseline story: a Contract baseline captured at award, a Rebaseline after the
    owner's mezzanine change order pushed the structure right, and a residual
    two-day weather slip on the current plan that drifts past even the rebaseline.
    """
    ns = "bayside"

    # Categorical label palette (ADR-0400): colors are enum keys, never hex.
    SITEWORK_LABELS = [
        {
            "slug": "critical-path",
            "name": "Critical path",
            "color": "rose",
            "position": 0,
        },
        {
            "slug": "inspection",
            "name": "Inspection gate",
            "color": "amber",
            "position": 1,
        },
        {
            "slug": "weather",
            "name": "Weather-sensitive",
            "color": "cyan",
            "position": 2,
        },
        {
            "slug": "change-order",
            "name": "Change order",
            "color": "purple",
            "position": 3,
        },
    ]
    BUILDING_LABELS = [
        {
            "slug": "critical-path",
            "name": "Critical path",
            "color": "rose",
            "position": 0,
        },
        {
            "slug": "long-lead",
            "name": "Long-lead procurement",
            "color": "amber",
            "position": 1,
        },
        {
            "slug": "inspection",
            "name": "Inspection gate",
            "color": "teal",
            "position": 2,
        },
        {
            "slug": "commissioning",
            "name": "Commissioning",
            "color": "green",
            "position": 3,
        },
    ]

    # phase -> [(task, most_likely, [(dep_wbs, dep_type[, lag])], [labels])]. Each
    # project keeps its own wbs tree starting at "1". A shared day cursor advances
    # across both projects so absolute planned_start dates stay sequential — the
    # building work naturally lands in the future, after the structure.
    sitework_phases = [
        (
            "Site Prep",
            [
                ("Mobilize site", 4, [], []),
                ("Clear & grade", 6, [("1.1", "FS")], ["critical-path"]),
                ("Temporary utilities", 3, [("1.1", "SS")], []),
                (
                    "Site survey sign-off",
                    2,
                    [("1.2", "FS"), ("1.3", "FS")],
                    ["inspection"],
                ),
            ],
        ),
        (
            "Foundation",
            [
                ("Excavate footings", 5, [("1.4", "FS")], ["critical-path"]),
                (
                    "Rebar & formwork",
                    6,
                    [("2.1", "FS")],
                    ["critical-path", "inspection"],
                ),
                ("Pour east footing", 3, [("2.2", "FS")], ["weather"]),
                (
                    "Pour west footing",
                    3,
                    [("2.2", "SS")],
                    ["weather"],
                ),  # parallel pours
                (
                    # East pour cures a week before forms strip (+7 curing lag on
                    # the FS edge); the west pour's forms strip together with it (FF).
                    "Cure & strip forms",
                    4,
                    [("2.3", "FS", 7), ("2.4", "FF")],
                    ["critical-path"],
                ),
            ],
        ),
        (
            "Framing",
            [
                ("Steel erection", 8, [("2.5", "FS")], ["critical-path"]),
                ("Floor decking", 6, [("3.1", "FS")], ["change-order"]),
                ("Roof structure", 7, [("3.1", "FS")], ["weather"]),
                (
                    "Framing inspection",
                    2,
                    [("3.2", "FF"), ("3.3", "FF")],
                    ["critical-path", "inspection"],
                ),
            ],
        ),
    ]
    building_phases = [
        (
            "MEP",
            [
                # Cross-project lead (negative lag): electrical rough-in mobilizes
                # three days before the sitework framing inspection certifies — the
                # trades overlap the inspection window across the project boundary.
                (
                    "Rough-in electrical",
                    7,
                    [("bayside-sitework:3.4", "FS", -3)],
                    ["critical-path"],
                ),
                ("Rough-in plumbing", 6, [("bayside-sitework:3.4", "FS")], []),
                ("HVAC ductwork", 8, [("bayside-sitework:3.4", "FS")], []),
                ("MEP equipment delivery", 5, [], ["long-lead"]),
                (
                    "MEP inspection",
                    3,
                    [("1.1", "FS"), ("1.2", "FS"), ("1.3", "FS")],
                    ["inspection"],
                ),
            ],
        ),
        (
            "Finish-out",
            [
                ("Drywall & paint", 8, [("1.5", "FS")], ["critical-path"]),
                ("Flooring", 6, [("2.1", "FS")], []),
                ("Fixtures & casework", 5, [("2.1", "FS")], []),
                # SF: commissioning must start no later than flooring finishes.
                ("Commissioning start", 0, [("2.2", "SF")], ["commissioning"]),
                (
                    "Final inspection & handover",
                    3,
                    [("2.2", "FS"), ("2.3", "FS")],
                    ["critical-path", "inspection"],
                ),
            ],
        ),
    ]

    crew = ["diego", "tom", "nadia", "omar"]

    def _emit_project(phases, *, cursor, slug, execution_front, mezzanine_shift):
        """Generate one waterfall project's tasks/deps/baseline rows.

        ``execution_front`` names the single in-flight wbs (COMPLETE before it,
        IN_PROGRESS at it, NOT_STARTED after) or is ``None`` for an all-future
        project. ``mezzanine_shift`` is a callable ``wbs -> (rebaseline_days,
        current_days)`` giving the change-order slip captured by the active
        rebaseline vs. the further slip on the current plan — so the contract
        baseline (0), the rebaseline, and the current plan can each diverge.
        """
        tasks, deps = [], []
        contract_rows, rebaseline_rows = [], []
        # A project is "done through" everything up to its execution front.
        done_wbs: set[str] = set()
        if execution_front is not None:
            ef_phase, ef_task = (int(x) for x in execution_front.split("."))
            for p_i, (_ph, items) in enumerate(phases, start=1):
                for t_i, _ in enumerate(items, start=1):
                    if (p_i, t_i) < (ef_phase, ef_task):
                        done_wbs.add(f"{p_i}.{t_i}")
        for p_idx, (phase, items) in enumerate(phases, start=1):
            tasks.append(
                {
                    "wbs_path": str(p_idx),
                    "name": phase,
                    "governance_class": "gated",
                    "delivery_mode": "waterfall",
                }
            )
            for t_idx, item in enumerate(items, start=1):
                name, ml, dep_list = item[0], item[1], item[2]
                labels = item[3] if len(item) > 3 else []
                wbs = f"{p_idx}.{t_idx}"
                rebase_shift, cur_shift = mezzanine_shift(wbs)
                is_done = wbs in done_wbs
                in_prog = wbs == execution_front
                status = (
                    "COMPLETE"
                    if is_done
                    else ("IN_PROGRESS" if in_prog else "NOT_STARTED")
                )
                is_ms = ml == 0
                # Floor decking absorbed the change-order rework: re-estimated 6 -> 8.
                duration = 8 if (slug == "bayside-sitework" and wbs == "3.2") else ml
                task = {
                    "wbs_path": wbs,
                    "name": name,
                    "status": status,
                    "governance_class": "gated",
                    "delivery_mode": "waterfall",
                    "assignee": crew[(p_idx + t_idx) % len(crew)],
                }
                if labels:
                    task["labels"] = labels
                # NOT_STARTED work carries no percent_complete — an honest ragged
                # front, not a wall of zeros.
                if is_done:
                    task["percent_complete"] = 100.0
                elif in_prog:
                    task["percent_complete"] = 55.0
                base_day = cursor[0] * 2
                if is_ms:
                    task["is_milestone"] = True
                    task["delivery_mode"] = "milestone"
                    task["planned_start"] = d(base_day + cur_shift)
                else:
                    task["duration"] = duration
                    task["planned_start"] = d(base_day + cur_shift)
                    task["estimate"] = three_point(duration)
                    # Contract baseline: the plan at award (no slip). Rebaseline:
                    # the change-order plan (captures the +7 shift and the 3.2
                    # re-estimate). Both keep ORIGINAL vs. re-baselined dates so
                    # each shows drift against the current plan.
                    contract_rows.append(
                        {
                            "task": wbs,
                            "start": d(base_day),
                            "finish": d(base_day + ml),
                            "duration": ml,
                        }
                    )
                    rebaseline_rows.append(
                        {
                            "task": wbs,
                            "start": d(base_day + rebase_shift),
                            "finish": d(base_day + rebase_shift + duration),
                            "duration": duration,
                        }
                    )
                tasks.append(task)
                for dep in dep_list:
                    deps.append(
                        {
                            "predecessor": dep[0],
                            "successor": wbs,
                            "dep_type": dep[1],
                            "lag": dep[2] if len(dep) > 2 else 0,
                        }
                    )
                cursor[0] += max(ml, 1)
        return tasks, deps, contract_rows, rebaseline_rows

    # Change-order slip model. The mezzanine change order pushed the structure
    # from Floor decking (3.2) onward +7 of the contract; a subsequent weather
    # delay added +2 to the roof/inspection tail on the *current* plan only, so
    # it drifts past even the rebaseline. Building work inherits the full slip.
    def sitework_shift(wbs: str) -> tuple[int, int]:
        if wbs in ("3.3", "3.4"):  # roof + framing inspection caught the weather slip
            return 7, 9
        if wbs == "3.2":  # floor decking: change order only
            return 7, 7
        return 0, 0  # phases 1-2 and steel erection predate the change order

    def building_shift(_wbs: str) -> tuple[int, int]:
        # Building has a single Contract baseline (no rebaseline); pass the same
        # value for rebaseline/current so its rebaseline rows are unused. Current
        # plan carries the full +9 cross-project slip from the structure.
        return 9, 9

    cursor = [0]
    sw_tasks, sw_deps, sw_contract, sw_rebaseline = _emit_project(
        sitework_phases,
        cursor=cursor,
        slug="bayside-sitework",
        execution_front="3.1",
        mezzanine_shift=sitework_shift,
    )
    # "Structure topped out" — the program marker gating all interior work.
    _topped = cursor[0] * 2
    sw_tasks.append(
        {
            "wbs_path": "4",
            "name": "Structure topped out",
            "is_milestone": True,
            "delivery_mode": "milestone",
            "governance_class": "gated",
            "planned_start": d(_topped + 9),
            "labels": ["critical-path"],
        }
    )
    sw_deps.append({"predecessor": "3.4", "successor": "4", "dep_type": "FS", "lag": 0})

    bd_tasks, bd_deps, bd_contract, _bd_rebaseline = _emit_project(
        building_phases,
        cursor=cursor,
        slug="bayside-building",
        execution_front=None,
        mezzanine_shift=building_shift,
    )
    # "Certificate of occupancy" — the program finish milestone.
    _co = cursor[0] * 2
    bd_tasks.append(
        {
            "wbs_path": "3",
            "name": "Certificate of occupancy",
            "is_milestone": True,
            "delivery_mode": "milestone",
            "governance_class": "gated",
            "planned_start": d(_co + 9),
            "labels": ["critical-path"],
        }
    )
    bd_deps.append({"predecessor": "2.5", "successor": "3", "dep_type": "FS", "lag": 0})
    bd_deps.append({"predecessor": "2.4", "successor": "3", "dep_type": "FS", "lag": 0})

    # --- event timeline ----------------------------------------------------
    # Waterfall history across both projects: an inspection-fail-and-rework loop
    # the synthesizer can't produce, a crew reassignment, permit/weather field
    # notes, the change-order re-baseline, and dated risk lifecycles. Offsets are
    # in days from program start; all stay <= the anchor (90 = "today").
    def sw(wbs: str) -> str:
        return f"task:bayside-sitework:{wbs}"

    def bd(wbs: str) -> str:
        return f"task:bayside-building:{wbs}"

    events: list[dict] = [
        # Permit gates the site-prep sign-off (1.4) — a field note plus the risk
        # moving from identified to actively mitigated.
        _ev(
            ts(22, 9, 0),
            "task.comment",
            sw("1.4"),
            "tom",
            body="Survey package is ready, but the municipal permit is still in "
            "review — that's gating the site-prep sign-off.",
        ),
        _ev(ts(24, 10, 0), "risk.status", "risk:permit-delay", "sam", to="MITIGATING"),
        # Soil risk surfaces and is closed out by the geotech survey during excavation.
        _ev(
            ts(31, 9, 0),
            "task.comment",
            sw("2.1"),
            "tom",
            body="Hit a soft layer at the east footing — ordering a geotech survey "
            "before we set rebar.",
        ),
        _ev(
            ts(31, 9, 30), "risk.status", "risk:soil-conditions", "tom", to="MITIGATING"
        ),
        _ev(ts(38, 14, 0), "risk.status", "risk:soil-conditions", "tom", to="CLOSED"),
        # Hero: Rebar & formwork (2.2) fails inspection on bar spacing, is re-tied,
        # and passes re-inspection — a non-linear Review -> rework -> Review path.
        _ev(
            ts(40, 8, 0),
            "task.comment",
            sw("2.2"),
            "diego",
            body="Rebar cage and formwork up for the east footing.",
        ),
        _ev(ts(40, 9, 0), "task.status", sw("2.2"), "diego", to="IN_PROGRESS"),
        _ev(
            ts(43, 15, 0),
            "task.comment",
            sw("2.2"),
            "diego",
            body="Tied and shimmed. Calling for inspection.",
        ),
        _ev(ts(43, 15, 30), "task.status", sw("2.2"), "diego", to="REVIEW"),
        _ev(
            ts(44, 10, 0),
            "task.comment",
            sw("2.2"),
            "omar",
            body="Inspection: bar spacing on the north face is out of tolerance per "
            "the spec. Failing it — needs a re-tie.",
        ),
        _ev(ts(44, 10, 30), "task.status", sw("2.2"), "omar", to="IN_PROGRESS"),
        _ev(
            ts(46, 14, 0),
            "task.comment",
            sw("2.2"),
            "diego",
            body="Re-tied to spec and re-shot the spacing. Ready for re-inspection.",
        ),
        _ev(ts(46, 14, 30), "task.status", sw("2.2"), "diego", to="REVIEW"),
        _ev(
            ts(47, 9, 0),
            "task.comment",
            sw("2.2"),
            "omar",
            body="Re-inspection passed. Cleared to pour.",
        ),
        _ev(ts(47, 9, 30), "task.status", sw("2.2"), "omar", to="COMPLETE"),
        # Weather note on the pour window.
        _ev(
            ts(50, 7, 0),
            "task.comment",
            sw("2.3"),
            "diego",
            body="Rain moving in for the pour window — coordinating to pour ahead of "
            "the front so we don't lose the day.",
        ),
        # Reassignment: the west pour was booked to the MEP lead by mistake; it
        # belongs to the concrete foreman.
        _ev(
            ts(56, 8, 0),
            "task.comment",
            sw("2.4"),
            "diego",
            body="The pours belong with the concrete crew — moving the west pour to Tom.",
        ),
        _ev(ts(56, 8, 5), "task.assign", sw("2.4"), "diego", assignee="tom"),
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
        # In-flight framing phase: steel erection kicks off with an authored status
        # move — the execution front on import day.
        _ev(
            ts(72, 8, 0),
            "task.comment",
            sw("3.1"),
            "diego",
            body="Crane is rigged and the first column line is bolted — steel "
            "erection is underway.",
        ),
        _ev(ts(72, 8, 30), "task.status", sw("3.1"), "diego", to="IN_PROGRESS"),
        _ev(
            ts(74, 9, 0),
            "task.comment",
            sw("3.1"),
            "diego",
            body="Steel is going up. Owner is still weighing a mezzanine design "
            "change — holding the final connections until it's resolved.",
        ),
        _ev(
            ts(76, 11, 0), "risk.status", "risk:design-change", "diego", to="MITIGATING"
        ),
        # The change order lands on floor decking: re-estimated 6 -> 8 days, and the
        # program is re-baselined so the contract plan is preserved for the claim.
        _ev(
            ts(77, 9, 0),
            "task.comment",
            sw("3.2"),
            "diego",
            body="Mezzanine change adds deck framing at grid C — re-estimating floor "
            "decking and re-baselining so the contract dates stay on record.",
        ),
        _ev(
            ts(77, 9, 30), "task.estimate", sw("3.2"), "diego", estimate=three_point(8)
        ),
        _ev(
            ts(77, 12, 0),
            "baseline.capture",
            "project:bayside-sitework",
            "sam",
            body="Rebaseline — mezzanine change order",
        ),
        # A subsequent weather delay drifts the roof/inspection tail two days past
        # even the fresh rebaseline — the residual variance on the current plan.
        _ev(
            ts(84, 7, 0),
            "task.comment",
            sw("3.3"),
            "tom",
            body="High winds shut the crane two afternoons this week — roof steel "
            "and the framing inspection are running two days behind the rebaseline.",
        ),
        # Cross-project field note: MEP mobilizes ahead of the inspection cert.
        _ev(
            ts(88, 14, 0),
            "task.comment",
            bd("1.1"),
            "nadia",
            body="Framing inspection is on the municipal calendar; electrical "
            "rough-in mobilizes three days ahead of the certificate so the fit-out "
            "project doesn't lose the overlap.",
        ),
        # Recent beats — the field log reaches import day.
        _ev(
            ts(87, 7, 30),
            "task.comment",
            sw("3.1"),
            "tom",
            body="Final steel delivery hit the laydown yard this morning — crane "
            "picks resume at first light.",
        ),
        _ev(ts(89, 11, 0), "risk.status", "risk:weather", "sam", to="MITIGATING"),
    ]

    _calendars = [
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
    ]
    _resources = [
        {
            "slug": "sam",
            "name": "Sam Okafor",
            "job_role": "Program Manager",
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
    ]

    sitework_project = {
        "slug": "bayside-sitework",
        "name": "Sitework & Structure",
        "description": "The below-grade and structural scope — site prep, foundation, and framing "
        "up to a topped-out structure.",
        "methodology": "WATERFALL",
        "start_date": d(0),
        "calendar": "site",
        "default_view": "SCHEDULE",
        "labels": SITEWORK_LABELS,
        "tasks": sw_tasks,
        "dependencies": sw_deps,
        "baselines": [
            {
                "name": "Contract baseline",
                # Superseded by the rebaseline: kept for the change-order claim but
                # no longer the active overlay (only one active baseline per project).
                "is_active": False,
                "captured_at": d(2),
                "tasks": sw_contract,
            },
            {
                "name": "Rebaseline — mezzanine change order",
                "is_active": True,
                "captured_at": d(77),
                "tasks": sw_rebaseline,
            },
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
                "slug": "soil-conditions",
                "title": "Unexpected soil conditions at excavation",
                # Starting state; risk.status walks it OPEN -> MITIGATING -> CLOSED.
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
                "slug": "permit-delay",
                "title": "Building permit approval slips",
                "description": "The municipal permit office is running 3 weeks behind; gates site prep sign-off.",
                "status": "OPEN",
                "probability": 3,
                "impact": 5,
                "category": "EXTERNAL",
                "response": "MITIGATE",
                "owner": "sam",
                "tasks": ["1.4"],
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
                "slug": "crane-availability",
                "title": "Tower crane scheduling conflict",
                # Starting state; risk.status walks it OPEN -> MITIGATING -> RESOLVED.
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
        ],
    }

    building_project = {
        "slug": "bayside-building",
        "name": "Building & Fit-out",
        "description": "The interior scope — MEP rough-in, finishes, and commissioning through to a "
        "certificate of occupancy. Every task is gated on the structure passing framing inspection.",
        "methodology": "WATERFALL",
        "start_date": d(0),
        "calendar": "site",
        "default_view": "SCHEDULE",
        "labels": BUILDING_LABELS,
        "tasks": bd_tasks,
        "dependencies": bd_deps,
        "baselines": [
            {
                "name": "Contract baseline",
                "is_active": True,
                "captured_at": d(2),
                # Captured at award; the current plan carries the +9 slip that
                # propagated across the boundary from the structure change order +
                # weather, so the fit-out variance reads the cross-project cascade.
                "tasks": bd_contract,
            }
        ],
        "risks": [
            {
                "slug": "supply-chain",
                "title": "MEP equipment supply delay",
                "status": "MITIGATING",
                "probability": 3,
                "impact": 5,
                "category": "EXTERNAL",
                "response": "MITIGATE",
                "owner": "nadia",
                "tasks": ["1.4"],
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
                "tasks": ["1.5"],
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
                "tasks": ["1.4"],
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
                "tasks": ["2.4"],
            },
        ],
    }

    return {
        "schema_version": "2.0",
        "program": {
            "slug": "bayside-civic-center",
            "name": "Bayside Civic Center Construction",
            "description": "Waterfall-only sample — a two-project program (structure + fit-out) joined by "
            "cross-project dependencies, with all four dependency types, three-point estimates, a "
            "contract baseline plus a change-order rebaseline, and a resource calendar.",
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
        "calendars": _calendars,
        "resources": _resources,
        # Program-level cross-project risk: a structure slip cascades into fit-out.
        "risks": [
            {
                "slug": "structure-cascade",
                "title": "Structure slip cascades into fit-out",
                "description": "Any framing-inspection slip pushes the entire interior fit-out project right, "
                "since every MEP and finish task is gated on the structure across the project boundary.",
                "status": "MITIGATING",
                "probability": 4,
                "impact": 4,
                "category": "ORGANIZATIONAL",
                "response": "MITIGATE",
                "owner": "sam",
                "tasks": ["bayside-sitework:3.4", "bayside-building:1.1"],
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
                "tasks": ["bayside-sitework:3.4"],
            },
        ],
        "projects": [sitework_project, building_project],
        "events": events,
    }


# ---------------------------------------------------------------------------
# #619 Helios CRM Replacement — hybrid-small
# ---------------------------------------------------------------------------


def build_helios() -> dict:
    ns = "helios"
    tasks, deps = [], []

    # Categorical label palette (ADR-0400) + attachments by wbs.
    helios_labels = [
        {"slug": "migration", "name": "Data migration", "color": "cyan", "position": 0},
        {
            "slug": "integration",
            "name": "Integration",
            "color": "purple",
            "position": 1,
        },
        {"slug": "compliance", "name": "Compliance", "color": "amber", "position": 2},
        {"slug": "core", "name": "Core CRM", "color": "blue", "position": 3},
    ]
    helios_task_labels = {
        "1.5": ["migration"],  # Data model design — the migration contract
        "2.3": ["core"],  # Lead pipeline
        "2.4": ["integration"],  # Email sync
        "2.13": ["compliance"],  # Audit log
        "2.14": ["integration", "compliance"],  # SSO integration
        "2.17": ["migration"],  # Data migration run
        "2.18": ["migration"],  # Cutover rehearsal
    }

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
    # Realized slip (#1784): vendor selection ran long, pushing 1.4-1.6 three
    # days right of the plan captured at kickoff. Baseline rows keep the
    # ORIGINAL dates; the current plan carries the slip, so the program rollup's
    # variance KPIs have real drift to show over the completed phase.
    baseline_rows = []
    cursor = 0
    prev = None
    for i, (name, ml) in enumerate(planning, start=1):
        wbs = f"1.{i}"
        slip = 3 if i >= 4 else 0
        tasks.append(
            {
                "wbs_path": wbs,
                "name": name,
                "status": "COMPLETE",
                "percent_complete": 100.0,
                "duration": ml,
                "planned_start": D(cursor + slip),
                "estimate": three_point(ml),
                "governance_class": "gated",
                "delivery_mode": "waterfall",
                "assignee": "ivan",
            }
        )
        if wbs in helios_task_labels:
            tasks[-1]["labels"] = helios_task_labels[wbs]
        baseline_rows.append(
            {"task": wbs, "start": D(cursor), "finish": D(cursor + ml), "duration": ml}
        )
        if prev:
            deps.append(
                {"predecessor": prev, "successor": wbs, "dep_type": "FS", "lag": 0}
            )
        prev = wbs
        cursor += ml

    # Planning-gate milestone: closes the waterfall phase (FS off 1.6) so the
    # program rollup's milestone health has a completed marker to report.
    tasks.append(
        {
            "wbs_path": "3",
            "name": "Planning gate approved",
            "status": "COMPLETE",
            "percent_complete": 100.0,
            "is_milestone": True,
            "planned_start": D(37),
            "governance_class": "gated",
            "delivery_mode": "milestone",
        }
    )
    deps.append({"predecessor": "1.6", "successor": "3", "dep_type": "FS", "lag": 0})

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
            # 21 completed (== the member COMPLETE sum) plus Email sync (2.4,
            # 3 pts) committed but carried into Sprint 2 -> PARTIAL close.
            "committed_points": 24,
            "completed_points": 21,
            "capacity_points": 32,
        },
        {
            "slug": "he-sprint-2",
            "name": "Build Sprint 2",
            "state": "ACTIVE",
            "start_date": D(74),
            "finish_date": D(87),
            # Activation-time members (2.1/2.4/2.7/2.10 = 18 pts); the audit-log
            # story (2.13) was injected mid-sprint and accepted, so it sits
            # outside the commitment.
            "committed_points": 18,
            "capacity_points": 32,
        },
        {
            "slug": "he-sprint-3",
            "name": "Build Sprint 3",
            "state": "PLANNED",
            "start_date": D(88),
            "finish_date": D(101),
            "capacity_points": 32,
            # The sprint -> milestone bridge the program rollup reads: Sprint 3
            # drives toward the go-live milestone.
            "target_milestone": "4",
        },
    ]
    states = ["COMPLETED", "ACTIVE", "PLANNED"]
    # Final-state overrides by wbs (#1784), on top of the formula placement, so
    # sprint aggregates reconcile with member stories: Sprint 1 varies its points
    # (COMPLETE sum 21); Sprint 2 reads as a mid-flight board (a completed
    # carryover, one story in review, ragged in-progress percentages, an
    # untouched injection); Sprint 3 varies its points and fits capacity (32).
    # 2.16 is declared at its post-replay state: the injection was REJECTED out
    # of the sprint, so it ends BACKLOG with no sprint at all.
    overrides: dict[str, dict[str, object]] = {
        # Build Sprint 1 (COMPLETED, sum 21).
        "2.3": {"story_points": 5},
        "2.6": {"story_points": 3},
        "2.9": {"story_points": 5},
        "2.12": {"story_points": 2},
        "2.15": {"story_points": 3},
        "2.18": {"story_points": 3},
        # Build Sprint 2 (ACTIVE).
        "2.1": {"percent_complete": 60.0, "remaining_points": 2},
        "2.4": {
            "story_points": 3,
            "status": "COMPLETE",
            "percent_complete": 100.0,
        },
        "2.7": {"status": "REVIEW", "percent_complete": 85.0, "remaining_points": 1},
        "2.10": {"percent_complete": 30.0, "remaining_points": 4},
        "2.13": {"story_points": 3, "status": "NOT_STARTED", "percent_complete": 0.0},
        "2.16": {"status": "BACKLOG", "percent_complete": 0.0, "sprint": None},
        # Build Sprint 3 (PLANNED, sum 32 == capacity).
        "2.2": {"story_points": 5},
        "2.5": {"story_points": 8},
        "2.8": {"story_points": 8},
        "2.11": {"story_points": 3},
        "2.14": {"story_points": 5},
        "2.17": {"story_points": 3},
    }
    for i, name in enumerate(stories, start=1):
        sidx = i % 3
        state = states[sidx]
        status = {
            "COMPLETED": "COMPLETE",
            "ACTIVE": "IN_PROGRESS",
            "PLANNED": "BACKLOG",
        }[state]
        override = overrides.get(f"2.{i}", {})
        points = override.get("story_points", [3, 5, 8][i % 3])
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
            "duration": {2: 2, 3: 2, 5: 3, 8: 5}[points],
            # Two engineers share the build; the timeline then load-balances a
            # couple of stories between them as sprints fill up.
            "assignee": ["mei", "nadia"][i % 2],
            "sprint": f"he-sprint-{sidx + 1}",
            "delivery_mode": "scrum",
            "governance_class": "flow",
        }
        story.update(override)
        if story.get("sprint") is None:
            del story["sprint"]
        if f"2.{i}" in helios_task_labels:
            story["labels"] = helios_task_labels[f"2.{i}"]
        tasks.append(story)
    # cross-phase dependency: the data-migration story depends on the planning data-model task
    deps.append({"predecessor": "1.5", "successor": "2.17", "dep_type": "FS", "lag": 0})

    # Go-live milestone: gated by the last build story (cutover rehearsal) and
    # targeted by Build Sprint 3 — the forecast_history commitment date below.
    tasks.append(
        {
            "wbs_path": "4",
            "name": "CRM go-live",
            "is_milestone": True,
            "planned_start": D(116),
            "governance_class": "gated",
            "delivery_mode": "milestone",
        }
    )
    deps.append({"predecessor": "2.18", "successor": "4", "dep_type": "FS", "lag": 0})

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
        # Sprint 1 closes PARTIAL: Email sync (2.4, 3 pts, finishing in Sprint 2)
        # misses the boundary — the shortfall behind 21-of-24.
        _ev(
            T(72, 11, 0),
            "task.comment",
            task("2.4"),
            "mei",
            body="Email sync won't clear review before the boundary — the IMAP "
            "provider quirks keep multiplying. Carrying it into Sprint 2.",
        ),
        _ev(
            T(73, 17, 0),
            "sprint.close",
            sprint("he-sprint-1"),
            "jordan",
            goal_outcome="PARTIAL",
        ),
        # Retro after the PARTIAL close: the carryover lesson plus a cadence fix.
        _ev(
            T(73, 17, 30),
            "retro.action",
            sprint("he-sprint-1"),
            "jordan",
            body="Pad estimates for third-party integrations — Email sync carried "
            "over on IMAP provider quirks.",
        ),
        _ev(
            T(73, 17, 45),
            "retro.action",
            sprint("he-sprint-1"),
            "ivan",
            body="Start the review pass by mid-sprint so stories don't stack up on "
            "the final two days.",
        ),
        # Build Sprint 2 (active) — the carryover lands, a load-balancing
        # reassignment, a *rejected* mid-sprint injection the team defers to
        # protect the goal, and an *accepted* one it can absorb.
        _ev(
            T(74, 9, 0),
            "task.comment",
            task("2.4"),
            "mei",
            body="Picking Email sync back up first thing this sprint.",
        ),
        _ev(T(74, 9, 30), "task.status", task("2.4"), "mei", to="IN_PROGRESS"),
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
        # Recent beats — the demo reaches import day: the carryover completes,
        # and a second injection (the audit log) is accepted because the freed
        # capacity can absorb it.
        _ev(
            T(80, 9, 0),
            "task.comment",
            task("2.13"),
            "jordan",
            body="Compliance flagged the audit log for the pilot go/no-go — "
            "pulling it into this sprint.",
        ),
        _ev(
            T(80, 9, 5),
            "sprint.scope_inject",
            task("2.13"),
            "jordan",
            goal_impact=False,
        ),
        _ev(
            T(80, 11, 0),
            "task.comment",
            task("2.13"),
            "ivan",
            body="We can absorb it — Email sync is closing out early. Accepting "
            "the injection.",
        ),
        _ev(T(80, 11, 5), "sprint.scope_resolve", task("2.13"), "ivan", to="ACCEPTED"),
        _ev(
            T(80, 15, 0),
            "task.comment",
            task("2.4"),
            "mei",
            body="OAuth refresh and folder mapping are solid — merged. The "
            "carryover is done.",
        ),
        _ev(T(80, 15, 30), "task.status", task("2.4"), "mei", to="COMPLETE"),
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
                # Forecast-trend history (#376): ~2 months of snapshots. The
                # go-live commitment (milestone 4, A+35) holds while the CPM
                # finish drifts a few days past it and the MC band widens right,
                # so total-float pressure turns negative near import day.
                "forecast_history": {
                    "days": 60,
                    "commitment_finish": D(116),
                    "cpm_start": D(111),
                    "cpm_end": D(119),
                    "p50_start": D(113),
                    "p50_end": D(121),
                    "p80_start": D(116),
                    "p80_end": D(126),
                    "p95_start": D(121),
                    "p95_end": D(133),
                    "mc_iterations": 2000,
                    # ~half the plan is done on import day: 6 planning tasks, the
                    # planning gate, Build Sprint 1's six stories, and the
                    # carried Email sync.
                    "completion_ratio": 0.5,
                },
                "labels": helios_labels,
                "tasks": tasks,
                "dependencies": deps,
                "sprints": sprints,
                "baselines": [
                    {
                        "name": "Kickoff baseline",
                        "is_active": True,
                        # Captured as planning began, before vendor selection
                        # slipped 1.4-1.6 three days right of it.
                        "captured_at": D(1),
                        "tasks": baseline_rows,
                    }
                ],
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
