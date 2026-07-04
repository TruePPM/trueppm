"""Unit tests for the seed-document validator (ADR-0109, issue #614).

``validate_seed`` is a pure function — these tests need no database. They cover
the structural JSON Schema layer, the version gate, and the referential
integrity pass (duplicate slugs and dangling cross-references).
"""

from __future__ import annotations

import copy
from typing import Any

import pytest

from trueppm_api.apps.projects.seed import (
    SUPPORTED_MAJORS,
    SeedValidationError,
    validate_seed,
)


def _valid_seed() -> dict[str, Any]:
    """A small but fully cross-referenced seed: two projects, a cross-project dep.

    Mutated by the negative tests below; each starts from this known-good base.
    """
    return {
        "schema_version": "1.0",
        "program": {
            "slug": "atlas",
            "name": "Atlas Platform Launch",
            "methodology": "HYBRID",
            "lead": "alex",
        },
        "accounts": [
            {"slug": "alex", "username": "alex", "email": "alex@example.com", "role": "OWNER"},
            {"slug": "sam", "username": "sam", "display_name": "Sam Lee"},
        ],
        "calendars": [
            {"slug": "default", "name": "Standard 5-day", "working_days": 31, "hours_per_day": 8.0},
        ],
        "resources": [
            {
                "slug": "alex",
                "name": "Alex Rivera",
                "max_units": 1.0,
                "calendar": "default",
                "account": "alex",
            },
            {"slug": "sam", "name": "Sam Lee", "max_units": 0.5, "account": "sam"},
        ],
        "risks": [
            {
                "slug": "vendor-lockin",
                "title": "Vendor lock-in",
                "status": "OPEN",
                "probability": 4,
                "impact": 5,
                "category": "EXTERNAL",
                "response": "MITIGATE",
                "owner": "alex",
                "tasks": ["platform-core:1", "migration-tooling:1"],
            },
        ],
        "projects": [
            {
                "slug": "platform-core",
                "name": "Platform Core",
                "methodology": "AGILE",
                "start_date": "2026-01-05",
                "calendar": "default",
                "board_columns": ["Backlog", "To Do", "In Progress", "Done"],
                "tasks": [
                    {
                        "wbs_path": "1",
                        "name": "Build auth service",
                        "type": "story",
                        "status": "IN_PROGRESS",
                        "story_points": 8,
                        "assignee": "alex",
                        "sprint": "pc-1",
                        "delivery_mode": "scrum",
                        "assignments": [{"resource": "alex", "units": 0.5}],
                    },
                    {
                        "wbs_path": "2",
                        "name": "GA milestone",
                        "is_milestone": True,
                        "duration": 0,
                        "delivery_mode": "milestone",
                    },
                ],
                "sprints": [
                    {
                        "slug": "pc-1",
                        "name": "Sprint 1",
                        "state": "ACTIVE",
                        "start_date": "2026-01-05",
                        "finish_date": "2026-01-19",
                        "committed_points": 24,
                        "target_milestone": "2",
                    },
                ],
                "baselines": [
                    {
                        "name": "Kickoff",
                        "is_active": True,
                        "tasks": [
                            {
                                "task": "1",
                                "start": "2026-01-05",
                                "finish": "2026-01-12",
                                "duration": 5,
                            }
                        ],
                    },
                ],
            },
            {
                "slug": "migration-tooling",
                "name": "Migration Tooling",
                "methodology": "WATERFALL",
                "start_date": "2026-02-02",
                "tasks": [
                    {
                        "wbs_path": "1",
                        "name": "ETL pipeline",
                        "estimate": {"optimistic": 3, "most_likely": 5, "pessimistic": 12},
                        "duration": 5,
                        "planned_start": "2026-02-02",
                    },
                ],
                "dependencies": [
                    # cross-project edge: Platform Core task 1 gates Migration task 1
                    {
                        "predecessor": "platform-core:1",
                        "successor": "1",
                        "dep_type": "FS",
                        "lag": 2,
                    },
                ],
                "risks": [
                    {
                        "slug": "etl-perf",
                        "title": "ETL too slow",
                        "status": "MITIGATING",
                        "probability": 3,
                        "impact": 4,
                        "tasks": ["1"],
                    },
                ],
            },
        ],
    }


def _expect_error(seed: dict[str, Any], needle: str) -> None:
    with pytest.raises(SeedValidationError) as exc:
        validate_seed(seed)
    joined = "\n".join(exc.value.errors)
    assert needle in joined, f"expected {needle!r} in errors:\n{joined}"


def test_valid_seed_passes() -> None:
    validate_seed(_valid_seed())  # does not raise


def test_supported_version_constant() -> None:
    assert "1" in SUPPORTED_MAJORS and "2" in SUPPORTED_MAJORS


def test_non_dict_rejected() -> None:
    _expect_error([], "must be a JSON object")  # type: ignore[arg-type]


