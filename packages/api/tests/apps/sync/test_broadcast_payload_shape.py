"""Every WS event type must emit one recognizable payload shape (#2843).

``FROZEN_WS_EVENT_TYPES`` freezes the event *names*. Nothing froze their
*shapes* — and with 168 broadcast call sites across ~130 event types, all passing
free-form ``dict[str, Any]``, the shapes drifted. ``task_updated`` shipped three
of them, one of which (retro carryover) carried ``task_id`` and **no** ``id`` at
all, so the frontend's ``typeof payload.id === 'string' ? payload.id : null``
resolved to null and silently degraded: the ADR-0152 per-task version dedup was
skipped and history invalidation widened from one task to the whole project.

The envelope carries ``protocol_version: 1`` precisely so payload shape can be
relied on, so this is a contract gap rather than a style question.

The invariant here is deliberately weak enough to be true of correct code and
strong enough to catch the defect: **all sites emitting a given event must share
at least one payload key.** Two sites with disjoint key sets cannot both be read
by one client handler — that is not a shape preference, it is an unparseable
event. It permits the documented "usually ``{id}``, sometimes richer" spread that
``websockets.md`` describes, and it does not force every site to enumerate the
canonical field list.

Scope: only call sites whose event type and payload dict are both literal can be
read statically. The unscannable remainder is asserted to stay small so the guard
cannot quietly stop covering the tree.
"""

from __future__ import annotations

import ast
import collections
import pathlib

import trueppm_api

_BROADCAST_HELPERS = frozenset({"broadcast_board_event", "abroadcast_board_event"})

# Call sites that build the payload in a variable or splat it. Static analysis
# cannot read these; the count is pinned so the scanner cannot degrade to
# covering nothing and still pass.
#
# Lowered from 15 to 11 by #3776: cpm_complete's two dispatch paths
# (scheduling/tasks.py) each built the payload as a dict *variable* and both
# fell into this bucket — which is exactly why the gate could not see they
# had drifted onto different key sets (one carried status_date, one did not).
# Both now route through one shared helper that passes a dict *literal* at
# the broadcast_board_event() call site, collapsing the two unscannable sites
# into a single scannable one. Ratcheted down rather than left at 15 so a
# future refactor that reintroduces a dict-variable payload has to raise this
# number deliberately instead of coasting under unused headroom.
# Raised 11 -> 12 for the ``extra`` branch of ``broadcast_task_updated``, which
# spreads caller context keys under the standard ``task_updated`` keys; the
# helper's literal branch stays scannable and always carries ``id``.
_MAX_UNSCANNABLE_SITES = 12

# Events that are pure signals — "something in this collection changed, re-read
# it" — and correctly carry no payload at all. Listed rather than inferred so
# adding a key to one of them is a deliberate act.
_SIGNAL_ONLY_EVENTS = frozenset(
    {
        "phases_reordered",
        "queue_reordered",
        "slip_conflicts_updated",
        "tasks_reordered",
        "tasks_restructured",
    }
)

_Site = tuple[frozenset[str], str]


