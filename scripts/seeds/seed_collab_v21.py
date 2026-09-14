"""Seed schema v2.1 collaboration layer for the bundled samples (#3603, #3490-#3493).

The three builders produce each sample's 2.0 document — schedule, sprints, people,
timeline. This module adds the layer a persona actually talks through: the program
backlog, program ceremonies, acceptance criteria, threaded review exchanges with
reactions and acknowledgements, decision notes, a few hand-logged hours, and — on
Atlas and Aurora — the agent trail and a share link.

Kept out of the builders so each program's 2.1 story reads in one place. Pure and
deterministic like the builders: no clock, no randomness, anchor-relative
timestamps only. Every reference to an existing comment is located by its task and
the start of its body and fails loudly if the builder's wording changes, so the
layer can never silently drift off the timeline it annotates.

Time and timesheet submissions beyond the hand-logged beats are synthesized by the
importer on the sample path; this module does not author them.
"""

from __future__ import annotations

from typing import Any

_LIVE_SPRINT_STATES = ("ACTIVE", "COMPLETED")


def _ev(at: str, action: str, target: str, actor: str, **extra: Any) -> dict[str, Any]:
    event: dict[str, Any] = {
        "at": at,
        "action": action,
        "target": target,
        "actor": actor,
    }
    event.update(extra)
    return event


def _comment(seed: dict[str, Any], target: str, body_prefix: str) -> dict[str, Any]:
    for event in seed["events"]:
        if (
            event["action"] == "task.comment"
            and event.get("target") == target
            and event.get("body", "").startswith(body_prefix)
        ):
            return event
    raise LookupError(f"no task.comment on {target} starting {body_prefix!r}")


def _thread(
    seed: dict[str, Any],
    target: str,
    root: tuple[str, str],
    replies: list[tuple[str, str | None]],
) -> None:
    """Turn an authored flat exchange into a thread: root slug + replies pointing at it."""
    prefix, slug = root
    _comment(seed, target, prefix)["slug"] = slug
    for reply_prefix, reply_slug in replies:
        event = _comment(seed, target, reply_prefix)
        event["reply_to"] = slug
        if reply_slug:
            event["slug"] = reply_slug


def _task(seed: dict[str, Any], project_slug: str, wbs: str) -> dict[str, Any]:
    for project in seed["projects"]:
        if project["slug"] != project_slug:
            continue
        for task in project.get("tasks", []):
            if task["wbs_path"] == wbs:
                return task
    raise LookupError(f"no task {project_slug}:{wbs}")


def _criteria(*rows: str | dict[str, Any]) -> list[dict[str, Any]]:
    return [{"text": row} if isinstance(row, str) else row for row in rows]


def _met(text: str, by: str, at: str) -> dict[str, Any]:
    return {"text": text, "met": True, "met_by": by, "met_at": at}


def _ready_live_stories(seed: dict[str, Any]) -> None:
    """A story in an ACTIVE or COMPLETED sprint was ready when it was planned (#3492).

    Only fills a story the builder left without a ``dor``; an authored value wins.
    """
    for project in seed["projects"]:
        live = {
            s["slug"]
            for s in project.get("sprints", [])
            if s["state"] in _LIVE_SPRINT_STATES
        }
        for task in project.get("tasks", []):
            if (
                task.get("type") == "story"
                and task.get("sprint") in live
                and "dor" not in task
            ):
                task["dor"] = "ready"


