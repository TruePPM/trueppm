"""Tests for inbound CI acceptance-result ingestion (#1075, ADR-0148).

A CI job that runs a story's acceptance tests POSTs the verdicts to
``/api/v1/projects/{id}/acceptance-results/`` authenticated with the existing
ADR-0068 ProjectApiToken (Bearer tppm_<hex>). Each matching AcceptanceCriterion.met
flips, stamping met_by/met_at to the human who minted the token. Flipping the last
unmet criterion SATISFIES the Definition-of-Ready gate (dor_ready in the response)
but never auto-transitions the task to READY.

Covers: happy-path flip + attribution + dor_ready; failing verdict unmarks;
idempotent re-report (unchanged, no restamp); cross-project criterion → unknown
(untouched); wrong-project token → 401; program-scoped token may ingest; batch cap;
duplicate criterion id; empty results; no auto-transition to READY.
"""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    AcceptanceCriterion,
    ApiToken,
    Calendar,
    DorState,
    Program,
    Project,
    ProjectApiToken,
    Task,
    TaskStatus,
    TaskType,
)
from trueppm_api.apps.projects.serializers import ACCEPTANCE_RESULT_BATCH_CAP

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def minter(db: object) -> Any:
    """The human who mints the CI token — the attribution target for met_by."""
    return User.objects.create_user(username="ci_minter", email="ci@example.com", password="pw")


@pytest.fixture
def project(calendar: Calendar, minter: Any) -> Project:
    proj = Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)
    ProjectMembership.objects.create(project=proj, user=minter, role=Role.ADMIN)
    return proj


@pytest.fixture
def other_project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Q", start_date=date(2026, 4, 1), calendar=calendar)


def _mint_token(project: Project, creator: Any) -> tuple[ProjectApiToken, str]:
    import secrets

    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    token = ProjectApiToken.objects.create(
        project=project,
        name="ci-token",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=creator,
    )
    return token, raw


def _mint_program_token(program: Program, creator: Any) -> tuple[ApiToken, str]:
    import secrets

    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    token = ApiToken.objects.create(
        program=program,
        name="ci-program-token",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=creator,
    )
    return token, raw


def _bearer(raw_token: str) -> APIClient:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw_token}")
    return client


def _story(project: Project, **kw: Any) -> Task:
    defaults: dict[str, Any] = {
        "name": "Story",
        "type": TaskType.STORY,
        "status": TaskStatus.BACKLOG,
        "duration": 1,
        "story_points": 5,
        "sprint": None,
    }
    defaults.update(kw)
    return Task.objects.create(project=project, **defaults)


def _criterion(
    task: Task, *, met: bool = False, pos: int = 0, text: str = "AC"
) -> AcceptanceCriterion:
    return AcceptanceCriterion.objects.create(task=task, text=text, met=met, position=pos)


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/acceptance-results/"


# ---------------------------------------------------------------------------
# Happy path + attribution + DoR
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_passing_result_flips_met_and_stamps_attribution(project: Project, minter: Any) -> None:
    story = _story(project)
    c1 = _criterion(story, pos=0)
    _, raw = _mint_token(project, minter)
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
        resp = _bearer(raw).post(
            _url(project),
            {"results": [{"criterion_id": str(c1.pk), "passed": True}]},
            format="json",
        )
    assert resp.status_code == 200, resp.data
    assert resp.data["updated"] == 1
    assert resp.data["unchanged"] == 0
    assert resp.data["unknown"] == []
    c1.refresh_from_db()
    assert c1.met is True
    # Attribution lands on the human who minted the token, not the CI system.
    assert c1.met_by_id == minter.pk
    assert c1.met_at is not None


@pytest.mark.django_db
def test_last_criterion_satisfies_dor_without_auto_ready(project: Project, minter: Any) -> None:
    story = _story(project, story_points=5)
    c1 = _criterion(story, pos=0)
    _, raw = _mint_token(project, minter)
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
        resp = _bearer(raw).post(
            _url(project),
            {"results": [{"criterion_id": str(c1.pk), "passed": True}]},
            format="json",
        )
    assert resp.status_code == 200, resp.data
    report = next(t for t in resp.data["tasks"] if t["task"] == str(story.pk))
    assert report["dor_ready"] is True
    assert report["criteria_met"] == 1
    assert report["criteria_total"] == 1
    # The gate is clear, but the task is NOT auto-advanced to READY.
    story.refresh_from_db()
    assert story.dor != DorState.READY


@pytest.mark.django_db
def test_dor_not_ready_when_other_criterion_unmet(project: Project, minter: Any) -> None:
    story = _story(project, story_points=5)
    c1 = _criterion(story, pos=0)
    _criterion(story, pos=1, met=False)  # remains unmet
    _, raw = _mint_token(project, minter)
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
        resp = _bearer(raw).post(
            _url(project),
            {"results": [{"criterion_id": str(c1.pk), "passed": True}]},
            format="json",
        )
    report = next(t for t in resp.data["tasks"] if t["task"] == str(story.pk))
    assert report["dor_ready"] is False
    assert report["criteria_met"] == 1
    assert report["criteria_total"] == 2


