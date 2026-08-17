"""Two ratchets on the `/api/v1/` surface: envelope vocabulary and path casing (#2842).

`api/stability.md` puts request and response field names in the stable v1 surface,
classifies renaming a field as **Breaking**, and freezes v1 at **0.9**. Both classes
below are therefore free to fix today and permanent afterwards — which is exactly
the window in which nothing was checking them.

Neither class is caught by an existing gate. `api:schema-drift` proves the committed
schema matches the code that generated it; it is equally happy if both agree on a
seventh pagination shape. `test_openapi_pagination_envelope.py` proves a declared
envelope is backed by a paginating handler and vice versa — a declared-vs-actual
check that says nothing about *which* envelope was chosen.

**These are ratchets, not sweeps.** #1355 did a 0.3-era envelope tidy and 0.4
re-fragmented it, which is the signal that a sweep without a rule does not hold.
Each pre-existing exception is pinned by path with its reason, so it stays visible
and cannot grow; anything new fails at merge time.
"""

from __future__ import annotations

import json
import pathlib
import re
from typing import Any

_SCHEMA_PATH = pathlib.Path(__file__).resolve().parents[2].parent / "docs" / "api" / "openapi.json"

# The envelope vocabulary a NEW paginated endpoint must pick from.
#
#   page-number  — the global DRF default (settings/base.py)
#   DRF cursor   — DRF's own CursorPagination
#   bespoke cursor — an opaque-cursor list; fewest keys, no redundant boolean, and
#                    `results` matches both DRF envelopes
_SANCTIONED_ENVELOPES: frozenset[frozenset[str]] = frozenset(
    {
        frozenset({"count", "next", "previous", "results"}),
        frozenset({"next", "previous", "results"}),
        frozenset({"results", "next_cursor"}),
    }
)

# Pre-existing exceptions, pinned per path with the reason each is not simply wrong.
# Adding an entry here is a deliberate act that shows up in review; the point of the
# map is that the set cannot grow silently.
_GRANDFATHERED_ENVELOPES: dict[str, str] = {
    # The offline-sync delta. `changes` is a per-collection bucket MAP, not a list,
    # so calling it `results` would be actively misleading against the two DRF
    # envelopes where `results` is always an array. `has_more` is redundant with
    # `next_cursor is None` and is deprecated for removal in 0.5 — it is documented
    # in the client drain loop, so dropping it now would silently truncate a client
    # that follows our own published example.
    "/api/v1/projects/{id}/sync/": "offline-sync delta (bucket map, not a list)",
    "/api/v1/sync/user/programs/": "offline-sync delta (bucket map, not a list)",
    # Pre-0.3 shapes. Out of scope for #2842 by its own terms; tracked in #2844.
    "/api/v1/projects/{project_pk}/board/activity/": "pre-0.3 keyset page (#2844)",
    "/api/v1/projects/{project_pk}/history/": "pre-0.3 additive superset (#2844)",
    "/api/v1/tasks/trash/": "pre-0.3 capped list (#2844)",
}

# Path segments that are not kebab-case. All pre-0.3; tracked in #2844.
_GRANDFATHERED_SEGMENTS: frozenset[str] = frozenset({"incoming_carryover"})

# Keys that mean "there is another page". A new envelope must not invent a fourth.
_CONTINUATION_KEYS = frozenset({"next", "next_cursor"})

_PAGINATION_SMELL = frozenset(
    {"next", "next_cursor", "next_until", "previous", "results", "count", "has_more", "changes"}
)


def _schema() -> dict[str, Any]:
    return json.loads(_SCHEMA_PATH.read_text())


def _resolve(schema: dict[str, Any], node: dict[str, Any]) -> dict[str, Any]:
    if "$ref" in node:
        name = node["$ref"].rsplit("/", 1)[-1]
        return schema.get("components", {}).get("schemas", {}).get(name, {})
    return node


def _paginated_responses(schema: dict[str, Any]) -> list[tuple[str, frozenset[str]]]:
    """``(path, response_keys)`` for every GET 200 whose body looks paginated."""
    found: list[tuple[str, frozenset[str]]] = []
    for path, operations in schema.get("paths", {}).items():
        body = (
            operations.get("get", {})
            .get("responses", {})
            .get("200", {})
            .get("content", {})
            .get("application/json", {})
            .get("schema")
        )
        if not body:
            continue
        keys = frozenset(_resolve(schema, body).get("properties", {}) or {})
        if keys & _PAGINATION_SMELL:
            found.append((path, keys))
    return found