def test_missing_schema_version() -> None:
    seed = _valid_seed()
    del seed["schema_version"]
    _expect_error(seed, "schema_version")


def test_unsupported_major_version() -> None:
    seed = _valid_seed()
    seed["schema_version"] = "9.0"
    _expect_error(seed, "unsupported version")


# --- v2: relative dates + events (ADR-0114) --------------------------------


def _valid_v2_seed() -> dict[str, Any]:
    """A minimal but cross-referenced v2 doc: anchor, relative dates, events."""
    return {
        "schema_version": "2.0",
        "anchor": "2026-02-01",
        "program": {"slug": "demo", "name": "Demo", "methodology": "AGILE"},
        "accounts": [{"slug": "alex", "username": "alex", "role": "OWNER"}],
        "projects": [
            {
                "slug": "core",
                "name": "Core",
                "methodology": "AGILE",
                "start_date": "A-25",
                "tasks": [{"wbs_path": "1", "name": "Auth", "status": "COMPLETE"}],
                "sprints": [
                    {
                        "slug": "s1",
                        "name": "S1",
                        "state": "COMPLETED",
                        "start_date": "A-20",
                        "finish_date": "A-6",
                    }
                ],
                "risks": [
                    {"slug": "r1", "title": "Risk", "status": "OPEN", "probability": 3, "impact": 3}
                ],
            }
        ],
        "events": [
            {
                "at": "A-10T09:00",
                "actor": "alex",
                "action": "task.status",
                "target": "task:core:1",
                "to": "COMPLETE",
            },
            {
                "at": "A-8",
                "actor": "alex",
                "action": "risk.status",
                "target": "risk:r1",
                "to": "MITIGATING",
            },
        ],
    }


def test_valid_v2_seed_passes() -> None:
    validate_seed(_valid_v2_seed())  # does not raise


def test_v2_relative_date_grammar_enforced() -> None:
    seed = _valid_v2_seed()
    seed["projects"][0]["start_date"] = "A--5"  # malformed offset
    _expect_error(seed, "start_date")


def test_v2_event_unknown_action_rejected() -> None:
    seed = _valid_v2_seed()
    seed["events"][0]["action"] = "task.teleport"
    _expect_error(seed, "action")


def test_v2_event_dangling_task_target_rejected() -> None:
    seed = _valid_v2_seed()
    seed["events"][0]["target"] = "task:core:99"
    _expect_error(seed, "no task '99'")


def test_v2_event_unqualified_task_target_rejected() -> None:
    seed = _valid_v2_seed()
    seed["events"][0]["target"] = "task:1"
    _expect_error(seed, "must be")


def test_v2_event_unknown_actor_rejected() -> None:
    seed = _valid_v2_seed()
    seed["events"][0]["actor"] = "ghost"
    _expect_error(seed, "no account")


def test_v2_event_wrong_target_kind_rejected() -> None:
    seed = _valid_v2_seed()
    seed["events"][1]["target"] = "task:core:1"  # risk.status expects a risk target
    _expect_error(seed, "expects a 'risk' target")


def test_v2_retro_actions_accepted() -> None:
    # #1109 re-adds retro.action / retro.promote to the enum + validator; both
    # target the sprint (SprintRetro is 1:1 with Sprint).
    seed = _valid_v2_seed()
    seed["events"].append(
        {
            "at": "A-6T17:30",
            "actor": "alex",
            "action": "retro.action",
            "target": "sprint:core:s1",
            "body": "Add integration tests",
        }
    )
    seed["events"].append(
        {
            "at": "A-5T09:00",
            "actor": "alex",
            "action": "retro.promote",
            "target": "sprint:core:s1",
            "body": "Add integration tests",
        }
    )
    validate_seed(seed)  # does not raise


def test_v2_retro_action_wrong_target_kind_rejected() -> None:
    seed = _valid_v2_seed()
    seed["events"].append(
        {
            "at": "A-6T17:30",
            "actor": "alex",
            "action": "retro.action",
            "target": "task:core:1",  # retro.* expects a sprint target
            "body": "x",
        }
    )
    _expect_error(seed, "expects a 'sprint' target")


def test_v2_retro_action_dangling_sprint_target_rejected() -> None:
    seed = _valid_v2_seed()
    seed["events"].append(
        {
            "at": "A-6T17:30",
            "actor": "alex",
            "action": "retro.action",
            "target": "sprint:core:ghost",
            "body": "x",
        }
    )
    _expect_error(seed, "no sprint 'ghost'")


def test_unknown_top_level_field_rejected() -> None:
    seed = _valid_seed()
    seed["portfolio"] = {}
    _expect_error(seed, "portfolio")


def test_unknown_task_field_rejected() -> None:
    seed = _valid_seed()
    seed["projects"][0]["tasks"][0]["early_start"] = "2026-01-05"
    _expect_error(seed, "early_start")