def _scan() -> tuple[dict[str, list[_Site]], int]:
    """Return ``{event_type: [(payload_keys, "file:line"), ...]}`` and an unscannable count."""
    root = pathlib.Path(trueppm_api.__file__).resolve().parent
    by_event: dict[str, list[_Site]] = collections.defaultdict(list)
    unscannable = 0

    for path in sorted(root.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = (
                func.attr
                if isinstance(func, ast.Attribute)
                else func.id
                if isinstance(func, ast.Name)
                else None
            )
            if name not in _BROADCAST_HELPERS:
                continue

            kwargs = {k.arg: k.value for k in node.keywords}
            event_type = kwargs.get("event_type") or (node.args[1] if len(node.args) > 1 else None)
            payload = kwargs.get("payload") or (node.args[2] if len(node.args) > 2 else None)

            if not isinstance(event_type, ast.Constant) or not isinstance(event_type.value, str):
                unscannable += 1
                continue
            if not isinstance(payload, ast.Dict):
                unscannable += 1
                continue
            keys = {
                k.value
                for k in payload.keys
                if isinstance(k, ast.Constant) and isinstance(k.value, str)
            }
            if len(keys) != len(payload.keys):  # a non-literal key or a ** spread
                unscannable += 1
                continue

            by_event[event_type.value].append(
                (frozenset(keys), f"{path.relative_to(root)}:{node.lineno}")
            )

    return dict(by_event), unscannable


def test_the_scanner_still_reaches_the_broadcast_sites() -> None:
    """Pin coverage — a refactor must not empty the scan and pass vacuously."""
    by_event, unscannable = _scan()
    assert len(by_event) >= 90, f"payload-shape scan collapsed to {len(by_event)} event types"
    assert unscannable <= _MAX_UNSCANNABLE_SITES, (
        f"{unscannable} broadcast sites build their payload dynamically (cap "
        f"{_MAX_UNSCANNABLE_SITES}). Static shape analysis cannot see these — pass a "
        f"literal dict at the call site, or raise the cap deliberately."
    )


def test_every_event_types_payload_sites_share_a_key() -> None:
    """No event may be emitted with two disjoint payload shapes.

    A client handler receives one ``event_type`` and reads keys off the payload.
    If site A emits ``{"id"}`` and site B emits ``{"task_id", "source"}``, there is
    no key the handler can read that is present on both — B is invisible to it.
    """
    by_event, _ = _scan()
    offenders: list[str] = []

    for event_type, sites in sorted(by_event.items()):
        if event_type in _SIGNAL_ONLY_EVENTS:
            continue
        keyed = [s for s in sites if s[0]]
        if len(keyed) < 2:
            continue
        if frozenset.intersection(*[keys for keys, _ in keyed]):
            continue
        detail = "\n".join(f"      {sorted(keys)}  @ {loc}" for keys, loc in keyed)
        offenders.append(f"  {event_type}:\n{detail}")

    assert not offenders, (
        "These event types are emitted with payload shapes that share no key, so one "
        "client handler cannot read them all:\n" + "\n".join(offenders)
    )


def test_signal_only_events_really_carry_no_payload() -> None:
    """The exemption list must not become a place to hide a shape drift.

    An event is exempt because it is a pure "re-read the collection" signal. The
    moment one of them starts carrying data, it is a normal event and must satisfy
    the shared-key rule like every other.
    """
    by_event, _ = _scan()
    leaked = {
        event_type: sorted({k for keys, _ in sites for k in keys})
        for event_type, sites in by_event.items()
        if event_type in _SIGNAL_ONLY_EVENTS and any(keys for keys, _ in sites)
    }
    assert not leaked, (
        f"Signal-only events now carry a payload: {leaked}. Remove them from "
        f"_SIGNAL_ONLY_EVENTS so the shared-key rule applies."
    )


# Row-subject lifecycle events that are deliberately NOT keyed on ``id`` (#4088).
# Each reason says why the event has no single subject row; adding an entry is a
# visible, reviewed act, and an entry whose event starts carrying ``id`` fails the
# staleness check below.
_ID_WAIVERS: dict[str, str] = {
    "board_config_updated": "Subject is the project's board configuration (a JSON "
    "field on Project), not a row of its own; the project is the channel.",
    "dependencies_bulk_created": "Aggregate of up to 500 edges from one POST "
    "/tasks/bulk/; names them as the plural dependency_ids (#3770), so no single id.",
    "milestone_forecast_updated": "Subject is a server-computed forecast, not a "
    "persisted row write; milestone_id names the milestone task it describes.",
}

# Events whose subject is a row but whose name does not end in a lifecycle suffix.
# The sprint family names the sprint as ``id`` like every ``sprint_*`` lifecycle
# event, and project_calendar_changed names the project whose calendar changed.
_ID_REQUIRED_EXTRA = frozenset(
    {
        "demo_reordered",
        "project_calendar_changed",
        "sprint_reranked",
        "sprint_retro_updated",
        "sprint_scope_changed",
    }
)

_LIFECYCLE_SUFFIXES = ("_created", "_updated", "_deleted")


def _id_required(event_type: str) -> bool:
    return event_type in _ID_REQUIRED_EXTRA or event_type.endswith(_LIFECYCLE_SUFFIXES)


def test_row_subject_events_all_carry_id() -> None:
    """Every row-subject event must name its subject as ``id`` (#4088, #2843).

    ``websockets.md`` tells consumers to key on ``payload.id``, and the frontend's
    dedup/history scoping reads it. The shared-key rule above only requires one
    event's sites to agree with *each other* — ``suggestion_created`` shipped as
    ``{task_id, suggestion_id, suggested_user_id}`` and passed it, while an MCP or
    integrator consumer had no way to find the suggestion it announced.
    """
    by_event, _ = _scan()
    missing: list[str] = []
    for event_type, sites in sorted(by_event.items()):
        if event_type in _SIGNAL_ONLY_EVENTS or event_type in _ID_WAIVERS:
            continue
        if not _id_required(event_type):
            continue
        for keys, loc in sites:
            if keys and "id" not in keys:
                missing.append(f"  {event_type} @ {loc} emits {sorted(keys)} with no 'id'")
    assert not missing, (
        "Row-subject events must carry 'id' (or take a reasoned _ID_WAIVERS entry):\n"
        + "\n".join(missing)
    )


def test_task_identity_events_are_scanned() -> None:
    """The rule above must actually reach the task events it was first written for."""
    by_event, _ = _scan()
    for event_type in ("task_created", "task_updated", *sorted(_ID_REQUIRED_EXTRA)):
        assert by_event.get(event_type), f"{event_type} is no longer scannable"


def test_id_waivers_are_not_stale() -> None:
    """A waiver for an event that now carries ``id`` everywhere (or is gone) must go."""
    by_event, _ = _scan()
    stale = [
        event_type
        for event_type in _ID_WAIVERS
        if not any(keys and "id" not in keys for keys, _ in by_event.get(event_type, []))
    ]
    assert not stale, f"Remove these _ID_WAIVERS entries; they no longer apply: {stale}"


def test_project_calendar_changed_names_its_actor_by_id() -> None:
    """Every other event names its actor as ``actor_id``; the display label is extra."""
    by_event, _ = _scan()
    sites = by_event.get("project_calendar_changed", [])
    assert sites
    for keys, loc in sites:
        assert {"actor", "actor_id"} <= keys, f"project_calendar_changed @ {loc}: {sorted(keys)}"
