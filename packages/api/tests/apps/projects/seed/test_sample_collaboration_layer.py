"""The v2.1 collaboration layer lands in every sample, and each persona sees what their
role allows (#3603, #3490, #3491, #3492, #3493).

Counts are asserted against the issues' acceptance lists. Visibility is asserted
through the API reads the web app makes, as named personas — RBAC must still hold,
so a Viewer or a non-member sees no more of the new data than the rule gives them.
"""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.agents.models import SAMPLE_SUMMARY_PREFIX, SAMPLE_TOKEN_PREFIX, AgentAction
from trueppm_api.apps.notifications.models import Mention
from trueppm_api.apps.projects.models import (
    AcceptanceCriterion,
    BacklogItem,
    CeremonyTemplate,
    CommentAcknowledgement,
    CommentReaction,
    Project,
    ShareLink,
    SprintState,
    Task,
    TaskComment,
    TaskNote,
)
from trueppm_api.apps.projects.seed.samples import SAMPLES, load_sample
from trueppm_api.apps.timetracking.models import TimeEntry, TimesheetSubmission

pytestmark = pytest.mark.django_db

User = get_user_model()

_AGILE = {"atlas-platform-launch", "aurora-mobile-app", "ga-launch", "helios-crm-replacement"}


def _load(key: str) -> Any:
    owner = User.objects.create_superuser(f"{key}-layer-owner", "owner@example.com", "x")
    return load_sample(key, owner=owner, create_users=True, persona_password="layer-3603")


def _as(username: str) -> APIClient:
    client = APIClient()
    client.force_authenticate(User.objects.get(username=username))
    return client


def _rows(resp: Any) -> list[Any]:
    assert resp.status_code == 200, resp.content
    data = resp.data
    return list(data["results"] if isinstance(data, dict) and "results" in data else data)


@pytest.mark.parametrize("key", sorted(SAMPLES))
def test_every_sample_loads_the_collaboration_layer(key: str) -> None:
    program = _load(key)
    in_program = {"task__project__program": program}

    # #3491 — a populated backlog with at least one item linked to its task.
    assert BacklogItem.objects.filter(program=program).exists()
    assert BacklogItem.objects.filter(program=program, pulled_task__isnull=False).exists()
    # #3603 — a program cadence.
    assert CeremonyTemplate.objects.filter(program=program).exists()
    # #3493 — a threaded exchange, three resolvable mentions, reactions or acks.
    assert TaskComment.objects.filter(parent__isnull=False, **in_program).exists()
    mentioned = Mention.objects.filter(
        task_comment__task__project__program=program, mentioned_user__isnull=False
    ).count()
    assert mentioned >= 3, f"{key}: only {mentioned} resolved mentions"
    assert (
        CommentReaction.objects.filter(comment__task__project__program=program).exists()
        or CommentAcknowledgement.objects.filter(comment__task__project__program=program).exists()
    )
    # #3492 — decisions, and no story in an active sprint left at "idea".
    decisions = TaskNote.objects.filter(decision=True, **in_program).count()
    assert decisions >= (3 if key == "atlas-platform-launch" else 1)
    assert not Task.objects.filter(
        project__program=program, type="story", sprint__state=SprintState.ACTIVE, dor="idea"
    ).exists()
    if key in _AGILE:
        criteria = AcceptanceCriterion.objects.filter(**in_program)
        assert criteria.filter(met=True).exists() and criteria.filter(met=False).exists()
    # #3490 — logged time, and submitted weeks for at least two personas.
    entries = TimeEntry.objects.filter(**in_program)
    assert entries.exists()
    loggers = set(entries.values_list("user_id", flat=True))
    submitted = set(
        TimesheetSubmission.objects.filter(user_id__in=loggers).values_list("user_id", flat=True)
    )
    assert len(submitted) >= 2, f"{key}: {len(submitted)} personas with a submitted week"


def test_atlas_personas_see_the_layer_their_roles_allow() -> None:
    program = _load("atlas-platform-launch")
    core = Project.objects.get(program=program, name="Platform Core")
    sso = Task.objects.get(project=core, wbs_path="1.1")
    outsider = User.objects.create_user("atlas-layer-outsider")
    outside = APIClient()
    outside.force_authenticate(outsider)

    # Agent-oversight panel: membership-scoped, every row marked as sample data.
    trail_url = f"/api/v1/agent-actions/?program={program.pk}"
    trail = _rows(_as("atlas-alex").get(trail_url))
    assert trail
    assert any(row["verdict"] == "refused" for row in trail)
    assert all(row["summary"].startswith(SAMPLE_SUMMARY_PREFIX) for row in trail)
    assert all(row["actor_token_prefix"] == SAMPLE_TOKEN_PREFIX for row in trail)
    # The rule is membership, not role: a Viewer on those projects reads the same
    # trail, and GTM-only Clara and a stranger read none of it.
    assert len(_rows(_as("atlas-ada").get(trail_url))) == len(trail)
    assert _rows(_as("atlas-clara").get(trail_url)) == []
    assert _rows(outside.get(trail_url)) == []
    assert AgentAction.objects.filter(project__program=program).count() == len(trail)

    # Program backlog and cadence: readable by a program Viewer, not by a stranger.
    backlog_url = f"/api/v1/programs/{program.pk}/backlog-items/"
    assert _rows(_as("atlas-ada").get(backlog_url))
    assert outside.get(backlog_url).status_code in (403, 404)
    assert _rows(_as("atlas-alex").get(f"/api/v1/programs/{program.pk}/ceremonies/"))

    # Decision notes: a Platform Core member reads them; GTM-only Clara cannot.
    notes_url = f"/api/v1/projects/{core.pk}/tasks/{sso.pk}/notes/"
    notes = _rows(_as("atlas-priya").get(notes_url))
    assert any(note["decision"] for note in notes)
    assert _as("atlas-clara").get(notes_url).status_code in (403, 404)

    # Timesheet: a persona's submitted week renders populated through their own read.
    submission = (
        TimesheetSubmission.objects.filter(user__username__startswith="atlas-")
        .order_by("-week_start")
        .select_related("user")
        .first()
    )
    assert submission is not None
    week = _as(submission.user.username).get(
        "/api/v1/me/time-entries/",
        {
            "from": submission.week_start.isoformat(),
            "to": (submission.week_start + timedelta(days=6)).isoformat(),
        },
    )
    assert week.status_code == 200, week.content
    body = json.dumps(week.data, default=str)
    assert '"submitted": true' in body
    assert '"week_minutes": 0' not in body


def test_aurora_share_link_is_visible_to_its_admins_only() -> None:
    program = _load("aurora-mobile-app")
    project = Project.objects.get(program=program)
    url = f"/api/v1/projects/{project.pk}/share-links/"

    links = _rows(_as("aurora-priya").get(url))
    assert len(links) == 1
    assert ShareLink.objects.get(project=project).revoked_at is None
    assert _as("aurora-ada").get(url).status_code in (403, 404)
