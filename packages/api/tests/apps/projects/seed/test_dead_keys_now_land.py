"""The four declared-but-unread seed keys now reach the database (#3093).

Companion to ``test_declared_keys_are_implemented``, which proves no *new* key
can be declared and left unread. These prove the four that already had.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.projects.models import Baseline, BoardColumnConfig, Project, Task
from trueppm_api.apps.projects.seed import import_seed

pytestmark = pytest.mark.django_db

User = get_user_model()

_SEEDS_DIR = (
    Path(__file__).resolve().parents[4]
    / "src"
    / "trueppm_api"
    / "apps"
    / "projects"
    / "fixtures"
    / "seeds"
)


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="deadkey-owner", email="o@example.com")


def _pack(stem: str) -> dict[str, Any]:
    return json.loads((_SEEDS_DIR / f"{stem}.json").read_text(encoding="utf-8"))


# --- baseline.captured_at ---------------------------------------------------


def test_declared_baselines_keep_their_authored_capture_date(owner: Any) -> None:
    """The interval between two baselines is what planned-vs-actual is measured
    over. auto_now_add collapsed Bayside's 75-day gap onto one afternoon."""
    program = import_seed(_pack("bayside-civic-center"), owner=owner, create_users=True)
    sitework = Project.objects.get(program=program, name__icontains="Sitework")

    captured = sorted(
        Baseline.objects.filter(project=sitework).values_list("created_at", flat=True)
    )
    assert len(captured) == 2, "sitework declares a contract baseline and a rebaseline"
    gap = (captured[1] - captured[0]).days
    assert gap > 60, f"contract -> rebaseline collapsed to {gap} days"


def test_a_rebaseline_sorts_after_the_baseline_it_replaces(owner: Any) -> None:
    program = import_seed(_pack("bayside-civic-center"), owner=owner, create_users=True)
    sitework = Project.objects.get(program=program, name__icontains="Sitework")

    names = list(
        Baseline.objects.filter(project=sitework)
        .order_by("created_at")
        .values_list("name", flat=True)
    )
    assert names == ["Contract baseline", "Rebaseline — mezzanine change order"]


def test_no_project_carries_two_baselines_of_the_same_name(owner: Any) -> None:
    """A declared baselines[] entry and a baseline.capture event of the same name
    produced two rows. Invisible while every capture date was import day."""
    program = import_seed(_pack("bayside-civic-center"), owner=owner, create_users=True)
    for project in Project.objects.filter(program=program):
        names = list(Baseline.objects.filter(project=project).values_list("name", flat=True))
        assert len(names) == len(set(names)), f"{project.name}: duplicate baseline in {names}"


# --- task.dor ---------------------------------------------------------------


def test_authored_dor_reaches_the_task(owner: Any) -> None:
    """Aurora is the pure-scrum pack and its Definition of Ready is the point of
    the sprint-picker story; all 25 non-default values landed on `idea`."""
    payload = _pack("aurora-mobile-app")
    authored = sum(
        1
        for project in payload["projects"]
        for task in project.get("tasks", [])
        if task.get("dor") in {"ready", "refine"}
    )
    assert authored > 0, "aurora stopped authoring dor — the fixture changed shape"

    program = import_seed(payload, owner=owner, create_users=True)
    landed = Task.objects.filter(
        project__program=program, dor__in=["ready", "refine"], is_deleted=False
    ).count()
    assert landed >= authored


# --- project.board_columns --------------------------------------------------


def test_board_columns_materialize_with_wip_limits_and_lanes(owner: Any) -> None:
    program = import_seed(_pack("atlas-platform-launch"), owner=owner, create_users=True)
    core = Project.objects.get(program=program, name="Platform Core")

    config = BoardColumnConfig.objects.get(project=core)
    by_status = {c["status"]: c for c in config.columns}
    assert set(by_status) == {"BACKLOG", "NOT_STARTED", "IN_PROGRESS", "REVIEW", "COMPLETE"}
    assert by_status["REVIEW"]["wip_limit"] == 2, "the sprint-3 retro action, on the board"
    assert [lane["key"] for lane in by_status["IN_PROGRESS"]["lanes"]] == ["building", "blocked"]


def test_a_project_without_board_columns_gets_no_config(owner: Any) -> None:
    """Absent means "uses the API defaults", not "pins today's defaults"."""
    program = import_seed(_pack("atlas-platform-launch"), owner=owner, create_users=True)
    waterfall = Project.objects.get(program=program, name="Migration Tooling")

    assert not BoardColumnConfig.objects.filter(project=waterfall).exists()


# --- project.agile_features -------------------------------------------------


def test_agile_features_is_gone_from_every_pack() -> None:
    """The model field was removed in migration 0123, so the key could only ever
    be a no-op. No bundled pack authors it any more.

    The schema still *accepts* it, marked ``deprecated``. Dropping a key under
    ``additionalProperties: false`` would break any hand-authored document
    carrying it — and `seed-data-schema.md` tells authors to start from a bundled
    fixture, so those documents plausibly exist."""
    for path in _SEEDS_DIR.glob("*.json"):
        payload = json.loads(path.read_text(encoding="utf-8"))
        for project in payload["projects"]:
            assert "agile_features" not in project, f"{path.name}/{project['slug']}"
