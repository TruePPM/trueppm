"""Live retro board + team-health pulse service layer (ADR-0117).

Every board-item write goes through here so the single broadcast point — a
best-effort ``broadcast_board_event`` deferred with ``transaction.on_commit``
(ADR-0117 §DE.1) — lives in one place and the viewset stays thin. Concurrency is
per-item last-write-wins on ``server_version``: writes always apply and bump the
version; the broadcast carries the winning state so a client whose in-flight edit
was superseded reconciles (and offers a non-destructive undo) on its side.

The pulse path deliberately does **not** broadcast: a project-board event reaches
every connected client including the PM band, so even a content-free "pulse
answered" ping is a read-receipt signal Morgan's hard-NO forbids. The trend is a
reflective view, refetched on retro open — not a live race — and is gated on read
by ADR-0104's ``pulse`` signal (team + coach only; PM/PMO omitted entirely;
non-member denied).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from django.db import transaction
from rest_framework.exceptions import ValidationError

# Server-side cap on a sticky body (ADR-0117 §1). Bounds storage and the broadcast
# fan-out — a sticky is a short note, not a document.
MAX_STICKY_LEN = 2000

if TYPE_CHECKING:
    from django.contrib.auth.models import User
    from rest_framework.request import Request

    from trueppm_api.apps.projects.models import (
        PulseResponse,
        RetroActionItem,
        RetroBoardItem,
        Sprint,
        SprintRetro,
    )


def _assert_board_writable(sprint: Sprint) -> None:
    """Guard the editable window (ADR-0117 §6). PLANNED/CANCELLED reject writes.

    The live ceremony usually runs at/just-after close, so a hard ACTIVE-only lock
    would shut the board at the exact moment teams use it — ACTIVE *and* COMPLETED
    are writable; CANCELLED (and not-yet-started PLANNED) are read-only.
    """
    from trueppm_api.apps.projects.models import SprintState

    if sprint.state not in (SprintState.ACTIVE, SprintState.COMPLETED):
        raise ValidationError(
            f"The retro board is read-only while the sprint is {sprint.state}; "
            "it opens when the sprint is active and stays editable after close."
        )


def _get_or_create_retro(sprint: Sprint, actor: User) -> SprintRetro:
    """Lazily create the SprintRetro the first sticky/pulse attaches to.

    Mirrors the single-author retro upsert's lazy creation so an existing sprint
    needs no data migration — a retro simply springs into being on first use.
    """
    from trueppm_api.apps.projects.models import SprintRetro

    retro, _ = SprintRetro.objects.get_or_create(
        sprint=sprint,
        defaults={"created_by": actor},
    )
    return retro


def _broadcast(project_id: Any, event_type: str, payload: dict[str, Any]) -> None:
    """Defer a best-effort board broadcast until the surrounding tx commits."""
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    pid = str(project_id)
    transaction.on_commit(lambda: broadcast_board_event(pid, event_type, payload))


# ---------------------------------------------------------------------------
# Board stickies — concurrent multi-writer CRUD (ADR-0117 §1, §3)
# ---------------------------------------------------------------------------


def create_board_item(
    sprint: Sprint,
    *,
    column: str,
    text: str,
    color: str,
    author: User,
) -> RetroBoardItem:
    """Create a sticky, appended to the end of its column.

    Position is ``max(column) + 1`` so a new card lands at the bottom; a later
    drag computes a fractional midpoint via :func:`move_board_item`.
    """
    from django.db.models import Max

    from trueppm_api.apps.projects.models import RetroBoardItem, RetroColumn

    _assert_board_writable(sprint)
    body = (text or "").strip()
    if not body:
        raise ValidationError({"text": "A sticky cannot be empty."})
    if len(body) > MAX_STICKY_LEN:
        raise ValidationError({"text": f"A sticky cannot exceed {MAX_STICKY_LEN} characters."})
    if column not in RetroColumn.values:
        raise ValidationError({"column": f"Unknown column '{column}'."})

    with transaction.atomic():
        retro = _get_or_create_retro(sprint, author)
        last = (
            RetroBoardItem.objects.filter(retro=retro, column=column, is_deleted=False)
            .aggregate(m=Max("position"))
            .get("m")
        )
        item = RetroBoardItem.objects.create(
            retro=retro,
            column=column,
            text=body,
            color=color or "",
            author=author,
            position=(last or 0.0) + 1.0,
        )
        _broadcast(
            sprint.project_id,
            "retro_item_created",
            {
                "id": str(item.id),
                "retro_id": str(retro.id),
                "sprint_id": str(sprint.id),
                "column": item.column,
                "author_id": author.pk,
            },
        )
    return item


def update_board_item(
    item: RetroBoardItem, *, text: str | None, color: str | None
) -> RetroBoardItem:
    """Edit a sticky's text/color (last-write-wins; ADR-0117 §3).

    Always applies — no version precondition. The bumped ``server_version`` and
    the broadcast let a client whose edit was superseded detect the collision and
    offer its non-destructive undo. Editing never moves the sticky (see
    :func:`move_board_item`).
    """
    _assert_board_writable(item.retro.sprint)
    fields: list[str] = []
    if text is not None:
        body = text.strip()
        if not body:
            raise ValidationError({"text": "A sticky cannot be empty."})
        if len(body) > MAX_STICKY_LEN:
            raise ValidationError({"text": f"A sticky cannot exceed {MAX_STICKY_LEN} characters."})
        item.text = body
        fields.append("text")
    if color is not None:
        item.color = color
        fields.append("color")
    if fields:
        item.save(update_fields=[*fields, "updated_at", "server_version"])
        _broadcast(
            item.retro.sprint.project_id,
            "retro_item_updated",
            {"id": str(item.id), "retro_id": str(item.retro_id)},
        )
    return item


def move_board_item(item: RetroBoardItem, *, column: str, position: float) -> RetroBoardItem:
    """Move a sticky to a column + fractional position (drag-reorder; ADR-0117 §3)."""
    from trueppm_api.apps.projects.models import RetroColumn

    _assert_board_writable(item.retro.sprint)
    if column not in RetroColumn.values:
        raise ValidationError({"column": f"Unknown column '{column}'."})
    item.column = column
    item.position = position
    item.save(update_fields=["column", "position", "updated_at", "server_version"])
    _broadcast(
        item.retro.sprint.project_id,
        "retro_item_moved",
        {"id": str(item.id), "retro_id": str(item.retro_id), "column": column},
    )
    return item


def delete_board_item(item: RetroBoardItem) -> None:
    """Soft-delete a sticky and broadcast its removal."""
    _assert_board_writable(item.retro.sprint)
    project_id = item.retro.sprint.project_id
    retro_id = item.retro_id
    item_id = item.id
    item.is_deleted = True
    item.save(update_fields=["is_deleted", "updated_at", "server_version"])
    _broadcast(
        project_id,
        "retro_item_deleted",
        {"id": str(item_id), "retro_id": str(retro_id)},
    )


def convert_to_action(item: RetroBoardItem, actor: User) -> RetroActionItem:
    """Distil a discussion sticky into a RetroActionItem (ADR-0117 §1).

    Idempotent (ADR-0117 §DE.7): a sticky already converted returns its existing
    action item rather than creating a duplicate. The new action item then uses the
    unchanged #858 promote flow.
    """
    from trueppm_api.apps.projects.models import RetroActionItem

    _assert_board_writable(item.retro.sprint)
    with transaction.atomic():
        locked = item.__class__.objects.select_for_update().get(pk=item.pk)
        if locked.converted_action_item_id is not None:
            existing = RetroActionItem.objects.filter(
                pk=locked.converted_action_item_id, is_deleted=False
            ).first()
            if existing is not None:
                return existing
        action = RetroActionItem.objects.create(retro=locked.retro, text=locked.text)
        locked.converted_action_item_id = action.pk
        locked.save(update_fields=["converted_action_item_id", "updated_at", "server_version"])
        _broadcast(
            locked.retro.sprint.project_id,
            "retro_item_updated",
            {"id": str(locked.id), "retro_id": str(locked.retro_id)},
        )
    return action


# ---------------------------------------------------------------------------
# Team-health pulse (ADR-0117 §5; ADR-0104 pulse gate consumed verbatim)
# ---------------------------------------------------------------------------


def upsert_pulse_response(
    sprint: Sprint,
    *,
    respondent: User,
    mood: int | None,
    energy: int | None,
    confidence: int | None,
) -> PulseResponse:
    """One-tap upsert of the requester's own pulse response (ADR-0117 §5).

    Keyed on ``unique(retro, respondent)`` so a re-tap updates rather than
    duplicates. Deliberately does **not** broadcast — a pulse event would reach
    PM-band clients as a read-receipt (Morgan 🔴). Validates each dimension to 1..5.
    """
    from trueppm_api.apps.projects.models import PulseResponse

    _assert_board_writable(sprint)
    # Explicit per-field guards (not a loop) so the type narrows to ``int`` for the
    # update_or_create below — mypy --strict + django-stubs reject ``int | None`` on
    # the non-null model fields.
    if mood is None or not (1 <= mood <= 5):
        raise ValidationError({"mood": "Must be an integer 1-5."})
    if energy is None or not (1 <= energy <= 5):
        raise ValidationError({"energy": "Must be an integer 1-5."})
    if confidence is not None and not (1 <= confidence <= 5):
        raise ValidationError({"confidence": "Must be an integer 1-5 or omitted."})

    with transaction.atomic():
        retro = _get_or_create_retro(sprint, respondent)
        response, _ = PulseResponse.objects.update_or_create(
            retro=retro,
            respondent=respondent,
            is_deleted=False,
            defaults={"mood": mood, "energy": energy, "confidence": confidence},
        )
    return response


def my_pulse_response(sprint: Sprint, respondent: User) -> PulseResponse | None:
    """The requester's own current response for this sprint, echoed so they can change it."""
    from trueppm_api.apps.projects.models import PulseResponse, SprintRetro

    retro = SprintRetro.objects.filter(sprint=sprint, is_deleted=False).first()
    if retro is None:
        return None
    return PulseResponse.objects.filter(
        retro=retro, respondent=respondent, is_deleted=False
    ).first()


