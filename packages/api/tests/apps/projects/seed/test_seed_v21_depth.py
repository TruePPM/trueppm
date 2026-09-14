"""Seed schema v2.1 depth — flow lane, task types, blockers (#3496); team facets,
skills, recurrence and subtasks (#3498).

Validation mirrors what the API refuses; the generic import and the v2 export
round-trip cover every new key; the sample checks are the issues' acceptance lists.
"""

from __future__ import annotations

import json
from datetime import time, timedelta
from pathlib import Path
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    BlockerType,
    Project,
    RecurrenceEndType,
    Task,
    TaskRecurrenceRule,
)
from trueppm_api.apps.projects.seed import import_seed
from trueppm_api.apps.projects.seed.exporter import dump_seed, export_program
from trueppm_api.apps.projects.seed.samples import SAMPLES, load_sample
from trueppm_api.apps.projects.seed.validation import SeedValidationError, validate_seed
from trueppm_api.apps.resources.models import ResourceSkill, Skill, TaskSkillRequirement
from trueppm_api.apps.teams.models import TeamMembership

User = get_user_model()

_SEEDS = Path(__file__).resolve().parents[4] / "src/trueppm_api/apps/projects/fixtures/seeds"
_AGILE = ("atlas-platform-launch", "aurora-mobile-app", "ga-launch", "helios-crm-replacement")


def _doc() -> dict[str, Any]:
    return {
        "schema_version": "2.1",
        "anchor": "2026-02-01",
        "program": {"slug": "depth", "name": "Depth", "methodology": "AGILE", "lead": "alex"},
        "accounts": [
            {"slug": "alex", "username": "depth-alex", "role": "OWNER"},
            {"slug": "priya", "username": "depth-priya", "role": "MEMBER"},
            {"slug": "sam", "username": "depth-sam", "role": "MEMBER"},
        ],
        "calendars": [{"slug": "std", "name": "Depth 5-day", "working_days": 31}],
        "resources": [
            {
                "slug": "priya",
                "name": "Priya",
                "account": "priya",
                "skills": [
                    {"name": "Python", "proficiency": "expert", "category": "Engineering"},
                    {"name": "Offline sync", "proficiency": "beginner"},
                ],
            }
        ],
        "projects": [
            {
                "slug": "core",
                "name": "Core",
                "methodology": "AGILE",
                "start_date": "A-30",
                "calendar": "std",
                "team": {
                    "name": "Core Squad",
                    "members": [
                        {"account": "sam", "scrum_master": True},
                        {"account": "priya", "product_owner": True},
                    ],
                },
                "tasks": [
                    {
                        "wbs_path": "1",
                        "name": "Sync engine",
                        "type": "story",
                        "assignee": "priya",
                        "skill_requirements": [
                            {"skill": "offline SYNC", "min_proficiency": "expert"}
                        ],
                    },
                    {"wbs_path": "1.1", "name": "Conflict resolution", "is_subtask": True},
                    {"wbs_path": "1.2", "name": "Retry queue", "is_subtask": True},
                    {
                        "wbs_path": "2",
                        "name": "Daily standup",
                        "assignee": "sam",
                        "recurrence": {
                            "frequency": "WEEKLY",
                            "weekdays": ["mon", "wed", "fri"],
                            "time_of_day": "09:15",
                            "end_count": 20,
                        },
                    },
                    {"wbs_path": "3", "name": "Legacy cleanup", "type": "tech_debt"},
                ],
            }
        ],
    }


def _errors(doc: dict[str, Any]) -> list[str]:
    with pytest.raises(SeedValidationError) as exc:
        validate_seed(doc)
    return exc.value.errors


def test_depth_document_is_valid() -> None:
    validate_seed(_doc())


def test_subtask_of_a_subtask_is_rejected() -> None:
    doc = _doc()
    doc["projects"][0]["tasks"].append(
        {"wbs_path": "1.1.1", "name": "Too deep", "is_subtask": True}
    )
    errors = _errors(doc)
    assert any("a subtask cannot hold subtasks" in e for e in errors)
    assert any("a subtask cannot have children" in e for e in errors)


def test_subtask_under_a_phase_is_rejected() -> None:
    doc = _doc()
    doc["projects"][0]["tasks"] += [
        {"wbs_path": "4", "name": "Phase"},
        {"wbs_path": "4.1", "name": "Structural child"},
        {"wbs_path": "4.2", "name": "Drawer child", "is_subtask": True},
    ]
    assert any("groups structural work" in e for e in _errors(doc))


def test_two_scrum_masters_are_rejected() -> None:
    doc = _doc()
    doc["projects"][0]["team"]["members"][1]["scrum_master"] = True
    assert any("at most one scrum_master" in e for e in _errors(doc))


def test_facet_on_a_non_member_is_rejected() -> None:
    doc = _doc()
    doc["projects"][0]["members"] = [{"account": "alex", "role": "OWNER"}]
    assert any("'sam' is not a member of this project" in e for e in _errors(doc))


def test_weekly_recurrence_without_weekdays_is_rejected() -> None:
    doc = _doc()
    del doc["projects"][0]["tasks"][3]["recurrence"]["weekdays"]
    assert any("requires at least one weekday" in e for e in _errors(doc))