# ---------------------------------------------------------------------------
# Failing verdict unmarks; idempotency
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_failing_result_unmarks_and_clears_attribution(project: Project, minter: Any) -> None:
    story = _story(project)
    c1 = _criterion(story, pos=0, met=True)
    c1.met_by = minter
    c1.save(update_fields=["met_by"])
    _, raw = _mint_token(project, minter)
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
        resp = _bearer(raw).post(
            _url(project),
            {"results": [{"criterion_id": str(c1.pk), "passed": False}]},
            format="json",
        )
    assert resp.status_code == 200, resp.data
    assert resp.data["updated"] == 1
    c1.refresh_from_db()
    assert c1.met is False
    assert c1.met_by_id is None
    assert c1.met_at is None


@pytest.mark.django_db
def test_reporting_same_verdict_is_unchanged(project: Project, minter: Any) -> None:
    story = _story(project)
    c1 = _criterion(story, pos=0, met=True)
    _, raw = _mint_token(project, minter)
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
        resp = _bearer(raw).post(
            _url(project),
            {"results": [{"criterion_id": str(c1.pk), "passed": True}]},
            format="json",
        )
    assert resp.status_code == 200, resp.data
    assert resp.data["updated"] == 0
    assert resp.data["unchanged"] == 1
    # No-op flip writes nothing — no task report (only changed tasks are reported).
    assert resp.data["tasks"] == []


# ---------------------------------------------------------------------------
# Cross-project IDOR defense
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_cross_project_criterion_is_unknown_not_flipped(
    project: Project, other_project: Project, minter: Any
) -> None:
    """A criterion in another project named by a valid token must not be flipped —
    it is returned in ``unknown`` and left untouched (write-IDOR defense)."""
    foreign_story = _story(other_project)
    foreign_c = _criterion(foreign_story, pos=0)
    _, raw = _mint_token(project, minter)
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
        resp = _bearer(raw).post(
            _url(project),
            {"results": [{"criterion_id": str(foreign_c.pk), "passed": True}]},
            format="json",
        )
    assert resp.status_code == 200, resp.data
    assert resp.data["updated"] == 0
    assert str(foreign_c.pk) in resp.data["unknown"]
    foreign_c.refresh_from_db()
    assert foreign_c.met is False


@pytest.mark.django_db
def test_wrong_project_token_is_401(project: Project, other_project: Project, minter: Any) -> None:
    """A token bound to another project cannot reach this URL project at all."""
    other_minter = User.objects.create_user(username="om", password="pw")
    _, raw = _mint_token(other_project, other_minter)
    resp = _bearer(raw).post(
        _url(project),
        {"results": []},
        format="json",
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Program-scoped token
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_program_scoped_token_can_ingest(calendar: Calendar, minter: Any) -> None:
    program = Program.objects.create(name="Artemis")
    project = Project.objects.create(
        name="InProgram", start_date=date(2026, 4, 1), calendar=calendar, program=program
    )
    story = _story(project)
    c1 = _criterion(story, pos=0)
    _, raw = _mint_program_token(program, minter)
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
        resp = _bearer(raw).post(
            _url(project),
            {"results": [{"criterion_id": str(c1.pk), "passed": True}]},
            format="json",
        )
    assert resp.status_code == 200, resp.data
    assert resp.data["updated"] == 1
    c1.refresh_from_db()
    assert c1.met is True
    assert c1.met_by_id == minter.pk


# ---------------------------------------------------------------------------
# Input validation / abuse surface
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_batch_over_cap_is_400(project: Project, minter: Any) -> None:
    story = _story(project)
    c1 = _criterion(story, pos=0)
    _, raw = _mint_token(project, minter)
    results = [{"criterion_id": str(c1.pk), "passed": True}] * (ACCEPTANCE_RESULT_BATCH_CAP + 1)
    resp = _bearer(raw).post(_url(project), {"results": results}, format="json")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_duplicate_criterion_id_is_400(project: Project, minter: Any) -> None:
    story = _story(project)
    c1 = _criterion(story, pos=0)
    _, raw = _mint_token(project, minter)
    resp = _bearer(raw).post(
        _url(project),
        {
            "results": [
                {"criterion_id": str(c1.pk), "passed": True},
                {"criterion_id": str(c1.pk), "passed": False},
            ]
        },
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_empty_results_is_400(project: Project, minter: Any) -> None:
    _, raw = _mint_token(project, minter)
    resp = _bearer(raw).post(_url(project), {"results": []}, format="json")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_no_auth_header_is_rejected(project: Project) -> None:
    resp = APIClient().post(_url(project), {"results": []}, format="json")
    assert resp.status_code in (401, 403)