def pulse_trend(request: Request, sprint: Sprint) -> dict[str, Any]:
    """Cross-sprint pulse trend, gated by ADR-0104's ``pulse`` signal (the 🔴).

    Returns ``{"gated": True}`` and **no data** for any requester outside the
    signal's audience (PM/PMO band by default; non-member always) — a redacted
    aggregate is no pulse (ADR-0104 §2.3). For the team + coach band, returns
    aggregate-only per-sprint points (never an individual's raw answer) ordered by
    sprint start, plus a server-computed ``energy_declining`` flag (the
    "two-sprints-before-velocity" signal), the response count, and the requester's
    own current response echoed back.
    """
    from django.db.models import Avg, Count

    from trueppm_api.apps.projects.models import PulseResponse
    from trueppm_api.apps.projects.signal_privacy_services import can_read_signal

    if not can_read_signal(request, sprint.project_id, "pulse"):
        # Omit entirely — no count, no points, nothing to infer from (ADR-0104 §2.3).
        return {"gated": True}

    # Aggregate per sprint across the whole project, oldest → newest. Grouping by
    # the sprint behind each retro keeps individual rows invisible — only means and
    # counts leave the server.
    rows = (
        PulseResponse.objects.filter(
            retro__sprint__project_id=sprint.project_id,
            is_deleted=False,
        )
        .values("retro__sprint_id", "retro__sprint__name", "retro__sprint__start_date")
        .annotate(
            avg_mood=Avg("mood"),
            avg_energy=Avg("energy"),
            avg_confidence=Avg("confidence"),
            response_count=Count("id"),
        )
        .order_by("retro__sprint__start_date", "retro__sprint__name")
    )
    points = [
        {
            "sprint_id": str(r["retro__sprint_id"]),
            "sprint_name": r["retro__sprint__name"],
            "avg_mood": round(r["avg_mood"], 2) if r["avg_mood"] is not None else None,
            "avg_energy": round(r["avg_energy"], 2) if r["avg_energy"] is not None else None,
            "avg_confidence": (
                round(r["avg_confidence"], 2) if r["avg_confidence"] is not None else None
            ),
            "response_count": r["response_count"],
        }
        for r in rows
    ]

    # energy_declining: the last two points both fell — the coach's early-warning
    # signal. Computed server-side so the client renders a fact, not a derivation.
    energy_declining = False
    energies = [p["avg_energy"] for p in points if p["avg_energy"] is not None]
    if len(energies) >= 3:
        energy_declining = energies[-1] < energies[-2] < energies[-3]

    mine = my_pulse_response(sprint, request.user)  # type: ignore[arg-type]
    return {
        "gated": False,
        "points": points,
        "energy_declining": energy_declining,
        "my_response": (
            {"mood": mine.mood, "energy": mine.energy, "confidence": mine.confidence}
            if mine is not None
            else None
        ),
    }