@pytest.mark.django_db
def test_generic_import_materializes_team_skills_recurrence_and_subtasks() -> None:
    owner = User.objects.create_user("depth-owner")
    program = import_seed(_doc(), owner=owner, create_users=True)
    project = Project.objects.get(program=program)
    tasks = {t.wbs_path: t for t in Task.objects.filter(project=project)}

    facets = {
        m.user.username: (m.is_scrum_master, m.is_product_owner)
        for m in TeamMembership.objects.filter(
            team__project=project, team__is_default=True
        ).select_related("user", "team")
    }
    assert facets["depth-sam"] == (True, False)
    assert facets["depth-priya"] == (False, True)
    assert TeamMembership.objects.filter(team__project=project).first().team.name == "Core Squad"

    skills = {
        rs.skill.normalized_name: rs.proficiency
        for rs in ResourceSkill.objects.filter(resource__user__username="depth-priya")
    }
    assert skills == {"python": 3, "offline sync": 1}
    requirement = TaskSkillRequirement.objects.get(task=tasks["1"])
    # The requirement's name is matched case-insensitively onto the same catalog row.
    assert requirement.skill == Skill.objects.get(normalized_name="offline sync")
    assert requirement.min_proficiency == 3

    assert tasks["1.1"].is_subtask and tasks["1.2"].is_subtask
    assert not tasks["1"].is_subtask

    rule = TaskRecurrenceRule.objects.get(task=tasks["2"])
    assert rule.weekdays == 1 | 4 | 16
    assert rule.time_of_day == time(9, 15)
    assert (rule.end_type, rule.end_count) == (RecurrenceEndType.AFTER_N, 20)
    assert Task.objects.get(pk=tasks["2"].pk).is_recurring is True
    assert tasks["3"].type == "tech_debt"


@pytest.mark.django_db
def test_depth_export_round_trip_is_byte_identical() -> None:
    owner = User.objects.create_user("depth-owner")
    program = import_seed(_doc(), owner=owner, create_users=True)
    first_doc = export_program(program, with_events=True)
    assert first_doc["schema_version"] == "2.1"
    project = first_doc["projects"][0]
    assert project["team"]["name"] == "Core Squad"
    by_wbs = {t["wbs_path"]: t for t in project["tasks"]}
    assert by_wbs["1.1"]["is_subtask"] is True
    assert by_wbs["2"]["recurrence"]["weekdays"] == ["mon", "wed", "fri"]
    assert by_wbs["1"]["skill_requirements"] == [
        {"skill": "Offline sync", "min_proficiency": "expert"}
    ]
    assert any(r.get("skills") for r in first_doc["resources"])
    validate_seed(first_doc)

    first = dump_seed(first_doc)
    again = import_seed(json.loads(first), owner=owner, create_users=True, replace=True)
    assert dump_seed(export_program(again, with_events=True)) == first


def _fixtures() -> list[dict[str, Any]]:
    return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(_SEEDS.glob("*.json"))]


def test_every_task_type_and_blocker_type_is_authored_somewhere() -> None:
    """#3496 acceptance: bug, spike and tech_debt, and all five BlockerTypes."""
    types: set[str] = set()
    blockers: set[str] = set()
    for doc in _fixtures():
        for project in doc["projects"]:
            for task in project.get("tasks", []):
                types.add(task.get("type", "task"))
                if task.get("blocked", {}).get("type"):
                    blockers.add(task["blocked"]["type"])
        blockers |= {
            e["blocker_type"] for e in doc.get("events", []) if e["action"] == "task.block"
        }
    assert {"bug", "spike", "tech_debt"} <= types
    assert blockers == {choice.value for choice in BlockerType}


@pytest.mark.django_db
@pytest.mark.parametrize("key", sorted(SAMPLES))
def test_every_sample_loads_the_depth_layer(key: str) -> None:
    owner = User.objects.create_superuser(f"{key}-depth-owner", "o@example.com", "x")
    program = load_sample(key, owner=owner, create_users=True)
    tasks = Task.objects.filter(project__program=program, is_deleted=False)

    # #3498 — one recurring template, skills on the roster, a requirement to fit.
    assert TaskRecurrenceRule.objects.filter(task__project__program=program).count() == 1
    persona_prefix = f"{key.split('-')[0]}-"
    assert ResourceSkill.objects.filter(
        resource__user__username__startswith=persona_prefix
    ).exists()
    assert TaskSkillRequirement.objects.filter(task__project__program=program).exists()
    if key in _AGILE:
        memberships = TeamMembership.objects.filter(
            team__project__program=program, team__is_default=True
        )
        assert memberships.filter(is_scrum_master=True).exists()
        assert memberships.filter(is_product_owner=True).exists()
        assert tasks.filter(is_subtask=True).exists()

    if key == "atlas-platform-launch":
        # #3496 — two blockers live at load.
        assert tasks.exclude(blocked_reason="").count() >= 2
    if key == "aurora-mobile-app":
        # #3496 — a flow lane over its WIP limit, with a card past its age threshold.
        lane = tasks.filter(delivery_mode="kanban", board_lane="support", status="IN_PROGRESS")
        assert lane.count() > 2
        assert lane.filter(status_changed_at__lte=timezone.now() - timedelta(days=5)).exists()
