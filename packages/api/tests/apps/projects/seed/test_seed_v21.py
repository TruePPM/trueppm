"""Seed schema v2.1 — collaboration sections (#3603, #3490, #3491, #3492, #3493).

Covers the additive 2.1 sections end to end: validation, replay/import, the export
round-trip, and the security line — agent actions and share links are honored only
on the bundled-sample path and rejected on every generic import path (REST import,
dry run, ``manage.py import_seed``).
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from rest_framework.test import APIClient

from trueppm_api.apps.agents.models import (
    SAMPLE_SUMMARY_PREFIX,
    SAMPLE_TOKEN_PREFIX,
    AgentAction,
    AgentActionVerdict,
)
from trueppm_api.apps.agents.signals import agent_action_recorded
from trueppm_api.apps.projects.models import (
    RESERVED_SCRUM_CEREMONY_NAMES,
    AcceptanceCriterion,
    BacklogItem,
    CeremonyTemplate,
    CommentAcknowledgement,
    CommentReaction,
    ShareLink,
    Task,
    TaskComment,
    TaskNote,
)
from trueppm_api.apps.projects.seed import import_seed, inspect_seed
from trueppm_api.apps.projects.seed.exporter import dump_seed, export_program
from trueppm_api.apps.projects.seed.validation import (
    RESERVED_CEREMONY_NAMES,
    SeedValidationError,
    validate_seed,
)
from trueppm_api.apps.projects.serializers import ALLOWED_REACTION_EMOJI
from trueppm_api.apps.timetracking.models import TimeEntry, TimesheetSubmission

pytestmark = pytest.mark.django_db

User = get_user_model()

# A Sunday, safely in the past, so every resolved date is deterministic.
ANCHOR = "2026-02-01"
ANCHOR_DATE = date(2026, 2, 1)
_SCHEMA = Path(__file__).resolve().parents[4] / "src/trueppm_api/apps/projects/schemas/seed_v2.json"


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="v21-owner", email="o@example.com")


def _doc() -> dict[str, Any]:
    """One agile project exercising every 2.1 section a generic import may carry."""
    return {
        "schema_version": "2.1",
        "anchor": ANCHOR,
        "program": {
            "slug": "v21",
            "name": "V21",
            "methodology": "AGILE",
            "lead": "alex",
            "backlog_items": [
                {
                    "slug": "offline-mode",
                    "title": "Offline mode for field staff",
                    "item_type": "feature",
                    "tags": ["customer-request"],
                    "priority_rank": 1,
                    "created_by": "priya",
                    "created_at": "A-20T09:00",
                },
                {
                    "slug": "login-errors",
                    "title": "Readable login errors",
                    "item_type": "story",
                    "status": "pulled",
                    "pulled_to": "core:2",
                    "pulled_by": "alex",
                    "pulled_at": "A-11T10:00",
                    "created_at": "A-15T09:00",
                },
            ],
            "ceremonies": [
                {
                    "name": "Program Sync",
                    "cadence_type": "weekly",
                    "cadence_day": "tuesday",
                    "cadence_time": "10:00",
                    "duration_minutes": 30,
                    "owner_role": "Program Manager",
                },
                {"name": "Phase Gate Review", "cadence_type": "on_milestone"},
            ],
        },
        "accounts": [
            {"slug": "alex", "username": "v21-alex", "display_name": "Alex", "role": "OWNER"},
            {"slug": "priya", "username": "v21-priya", "display_name": "Priya", "role": "MEMBER"},
        ],
        "calendars": [{"slug": "std", "name": "V21 5-day", "working_days": 31}],
        "resources": [
            {"slug": "priya", "name": "Priya", "calendar": "std", "account": "priya"},
        ],
        "projects": [
            {
                "slug": "core",
                "name": "Core",
                "methodology": "AGILE",
                "start_date": "A-30",
                "calendar": "std",
                "sprints": [
                    {
                        "slug": "s1",
                        "name": "Sprint 1",
                        "state": "ACTIVE",
                        "start_date": "A-12",
                        "finish_date": "A+2",
                        "committed_points": 8,
                    }
                ],
                "tasks": [
                    {
                        "wbs_path": "1",
                        "name": "Build login",
                        "type": "story",
                        "status": "COMPLETE",
                        "story_points": 5,
                        "assignee": "priya",
                        "sprint": "s1",
                        "delivery_mode": "scrum",
                        "dor": "ready",
                        "acceptance_criteria": [
                            {
                                "text": "A user can sign in",
                                "met": True,
                                "met_by": "priya",
                                "met_at": "A-8T10:00",
                            },
                            {
                                "text": "A wrong password shows an error",
                                "given": "a registered user",
                                "when": "they enter a wrong password",
                                "then": "an inline error is shown",
                            },
                        ],
                    },
                    {
                        "wbs_path": "2",
                        "name": "Login errors",
                        "type": "story",
                        "status": "IN_PROGRESS",
                        "story_points": 3,
                        "assignee": "priya",
                        "sprint": "s1",
                        "delivery_mode": "scrum",
                    },
                ],
            }
        ],
        "events": [
            {
                "at": "A-9T09:00",
                "action": "task.comment",
                "target": "task:core:1",
                "actor": "alex",
                "slug": "review",
                "body": "Review: the lockout message leaks whether the account exists.",
            },
            {
                "at": "A-9T11:00",
                "action": "task.comment",
                "target": "task:core:1",
                "actor": "priya",
                "reply_to": "review",
                "body": "Fixed — same message either way now.",
            },
            {
                "at": "A-9T11:30",
                "action": "task.react",
                "target": "comment:review",
                "actor": "priya",
                "emoji": "👍",
            },
            {
                "at": "A-9T11:31",
                "action": "task.ack",
                "target": "comment:review",
                "actor": "priya",
            },
            {
                "at": "A-9T12:00",
                "action": "task.note",
                "target": "task:core:1",
                "actor": "alex",
                "body": "Decision: lockout copy never distinguishes unknown accounts.",
                "decision": True,
            },
            {
                "at": "A-9T15:00",
                "action": "time.log",
                "target": "task:core:1",
                "actor": "priya",
                "minutes": 90,
                "note": "Pairing on the error path",
            },
            {
                "at": "A-7T11:00",
                "action": "task.ac_met",
                "target": "task:core:1",
                "actor": "alex",
                "criterion": 1,
            },
        ],
    }


def _sample_doc() -> dict[str, Any]:
    doc = _doc()
    doc["program"]["agent_actions"] = [
        {
            "at": "A-3T10:00",
            "principal": "alex",
            "action": "get_schedule",
            "method": "GET",
            "capability": "mcp:read",
            "project": "core",
            "verdict": "allowed",
            "summary": "Read the Core schedule.",
        },
        {
            "at": "A-2T10:00",
            "principal": "alex",
            "action": "update_task",
            "method": "PATCH",
            "capability": "mcp:read",
            "object": "core:2",
            "verdict": "refused",
            "refusal_reason": "policy",
            "refusal_constraint": "graph_validation",
            "projected_impact": {"finish_slip_days": 4},
            "summary": "Refused: moving Login errors would slip the sprint goal by 4 days.",
        },
    ]
    doc["projects"][0]["share_links"] = [
        {"label": "Client review board", "created_by": "alex", "expires_in_days": 30}
    ]
    return doc


# --- validation ------------------------------------------------------------------


def test_v20_document_is_unchanged_and_valid() -> None:
    doc = _doc()
    del doc["program"]["backlog_items"], doc["program"]["ceremonies"]
    del doc["projects"][0]["tasks"][0]["acceptance_criteria"]
    doc["events"] = [e for e in doc["events"] if e["action"] == "task.comment"]
    for event in doc["events"]:
        event.pop("slug", None), event.pop("reply_to", None)
    doc["schema_version"] = "2.0"
    validate_seed(doc)


def test_v21_document_is_valid() -> None:
    validate_seed(_doc())


@pytest.mark.parametrize(
    ("section", "path"),
    [
        ("agent_actions", "$.program.agent_actions"),
        ("share_links", "$.projects[0].share_links"),
    ],
)
def test_generic_validation_rejects_sample_only_sections(section: str, path: str) -> None:
    doc = _sample_doc()
    if section == "agent_actions":
        doc["projects"][0].pop("share_links")
    else:
        doc["program"].pop("agent_actions")
    report = inspect_seed(doc)
    assert not report.valid
    assert any(e.startswith(path) and "only bundled sample" in e for e in report.errors)
    # The trusted path accepts the same document.
    assert inspect_seed(doc, allow_sample_sections=True).valid


def _errors(doc: dict[str, Any]) -> list[str]:
    with pytest.raises(SeedValidationError) as exc:
        validate_seed(doc)
    return exc.value.errors


def test_reply_to_a_reply_is_rejected() -> None:
    doc = _doc()
    doc["events"][1]["slug"] = "fix"
    doc["events"].append(
        {
            "at": "A-9T13:00",
            "action": "task.comment",
            "target": "task:core:1",
            "actor": "alex",
            "reply_to": "fix",
            "body": "nested",
        }
    )
    assert any("replies are one level deep" in e for e in _errors(doc))


def test_reply_on_another_task_is_rejected() -> None:
    doc = _doc()
    doc["events"][1]["target"] = "task:core:2"
    assert any("same task" in e for e in _errors(doc))


def test_reserved_scrum_ceremony_name_is_rejected() -> None:
    doc = _doc()
    doc["program"]["ceremonies"][0]["name"] = "Daily Standup"
    assert any("team-level sprint event" in e for e in _errors(doc))


def test_timed_ceremony_without_a_time_is_rejected() -> None:
    doc = _doc()
    del doc["program"]["ceremonies"][0]["cadence_time"]
    assert any("cadence_time: required" in e for e in _errors(doc))


def test_pulled_backlog_item_must_name_its_task() -> None:
    doc = _doc()
    del doc["program"]["backlog_items"][1]["pulled_to"]
    assert any("must name the task it became" in e for e in _errors(doc))


def test_reaction_on_unknown_comment_is_rejected() -> None:
    doc = _doc()
    doc["events"][2]["target"] = "comment:nope"
    assert any("no comment with slug 'nope'" in e for e in _errors(doc))


def test_forward_dated_time_log_is_rejected() -> None:
    doc = _doc()
    doc["events"][5]["at"] = "A+3T10:00"
    assert any("cannot be forward-dated" in e for e in _errors(doc))


def test_time_log_without_actor_is_rejected() -> None:
    doc = _doc()
    del doc["events"][5]["actor"]
    assert any("must name the account" in e for e in _errors(doc))


def test_criterion_index_out_of_range_is_rejected() -> None:
    doc = _doc()
    doc["events"][6]["criterion"] = 5
    assert any("does not exist" in e for e in _errors(doc))


def test_reserved_ceremony_names_match_the_model() -> None:
    """validation.py restates the list to stay Django-free; this pins the copy."""
    assert RESERVED_CEREMONY_NAMES == RESERVED_SCRUM_CEREMONY_NAMES


def test_reaction_emoji_enum_matches_the_api_allow_list() -> None:
    schema = json.loads(_SCHEMA.read_text(encoding="utf-8"))
    assert set(schema["$defs"]["event"]["properties"]["emoji"]["enum"]) == set(
        ALLOWED_REACTION_EMOJI
    )


# --- generic import ----------------------------------------------------------------


def test_generic_import_materializes_every_v21_section(owner: Any) -> None:
    program = import_seed(_doc(), owner=owner, create_users=True)
    task1 = Task.objects.get(project__program=program, wbs_path="1")
    task2 = Task.objects.get(project__program=program, wbs_path="2")
    priya = User.objects.get(username="v21-priya")
    alex = User.objects.get(username="v21-alex")

    items = {i.title: i for i in BacklogItem.objects.filter(program=program)}
    assert items["Readable login errors"].status == "pulled"
    assert items["Readable login errors"].pulled_task_id == task2.pk
    assert items["Readable login errors"].pulled_by == alex
    assert items["Offline mode for field staff"].created_at.date() == ANCHOR_DATE - timedelta(20)

    ceremonies = {c.name: c for c in CeremonyTemplate.objects.filter(program=program)}
    assert ceremonies["Program Sync"].cadence_time.strftime("%H:%M") == "10:00"
    assert ceremonies["Phase Gate Review"].cadence_time is None

    criteria = list(AcceptanceCriterion.objects.filter(task=task1).order_by("position"))
    assert [c.met for c in criteria] == [True, True]
    assert criteria[0].met_by == priya
    # The second was ticked by the dated beat, not authored met.
    assert criteria[1].met_by == alex
    assert criteria[1].met_at.date() == ANCHOR_DATE - timedelta(7)
    assert criteria[1].given == "a registered user"

    root = TaskComment.objects.get(task=task1, parent__isnull=True)
    reply = TaskComment.objects.get(task=task1, parent__isnull=False)
    assert reply.parent_id == root.pk
    assert CommentReaction.objects.filter(comment=root, user=priya, emoji="👍").exists()
    assert CommentAcknowledgement.objects.filter(comment=root, user=priya).exists()

    note = TaskNote.objects.get(task=task1)
    assert note.decision is True
    assert note.author == alex
    assert note.created_at.date() == ANCHOR_DATE - timedelta(9)

    entry = TimeEntry.objects.get(task=task1)
    assert (entry.user, entry.minutes, entry.entry_date) == (
        priya,
        90,
        ANCHOR_DATE - timedelta(9),
    )
    # Generic path: no synthesized time, no submissions, no evidence, no credentials.
    assert TimeEntry.objects.filter(task__project__program=program).count() == 1
    assert TimesheetSubmission.objects.count() == 0
    assert AgentAction.objects.count() == 0
    assert ShareLink.objects.count() == 0


def test_time_log_by_unresolved_account_is_skipped_not_reattributed(owner: Any) -> None:
    """Generic path, create_users=False: priya resolves to None, so her hour is dropped."""
    program = import_seed(_doc(), owner=owner, create_users=False)
    assert not TimeEntry.objects.filter(task__project__program=program).exists()
    assert not CommentReaction.objects.exists()


def test_generic_import_rejects_agent_actions_and_writes_nothing(owner: Any) -> None:
    with pytest.raises(SeedValidationError):
        import_seed(_sample_doc(), owner=owner, create_users=True)
    assert AgentAction.objects.count() == 0
    assert ShareLink.objects.count() == 0


def test_rest_import_rejects_sample_only_sections(owner: Any) -> None:
    client = APIClient()
    client.force_authenticate(owner)
    resp = client.post("/api/v1/programs/import/", data=_sample_doc(), format="json")
    assert resp.status_code == 400, resp.content
    detail = " ".join(resp.data["detail"])
    assert "$.program.agent_actions" in detail
    assert "$.projects[0].share_links" in detail
    assert AgentAction.objects.count() == 0


def test_dry_run_reports_sample_only_sections(owner: Any) -> None:
    client = APIClient()
    client.force_authenticate(owner)
    resp = client.post("/api/v1/programs/import/validate/", data=_sample_doc(), format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["valid"] is False
    assert any("only bundled sample" in e for e in resp.data["errors"])


def test_import_seed_command_rejects_sample_only_sections(owner: Any, tmp_path: Path) -> None:
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])
    path = tmp_path / "seed.json"
    path.write_text(json.dumps(_sample_doc()), encoding="utf-8")
    with pytest.raises(CommandError, match="only bundled sample"):
        call_command("import_seed", str(path), "--owner", owner.username)
    assert AgentAction.objects.count() == 0


# --- sample path -------------------------------------------------------------------


def test_sample_path_writes_marked_agent_trail_without_extension_signal(
    owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    received: list[Any] = []

    def _receiver(**kwargs: Any) -> None:
        received.append(kwargs["action"])

    agent_action_recorded.connect(_receiver, weak=False)
    try:
        with django_capture_on_commit_callbacks(execute=True):
            import_seed(_sample_doc(), owner=owner, create_users=True, is_sample=True)
    finally:
        agent_action_recorded.disconnect(_receiver)

    rows = list(AgentAction.objects.order_by("sequence"))
    assert len(rows) == 2
    assert all(r.actor_token_prefix == SAMPLE_TOKEN_PREFIX for r in rows)
    assert all(r.summary.startswith(SAMPLE_SUMMARY_PREFIX) for r in rows)
    # Chain order follows the narrated time.
    assert rows[0].occurred_at < rows[1].occurred_at
    refused = rows[1]
    assert refused.verdict == AgentActionVerdict.REFUSED
    assert refused.refusal_detail.constraint == "graph_validation"
    assert refused.refusal_detail.projected_impact == {"finish_slip_days": 4}
    assert received == []
    # The marked rows are still a valid chain.
    call_command("audit_verify")


def test_non_sample_record_still_dispatches_the_extension_signal(
    owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    """Negative control for the test above: the receiver hook does observe real rows."""
    from trueppm_api.apps.agents.services import record_agent_action

    received: list[Any] = []

    def _receiver(**kwargs: Any) -> None:
        received.append(kwargs["action"])

    agent_action_recorded.connect(_receiver, weak=False)
    try:
        with django_capture_on_commit_callbacks(execute=True):
            record_agent_action(
                actor_token=None,
                principal=owner,
                action="get_schedule",
                method="GET",
                capability_used="mcp:read",
                verdict=AgentActionVerdict.ALLOWED,
                payload_hash="0" * 64,
            )
    finally:
        agent_action_recorded.disconnect(_receiver)
    assert len(received) == 1
    assert received[0].actor_token_prefix == ""


def test_sample_share_link_token_is_minted_not_read(owner: Any) -> None:
    doc = _sample_doc()
    import_seed(doc, owner=owner, create_users=True, is_sample=True)
    link = ShareLink.objects.get()
    assert link.label == "Client review board"
    assert link.revoked_at is None
    assert link.expires_at is not None
    assert len(link.token_hash) == 64
    assert link.token_prefix not in json.dumps(doc)


def test_sample_path_synthesizes_bounded_time_and_submissions(owner: Any) -> None:
    program = import_seed(_sample_doc(), owner=owner, create_users=True, is_sample=True)
    priya = User.objects.get(username="v21-priya")
    entries = TimeEntry.objects.filter(task__project__program=program)
    # Authored beat on task 1 plus synthesized fill on the in-flight task 2.
    assert entries.filter(task__wbs_path="1").count() == 1
    assert entries.filter(task__wbs_path="2").exists()
    assert not entries.filter(entry_date__gte=ANCHOR_DATE).exists()
    per_day: dict[date, int] = {}
    for entry in entries.filter(user=priya, task__wbs_path="2"):
        per_day[entry.entry_date] = per_day.get(entry.entry_date, 0) + entry.minutes
    assert per_day and max(per_day.values()) <= int(8 * 60 * 1.1)

    anchor_monday = ANCHOR_DATE - timedelta(days=ANCHOR_DATE.weekday())
    weeks = list(TimesheetSubmission.objects.filter(user=priya))
    assert weeks
    assert all(w.week_start < anchor_monday and w.week_start.weekday() == 0 for w in weeks)


# --- export ------------------------------------------------------------------------


def test_v21_export_round_trip_is_byte_identical(owner: Any) -> None:
    program = import_seed(_sample_doc(), owner=owner, create_users=True, is_sample=True)
    first_doc = export_program(program, with_events=True)
    assert first_doc["schema_version"] == "2.1"
    assert "backlog_items" in first_doc["program"]
    assert "ceremonies" in first_doc["program"]
    # Evidence, credentials and per-person hours never leave through an export.
    assert "agent_actions" not in first_doc["program"]
    assert "share_links" not in first_doc["projects"][0]
    actions = {e["action"] for e in first_doc["events"]}
    assert {"task.note", "task.react", "task.ack"} <= actions
    assert "time.log" not in actions
    assert any("reply_to" in e for e in first_doc["events"])
    validate_seed(first_doc)

    first = dump_seed(first_doc)
    reimported = import_seed(json.loads(first), owner=owner, create_users=True, replace=True)
    second = dump_seed(export_program(reimported, with_events=True))
    assert first == second


def test_export_without_v21_constructs_stays_2_0(owner: Any) -> None:
    doc = _doc()
    del doc["program"]["backlog_items"], doc["program"]["ceremonies"]
    del doc["projects"][0]["tasks"][0]["acceptance_criteria"]
    doc["events"] = [
        {k: v for k, v in e.items() if k not in ("slug", "reply_to")}
        for e in doc["events"]
        if e["action"] == "task.comment"
    ]
    doc["schema_version"] = "2.0"
    program = import_seed(doc, owner=owner, create_users=True)
    assert export_program(program, with_events=True)["schema_version"] == "2.0"
