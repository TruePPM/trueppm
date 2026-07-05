"""Field-level conflict detection for stale-``server_version`` writes (ADR-0217, #322).

Every ``VersionedModel`` resolves concurrent writes with ``server_version``
last-writer-wins (LWW): the loser's whole row is discarded and no signal reaches
the user — even when the two writers touched *disjoint* fields. This module
upgrades the three entities a PM actually co-edits (``Task``, ``Project``,
``Risk``) to **field-level merge**:

- The client sends the version it last saw as the ``X-Base-Version`` request
  header (or a ``base_version`` body key). Absent → LWW is preserved, so the
  change is fully backward compatible.
- On a write whose ``base_version`` is stale (``instance.server_version >
  base_version``), the fields changed by the intervening writers are
  reconstructed from ``HistoricalRecords`` and intersected with the payload's
  changed fields.
  - **Disjoint** → the write proceeds (the returned object carries both change
    sets, because it reflects the merged row); a ``X-Merged-Concurrent-Fields``
    header names what the other writer changed so the client reconciles its cache.
  - **Overlapping** (or an unresolvable history gap) → :class:`MergeConflict`
    (HTTP 409) with a structured body, failing *closed* so work is never lost.

The mechanism is model-agnostic: any ``VersionedModel`` carrying
``HistoricalRecords`` can opt in, so Enterprise reuses it without forking logic.
``TaskComment`` and other append-only models are intentionally excluded — they
are immutable after a short self-edit window and carry no ``HistoricalRecords``,
so there is no in-place concurrent edit to merge.
"""

from __future__ import annotations

from typing import Any

from rest_framework import status
from rest_framework.exceptions import APIException
from rest_framework.request import Request
from rest_framework.serializers import BaseSerializer


class MergeConflict(APIException):
    """HTTP 409 raised when a stale write overlaps a concurrent writer's fields.

    The ``detail`` is a structured body (``conflict_fields`` / ``server_value`` /
    ``client_value`` / ``server_version``) rendered verbatim by DRF's exception
    handler so the client can drive its "Someone else changed this" toast.
    """

    status_code = status.HTTP_409_CONFLICT
    default_code = "sync_conflict"

    def __init__(self, detail: dict[str, Any]) -> None:
        # Bypass APIException's str-coercion of detail — we want the dict rendered
        # as the response body as-is.
        self.detail = detail  # type: ignore[assignment]


def parse_base_version(request: Request) -> int | None:
    """Read the client's last-known ``server_version`` from header or body.

    Header ``X-Base-Version`` is preferred (survives serializer field filtering);
    a ``base_version`` body key is the offline-friendly fallback. Returns ``None``
    when absent or unparseable, in which case the caller keeps LWW behavior.
    """
    raw: Any = request.headers.get("X-Base-Version")
    if raw is None and isinstance(request.data, dict):
        raw = request.data.get("base_version")
    if raw is None or isinstance(raw, bool):
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value >= 0 else None


def _concurrent_changed_fields(instance: Any, base_version: int) -> tuple[set[str], bool]:
    """Fields changed by writes committed since ``base_version``, plus an ambiguity flag.

    ``server_version`` increments 1:1 with the ``save()``-created ``HistoricalRecords``
    rows, so the most recent ``(current - base_version)`` history rows are exactly the
    intervening writes. If fewer history rows exist than the version gap — a bulk
    ``QuerySet.update()`` bumped ``server_version`` via ``F()`` without writing a
    history row — the changed-field set is incomplete, so ``ambiguous`` is ``True`` and
    the caller fails closed (409) rather than risk a silent merge over an unknown change.
    """
    current = int(instance.server_version)
    gap = current - base_version
    if gap <= 0:
        return set(), False

    # Newest-first by the monotonic history pk. Pull one extra row so the oldest of
    # the ``gap`` recent rows can diff against its predecessor without a per-row query.
    records = list(instance.history.order_by("-history_id")[: gap + 1])
    recent = records[:gap]
    ambiguous = len(recent) < gap

    changed: set[str] = set()
    for i, rec in enumerate(recent):
        older = records[i + 1] if i + 1 < len(records) else rec.prev_record
        if older is None:
            # A creation row (no predecessor) means every field is "new" — treat the
            # whole row as changed so an overlapping edit is caught.
            changed |= {f.name for f in instance._meta.concrete_fields}
        else:
            changed |= set(rec.diff_against(older).changed_fields)
    return changed, ambiguous


