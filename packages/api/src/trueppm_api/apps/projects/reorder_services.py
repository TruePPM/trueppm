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
    anchors = [a for a in (before_id, after_id) if a is not None]
    if to_end:
        anchors.append("__end__")
    if len(anchors) != 1:
        raise ReorderError("Provide exactly one of before_id, after_id, or to_end.")

    # Lock the sibling group and read it in rank order. The list is the source of
    # truth for every subsequent index/neighbor computation.
    siblings = list(queryset.select_for_update().order_by(rank_field, "id"))
    by_id = {str(s.pk): s for s in siblings}

    item = by_id.get(item_id)
    if item is None:
        raise ReorderError("item_id is not a member of the reorderable group.")

    anchor_id = before_id or after_id
    if anchor_id is not None:
        if anchor_id == item_id:
            raise ReorderError("Cannot anchor an item to itself.")
        if anchor_id not in by_id:
            raise ReorderError("anchor id is not a member of the reorderable group.")

    # Build the target ordering as a list of ids, then assign dense ranks. Working
    # on the ordered id list (not the raw floats) keeps the result deterministic and
    # collapse-proof: we always rewrite affected rows to clean RANK_STEP multiples.
    ordered_ids = [str(s.pk) for s in siblings if str(s.pk) != item_id]
    if to_end:
        ordered_ids.append(item_id)
    elif before_id is not None:
        ordered_ids.insert(ordered_ids.index(before_id), item_id)
    else:  # after_id
        ordered_ids.insert(ordered_ids.index(after_id) + 1, item_id)

    # Assign dense ranks; only persist rows whose rank actually changes so the write
    # (and the server_version bump / history row it creates) stays minimal.
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

    return {"id": item_id, "priority_rank": moved_rank, "renormalized": renormalized}
