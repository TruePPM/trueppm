"""Estimation-poker state transitions (ADR-0179, #863).

One function per transition, each running under ``select_for_update()`` + a status guard
so concurrent multi-writer planning converges — the ``signal_privacy_services`` idiom. The
caller (the viewset) enforces *who* may call each (facilitator vs participant); these
functions enforce *what* transition is legal and keep the data consistent.

Kept free of view imports so the viewset and tests share them without a cycle.
"""

from __future__ import annotations

from typing import Any

from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from trueppm_api.apps.projects.models import (
    POKER_CARD_VALUES,
    PokerSession,
    PokerSessionState,
    PokerVote,
    Sprint,
    SprintState,
    Task,
)


class PokerConflict(Exception):
    """A poker transition that is illegal in the current state (maps to 409 in the view)."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


_LIVE_STATES = (PokerSessionState.OPEN, PokerSessionState.REVEALED)


def open_session(*, sprint: Sprint, task: Task, actor: Any) -> PokerSession:
    """Open a poker round for a task during planning.

    Guards: the sprint must be PLANNED (poker is a pre-activation ceremony, so a commit
    only sets the initial estimate — never a silent mid-sprint scope change, ADR-0179 §2);
    the task must belong to the sprint; and the task must not already be in a live round
    (the ``poker_one_live_per_task`` partial-unique enforces this under concurrency).
    """
    if sprint.state != SprintState.PLANNED:
        raise PokerConflict("sprint_not_planned", "Poker is only available while planning.")
    if task.sprint_id != sprint.pk:
        raise ValidationError({"task": "Task is not in this sprint."})
    try:
        with transaction.atomic():
            return PokerSession.objects.create(
                sprint=sprint, task=task, state=PokerSessionState.OPEN, started_by=actor
            )
    except IntegrityError:
        # The partial-unique fired — a concurrent open won the race.
        raise PokerConflict(
            "already_live", "This task already has a poker round in progress."
        ) from None


def _locked(session_id: Any) -> PokerSession:
    try:
        return PokerSession.objects.select_for_update().get(pk=session_id)
    except PokerSession.DoesNotExist:
        raise PokerConflict("not_found", "Poker session not found.") from None


def cast_vote(*, session_id: Any, voter: Any, value: int | None, comment: str) -> PokerSession:
    """Upsert the caller's vote while the round is OPEN.

    Idempotent on ``unique(session, voter)`` — re-running converges to the same vote.
    """
    if value is not None and value not in POKER_CARD_VALUES:
        raise ValidationError({"value": f"Invalid card '{value}'."})
    with transaction.atomic():
        session = _locked(session_id)
        if session.state != PokerSessionState.OPEN:
            raise PokerConflict("not_open", "Voting is closed for this round.")
        PokerVote.objects.update_or_create(
            session=session,
            voter=voter,
            defaults={"value": value, "comment": comment or ""},
        )
        return session


def reveal(*, session_id: Any) -> PokerSession:
    """Reveal votes: OPEN -> REVEALED."""
    with transaction.atomic():
        session = _locked(session_id)
        if session.state != PokerSessionState.OPEN:
            raise PokerConflict("not_open", "Only an open round can be revealed.")
        session.state = PokerSessionState.REVEALED
        session.save(update_fields=["state"])
        return session


def reopen(*, session_id: Any) -> PokerSession:
    """Re-vote: REVEALED -> OPEN (Alex's one-click re-vote; existing votes are retained
    so voters adjust rather than restart from blank)."""
    with transaction.atomic():
        session = _locked(session_id)
        if session.state != PokerSessionState.REVEALED:
            raise PokerConflict("not_revealed", "Only a revealed round can be reopened.")
        session.state = PokerSessionState.OPEN
        session.save(update_fields=["state"])
        return session


def commit_points(*, session_id: Any, points: int) -> PokerSession:
    """Commit the agreed value: {OPEN, REVEALED} -> COMMITTED; write ``Task.story_points``.

    Writing ``story_points`` triggers no CPM reschedule (it is an agile-only field).
    """
    if points not in POKER_CARD_VALUES:
        raise ValidationError({"points": f"Invalid card '{points}'."})
    with transaction.atomic():
        session = _locked(session_id)
        if session.state not in _LIVE_STATES:
            raise PokerConflict("not_live", "This round is already closed.")
        task = Task.objects.select_for_update().get(pk=session.task_id)
        task.story_points = points
        task.save(update_fields=["story_points"])
        session.state = PokerSessionState.COMMITTED
        session.committed_points = points
        session.closed_at = timezone.now()
        session.save(update_fields=["state", "committed_points", "closed_at"])
        return session


def cancel(*, session_id: Any) -> PokerSession:
    """Abandon a round: {OPEN, REVEALED} -> CANCELLED (no story_points write)."""
    with transaction.atomic():
        session = _locked(session_id)
        if session.state not in _LIVE_STATES:
            raise PokerConflict("not_live", "This round is already closed.")
        session.state = PokerSessionState.CANCELLED
        session.closed_at = timezone.now()
        session.save(update_fields=["state", "closed_at"])
        return session


def live_sessions_for_sprint(sprint_id: Any) -> list[PokerSession]:
    """The sprint's live (open/revealed) poker rounds, newest first — the GET feed."""
    return list(
        PokerSession.objects.filter(sprint_id=sprint_id, state__in=_LIVE_STATES)
        .select_related("task", "started_by")
        .prefetch_related("votes__voter")
    )