def _payload_changed_fields(instance: Any, validated_data: dict[str, Any]) -> set[str]:
    """The subset of the payload that actually changes a value on ``instance``.

    A no-op field (submitted but equal to the stored value) is not a conflict, so it
    is excluded. On any comparison uncertainty the field is *included* (conservative:
    an over-reported field can only turn a merge into a 409, never lose data).
    """
    changed: set[str] = set()
    for field, new_value in validated_data.items():
        try:
            current = getattr(instance, field)
        except Exception:
            changed.add(field)
            continue
        try:
            if current != new_value:
                changed.add(field)
        except Exception:
            changed.add(field)
    return changed


def check_field_conflict(request: Request, serializer: BaseSerializer[Any]) -> list[str]:
    """Detect a field-level conflict before a stale write is applied (ADR-0217).

    Call at the top of ``perform_update`` — after ``is_valid()``, before
    ``serializer.save()``. Returns the sorted list of fields a concurrent writer
    changed on this row (empty when the client is current or opted out), for the
    caller to surface via the ``X-Merged-Concurrent-Fields`` header. Raises
    :class:`MergeConflict` when the payload overlaps those fields, or when the
    intervening history is ambiguous (fail-closed).
    """
    instance = serializer.instance
    base = parse_base_version(request)
    if instance is None or base is None:
        return []
    if int(instance.server_version) <= base:
        return []

    concurrent, ambiguous = _concurrent_changed_fields(instance, base)
    client_fields = _payload_changed_fields(instance, dict(serializer.validated_data))
    overlap = client_fields & concurrent

    if overlap or ambiguous:
        raise MergeConflict(_conflict_body(serializer, instance, overlap, ambiguous))
    return sorted(concurrent)


def _conflict_body(
    serializer: BaseSerializer[Any],
    instance: Any,
    overlap: set[str],
    ambiguous: bool,
) -> dict[str, Any]:
    """Build the structured 409 body, RBAC-safe.

    ``server_value`` is drawn from the serializer's representation *for the
    requesting user*, so a field the requester cannot read is never exposed (VoC
    blocker). ``client_value`` echoes the raw submitted values for the conflicting
    fields so the UI can show a side-by-side.
    """
    fields = sorted(overlap)
    representation = serializer.to_representation(instance) if fields else {}
    server_value = {f: representation[f] for f in fields if f in representation}
    initial = serializer.initial_data if isinstance(serializer.initial_data, dict) else {}
    client_value = {f: initial.get(f) for f in fields}

    detail = (
        "This record changed in a way that can't be safely merged. Reload and reapply your edit."
        if ambiguous
        else "Someone else changed this. Reload to see their changes."
    )
    body: dict[str, Any] = {
        "code": "sync_conflict",
        "detail": detail,
        "conflict_fields": fields,
        "server_value": server_value,
        "client_value": client_value,
        "server_version": int(instance.server_version),
    }
    if ambiguous:
        body["ambiguous"] = True
    return body


class FieldLevelMergeMixin:
    """Attach the ``X-Merged-Concurrent-Fields`` header after a disjoint merge.

    The viewset's ``perform_update`` stores the concurrent-field list on
    ``self._merge_concurrent_fields`` (via :func:`check_field_conflict`); this
    mixin surfaces it as a response header so the client knows which fields another
    writer changed and can reconcile its cache without a blind refetch. Add it to
    the base-class list of any viewset that calls ``check_field_conflict``.
    """

    def finalize_response(self, request: Request, response: Any, *args: Any, **kwargs: Any) -> Any:
        fields = getattr(self, "_merge_concurrent_fields", None)
        if fields:
            response["X-Merged-Concurrent-Fields"] = ",".join(fields)
        return super().finalize_response(request, response, *args, **kwargs)  # type: ignore[misc]