def test_missing_required_program_field() -> None:
    seed = _valid_seed()
    del seed["program"]["name"]
    _expect_error(seed, "name")


def test_bad_enum_value() -> None:
    seed = _valid_seed()
    seed["projects"][0]["tasks"][0]["type"] = "Story"  # wrong case
    _expect_error(seed, "tasks[0]")


def test_partial_estimate_rejected() -> None:
    seed = _valid_seed()
    seed["projects"][1]["tasks"][0]["estimate"] = {"optimistic": 3, "most_likely": 5}
    _expect_error(seed, "pessimistic")


def test_bad_date_format_rejected() -> None:
    seed = _valid_seed()
    seed["projects"][0]["start_date"] = "2026-13-40"
    _expect_error(seed, "start_date")


def test_duplicate_account_slug() -> None:
    seed = _valid_seed()
    seed["accounts"].append({"slug": "alex", "username": "alex2"})
    _expect_error(seed, "duplicate slug 'alex'")


def test_duplicate_task_wbs_path() -> None:
    seed = _valid_seed()
    seed["projects"][0]["tasks"].append({"wbs_path": "1", "name": "Dup"})
    _expect_error(seed, "duplicate path '1'")


def test_dangling_assignee_reference() -> None:
    seed = _valid_seed()
    seed["projects"][0]["tasks"][0]["assignee"] = "ghost"
    _expect_error(seed, "no account with slug 'ghost'")


def test_dangling_assignment_resource_reference() -> None:
    seed = _valid_seed()
    seed["projects"][0]["tasks"][0]["assignments"] = [{"resource": "ghost", "units": 1.0}]
    _expect_error(seed, "no resource with slug 'ghost'")


def test_dangling_sprint_reference() -> None:
    seed = _valid_seed()
    seed["projects"][0]["tasks"][0]["sprint"] = "nope"
    _expect_error(seed, "no sprint with slug 'nope'")


def test_dangling_dependency_task_reference() -> None:
    seed = _valid_seed()
    seed["projects"][1]["dependencies"][0]["successor"] = "99"
    _expect_error(seed, "no task '99' in project 'migration-tooling'")


def test_dependency_unknown_project_reference() -> None:
    seed = _valid_seed()
    seed["projects"][1]["dependencies"][0]["predecessor"] = "ghost-project:1"
    _expect_error(seed, "no project with slug 'ghost-project'")


def test_calendar_reference_resolves() -> None:
    seed = _valid_seed()
    seed["projects"][0]["calendar"] = "weekend-crew"
    _expect_error(seed, "no calendar with slug 'weekend-crew'")


def test_sprint_target_milestone_must_exist() -> None:
    seed = _valid_seed()
    seed["projects"][0]["sprints"][0]["target_milestone"] = "404"
    _expect_error(seed, "no task '404' in this project")


def test_baseline_task_must_exist() -> None:
    seed = _valid_seed()
    seed["projects"][0]["baselines"][0]["tasks"][0]["task"] = "404"
    _expect_error(seed, "baselines[0].tasks[0].task")


def test_program_scoped_risk_requires_qualified_task_ref() -> None:
    seed = _valid_seed()
    # bare wbs path on a program-scoped risk is ambiguous -> rejected
    seed["risks"][0]["tasks"] = ["1"]
    _expect_error(seed, "must be qualified")


def test_program_risk_owner_resolves() -> None:
    seed = _valid_seed()
    seed["risks"][0]["owner"] = "ghost"
    _expect_error(seed, "no account with slug 'ghost'")


def test_errors_are_collected_not_failed_fast() -> None:
    seed = _valid_seed()
    seed["projects"][0]["tasks"][0]["assignee"] = "ghost1"
    seed["projects"][1]["tasks"][0]["estimate"] = {"optimistic": 1, "most_likely": 2}
    with pytest.raises(SeedValidationError) as exc:
        validate_seed(seed)
    # structural errors short-circuit referential, but multiple structural
    # errors are still all reported.
    assert len(exc.value.errors) >= 1


def test_node_budget_enforced(monkeypatch: pytest.MonkeyPatch) -> None:
    import trueppm_api.apps.projects.seed.validation as validation_module

    monkeypatch.setattr(validation_module, "MAX_SEED_NODES", 1)
    _expect_error(_valid_seed(), "seed too large")


def test_program_slug_over_40_chars_rejected() -> None:
    seed = _valid_seed()
    seed["program"]["slug"] = "a" * 41
    _expect_error(seed, "program")  # slug maxLength 40 keeps it within Program.code


def test_deepcopy_base_is_independent() -> None:
    # guard against accidental shared-state between cases
    a = _valid_seed()
    b = copy.deepcopy(a)
    a["accounts"].append({"slug": "x", "username": "x"})
    assert b["accounts"] != a["accounts"]
