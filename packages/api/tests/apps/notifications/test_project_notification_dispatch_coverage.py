"""Every project-notification matrix row is classified, and only wired rows default ON (#2904).

Eight of the nine ``ProjectNotificationEventType`` members were defined, persisted,
rendered in the settings matrix, defaulted **ON** across in-app, email and Slack —
and dispatched by nothing. ``grep -rn "ProjectNotificationEventType\\."`` over the
API source returned exactly one consumer outside the model file. No TODO and no
issue number was attached anywhere.

Because eight rows defaulted ON, the settings page actively told an admin that
eight kinds of notification were being delivered. Turning one *off* was the only
action that appeared to mean anything, and it had no effect either.

These tests pin the classification, not the delivery. Wiring the dispatchers is
#3016. What is enforced here is that nobody can add a member to the matrix without
deciding which side of the line it is on, and that a row cannot default ON until
something actually dispatches it — so the surface can never silently start lying
again.
"""

from __future__ import annotations

import ast
import pathlib

import pytest

from trueppm_api.apps.notifications.models import (
    PROJECT_NOTIFICATION_DEFAULT_MATRIX,
    PROJECT_NOTIFICATION_DISPATCHED_EVENTS,
    PROJECT_NOTIFICATION_UNDISPATCHED_EVENTS,
    ProjectNotificationEventType,
)

API_SRC = pathlib.Path(__file__).resolve().parents[3] / "src" / "trueppm_api"
MODEL_FILE = API_SRC / "apps" / "notifications" / "models.py"


def test_the_two_sets_cover_the_enum_exactly() -> None:
    """A new member must be classified — it cannot slip in unclassified."""
    declared = PROJECT_NOTIFICATION_DISPATCHED_EVENTS | PROJECT_NOTIFICATION_UNDISPATCHED_EVENTS
    enum_values = {member.value for member in ProjectNotificationEventType}

    assert declared == enum_values, (
        "Every ProjectNotificationEventType member must be declared either dispatched "
        "or not-yet-dispatched. Unclassified: "
        f"{sorted(enum_values - declared)}; stale: {sorted(declared - enum_values)}"
    )


def test_the_two_sets_are_disjoint() -> None:
    assert not (PROJECT_NOTIFICATION_DISPATCHED_EVENTS & PROJECT_NOTIFICATION_UNDISPATCHED_EVENTS)


def test_the_default_matrix_covers_the_enum_exactly() -> None:
    enum_values = {member.value for member in ProjectNotificationEventType}
    assert set(PROJECT_NOTIFICATION_DEFAULT_MATRIX) == enum_values


@pytest.mark.parametrize("event", sorted(PROJECT_NOTIFICATION_UNDISPATCHED_EVENTS))
def test_an_undispatched_event_defaults_off_on_every_channel(event: str) -> None:
    """The load-bearing assertion. A default of ``True`` is a claim that something
    will be delivered; for these rows nothing is. Flip a row back to ON in the same
    change that wires its dispatcher (#3016)."""
    row = PROJECT_NOTIFICATION_DEFAULT_MATRIX[event]

    assert row, f"{event} has no default row at all"
    enabled = sorted(channel for channel, on in row.items() if on)
    assert not enabled, (
        f"{event} is declared undispatched but defaults ON for {enabled}. Either wire "
        "its dispatcher and move it to PROJECT_NOTIFICATION_DISPATCHED_EVENTS, or "
        "leave the default OFF — the settings matrix must not promise a delivery "
        "that never happens."
    )


def _enum_members_referenced_outside_the_model() -> set[str]:
    """``ProjectNotificationEventType.X`` attribute reads across the API source.

    An AST walk rather than a grep so a mention inside a comment or docstring — of
    which this codebase has several, deliberately — cannot be mistaken for a
    consumer. The model file itself is excluded: defining and defaulting a member
    is not dispatching it, which is the entire defect.
    """
    referenced: set[str] = set()
    for path in API_SRC.rglob("*.py"):
        if path == MODEL_FILE or "/migrations/" in str(path):
            continue
        try:
            tree = ast.parse(path.read_text())
        except SyntaxError:  # pragma: no cover
            continue
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Attribute)
                and isinstance(node.value, ast.Name)
                and node.value.id == "ProjectNotificationEventType"
            ):
                referenced.add(node.attr)
    return referenced


def test_a_dispatched_event_is_actually_referenced_in_the_source() -> None:
    """A DISPATCHED claim must be visible in the code, not just asserted here —
    otherwise the classification could rot into the same fiction it replaced."""
    referenced = _enum_members_referenced_outside_the_model()
    by_value = {m.value: m.name for m in ProjectNotificationEventType}

    for event in sorted(PROJECT_NOTIFICATION_DISPATCHED_EVENTS):
        assert by_value[event] in referenced, (
            f"{event} is declared dispatched but ProjectNotificationEventType."
            f"{by_value[event]} is referenced nowhere outside the model"
        )


def test_undispatched_events_are_referenced_nowhere() -> None:
    """The other direction: if one of these gains a real consumer, this fails and
    prompts moving it to the dispatched set (and re-deciding its default)."""
    referenced = _enum_members_referenced_outside_the_model()
    by_value = {m.value: m.name for m in ProjectNotificationEventType}

    unexpected = sorted(
        event for event in PROJECT_NOTIFICATION_UNDISPATCHED_EVENTS if by_value[event] in referenced
    )
    assert not unexpected, (
        f"{unexpected} now have a consumer in the source but are still declared "
        "undispatched — move them to PROJECT_NOTIFICATION_DISPATCHED_EVENTS and "
        "decide whether their default should become ON."
    )
