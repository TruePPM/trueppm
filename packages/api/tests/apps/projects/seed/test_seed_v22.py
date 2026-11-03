"""Seed schema v2.2 — the program decision log (#4776).

Covers validation, import (including restoring ``created_at``/``updated_at`` past
``auto_now``), the export round-trip, and that a document with no decisions keeps
its old version string.
"""

from __future__ import annotations

import copy
import json
from datetime import UTC, date, datetime
from typing import Any

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.projects.models import ProgramDecision, ProgramDecisionStatus
from trueppm_api.apps.projects.seed import import_seed
from trueppm_api.apps.projects.seed.exporter import dump_seed, export_program
from trueppm_api.apps.projects.seed.validation import SeedValidationError, validate_seed

pytestmark = pytest.mark.django_db

User = get_user_model()

ANCHOR = "2026-02-01"


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="v22-owner", email="o@example.com")


def _doc() -> dict[str, Any]:
    return {
        "schema_version": "2.2",
        "anchor": ANCHOR,
        "program": {
            "slug": "v22",
            "name": "V22",
            "methodology": "HYBRID",
            "lead": "alex",
            "decisions": [
                {
                    "slug": "pick-vendor",
                    "title": "Pick the payments vendor",
                    "owner": "alex",
                    "due_date": "A+10!",
                    "status": "awaiting",
                    "linked_task": "core:1",
                    "impact_note": "Slips go-live by about two weeks if we wait.",
                    "created_by": "alex",
                    "created_at": "A-40T09:00",
                    "updated_at": "A-12T16:30",
                },
                {
                    "slug": "freeze-scope",
                    "title": "Freeze scope for the beta",
                    "owner": "priya",
                    "status": "made",
                    "decided_at": "A-5T11:15",
                    "linked_risk": "core:vendor-lock-in",
                    "created_at": "A-30T09:00",
                    "updated_at": "A-5T11:15",
                },
                {"slug": "drop-sso", "title": "Drop SSO from beta", "status": "withdrawn"},
            ],
        },
        "accounts": [
            {"slug": "alex", "username": "v22-alex", "role": "OWNER"},
            {"slug": "priya", "username": "v22-priya", "role": "MEMBER"},
        ],
        "projects": [
            {
                "slug": "core",
                "name": "Core",
                "methodology": "WATERFALL",
                "start_date": "A-60",
                "tasks": [
                    {
                        "wbs_path": "1",
                        "name": "Integrate payments",
                        "status": "IN_PROGRESS",
                        "duration": 10,
                    }
                ],
                "risks": [
                    {
                        "slug": "vendor-lock-in",
                        "title": "Vendor lock-in",
                        "status": "OPEN",
                        "probability": 3,
                        "impact": 3,
                    }
                ],
            }
        ],
    }


def _errors(doc: dict[str, Any]) -> list[str]:
    with pytest.raises(SeedValidationError) as exc:
        validate_seed(doc)
    return exc.value.errors


def _at(day_offset: int, hour: int, minute: int) -> datetime:
    start = date.fromisoformat(ANCHOR)
    d = date.fromordinal(start.toordinal() + day_offset)
    return datetime(d.year, d.month, d.day, hour, minute, tzinfo=UTC)


# --- validation ------------------------------------------------------------------


def test_v22_document_is_valid() -> None:
    validate_seed(_doc())


def test_duplicate_decision_slug_is_rejected() -> None:
    doc = _doc()
    doc["program"]["decisions"][1]["slug"] = "pick-vendor"
    assert any("duplicate slug 'pick-vendor'" in e for e in _errors(doc))


def test_decision_owner_must_be_an_account() -> None:
    doc = _doc()
    doc["program"]["decisions"][0]["owner"] = "nobody"
    assert any("decisions[0].owner: no account with slug 'nobody'" in e for e in _errors(doc))


def test_decision_status_must_be_one_of_the_three() -> None:
    doc = _doc()
    doc["program"]["decisions"][0]["status"] = "pending"
    assert any("decisions[0].status" in e for e in _errors(doc))


def test_decision_cannot_link_both_a_task_and_a_risk() -> None:
    doc = _doc()
    doc["program"]["decisions"][0]["linked_risk"] = "core:vendor-lock-in"
    assert any("linked_task or linked_risk, not both" in e for e in _errors(doc))


