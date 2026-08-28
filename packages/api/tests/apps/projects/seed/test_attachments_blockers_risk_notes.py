"""Attachments, blocked work, and risk narrative are expressible in a seed (#3094).

Three capabilities the product models had no seed surface for, so no bundled
sample could show them: **0** attachments across 187 tasks, **0** blocked tasks,
and a risk register that recorded *that* a risk was mitigated but never *how*.

Two backdating traps are covered here because both fail silently and both make
the demo say something false:

* ``Task.save()`` stamps ``blocked_since`` with ``timezone.now()``. The importer
  bulk-creates, so ``save()`` never runs and nothing stamps it at all; the replay
  path does run it, and would stamp *now* on a backdated timeline. Either way a
  blocker renders "0d", and age is the entire triage signal.
* ``RiskComment.created_at`` is ``auto_now_add``.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    Risk,
    RiskComment,
    Task,
    TaskAttachment,
)
from trueppm_api.apps.projects.seed import import_seed
from trueppm_api.apps.projects.seed.exporter import export_program

pytestmark = pytest.mark.django_db

User = get_user_model()


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="surface-owner", email="o@example.com")


def _seed(**project_extra: Any) -> dict[str, Any]:
    project: dict[str, Any] = {
        "slug": "core",
        "name": "Core",
        "methodology": "AGILE",
        "start_date": "A-30",
        "tasks": [
            {"wbs_path": "1", "name": "Ship checkout"},
            {"wbs_path": "2", "name": "Vendor SSO certification"},
        ],
        "risks": [
            {
                "slug": "vendor-slip",
                "title": "Vendor certification slips",
                "status": "MITIGATING",
                "probability": 3,
                "impact": 4,
                "owner": "mei",
            }
        ],
    }
    project.update(project_extra)
    return {
        "schema_version": "2.0",
        "program": {"slug": "surface-demo", "name": "Surface Demo", "methodology": "AGILE"},
        "accounts": [
            {"slug": "mei", "username": "surface-mei", "role": "MEMBER"},
            {"slug": "sam", "username": "surface-sam", "role": "ADMIN"},
        ],
        "projects": [project],
    }


def _task(program: Any, wbs: str) -> Task:
    return Task.objects.get(project__program=program, wbs_path=wbs)


# --- attachments ------------------------------------------------------------


def test_external_url_attachments_land_on_the_task(owner: Any) -> None:
    seed = _seed()
    seed["projects"][0]["tasks"][0]["attachments"] = [
        {
            "external_url": "https://example.com/design-doc",
            "external_title": "Checkout design doc",
            "is_pinned": True,
            "uploaded_by": "mei",
        }
    ]
    program = import_seed(seed, owner=owner, create_users=True)

    attachment = TaskAttachment.objects.get(task=_task(program, "1"))
    assert attachment.external_url == "https://example.com/design-doc"
    assert attachment.external_title == "Checkout design doc"
    assert attachment.is_pinned is True
    assert attachment.uploaded_by.get_username() == "surface-mei"
    assert attachment.file == "", "URL-only: the file XOR external_url constraint holds"


def test_attachments_round_trip(owner: Any) -> None:
    seed = _seed()
    seed["projects"][0]["tasks"][0]["attachments"] = [
        {"external_url": "https://example.com/a", "external_title": "A"},
        {"external_url": "https://example.com/b"},
    ]
    program = import_seed(seed, owner=owner, create_users=True)

    exported = export_program(program, with_events=True)
    task_block = next(t for t in exported["projects"][0]["tasks"] if t["wbs_path"] == "1")
    assert [a["external_url"] for a in task_block["attachments"]] == [
        "https://example.com/a",
        "https://example.com/b",
    ]
    assert "is_pinned" not in task_block["attachments"][1], "unset metadata is omitted"


# --- blocked work -----------------------------------------------------------


def test_a_declared_blocker_lands_with_a_real_age(owner: Any) -> None:
    """The importer bulk-creates, so Task.save() never stamps blocked_since."""
    seed = _seed()
    # Pin the anchor to a Friday so "A-6" lands on a Saturday. That is the case
    # weekend-snapping used to push forward to the following Monday, which both
    # understated the blocker's age and made this test fail only on Fridays
    # (#3112). An explicit anchor keeps the assertion independent of run day.
    seed["anchor"] = "2026-08-28"
    seed["projects"][0]["tasks"][0]["blocked"] = {
        "reason": "Waiting on the vendor's SSO certification sandbox.",
        "since": "A-6",
        "type": "vendor",
        "blocking_task": "2",
        "by": "sam",
    }
    program = import_seed(seed, owner=owner, create_users=True)

    task = _task(program, "1")
    assert task.blocked_reason.startswith("Waiting on the vendor")
    assert task.blocker_type == "vendor"
    assert task.blocking_task == _task(program, "2")
    assert task.blocked_by.get_username() == "surface-sam"
    assert task.blocked_since is not None
    # A blocker started when it started: six days before the Friday anchor is the
    # Saturday, not the Monday after it. This also pins that the importer
    # backdates at all -- a `Task.save()` stamp would land today instead.
    assert task.blocked_since.date() == date(2026, 8, 22)


def test_a_blocker_without_since_still_carries_an_age(owner: Any) -> None:
    seed = _seed()
    seed["projects"][0]["tasks"][0]["blocked"] = {"reason": "Waiting on a decision."}
    program = import_seed(seed, owner=owner, create_users=True)

    assert _task(program, "1").blocked_since is not None


def test_block_and_unblock_events_span_real_time(owner: Any) -> None:
    seed = _seed()
    seed["events"] = [
        {
            "at": "A-9T09:00",
            "action": "task.block",
            "target": "task:core:1",
            "actor": "sam",
            "body": "Vendor sandbox is down.",
            "blocker_type": "vendor",
            "blocking_task": "core:2",
        },
        {
            "at": "A-5T15:00",
            "action": "task.unblock",
            "target": "task:core:1",
            "actor": "sam",
            "body": "Sandbox restored.",
        },
    ]
    program = import_seed(seed, owner=owner, create_users=True)

    task = _task(program, "1")
    assert task.blocked_reason == "", "unblock clears the flag of record"
    assert task.blocked_since is None, "Task.save() owns the unblock cascade"
    assert task.blocker_type == ""
    assert task.blocking_task is None


def test_a_block_event_is_backdated_not_stamped_now(owner: Any) -> None:
    """Task.save() would stamp timezone.now() and render every blocker as 0d."""
    seed = _seed()
    seed["events"] = [
        {
            "at": "A-9T09:00",
            "action": "task.block",
            "target": "task:core:1",
            "actor": "sam",
            "body": "Vendor sandbox is down.",
            "blocker_type": "vendor",
        }
    ]
    program = import_seed(seed, owner=owner, create_users=True)

    task = _task(program, "1")
    assert task.blocked_since is not None
    assert timezone.now() - task.blocked_since > timedelta(days=7), (
        "blocked_since was stamped at import time, so the badge reads 0d"
    )


# --- risk narrative ---------------------------------------------------------


def test_risk_note_records_how_a_risk_was_mitigated(owner: Any) -> None:
    seed = _seed()
    seed["events"] = [
        {
            "at": "A-12T10:00",
            "action": "risk.note",
            "target": "risk:vendor-slip",
            "actor": "mei",
            "body": "Opened a parallel evaluation of a second IdP as a fallback.",
        },
        {
            "at": "A-4T10:00",
            "action": "risk.status",
            "target": "risk:vendor-slip",
            "actor": "mei",
            "to": "RESOLVED",
        },
    ]
    program = import_seed(seed, owner=owner, create_users=True)

    risk = Risk.objects.get(project__program=program, title="Vendor certification slips")
    assert risk.status == "RESOLVED"
    comment = RiskComment.objects.get(risk=risk)
    assert comment.message.startswith("Opened a parallel evaluation")
    assert comment.author.get_username() == "surface-mei"
    assert timezone.now() - comment.created_at > timedelta(days=8), (
        "created_at is auto_now_add and must be backdated to the beat"
    )


def test_risk_notes_round_trip_as_events(owner: Any) -> None:
    seed = _seed()
    seed["events"] = [
        {
            "at": "A-12T10:00",
            "action": "risk.note",
            "target": "risk:vendor-slip",
            "actor": "mei",
            "body": "Opened a parallel evaluation of a second IdP.",
        }
    ]
    program = import_seed(seed, owner=owner, create_users=True)

    exported = export_program(program, with_events=True)
    notes = [e for e in exported["events"] if e["action"] == "risk.note"]
    assert len(notes) == 1
    assert notes[0]["body"] == "Opened a parallel evaluation of a second IdP."
    assert notes[0]["target"].startswith("risk:")


def test_board_lane_lands_on_the_task(owner: Any) -> None:
    seed = _seed()
    seed["projects"][0]["tasks"][0]["board_lane"] = "blocked"
    program = import_seed(seed, owner=owner, create_users=True)

    assert _task(program, "1").board_lane == "blocked"


def test_the_new_surface_survives_a_full_round_trip(owner: Any) -> None:
    """export -> import -> export is byte-identical with all of it in play."""
    from trueppm_api.apps.projects.seed.exporter import dump_seed

    seed = _seed()
    seed["projects"][0]["tasks"][0].update(
        {
            "board_lane": "blocked",
            "blocked": {"reason": "Waiting on vendor.", "since": "A-6", "type": "vendor"},
            "attachments": [{"external_url": "https://example.com/a", "external_title": "A"}],
        }
    )
    seed["events"] = [
        {
            "at": "A-12T10:00",
            "action": "risk.note",
            "target": "risk:vendor-slip",
            "actor": "mei",
            "body": "Parallel IdP evaluation opened.",
        }
    ]
    program1 = import_seed(seed, owner=owner, create_users=True)
    export1 = export_program(program1, with_events=True)
    program2 = import_seed(export1, owner=owner, create_users=True, replace=True)
    export2 = export_program(program2, with_events=True)

    assert dump_seed(export1) == dump_seed(export2)
