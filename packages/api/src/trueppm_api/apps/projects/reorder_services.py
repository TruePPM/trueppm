"""Server-side single-item reorder under a row lock (ADR-0217, #322).

Client-computed ``position`` / ``priority_rank`` values crisscross under
contention: two simultaneous drags each compute their target from a now-stale
neighbor set, so the loser lands in the wrong place. This service moves the
computation server-side and serializes it on ``SELECT ... FOR UPDATE`` so
concurrent reorders produce a deterministic final order.

The public entry point :func:`reorder_by_anchor` takes a single item and an
anchor — ``before_id``, ``after_id``, or ``to_end`` — and writes a dense
``priority_rank`` for the moved row, renormalizing the sibling group when the
fractional gap between neighbors collapses. It is model-agnostic (any model with
an integer/float rank field and a ``server_version`` bump on ``save()``), so the
board, schedule, and Enterprise reorder surfaces share one implementation.
"""

from __future__ import annotations

from typing import Any

from django.db import transaction
from django.db.models import QuerySet

# Dense spacing between adjacent ranks after a renormalize. Wide enough that many
# midpoint inserts fit before the integer gap collapses and forces the next pass.
RANK_STEP = 10


class ReorderError(ValueError):
    """The reorder request was malformed or referenced a non-sibling anchor."""


@transaction.atomic
def reorder_by_anchor(
    *,
    queryset: QuerySet[Any],
    item_id: str,
    before_id: str | None = None,
    after_id: str | None = None,
    to_end: bool = False,
    rank_field: str = "priority_rank",
) -> dict[str, Any]:
    """Reposition ``item_id`` within its sibling ``queryset`` relative to an anchor.

    Exactly one of ``before_id``, ``after_id``, or ``to_end`` must be given. The
    whole sibling group is locked ``FOR UPDATE`` (ordered by ``rank_field`` then
    ``id`` for a stable tie-break), so two concurrent reorders serialize on the
    lock and the second observes the first's writes — no crisscross.

    Returns ``{"id", "priority_rank", "renormalized": [ {id, priority_rank}, ... ]}``:
    the moved item's new rank, plus every row whose rank changed if a renormalize
    was needed (so the caller can broadcast/refetch the affected set).

    Raises :class:`ReorderError` on a bad anchor selector or an id that is not a
    member of the sibling group.
    """
    _validate_anchor_selector(before_id, after_id, to_end)

    # Lock the sibling group and read it in rank order. The list is the source of
    # truth for every subsequent index/neighbor computation.
    siblings = list(queryset.select_for_update().order_by(rank_field, "id"))
    by_id = {str(s.pk): s for s in siblings}

    item = by_id.get(item_id)
    if item is None:
        raise ReorderError("item_id is not a member of the reorderable group.")

    _check_anchor_membership(before_id or after_id, item_id, by_id)

    ordered_ids = _build_ordered_ids(siblings, item_id, before_id, after_id, to_end=to_end)
    moved_rank, renormalized = _assign_dense_ranks(ordered_ids, by_id, rank_field, item_id)

    return {"id": item_id, "priority_rank": moved_rank, "renormalized": renormalized}


def _validate_anchor_selector(before_id: str | None, after_id: str | None, to_end: bool) -> None:
    """Assert exactly one of ``before_id``, ``after_id``, or ``to_end`` was given."""
    anchors = [a for a in (before_id, after_id) if a is not None]
    if to_end:
        anchors.append("__end__")
    if len(anchors) != 1:
        raise ReorderError("Provide exactly one of before_id, after_id, or to_end.")


def _check_anchor_membership(anchor_id: str | None, item_id: str, by_id: dict[str, Any]) -> None:
    """Reject an anchor that is the item itself or not a member of the group."""
    if anchor_id is None:
        return
    if anchor_id == item_id:
        raise ReorderError("Cannot anchor an item to itself.")
    if anchor_id not in by_id:
        raise ReorderError("anchor id is not a member of the reorderable group.")


def _build_ordered_ids(
    siblings: list[Any],
    item_id: str,
    before_id: str | None,
    after_id: str | None,
    *,
    to_end: bool,
) -> list[str]:
    """Compute the target id ordering with ``item_id`` moved to the anchor position.

    Working on the ordered id list (not the raw floats) keeps the result
    deterministic and collapse-proof: the caller always rewrites affected rows to
    clean RANK_STEP multiples.
    """
    ordered_ids = [str(s.pk) for s in siblings if str(s.pk) != item_id]
    if to_end:
        ordered_ids.append(item_id)
    elif before_id is not None:
        ordered_ids.insert(ordered_ids.index(before_id), item_id)
    else:  # after_id — non-None here: exactly one anchor, and it is neither to_end nor before_id
        assert after_id is not None
        ordered_ids.insert(ordered_ids.index(after_id) + 1, item_id)
    return ordered_ids


def _assign_dense_ranks(
    ordered_ids: list[str],
    by_id: dict[str, Any],
    rank_field: str,
    item_id: str,
) -> tuple[int | None, list[dict[str, Any]]]:
    """Write dense ``RANK_STEP`` multiples to ``ordered_ids``; return the moved rank.

    Only persists rows whose rank actually changes so the write (and the
    server_version bump / history row it creates) stays minimal. Returns
    ``(moved_rank, renormalized)`` where ``renormalized`` lists every *other* row
    whose rank changed.
    """
    renormalized: list[dict[str, Any]] = []
    moved_rank: int | None = None
    for position, sid in enumerate(ordered_ids):
        new_rank = (position + 1) * RANK_STEP
        row = by_id[sid]
        if getattr(row, rank_field) != new_rank:
            setattr(row, rank_field, new_rank)
            row.save(update_fields=[rank_field, "server_version"])
            if sid != item_id:
                renormalized.append({"id": sid, "priority_rank": new_rank})
        if sid == item_id:
            moved_rank = new_rank
    return moved_rank, renormalized