def _finish(
    seed: dict[str, Any],
    *,
    backlog: list[dict[str, Any]],
    ceremonies: list[dict[str, Any]],
    criteria: dict[tuple[str, str], list[dict[str, Any]]],
    events: list[dict[str, Any]],
    agent_actions: list[dict[str, Any]] | None = None,
    share_links: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    seed["schema_version"] = "2.1"
    program = seed["program"]
    program["backlog_items"] = backlog
    program["ceremonies"] = ceremonies
    if agent_actions:
        program["agent_actions"] = agent_actions
    for (project_slug, wbs), rows in criteria.items():
        _task(seed, project_slug, wbs)["acceptance_criteria"] = rows
    for project in seed["projects"]:
        links = (share_links or {}).get(project["slug"])
        if links:
            project["share_links"] = links
    seed["events"].extend(events)
    _ready_live_stories(seed)
    return seed


# ---------------------------------------------------------------------------
# Atlas Platform Launch — the hybrid program, and the agent-oversight demo
# ---------------------------------------------------------------------------


def apply_atlas(seed: dict[str, Any]) -> dict[str, Any]:
    pc, mt, gtm = "task:platform-core", "task:migration-tooling", "task:gtm-readiness"

    _thread(
        seed,
        f"{pc}:1.1",
        ("Security review: the state param", "sso-security-review"),
        [
            ("Validated state and nonce", None),
            ("Solid now. Approving.", "sso-approval"),
        ],
    )
    _thread(
        seed,
        f"{pc}:5.3",
        ("@atlas-priya this is a vendor wait", "digest-vendor-wait"),
        [("Acknowledged. @atlas-alex", "digest-carry-call")],
    )
    _thread(
        seed,
        f"{mt}:2.2",
        ("Review: the account-type enum", "mt-enum-review"),
        [("Split the enum mapping", None), ("Reconciles now. Approved.", None)],
    )

    events = [
        _ev("A-55T11:20", "task.ack", "comment:sso-security-review", "mei"),
        _ev("A-51T16:20", "task.react", "comment:sso-approval", "mei", emoji="👍"),
        _ev("A-34T11:20", "task.ack", "comment:mt-enum-review", "yuki"),
        _ev("A-9T10:30", "task.ack", "comment:digest-vendor-wait", "priya"),
        _ev("A-8T17:00", "task.react", "comment:digest-carry-call", "alex", emoji="👍"),
        _ev(
            "A-5T10:00",
            "task.comment",
            f"{pc}:4.4",
            "alex",
            body="@atlas-nadia @atlas-jordan the dunning flow and its notice copy (4.10) "
            "ship together — keep them in one review so the retry ladder and the "
            "wording cannot drift apart.",
        ),
        # Decisions — the Decisions view reads these, not the comment prose.
        _ev(
            "A-51T16:10",
            "task.note",
            f"{pc}:1.1",
            "priya",
            body="Decision: every OIDC callback validates state and nonce. A login CSRF "
            "finding blocks release; it is not a follow-up ticket.",
            decision=True,
        ),
        _ev(
            "A-30T11:05",
            "task.note",
            f"{pc}:4.5",
            "jordan",
            body="Decision: multi-jurisdiction tax moves out of 1.0 rather than being "
            "deferred inside it. The tax engine covers the launch jurisdictions only.",
            decision=True,
            pinned=True,
        ),
        _ev(
            "A-30T16:10",
            "task.note",
            f"{mt}:2.2",
            "omar",
            body="Decision: legacy account-type codes map one-to-one, and the "
            "reconciliation check fails the run on any lossy mapping.",
            decision=True,
        ),
        _ev(
            "A-10T09:10",
            "task.note",
            f"{mt}:3.1",
            "sam",
            body="The active baseline is now the post-dry-run re-plan. Slip against the "
            "kickoff plan lives on the superseded baseline — compare both before "
            "calling a date.",
            pinned=True,
        ),
        _ev(
            "A-2T11:10",
            "task.note",
            f"{pc}:3.4",
            "priya",
            body="Decision: accept the Backfill tool injection and hold Webhook retries "
            "dashboard (2.8) for Sprint 6 to protect the sprint goal.",
            decision=True,
        ),
        # Criteria ticked during review, on dated beats.
        _ev("A-1T10:00", "task.ac_met", f"{pc}:4.4", "jordan", criterion=0),
        _ev("A-1T10:05", "task.ac_met", f"{pc}:4.4", "jordan", criterion=1),
        _ev("A-1T15:00", "task.ac_met", f"{pc}:3.4", "yuki", criterion=0),
        # Hand-logged hours with notes; the importer fills the rest.
        _ev(
            "A-52T17:30",
            "time.log",
            f"{pc}:1.1",
            "mei",
            minutes=240,
            note="State and nonce validation plus the regression test",
        ),
        _ev(
            "A-2T16:30",
            "time.log",
            f"{pc}:4.4",
            "nadia",
            minutes=180,
            note="Retry ladder and grace-period edge cases",
        ),
        _ev(
            "A-2T17:00",
            "time.log",
            f"{mt}:3.1",
            "yuki",
            minutes=300,
            note="Dry-run: tenant shard fan-out profiling",
        ),
        _ev(
            "A-2T12:00",
            "time.log",
            f"{gtm}:2.5",
            "clara",
            minutes=120,
            note="Launch blog, pricing section",
        ),
    ]

    backlog = [
        {
            "slug": "scim-provisioning",
            "title": "SCIM provisioning for enterprise tenants",
            "description": "Three design-partner customers asked for automated user "
            "provisioning from their identity provider before rollout.",
            "item_type": "feature",
            "tags": ["customer-request", "identity"],
            "priority_rank": 1,
            "story_points": 13,
            "created_by": "priya",
            "created_at": "A-35T10:00",
        },
        {
            "slug": "usage-alerts",
            "title": "Usage alerts at 80% of plan",
            "item_type": "story",
            "tags": ["customer-request", "billing"],
            "priority_rank": 2,
            "story_points": 5,
            "created_by": "jordan",
            "created_at": "A-28T14:00",
        },
        {
            "slug": "invoice-csv-export",
            "title": "CSV export of invoices",
            "item_type": "story",
            "tags": ["billing"],
            "priority_rank": 3,
            "story_points": 3,
            "created_by": "nadia",
            "created_at": "A-20T11:00",
        },
        {
            "slug": "webhook-secret-rotation",
            "title": "Webhook signing-secret rotation",
            "item_type": "spike",
            "tags": ["security"],
            "priority_rank": 4,
            "story_points": 2,
            "created_by": "tom",
            "created_at": "A-9T16:00",
        },
        {
            "slug": "dunning-notice-copy",
            "title": "Dunning notice copy",
            "item_type": "story",
            "status": "pulled",
            "pulled_to": "platform-core:4.10",
            "pulled_by": "priya",
            "pulled_at": "A-20T09:30",
            "tags": ["billing"],
            "story_points": 2,
            "created_by": "jordan",
            "created_at": "A-24T15:00",
        },
        {
            "slug": "backfill-tool",
            "title": "Backfill tool for warehouse schema churn",
            "item_type": "story",
            "status": "pulled",
            "pulled_to": "platform-core:3.4",
            "pulled_by": "jordan",
            "pulled_at": "A-3T09:25",
            "tags": ["data"],
            "story_points": 5,
            "created_by": "yuki",
            "created_at": "A-12T10:00",
        },
        {
            "slug": "multi-jurisdiction-tax",
            "title": "Multi-jurisdiction tax",
            "description": "Archived by the scope decision: multi-jurisdiction tax moves "
            "out of 1.0 rather than being deferred inside it.",
            "item_type": "feature",
            "status": "archived",
            "tags": ["billing", "out-of-1.0"],
            "story_points": 21,
            "created_by": "jordan",
            "created_at": "A-45T10:00",
        },
        {
            "slug": "partner-referral-tracking",
            "title": "Partner referral tracking",
            "description": "Rejected for launch: the partner program starts after GA.",
            "item_type": "feature",
            "status": "archived",
            "tags": ["gtm"],
            "created_by": "clara",
            "created_at": "A-25T13:00",
        },
    ]

    ceremonies = [
        {
            "name": "Program Sync",
            "cadence_type": "weekly",
            "cadence_day": "tuesday",
            "cadence_time": "10:00",
            "duration_minutes": 30,
            "owner_role": "Program Manager",
        },
        {
            "name": "Cross-team Dependency Review",
            "cadence_type": "biweekly",
            "cadence_day": "wednesday",
            "cadence_time": "14:00",
            "duration_minutes": 45,
            "owner_role": "Delivery Lead",
        },
        {
            "name": "Steering Committee",
            "cadence_type": "monthly",
            "cadence_day": "1st-thursday",
            "cadence_time": "15:00",
            "duration_minutes": 60,
            "owner_role": "Executive Sponsor",
        },
        {
            "name": "Launch Readiness Review",
            "cadence_type": "on_milestone",
            "duration_minutes": 90,
            "owner_role": "Program Manager",
        },
    ]

    criteria = {
        ("platform-core", "1.5"): _criteria(
            _met(
                "Every admin role change writes an entry with actor, before and after",
                "priya",
                "A-3T15:30",
            ),
            _met(
                "Entries cannot be edited or deleted through the API",
                "priya",
                "A-3T15:30",
            ),
            _met(
                "The log exports as CSV for the security review", "priya", "A-3T15:30"
            ),
        ),
        ("platform-core", "3.4"): _criteria(
            "Backfills one tenant at a time without locking the warehouse",
            {
                "text": "Re-running a backfill never duplicates rows",
                "given": "a backfill that already completed for a tenant",
                "when": "it runs again after a schema change",
                "then": "no row is written twice",
            },
            "Progress resumes after a worker restart",
        ),
        ("platform-core", "4.4"): _criteria(
            "Retries follow the 1-3-7 day ladder",
            "Paying an invoice cancels its pending retries",
            "Access is suspended only after the last retry fails",
        ),
        ("platform-core", "4.5"): _criteria(
            "Tax is calculated for every launch jurisdiction",
            "An out-of-scope jurisdiction is refused at checkout, never taxed at zero",
        ),
        ("platform-core", "4.10"): _criteria(
            "Legal has reviewed the copy for each notice",
            "Every notice names the amount due and the next retry date",
        ),
        ("platform-core", "5.3"): _criteria(
            _met("Digests send in the recipient's timezone", "diego", "A-6T12:00"),
            "A user who opts out receives nothing",
        ),
    }

    # The agent-oversight trail (#3603): reads, one computed schedule answer with its
    # derivation, and one refusal of a write that would break the plan.
    agent_actions = [
        {
            "at": "A-5T09:00",
            "principal": "sam",
            "action": "get_program_schedule",
            "method": "GET",
            "capability": "mcp:read",
            "project": "platform-core",
            "object_type": "program",
            "verdict": "allowed",
            "summary": "Read the Atlas program schedule across Platform Core, Migration "
            "Tooling and GTM Readiness.",
        },
        {
            "at": "A-5T09:02",
            "principal": "sam",
            "action": "get_critical_path",
            "method": "GET",
            "capability": "mcp:read",
            "object": "migration-tooling:3.2",
            "verdict": "allowed",
            "summary": 'Answered "what drives the cutover date?": Platform Core 2.1 Tenant '
            "model -> Migration 2.1 ETL framework (FS +5 days) -> 3.1 Dry-run -> 3.2 "
            "Performance tuning -> cutover. The dry-run re-plan moved phases 3-5 out 6-7 "
            "days, so 3.2 now carries zero total float: any further slip in the dry-run "
            "moves the cutover milestone day for day.",
        },
        {
            "at": "A-4T14:30",
            "principal": "priya",
            "action": "get_task",
            "method": "GET",
            "capability": "mcp:read",
            "object": "platform-core:5.3",
            "verdict": "allowed",
            "summary": "Read Digest scheduler: blocked four days on vendor DKIM "
            "verification, unblocked, back in progress.",
        },
        {
            "at": "A-3T10:15",
            "principal": "jordan",
            "action": "list_risks",
            "method": "GET",
            "capability": "mcp:read",
            "project": "platform-core",
            "object_type": "risk",
            "verdict": "allowed",
            "summary": "Listed the open and mitigating risks on Platform Core.",
        },
        {
            "at": "A-2T15:20",
            "principal": "sam",
            "action": "update_task",
            "method": "PATCH",
            "capability": "mcp:read",
            "object": "migration-tooling:3.2",
            "verdict": "refused",
            "refusal_reason": "policy",
            "refusal_constraint": "capability_scope",
            "projected_impact": {
                "requested_change": "planned_start 6 working days earlier",
                "violates": "FS dependency on 3.1 Dry-run migration",
                "critical_path": True,
            },
            "summary": "Refused a write: the agent tried to pull Performance tuning's start "
            "forward six working days, ahead of its Dry-run predecessor. The token is "
            "read-only, and the change would have broken a finish-to-start dependency "
            "on the critical path.",
        },
        {
            "at": "A-1T08:45",
            "principal": "alex",
            "action": "get_project_overview",
            "method": "GET",
            "capability": "mcp:read",
            "project": "platform-core",
            "object_type": "project",
            "verdict": "allowed",
            "summary": "Read the Platform Core overview: Sprint 5 progress and the "
            "milestone forecast.",
        },
    ]

    return _finish(
        seed,
        backlog=backlog,
        ceremonies=ceremonies,
        criteria=criteria,
        events=events,
        agent_actions=agent_actions,
    )


# ---------------------------------------------------------------------------
# Aurora Mobile App — the pure-scrum team, and the share link
# ---------------------------------------------------------------------------


def apply_aurora(seed: dict[str, Any]) -> dict[str, Any]:
    au = "task:aurora"

    _thread(
        seed,
        f"{au}:1.1",
        ("Review: the skip button", "onboarding-review"),
        [
            ("Fixed — onboarding-complete", None),
            ("QA pass on iOS and Android", "onboarding-qa"),
        ],
    )
    _thread(
        seed,
        f"{au}:4.4",
        ("Marketing needs the widget gallery", "widget-gallery-ask"),
        [("We have the room this time", "widget-gallery-accept")],
    )
    _comment(seed, f"{au}:2.5", "Settings sync conflict resolution")["slug"] = (
        "settings-sync-lww"
    )
    _comment(seed, f"{au}:3.5", "Crash reporting is wired")["slug"] = (
        "crash-reporting-pr"
    )

    events = [
        _ev("A-57T11:15", "task.ack", "comment:onboarding-review", "mei"),
        _ev("A-54T16:10", "task.react", "comment:onboarding-qa", "mei", emoji="👍"),
        _ev(
            "A-17T11:30",
            "task.react",
            "comment:widget-gallery-accept",
            "clara",
            emoji="👍",
        ),
        _ev(
            "A-2T15:30",
            "task.comment",
            f"{au}:3.5",
            "sam",
            reply_to="crash-reporting-pr",
            body="@aurora-tom can you take this review? Symbolication is new to the team "
            "and you set up the release pipeline.",
        ),
        _ev("A-2T15:45", "task.ack", "comment:crash-reporting-pr", "tom"),
        _ev(
            "A-1T11:00",
            "task.comment",
            f"{au}:2.5",
            "priya",
            reply_to="settings-sync-lww",
            body="@aurora-diego @aurora-mei agreed — pair on a per-field merge for the "
            "notification prefs. I would rather slip this story than ship a sync that "
            "drops an offline edit.",
        ),
        _ev(
            "A-59T13:05",
            "task.note",
            f"{au}:1.5",
            "priya",
            body="Decision: biometric login moves to Mei, so launch-critical auth does not "
            "wait on a learning curve.",
            decision=True,
        ),
        _ev(
            "A-31T11:10",
            "task.note",
            f"{au}:5.3",
            "priya",
            body="Decision: pull the monetization slice (receipt export, activity feed, "
            "bookmark sync) after the 4% paywall open rate in beta. Revisit once onboarding "
            "completion clears 60%.",
            decision=True,
            pinned=True,
        ),
        _ev(
            "A-3T11:10",
            "task.note",
            f"{au}:1.6",
            "sam",
            body="Decision: cancel Sprint 6 — holiday week, 8 points of capacity against a "
            "30-point commitment — and fold its scope into Sprint 7.",
            decision=True,
        ),
        _ev("A-2T16:00", "task.ac_met", f"{au}:2.3", "diego", criterion=0),
        _ev("A-1T15:30", "task.ac_met", f"{au}:3.5", "tom", criterion=0),
        _ev(
            "A-5T16:00",
            "time.log",
            f"{au}:1.5",
            "mei",
            minutes=180,
            note="Secure-enclave path, second attempt",
        ),
        _ev(
            "A-1T15:00",
            "time.log",
            f"{au}:3.5",
            "tom",
            minutes=150,
            note="Crash reporting review: symbol upload",
        ),
    ]

    backlog = [
        {
            "slug": "crash-on-rotate",
            "title": "Crash when rotating during a photo upload",
            "item_type": "bug",
            "tags": ["bug", "beta-feedback"],
            "priority_rank": 0,
            "story_points": 2,
            "created_by": "tom",
            "created_at": "A-6T10:00",
        },
        {
            "slug": "watch-companion",
            "title": "Apple Watch companion",
            "item_type": "feature",
            "tags": ["customer-request"],
            "priority_rank": 1,
            "story_points": 13,
            "created_by": "priya",
            "created_at": "A-40T10:00",
        },
        {
            "slug": "sync-conflict-ui",
            "title": "Show sync conflicts instead of resolving them silently",
            "item_type": "story",
            "tags": ["offline"],
            "priority_rank": 2,
            "story_points": 5,
            "created_by": "sam",
            "created_at": "A-25T09:00",
        },
        {
            "slug": "portuguese-localization",
            "title": "Portuguese localization",
            "item_type": "story",
            "tags": ["growth"],
            "priority_rank": 3,
            "story_points": 3,
            "created_by": "clara",
            "created_at": "A-12T14:00",
        },
        {
            "slug": "widget-gallery",
            "title": "Widget gallery for the launch campaign",
            "item_type": "story",
            "status": "pulled",
            "pulled_to": "aurora:4.4",
            "pulled_by": "priya",
            "pulled_at": "A-18T09:25",
            "tags": ["marketing"],
            "story_points": 5,
            "created_by": "clara",
            "created_at": "A-22T11:00",
        },
        {
            "slug": "app-shortcuts",
            "title": "App shortcuts",
            "item_type": "story",
            "status": "pulled",
            "pulled_to": "aurora:1.6",
            "pulled_by": "sam",
            "pulled_at": "A-3T11:05",
            "story_points": 3,
            "created_by": "tom",
            "created_at": "A-10T10:00",
        },
        {
            "slug": "paywall-redesign",
            "title": "Paywall redesign",
            "description": "Archived with the Sprint 3 pivot: 4% of the beta cohort opened "
            "the paywall.",
            "item_type": "feature",
            "status": "archived",
            "tags": ["monetization"],
            "created_by": "priya",
            "created_at": "A-45T10:00",
        },
    ]

    ceremonies = [
        {
            "name": "Stakeholder Demo",
            "cadence_type": "biweekly",
            "cadence_day": "friday",
            "cadence_time": "15:00",
            "duration_minutes": 45,
            "owner_role": "Product Owner",
        },
        {
            "name": "Release Go/No-Go",
            "cadence_type": "on_milestone",
            "duration_minutes": 30,
            "owner_role": "Product Owner",
        },
    ]

    criteria = {
        ("aurora", "1.5"): _criteria(
            _met("Face ID and fingerprint both unlock the app", "mei", "A-5T14:30"),
            _met("Falls back to the passcode after three failures", "mei", "A-5T14:30"),
        ),
        ("aurora", "2.3"): _criteria(
            "Shares a link, an image, or both through the system sheet",
            "Cancelling the sheet leaves no draft behind",
        ),
        ("aurora", "2.5"): _criteria(
            "An offline change syncs within a minute of reconnecting",
            "Two devices editing notification prefs never lose either change",
        ),
        ("aurora", "3.5"): _criteria(
            "Release-build crashes arrive symbolicated",
            _met(
                "No personal data leaves the device in a crash report",
                "nadia",
                "A-2T14:05",
            ),
            "Crash reporting can be turned off in settings",
        ),
        ("aurora", "6.5"): _criteria(
            "Every list screen has an empty state with a next action"
        ),
    }

    return _finish(
        seed,
        backlog=backlog,
        ceremonies=ceremonies,
        criteria=criteria,
        events=events,
        share_links={
            "aurora": [
                {
                    "label": "Stakeholder board — current sprint",
                    "content_kind": "board",
                    "created_by": "priya",
                    "expires_in_days": 30,
                }
            ]
        },
    )


# ---------------------------------------------------------------------------
# Bayside Civic Center — the waterfall construction program
# ---------------------------------------------------------------------------


def apply_bayside(seed: dict[str, Any]) -> dict[str, Any]:
    site, bldg = "task:bayside-sitework", "task:bayside-building"

    _thread(
        seed,
        f"{site}:2.2",
        ("Inspection: bar spacing on the north face", "footing-inspection-fail"),
        [
            ("Re-tied to spec", None),
            ("Re-inspection passed.", "footing-reinspection-pass"),
        ],
    )
    _thread(
        seed,
        f"{site}:2.1",
        ("Hit a soft layer at the east footing", "east-soft-layer"),
        [("Over-excavating the soft zone", None)],
    )

    events = [
        _ev("A-59T09:30", "task.ack", "comment:east-soft-layer", "sam"),
        _ev("A-46T10:30", "task.ack", "comment:footing-inspection-fail", "diego"),
        _ev(
            "A-43T09:30",
            "task.react",
            "comment:footing-reinspection-pass",
            "sam",
            emoji="👍",
        ),
        _ev(
            "A-12T10:00",
            "task.comment",
            f"{site}:3.2",
            "sam",
            body="@bayside-diego @bayside-raj re-estimate decking with the mezzanine framing "
            "in before we re-baseline — I want one change order, not two.",
        ),
        _ev(
            "A-5T11:00",
            "task.comment",
            f"{bldg}:1.1",
            "raj",
            body="@bayside-nadia the crane inspection moves decking, which moves your "
            "rough-in start. Check the new date before you confirm the electrician.",
        ),
        # Building & Fit-out had one comment; a project mobilizing in weeks talks more.
        _ev(
            "A-3T10:00",
            "task.comment",
            f"{bldg}:1.2",
            "omar",
            body="Plumbing rough-in materials are staged. Waiting on the framing inspection "
            "like everyone else.",
        ),
        _ev(
            "A-2T09:00",
            "task.comment",
            f"{bldg}:1.4",
            "tom",
            body="Rooftop units ship in two lots — the second lot lands the week after decking.",
        ),
        _ev(
            "A-1T10:00",
            "task.comment",
            f"{bldg}:1.3",
            "diego",
            body="HVAC submittals came back approved as noted: two duct sizes change at the "
            "mezzanine.",
        ),
        _ev(
            "A-1T15:00",
            "task.comment",
            f"{bldg}:1.5",
            "nadia",
            body="Booked the MEP inspector tentatively; I will firm it up once rough-in has a "
            "start date.",
        ),
        _ev(
            "A-56T08:10",
            "task.note",
            f"{site}:2.1",
            "sam",
            body="Decision: over-excavate and backfill the east soft zone with engineered fill "
            "rather than redesign the footing. Accepts the excavation re-estimate and keeps "
            "the structural design unchanged.",
            decision=True,
            pinned=True,
        ),
        _ev(
            "A-13T09:10",
            "task.note",
            f"{site}:3.2",
            "sam",
            body="Decision: the mezzanine goes in as one change order, with decking "
            "re-estimated and the schedule re-baselined against it.",
            decision=True,
        ),
        _ev(
            "A-57T16:00",
            "time.log",
            f"{site}:2.1",
            "omar",
            minutes=480,
            note="Over-excavation, east soft zone",
        ),
        _ev(
            "A-44T15:30",
            "time.log",
            f"{site}:2.2",
            "diego",
            minutes=360,
            note="Re-tie the north face to spec",
        ),
    ]

    backlog = [
        {
            "slug": "ev-charging-conduit",
            "title": "EV charging conduit in the parking structure",
            "description": "Owner request: rough in conduit now so chargers can be added "
            "without trenching later.",
            "item_type": "task",
            "tags": ["owner-request"],
            "priority_rank": 1,
            "created_by": "sam",
            "created_at": "A-15T10:00",
        },
        {
            "slug": "mezzanine-grid-c",
            "title": "Mezzanine at grid C",
            "description": "Owner change request, taken as one change order.",
            "item_type": "task",
            "status": "pulled",
            "pulled_to": "bayside-sitework:3.2",
            "pulled_by": "sam",
            "pulled_at": "A-13T09:00",
            "tags": ["change-order"],
            "created_by": "sam",
            "created_at": "A-20T10:00",
        },
        {
            "slug": "low-e-lobby-glazing",
            "title": "Low-E lobby glazing upgrade",
            "description": "Rejected by the owner: over the remaining contingency.",
            "item_type": "task",
            "status": "archived",
            "tags": ["owner-request"],
            "created_by": "diego",
            "created_at": "A-30T10:00",
        },
    ]

    ceremonies = [
        {
            "name": "OAC Meeting",
            "cadence_type": "weekly",
            "cadence_day": "thursday",
            "cadence_time": "09:00",
            "duration_minutes": 60,
            "owner_role": "Project Manager",
        },
        {
            "name": "Safety Stand-down",
            "cadence_type": "monthly",
            "cadence_day": "1st-monday",
            "cadence_time": "07:00",
            "duration_minutes": 30,
            "owner_role": "Site Superintendent",
        },
        {
            "name": "Substantial Completion Walkthrough",
            "cadence_type": "on_milestone",
            "duration_minutes": 120,
            "owner_role": "Project Manager",
        },
    ]

    return _finish(
        seed, backlog=backlog, ceremonies=ceremonies, criteria={}, events=events
    )


# ---------------------------------------------------------------------------
# 1.0 GA Launch — four workstreams, one outcome
# ---------------------------------------------------------------------------


def apply_ga_launch(seed: dict[str, Any]) -> dict[str, Any]:
    sec, soc2, mkt = "task:ga-security", "task:ga-soc2", "task:ga-marketing"

    _comment(seed, f"{sec}:2", "Triage done: seven criticals")["slug"] = (
        "pentest-triage"
    )

    events = [
        _ev(
            "A-12T09:00",
            "task.comment",
            f"{sec}:2",
            "dana",
            reply_to="pentest-triage",
            slug="triage-ask",
            body="Seven is the number we plan against now. @ga-malcolm can you take the two "
            "auth-path criticals?",
        ),
        _ev(
            "A-12T11:00",
            "task.comment",
            f"{sec}:2",
            "malcolm",
            reply_to="pentest-triage",
            body="Yes, half time from Monday. Platform on-call stays with me.",
        ),
        _ev("A-13T16:30", "task.ack", "comment:pentest-triage", "malcolm"),
        _ev("A-12T09:30", "task.react", "comment:triage-ask", "janus", emoji="👍"),
        _ev(
            "A-30T10:00",
            "task.comment",
            f"{soc2}:2",
            "bob",
            body="@ga-lena the control narratives for CC6 and CC7 are the two I need first; "
            "the rest can follow.",
        ),
        # SOC 2 had one comment; its evidence work is where the audit risk lives.
        _ev(
            "A-20T14:00",
            "task.comment",
            f"{soc2}:3",
            "bob",
            body="Evidence collection is gated on security sign-off, so I am starting with "
            "the controls that do not depend on it.",
        ),
        _ev(
            "A-8T10:00",
            "task.comment",
            f"{soc2}:3",
            "bob",
            body="Access-review evidence is pulled for the quarter. Change-management evidence "
            "waits on the remediation tickets.",
        ),
        _ev(
            "A-6T15:00",
            "task.comment",
            f"{soc2}:4",
            "malcolm",
            body="Readiness review slot is held with the auditor. It moves if sign-off moves.",
        ),
        _ev(
            "A-1T16:00",
            "task.comment",
            f"{mkt}:4",
            "jane",
            body="@ga-lena @ga-dana press outreach waits on the blog draft. I would rather "
            "slip outreach a day than send it without the disclosure paragraph.",
        ),
        _ev(
            "A-33T10:05",
            "task.note",
            f"{soc2}:2",
            "bob",
            body="Decision: Lena drafts the control narratives first and launch content "
            "second. The blog slips rather than the audit.",
            decision=True,
        ),
        _ev(
            "A-4T09:05",
            "task.note",
            f"{sec}:3",
            "dana",
            body="Decision: Malcolm splits half time onto the two auth-path criticals; "
            "platform on-call stays with him rather than rotating mid-launch.",
            decision=True,
            pinned=True,
        ),
        _ev("A-1T15:00", "task.ac_met", f"{mkt}:3", "jane", criterion=0),
        _ev(
            "A-2T14:00",
            "time.log",
            f"{sec}:3",
            "janus",
            minutes=300,
            note="Verify the auth-path critical fixes",
        ),
        _ev(
            "A-1T13:30",
            "time.log",
            f"{mkt}:3",
            "lena",
            minutes=240,
            note="Blog draft and docs diff",
        ),
    ]

    backlog = [
        {
            "slug": "public-status-page",
            "title": "Public status page",
            "item_type": "feature",
            "tags": ["customer-request"],
            "priority_rank": 1,
            "story_points": 8,
            "created_by": "malcolm",
            "created_at": "A-18T10:00",
        },
        {
            "slug": "analyst-briefing-kit",
            "title": "Analyst briefing kit",
            "item_type": "story",
            "status": "pulled",
            "pulled_to": "ga-marketing:4",
            "pulled_by": "dana",
            "pulled_at": "A-14T10:00",
            "created_by": "jane",
            "created_at": "A-20T10:00",
        },
        {
            "slug": "bug-bounty-program",
            "title": "Bug bounty program",
            "description": "Deferred past GA: triage capacity is consumed by pen-test "
            "remediation.",
            "item_type": "feature",
            "status": "archived",
            "tags": ["security"],
            "created_by": "janus",
            "created_at": "A-10T10:00",
        },
    ]

    ceremonies = [
        {
            "name": "Launch Readiness Sync",
            "cadence_type": "weekly",
            "cadence_day": "monday",
            "cadence_time": "11:00",
            "duration_minutes": 30,
            "owner_role": "Launch Lead",
        },
        {
            "name": "Audit Readiness Check-in",
            "cadence_type": "biweekly",
            "cadence_day": "wednesday",
            "cadence_time": "16:00",
            "duration_minutes": 30,
            "owner_role": "Compliance Lead",
        },
        {
            "name": "Security Sign-off Board",
            "cadence_type": "on_milestone",
            "duration_minutes": 60,
            "owner_role": "Security Lead",
        },
    ]

    criteria = {
        ("ga-marketing", "1"): _criteria(
            _met("Positioning is approved by the launch lead", "dana", "A-30T10:00")
        ),
        ("ga-marketing", "3"): _criteria(
            "Blog and docs describe only what ships in GA",
            "The security-disclosure paragraph is reviewed by the security lead",
        ),
        ("ga-marketing", "4"): _criteria(
            "Every briefing uses the approved positioning",
            "No outreach goes out before the embargo lifts",
        ),
    }

    return _finish(
        seed, backlog=backlog, ceremonies=ceremonies, criteria=criteria, events=events
    )


# ---------------------------------------------------------------------------
# Helios CRM Replacement — the hybrid bridge, and late requirements
# ---------------------------------------------------------------------------


def apply_helios(seed: dict[str, Any]) -> dict[str, Any]:
    he = "task:helios"

    _thread(
        seed,
        f"{he}:2.3",
        ("Review: stage transitions don't fire", "pipeline-review"),
        [
            ("Wired stage transitions", None),
            ("Looks good now. Merged.", "pipeline-merged"),
        ],
    )
    _thread(
        seed,
        f"{he}:2.16",
        ("Sales is asking for Search & filters now", "search-filters-ask"),
        [("This pushes us well past capacity", "search-filters-defer")],
    )

    events = [
        _ev("A-14T11:30", "task.ack", "comment:pipeline-review", "nadia"),
        _ev("A-10T16:15", "task.react", "comment:pipeline-merged", "nadia", emoji="👍"),
        _ev(
            "A-2T15:20",
            "task.react",
            "comment:search-filters-defer",
            "jordan",
            emoji="👍",
        ),
        _ev(
            "A-2T15:30",
            "task.comment",
            f"{he}:2.16",
            "jordan",
            reply_to="search-filters-ask",
            body="@helios-ivan agreed. I will tell Sales it is first in line for the next "
            "release.",
        ),
        _ev(
            "A-3T09:05",
            "task.comment",
            f"{he}:2.7",
            "ivan",
            body="@helios-mei it is yours now. @helios-nadia please drop your branch notes on "
            "the story before you hand it over.",
        ),
        _ev(
            "A-6T09:05",
            "task.note",
            f"{he}:2.17",
            "ivan",
            body="Decision: the planning-phase data model (1.5) is frozen as the migration "
            "contract. A schema change after this point needs a change request.",
            decision=True,
            pinned=True,
        ),
        _ev(
            "A-2T15:10",
            "task.note",
            f"{he}:2.16",
            "ivan",
            body="Decision: Search & filters is deferred to the next release to protect the "
            "Sprint 2 goal.",
            decision=True,
        ),
        _ev("A-1T16:00", "task.ac_met", f"{he}:2.7", "ivan", criterion=0),
        _ev(
            "A-1T15:10",
            "time.log",
            f"{he}:2.4",
            "mei",
            minutes=90,
            note="OAuth refresh soak test",
        ),
        _ev(
            "A-1T16:30",
            "time.log",
            f"{he}:2.1",
            "nadia",
            minutes=240,
            note="Account import: duplicate-detection keys",
        ),
    ]

    # Helios's risk register already names the problem ("late requirements injected
    # into the build sprints"); the backlog is where those requirements arrive.
    backlog = [
        {
            "slug": "territory-assignment-rules",
            "title": "Territory assignment rules",
            "item_type": "feature",
            "tags": ["late-requirement"],
            "priority_rank": 1,
            "story_points": 8,
            "created_by": "jordan",
            "created_at": "A-9T10:00",
        },
        {
            "slug": "outlook-calendar-sync",
            "title": "Outlook calendar sync",
            "item_type": "story",
            "tags": ["customer-request"],
            "priority_rank": 2,
            "story_points": 5,
            "created_by": "mei",
            "created_at": "A-6T11:00",
        },
        {
            "slug": "search-and-filters",
            "title": "Search & filters",
            "description": "Pulled in for Sales, then deferred to protect the Sprint 2 goal.",
            "item_type": "story",
            "status": "pulled",
            "pulled_to": "helios:2.16",
            "pulled_by": "jordan",
            "pulled_at": "A-5T08:55",
            "tags": ["sales-request", "late-requirement"],
            "story_points": 8,
            "created_by": "jordan",
            "created_at": "A-7T14:00",
        },
        {
            "slug": "pilot-audit-log",
            "title": "Audit log for the pilot go/no-go",
            "item_type": "story",
            "status": "pulled",
            "pulled_to": "helios:2.13",
            "pulled_by": "jordan",
            "pulled_at": "A-1T08:55",
            "tags": ["compliance", "late-requirement"],
            "story_points": 5,
            "created_by": "jordan",
            "created_at": "A-2T16:00",
        },
        {
            "slug": "legacy-quote-pdfs",
            "title": "Legacy quote PDFs in the new CRM",
            "description": "Rejected: legacy quotes stay in the archive system, per the "
            "target architecture (1.3).",
            "item_type": "feature",
            "status": "archived",
            "created_by": "ivan",
            "created_at": "A-30T10:00",
        },
    ]

    ceremonies = [
        {
            "name": "Steering Committee",
            "cadence_type": "monthly",
            "cadence_day": "last-friday",
            "cadence_time": "14:00",
            "duration_minutes": 60,
            "owner_role": "Executive Sponsor",
        },
        {
            "name": "Planning Gate Review",
            "cadence_type": "on_milestone",
            "duration_minutes": 90,
            "owner_role": "Program Manager",
        },
    ]

    criteria = {
        ("helios", "2.1"): _criteria(
            "Imports accounts with their owners and territories",
            "Duplicate accounts are flagged, never merged silently",
        ),
        ("helios", "2.4"): _criteria(
            _met(
                "Inbound and outbound mail threads onto the contact", "mei", "A-1T15:05"
            ),
            _met("OAuth refresh survives a 30-day idle", "mei", "A-1T15:05"),
        ),
        ("helios", "2.7"): _criteria(
            "Stage transitions appear on the account timeline",
            "The timeline loads the latest 50 events in under a second",
        ),
        ("helios", "2.10"): _criteria(
            "A rule can reassign a lead when its stage changes"
        ),
    }

    return _finish(
        seed, backlog=backlog, ceremonies=ceremonies, criteria=criteria, events=events
    )