@pytest.mark.parametrize("ref", ["core:99", "ghost:1"])
def test_decision_task_link_must_resolve(ref: str) -> None:
    doc = _doc()
    doc["program"]["decisions"][0]["linked_task"] = ref
    assert any("decisions[0].linked_task" in e for e in _errors(doc))


@pytest.mark.parametrize("ref", ["core:no-such-risk", "ghost:vendor-lock-in"])
def test_decision_risk_link_must_resolve(ref: str) -> None:
    doc = _doc()
    doc["program"]["decisions"][1]["linked_risk"] = ref
    assert any("decisions[1].linked_risk" in e for e in _errors(doc))


def test_decided_at_requires_a_made_decision() -> None:
    doc = _doc()
    doc["program"]["decisions"][0]["decided_at"] = "A-1T09:00"
    assert any("decisions[0].decided_at" in e for e in _errors(doc))


def test_malformed_link_is_a_schema_error_not_a_crash() -> None:
    doc = _doc()
    doc["program"]["decisions"][0]["linked_task"] = 7
    doc["program"]["decisions"][1]["linked_risk"] = "no-colon"
    assert _errors(doc)


# --- import ----------------------------------------------------------------------


def test_import_restores_links_dates_and_timestamps(owner: Any) -> None:
    program = import_seed(_doc(), owner=owner, create_users=True)
    rows = {d.title: d for d in ProgramDecision.objects.filter(program=program)}
    assert len(rows) == 3

    vendor = rows["Pick the payments vendor"]
    assert vendor.owner.username == "v22-alex"
    assert vendor.status == ProgramDecisionStatus.AWAITING
    assert vendor.linked_task is not None and vendor.linked_task.name == "Integrate payments"
    assert vendor.linked_risk is None
    assert vendor.due_date == date(2026, 2, 11)
    # auto_now_add / auto_now would have stamped import time; the authored values win.
    assert vendor.created_at == _at(-40, 9, 0)
    assert vendor.updated_at == _at(-12, 16, 30)

    made = rows["Freeze scope for the beta"]
    assert made.status == ProgramDecisionStatus.MADE
    assert made.decided_at == _at(-5, 11, 15)
    assert made.linked_risk is not None and made.linked_risk.title == "Vendor lock-in"
    assert made.linked_task is None
    assert made.updated_at == _at(-5, 11, 15)

    withdrawn = rows["Drop SSO from beta"]
    assert withdrawn.owner is None and withdrawn.decided_at is None
    assert withdrawn.created_by == owner


# --- export ----------------------------------------------------------------------


def test_export_round_trip_is_byte_identical(owner: Any) -> None:
    program = import_seed(_doc(), owner=owner, create_users=True)
    first_doc = export_program(program, with_events=True)
    assert first_doc["schema_version"] == "2.2"
    decisions = first_doc["program"]["decisions"]
    assert {d["status"] for d in decisions} == {"awaiting", "made", "withdrawn"}
    assert any(d.get("linked_task") == "core:1" for d in decisions)
    assert any(d.get("linked_risk") == "core:vendor-lock-in" for d in decisions)
    validate_seed(first_doc)

    first = dump_seed(first_doc)
    reimported = import_seed(json.loads(first), owner=owner, create_users=True, replace=True)
    assert dump_seed(export_program(reimported, with_events=True)) == first
    # The as-of date survived the round trip, not just the document.
    row = ProgramDecision.objects.get(program=reimported, title="Pick the payments vendor")
    assert row.updated_at == _at(-12, 16, 30)


def test_export_without_decisions_keeps_its_old_version_string(owner: Any) -> None:
    doc = copy.deepcopy(_doc())
    del doc["program"]["decisions"]
    doc["schema_version"] = "2.0"
    program = import_seed(doc, owner=owner, create_users=True)
    exported = export_program(program, with_events=True)
    assert exported["schema_version"] == "2.0"
    assert "decisions" not in exported["program"]


def test_v1_export_never_carries_decisions(owner: Any) -> None:
    program = import_seed(_doc(), owner=owner, create_users=True)
    exported = export_program(program)
    assert exported["schema_version"] == "1.0"
    assert "decisions" not in exported["program"]