def test_the_schema_is_readable_and_still_has_paginated_endpoints() -> None:
    """Pin the scan — an unreadable or restructured schema must not pass vacuously."""
    assert _SCHEMA_PATH.exists(), f"committed schema not found at {_SCHEMA_PATH}"
    assert len(_paginated_responses(_schema())) >= 60


def test_every_paginated_response_uses_a_sanctioned_envelope() -> None:
    """A new paginated endpoint must pick one of three shapes, not invent a fourth."""
    schema = _schema()
    offenders = [
        f"  {path}\n      {sorted(keys)}"
        for path, keys in _paginated_responses(schema)
        if keys not in _SANCTIONED_ENVELOPES and path not in _GRANDFATHERED_ENVELOPES
    ]
    assert not offenders, (
        "These paginated responses use an unsanctioned envelope shape:\n"
        + "\n".join(offenders)
        + "\n\nPick one of:\n"
        + "\n".join(f"  {sorted(e)}" for e in _SANCTIONED_ENVELOPES)
        + "\n\nAn integrator writes ONE fetchAllPages() helper. Every extra shape is a "
        "branch they carry forever once v1 freezes in 0.9. If the endpoint genuinely "
        "cannot use one of these, add it to _GRANDFATHERED_ENVELOPES with the reason."
    )


def test_no_envelope_invents_a_new_continuation_key() -> None:
    """ "There is another page" is spelled ``next`` or ``next_cursor``. Not a third way.

    This is the specific failure the fragmentation causes: a client extends its
    page-number helper to cursor endpoints by reading ``next``, and silently gets
    exactly one page from every endpoint that spells it differently.
    """
    schema = _schema()
    offenders = []
    for path, keys in _paginated_responses(schema):
        if path in _GRANDFATHERED_ENVELOPES or "results" not in keys:
            continue
        if not keys & _CONTINUATION_KEYS:
            offenders.append(f"  {path} — {sorted(keys)}")
    assert not offenders, (
        "These list responses signal continuation with neither `next` nor "
        "`next_cursor`:\n" + "\n".join(offenders)
    )


def test_every_path_segment_is_kebab_case() -> None:
    """``url_path`` casing is part of the frozen surface; the viewsets are kebab-case.

    A snake_case segment on an otherwise kebab-case resource is the kind of thing
    nobody notices in review and nobody can change after 0.9.
    """
    offenders: list[str] = []
    for path in _schema().get("paths", {}):
        for segment in path.strip("/").split("/"):
            if not segment or segment.startswith("{") or segment in _GRANDFATHERED_SEGMENTS:
                continue
            if "_" in segment or re.search(r"[A-Z]", segment):
                offenders.append(f"  {segment!r} in {path}")
    assert not offenders, (
        "These path segments are not kebab-case:\n"
        + "\n".join(offenders)
        + "\n\nRename the action's `url_path=` (the Python method name stays snake_case)."
    )


def test_grandfathered_entries_still_describe_something_real() -> None:
    """An exception that no longer applies must be deleted, not left as cover.

    Without this, the two allowlists become the place drift hides: an endpoint gets
    fixed, its pin stays, and the next endpoint at that path inherits an exemption
    nobody granted it.
    """
    schema = _schema()
    paths = set(schema.get("paths", {}))
    stale_paths = sorted(set(_GRANDFATHERED_ENVELOPES) - paths)
    assert not stale_paths, f"Grandfathered envelope paths no longer exist: {stale_paths}"

    conforming = sorted(
        path
        for path, keys in _paginated_responses(schema)
        if path in _GRANDFATHERED_ENVELOPES and keys in _SANCTIONED_ENVELOPES
    )
    assert not conforming, (
        f"These paths now use a sanctioned envelope — remove their grandfather "
        f"entries: {conforming}"
    )

    live_segments = {
        segment
        for path in paths
        for segment in path.strip("/").split("/")
        if segment and not segment.startswith("{")
    }
    stale_segments = sorted(_GRANDFATHERED_SEGMENTS - live_segments)
    assert not stale_segments, f"Grandfathered path segments no longer exist: {stale_segments}"
