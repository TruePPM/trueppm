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
    inspect_seed,
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


def test_v2_event_dangling_project_target_rejected() -> None:
    # `baseline.capture` is the one action whose target is a project slug. The
    # task and sprint arms of _check_event_target had dangling-ref tests; the
    # project and risk arms did not, so both were unexercised until #2775's
    # diff-coverage gate surfaced the project one.
    seed = _valid_v2_seed()
    seed["events"].append(
        {
            "at": "A-5",
            "actor": "alex",
            "action": "baseline.capture",
            "target": "project:ghost",
        }
    )
    _expect_error(seed, "no project with slug 'ghost'")


def test_v2_event_project_target_resolves() -> None:
    # The pass side of the same branch: a baseline.capture against a project that
    # DOES exist must validate, so the test above is proving the slug check and
    # not just that any baseline.capture event is rejected.
    seed = _valid_v2_seed()
    seed["events"].append(
        {
            "at": "A-5",
            "actor": "alex",
            "action": "baseline.capture",
            "target": "project:core",
        }
    )
    validate_seed(seed)  # does not raise


def test_v2_event_dangling_risk_target_rejected() -> None:
    # The other untested arm found alongside the project one. Not required by the
    # coverage gate (this line is not in the #2775 diff), but it is the same
    # branch family and the gap was real.
    seed = _valid_v2_seed()
    seed["events"][1]["target"] = "risk:ghost"
    _expect_error(seed, "no risk with slug 'ghost'")


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


# --- inspect_seed: the non-raising dry-run form (#2418) ---------------------


def test_inspect_valid_seed_reports_valid() -> None:
    report = inspect_seed(_valid_seed())
    assert report.valid is True
    assert report.errors == []


def test_inspect_never_raises_on_a_bad_document() -> None:
    """Totality is the contract — the caller needs diagnostics precisely when
    the document is bad."""
    for payload in (None, [], "nope", 42, {}, {"schema_version": "9.0"}):
        report = inspect_seed(payload)
        assert report.valid is False
        assert report.errors


def test_inspect_echoes_the_claimed_shape() -> None:
    report = inspect_seed(_valid_seed())
    assert report.schema_version == "1.0"
    assert report.program_slug == "atlas"
    assert report.program_name == "Atlas Platform Launch"
    assert report.project_count == 2
    assert report.resource_count == 2
    assert report.task_count > 0


def test_inspect_echoes_the_claimed_shape_of_an_invalid_document() -> None:
    """The echo is read defensively — it is most useful on a file that failed."""
    seed = _valid_seed()
    del seed["schema_version"]
    seed["projects"][0]["tasks"][0]["assignee"] = "ghost"
    report = inspect_seed(seed)
    assert report.valid is False
    assert report.schema_version is None
    assert report.program_slug == "atlas"
    assert report.project_count == 2


def test_inspect_survives_a_program_of_the_wrong_type() -> None:
    report = inspect_seed({"schema_version": "1.0", "program": "not-an-object", "projects": {}})
    assert report.valid is False
    assert report.program_slug is None
    assert report.project_count == 0


def test_missing_version_reports_every_other_problem_too() -> None:
    """The bug this issue names: a version-less document used to report one
    problem and hide the other twenty (#2418)."""
    seed = _valid_seed()
    del seed["schema_version"]
    seed["projects"][0]["tasks"][0]["assignee"] = "ghost"
    seed["accounts"].append({"slug": "alex", "username": "dup"})

    report = inspect_seed(seed)

    joined = "\n".join(report.errors)
    assert "$.schema_version: required and missing" in joined
    assert "ghost" in joined, joined
    assert "duplicate slug" in joined, joined


def test_missing_version_is_reported_exactly_once() -> None:
    """The structural pass runs against an injected version, so the schema's own
    required-property error cannot double up on the specific one."""
    seed = _valid_seed()
    del seed["schema_version"]
    report = inspect_seed(seed)
    version_errors = [e for e in report.errors if "schema_version" in e]
    assert version_errors == ["$.schema_version: required and missing"]


def test_missing_version_does_not_mutate_the_caller_payload() -> None:
    """The injected version lives in a shallow copy — an operator's parsed
    document must come back out the way it went in."""
    seed = _valid_seed()
    del seed["schema_version"]
    inspect_seed(seed)
    assert "schema_version" not in seed


def test_unsupported_major_stops_at_the_version() -> None:
    """No defensible schema to substitute — checking a 9.x document against the
    v2 schema would bury the one diagnostic that matters."""
    seed = _valid_seed()
    seed["schema_version"] = "9.0"
    seed["projects"][0]["tasks"][0]["assignee"] = "ghost"
    report = inspect_seed(seed)
    assert len(report.errors) == 1
    assert "unsupported version" in report.errors[0]


def test_non_string_version_is_unsupported_not_a_crash() -> None:
    seed = _valid_seed()
    seed["schema_version"] = 2
    report = inspect_seed(seed)
    assert report.valid is False
    assert "unsupported version" in "\n".join(report.errors)


def test_validate_seed_still_raises_everything_inspect_reports() -> None:
    """``validate_seed`` is now a wrapper; the importer's contract is unchanged."""
    seed = _valid_seed()
    del seed["schema_version"]
    report = inspect_seed(seed)
    with pytest.raises(SeedValidationError) as exc:
        validate_seed(seed)
    assert exc.value.errors == report.errors
