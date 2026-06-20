"""Replayed-history assertions for the bundled sample seeds (#1253).

``test_sample_content`` checks the *static* fixture (risk counts, RBAC, capacity).
This module loads each sample into a real database and asserts the *replayed*
history an evaluator actually sees — that the authored event timelines produced
dated reassignments, review rework, persona comments, risk lifecycles, sprint
goal verdicts, and mid-sprint scope audit, not just a synthesized status walk.

One import per sample (Atlas replays 68 tasks), so every dimension for a sample
is asserted in a single test to avoid re-importing.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    Risk,
    Sprint,
    SprintScopeChange,
    Task,
    TaskComment,
    TaskStatus,
)
from trueppm_api.apps.projects.seed.samples import load_sample

pytestmark = pytest.mark.django_db

User = get_user_model()

# (sample key, has sprints — drives the sprint/scope-audit assertions)
SAMPLES = [
    ("aurora-mobile-app", True),
    ("bayside-civic-center", False),
    ("helios-crm-replacement", True),
    ("atlas-platform-launch", True),
]

# Progression order for detecting a backward (rework) status move.
_ORDER = {
    str(TaskStatus.NOT_STARTED): 0,
    str(TaskStatus.IN_PROGRESS): 1,
    str(TaskStatus.REVIEW): 2,
    str(TaskStatus.COMPLETE): 3,
}


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="hist-owner", email="h@example.com")


def _tasks(program: Any) -> Any:
    return Task.objects.filter(project__program=program)


@pytest.mark.parametrize("key,has_sprints", SAMPLES)
def test_sample_replays_realistic_history(owner: Any, key: str, has_sprints: bool) -> None:
    program = load_sample(key, owner=owner, create_users=True)

    # 1. Reassignments — at least one task changed hands over its lifetime.
    reassigned = [
        t for t in _tasks(program) if len(set(t.history.values_list("assignee_id", flat=True))) >= 2
    ]
    assert reassigned, f"{key}: no task shows a reassignment in its history"

    # 2. Comments — dated, by named people, and more than one author across the
    #    program (handoffs and reviews, not one person talking to themselves).
    comments = TaskComment.objects.filter(task__project__program=program)
    assert comments.exists(), f"{key}: no task comments replayed"
    authors = set(comments.values_list("author_id", flat=True))
    assert len(authors) >= 2, f"{key}: comments come from a single author"
    a_day_ago = timezone.now() - timedelta(days=1)
    assert comments.filter(created_at__lt=a_day_ago).exists(), (
        f"{key}: no comment is backdated — history reads as import-time"
    )

    # 3. A non-linear "hero" — some task moved REVIEW → IN_PROGRESS (a real review
    #    bounce) the linear synthesizer can't produce.
    review = _ORDER[str(TaskStatus.REVIEW)]
    bounced = False
    for t in _tasks(program):
        seq = [
            _ORDER[s]
            for s in t.history.order_by("history_date").values_list("status", flat=True)
            if s in _ORDER
        ]
        # A backward step out of REVIEW is a real review bounce (rework).
        if any(seq[i] == review and seq[i + 1] < seq[i] for i in range(len(seq) - 1)):
            bounced = True
            break
    assert bounced, f"{key}: no task shows a Review → rework bounce-back"

    # 4. Risk lifecycle — at least one risk walked through more than one status,
    #    and the opening row is dated before its transitions (the importer
    #    backdates risk creation, so the lifecycle reads in order).
    animated = None
    for risk in Risk.objects.filter(project__program=program):
        statuses = list(risk.history.order_by("history_date").values_list("status", flat=True))
        if len(set(statuses)) >= 2:
            animated = risk
            break
    assert animated is not None, f"{key}: no risk shows a status lifecycle"
    rows = list(animated.history.order_by("history_date"))
    assert rows[0].history_type == "+", f"{key}: risk creation row is not the earliest"

    if has_sprints:
        # 5. Closed sprints carry an honest goal verdict.
        closed = Sprint.objects.filter(project__program=program, state="COMPLETED")
        assert closed.exists(), f"{key}: no closed sprints"
        assert all(s.goal_outcome for s in closed), f"{key}: a closed sprint has no goal_outcome"
        outcomes = {s.goal_outcome for s in closed}
        assert outcomes, f"{key}: no goal outcomes recorded"

        # 6. The mid-sprint scope audit was exercised.
        assert SprintScopeChange.objects.filter(sprint__project__program=program).exists(), (
            f"{key}: no SprintScopeChange recorded"
        )
