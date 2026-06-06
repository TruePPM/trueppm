"""DB tests for the seed importer (ADR-0109, issue #615).

Exercises a small two-project seed end to end: program/projects/tasks created,
cross-project dependency wired, sprint milestone bound, baseline snapshotted,
risk linked, resource assigned, three-point estimate imported ACCEPTED, and
re-import idempotency on the program slug.
"""

from __future__ import annotations

import copy
from typing import Any

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    Dependency,
    EstimateStatus,
    Program,
    Project,
    Risk,
    RiskTask,
    Sprint,
    Task,
)
from trueppm_api.apps.projects.seed import SeedValidationError, import_seed
from trueppm_api.apps.resources.models import Resource, TaskResource

pytestmark = pytest.mark.django_db

User = get_user_model()


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="importer-owner", email="o@example.com")


def _seed() -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "program": {
            "slug": "atlas",
            "name": "Atlas Platform Launch",
            "description": "Flagship hybrid demo",
            "methodology": "HYBRID",
            "color": "#123456",
            "lead": "alex",
        },
        "accounts": [
            {
                "slug": "alex",
                "username": "seed-alex",
                "email": "alex@example.com",
                "display_name": "Alex Rivera",
                "role": "OWNER",
            },
            {"slug": "sam", "username": "seed-sam", "display_name": "Sam Lee", "role": "ADMIN"},
        ],
        "calendars": [
            {
                "slug": "default",
                "name": "Seed Standard 5-day",
                "working_days": 31,
                "hours_per_day": 8.0,
            },
        ],
        "resources": [
            {
                "slug": "alex",
                "name": "Alex Rivera",
                "email": "alex@example.com",
                "max_units": 1.0,
                "calendar": "default",
                "account": "alex",
            },
        ],
        "risks": [
            {
                "slug": "vendor",
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
                "tasks": [
                    {
                        "wbs_path": "1",
                        "name": "Build auth",
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
                        "name": "GA",
                        "is_milestone": True,
                        "delivery_mode": "milestone",
                        "estimate": {"optimistic": 1, "most_likely": 2, "pessimistic": 3},
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
                        "name": "ETL",
                        "duration": 5,
                        "planned_start": "2026-02-02",
                        "estimate": {"optimistic": 3, "most_likely": 5, "pessimistic": 12},
                    },
                ],
                "dependencies": [
                    {
                        "predecessor": "platform-core:1",
                        "successor": "1",
                        "dep_type": "FS",
                        "lag": 2,
                    },
                ],
                "risks": [
                    {
                        "slug": "etl",
                        "title": "ETL slow",
                        "status": "MITIGATING",
                        "probability": 3,
                        "impact": 4,
                        "tasks": ["1"],
                    },
                ],
            },
        ],
    }


def test_import_creates_full_program(owner: Any) -> None:
    program = import_seed(_seed(), owner=owner, create_users=True)

    assert program.code == "atlas"
    assert program.color == "#123456"
    assert program.lead is not None and program.lead.username == "seed-alex"
    assert Project.objects.filter(program=program).count() == 2

    pc = Project.objects.get(program=program, code="", name="Platform Core")
    assert Task.objects.filter(project=pc).count() == 2

    # cross-project dependency resolved
    dep = Dependency.objects.get(dep_type="FS")
    assert dep.predecessor.name == "Build auth"
    assert dep.successor.name == "ETL"
    assert dep.lag == 2

    # milestone duration coerced to 0; estimate NOT written on milestone
    ga = Task.objects.get(name="GA")
    assert ga.is_milestone and ga.duration == 0
    assert ga.optimistic_duration is None

    # three-point estimate imported ACCEPTED on a real task
    etl = Task.objects.get(name="ETL")
    assert (etl.optimistic_duration, etl.most_likely_duration, etl.pessimistic_duration) == (
        3,
        5,
        12,
    )
    assert etl.estimate_status == EstimateStatus.ACCEPTED

    # sprint milestone binding
    sprint = Sprint.objects.get(name="Sprint 1")
    assert sprint.target_milestone == ga

    # baseline snapshot
    baseline = Baseline.objects.get(name="Kickoff")
    assert baseline.is_active and baseline.has_cpm_dates
    assert BaselineTask.objects.filter(baseline=baseline).count() == 1

    # resource assignment + roster
    assert TaskResource.objects.filter(task__name="Build auth").count() == 1
    assert Resource.objects.filter(name="Alex Rivera").exists()

    # risks: program-scoped on lead project + project-scoped
    assert Risk.objects.filter(title="Vendor lock-in").exists()
    assert RiskTask.objects.filter(risk__title="Vendor lock-in").count() == 2
    assert RiskTask.objects.filter(risk__title="ETL slow").count() == 1

    # membership: sam got ADMIN at program level
    from trueppm_api.apps.access.models import ProgramMembership

    assert ProgramMembership.objects.filter(
        program=program, user__username="seed-sam", role=Role.ADMIN
    ).exists()


def test_reimport_is_idempotent(owner: Any) -> None:
    import_seed(_seed(), owner=owner, create_users=True)
    import_seed(_seed(), owner=owner, create_users=True)

    # exactly one live program with the slug; old subtree hard-deleted
    assert Program.objects.filter(code="atlas", is_deleted=False).count() == 1
    program = Program.objects.get(code="atlas", is_deleted=False)
    assert Project.objects.filter(program=program).count() == 2
    # tasks belong only to the surviving program
    assert Task.objects.filter(project__program=program).count() == 3


def test_create_users_false_does_not_mint_logins(owner: Any) -> None:
    seed = _seed()
    program = import_seed(seed, owner=owner, create_users=False)
    # referenced accounts that don't exist are not created
    assert not User.objects.filter(username="seed-alex").exists()
    # lead/assignee gracefully unresolved
    assert program.lead is None
    assert Task.objects.get(name="Build auth").assignee is None


def test_invalid_seed_writes_nothing(owner: Any) -> None:
    seed = _seed()
    seed["projects"][0]["tasks"][0]["assignee"] = "ghost"
    with pytest.raises(SeedValidationError):
        import_seed(seed, owner=owner, create_users=True)
    assert not Program.objects.filter(code="atlas").exists()


def test_seed_fixture_is_isolated() -> None:
    a = _seed()
    b = copy.deepcopy(a)
    a["projects"].pop()
    assert len(b["projects"]) == 2
