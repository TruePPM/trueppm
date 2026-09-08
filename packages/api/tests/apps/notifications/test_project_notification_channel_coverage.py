"""Every matrix *column* is classified, and only deliverable ones default ON (#3378).

The per-row twin of ``test_project_notification_dispatch_coverage``. #2904 fixed the
event axis and left the channel axis unguarded: ``slack`` and ``mobile_push`` were
rendered as columns, ``comment_mention`` defaulted them **ON**, and nothing anywhere
in ``apps/notifications`` sends to either. The settings page therefore told a member
that a mention would reach their Slack, and the copy explained the gap as "the
integration is not configured" — there is nothing to configure.

``PROJECT_NOTIFICATION_DELIVERABLE_CHANNELS`` is a literal rather than a projection
of ADR-0049's ``NOTIFICATION_CHANNELS`` registry, because that registry is the
account-wide ``NotificationPreference.channel`` vocabulary and whether the two axes
converge is #3252's open question. These tests are what keeps the literal honest:
the two sets must cover the enum exactly, and a channel declared undeliverable must
be referenced by no dispatch site — so it cannot rot into the fiction it replaced.
"""

from __future__ import annotations

import ast
import functools
import pathlib

import pytest

from trueppm_api.apps.notifications.models import (
    PROJECT_NOTIFICATION_DEFAULT_MATRIX,
    PROJECT_NOTIFICATION_DELIVERABLE_CHANNELS,
    PROJECT_NOTIFICATION_DISPATCHED_EVENTS,
    PROJECT_NOTIFICATION_UNDELIVERABLE_CHANNELS,
    ProjectNotificationChannel,
    ProjectNotificationEventType,
    project_notification_channel_delivery,
)

API_SRC = pathlib.Path(__file__).resolve().parents[3] / "src" / "trueppm_api"
MODEL_FILE = API_SRC / "apps" / "notifications" / "models.py"


def test_the_two_sets_cover_the_enum_exactly() -> None:
    """A new column must be classified — it cannot slip in unclassified."""
    declared = (
        PROJECT_NOTIFICATION_DELIVERABLE_CHANNELS | PROJECT_NOTIFICATION_UNDELIVERABLE_CHANNELS
    )
    enum_values = {member.value for member in ProjectNotificationChannel}

    assert declared == enum_values, (
        "Every ProjectNotificationChannel member must be declared either deliverable "
        "or not-yet-deliverable. Unclassified: "
        f"{sorted(enum_values - declared)}; stale: {sorted(declared - enum_values)}"
    )


def test_there_is_something_for_the_column_guards_to_guard() -> None:
    """Empty this set and every parametrized guard in this module collects **zero**
    items — pytest reports no failure and no skip, just silence. Delete this test in
    the same change that legitimately empties it (i.e. when every column delivers)."""
    assert PROJECT_NOTIFICATION_UNDELIVERABLE_CHANNELS


def test_the_two_sets_are_disjoint() -> None:
    assert not (
        PROJECT_NOTIFICATION_DELIVERABLE_CHANNELS & PROJECT_NOTIFICATION_UNDELIVERABLE_CHANNELS
    )


def test_channel_delivery_reports_one_boolean_per_column() -> None:
    delivery = project_notification_channel_delivery()

    assert set(delivery) == {member.value for member in ProjectNotificationChannel}
    for channel in sorted(PROJECT_NOTIFICATION_DELIVERABLE_CHANNELS):
        assert delivery[channel] is True
    for channel in sorted(PROJECT_NOTIFICATION_UNDELIVERABLE_CHANNELS):
        assert delivery[channel] is False


@pytest.mark.parametrize("channel", sorted(PROJECT_NOTIFICATION_UNDELIVERABLE_CHANNELS))
def test_an_undeliverable_channel_defaults_off_on_every_event(channel: str) -> None:
    """The load-bearing assertion, and the one #2904's event-axis guard could not make.

    ``comment_mention`` is dispatched, so the event guard passes it — and it still
    defaulted Slack and mobile push ON, which is a claim that a mention will arrive
    somewhere it cannot. Flip a column back to ON in the same change that ships its
    delivery (#3252).
    """
    on_for = sorted(
        event for event, row in PROJECT_NOTIFICATION_DEFAULT_MATRIX.items() if row.get(channel)
    )

    assert not on_for, (
        f"{channel} is declared undeliverable but defaults ON for {on_for}. Either "
        "ship its delivery and move it to PROJECT_NOTIFICATION_DELIVERABLE_CHANNELS, "
        "or leave the default OFF — the settings matrix must not promise a delivery "
        "that never happens."
    )


def test_a_default_on_cell_needs_both_axes() -> None:
    """The rule stated whole: ON requires a dispatched event AND a delivering channel.

    Asserted over the matrix rather than per-axis because the two guards passing
    separately is exactly how ``comment_mention``/``slack`` survived — the event was
    dispatched, so nothing looked at the channel.
    """
    checked = 0
    for event, row in PROJECT_NOTIFICATION_DEFAULT_MATRIX.items():
        for channel, enabled in row.items():
            if not enabled:
                continue
            checked += 1
            assert event in PROJECT_NOTIFICATION_DISPATCHED_EVENTS, (
                f"{event}/{channel} defaults ON but {event} is dispatched by nothing"
            )
            assert channel in PROJECT_NOTIFICATION_DELIVERABLE_CHANNELS, (
                f"{event}/{channel} defaults ON but nothing delivers on {channel}"
            )

    # This whole change flips defaults OFF, so an all-off matrix is a plausible next
    # step — and it would make the loop above assert nothing while still passing.
    assert checked, (
        "No cell in PROJECT_NOTIFICATION_DEFAULT_MATRIX defaults ON, so this test "
        "asserted nothing. Either the matrix regressed to all-off, or all-off is "
        "deliberate and this guard needs rewriting rather than passing silently."
    )


@functools.cache
def _channel_members_referenced_outside_the_model() -> set[str]:
    """``ProjectNotificationChannel.X`` attribute reads across the API source.

    An AST walk rather than a grep so a mention inside a comment or docstring — of
    which this codebase has several, deliberately — cannot be mistaken for a
    consumer. The model file itself is excluded: declaring a column and defaulting
    it is not delivering on it, which is the entire defect.

    Covers the ``ProjectNotificationChannel.X`` **attribute** form only. A dispatcher
    naming a channel by bare string literal (``should_deliver(..., "slack")`` — the
    signature takes ``channel: str``) or through an aliased import would slip past.
    House style is the attribute form and every real dispatch site uses it, so this
    is a residual hole rather than a live one; widen the walk if that changes.

    Cached: the walk is ~1s over 393 files, and every caller wants the same answer
    for the same tree.
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
                and node.value.id == "ProjectNotificationChannel"
            ):
                referenced.add(node.attr)
    return referenced


#: The walk's known-good denominator — the two members it does find today, both from
#: the ``_*_EXEMPT_CHANNELS`` literals in ``services.py``. Zero would make the guard
#: below pass forever.
_KNOWN_CHANNEL_CONSUMERS = frozenset({"IN_APP", "EMAIL"})


def test_the_reference_walk_still_sees_the_known_consumers() -> None:
    """Non-zero denominator for the guard below — the guard's own vacuity check.

    The walk resolves ``ProjectNotificationChannel.X`` attribute reads only, and today
    finds exactly two, both in one file. Aliasing the import or moving those literals
    silently zeroes it, and the guard below then passes on any tree at all. That
    matters more here than usual: the delivery gate has no channel-axis check (see
    :func:`test_the_delivery_gate_is_blind_to_the_channel_axis`), so this walk is the
    only thing holding the line.
    """
    referenced = _channel_members_referenced_outside_the_model()
    missing = sorted(_KNOWN_CHANNEL_CONSUMERS - referenced)

    assert not missing, (
        f"The AST walk found no ProjectNotificationChannel.{missing} reference "
        "outside models.py. Fix the walk before touching these sets, or "
        "test_an_undeliverable_channel_is_referenced_nowhere asserts nothing."
    )


def test_an_undeliverable_channel_is_referenced_nowhere() -> None:
    """If one of these gains a real consumer, this fails and prompts moving it to
    PROJECT_NOTIFICATION_DELIVERABLE_CHANNELS (and re-deciding its defaults)."""
    referenced = _channel_members_referenced_outside_the_model()
    by_value = {m.value: m.name for m in ProjectNotificationChannel}

    unexpected = sorted(
        channel
        for channel in PROJECT_NOTIFICATION_UNDELIVERABLE_CHANNELS
        if by_value[channel] in referenced
    )
    assert not unexpected, (
        f"{unexpected} now have a consumer in the source but are still declared "
        "undeliverable — move them to PROJECT_NOTIFICATION_DELIVERABLE_CHANNELS and "
        "decide whether their defaults should become ON."
    )


def test_the_quiet_hours_gate_treats_every_undeliverable_channel_as_transient() -> None:
    """What the exemption sets pin, stated the way round they actually run.

    Being *in* an exemption set means quiet hours does NOT silence that channel, so
    this asserts the undeliverable columns stay on the silenced side — the permissive
    direction, and the one a future change would break by exempting Slack.

    It deliberately does **not** claim to cover #3378's ``services.py`` change: that
    was a comment rewrite (the old text named Slack and mobile push among the
    channels quiet hours silences, which reads as a claim they otherwise deliver),
    and no assertion can see a comment. What actually keeps an undeliverable column
    inert is the absence of a caller — see
    :func:`test_the_delivery_gate_is_blind_to_the_channel_axis` for why that is the
    load-bearing fact, and ``test_an_undeliverable_channel_is_referenced_nowhere``
    for the guard on it.
    """
    from trueppm_api.apps.notifications.services import (
        _DND_EXEMPT_CHANNELS,
        _QUIET_HOURS_EXEMPT_CHANNELS,
    )

    for exempt in (_QUIET_HOURS_EXEMPT_CHANNELS, _DND_EXEMPT_CHANNELS):
        assert not (exempt & PROJECT_NOTIFICATION_UNDELIVERABLE_CHANNELS)


@pytest.mark.parametrize("channel", sorted(PROJECT_NOTIFICATION_UNDELIVERABLE_CHANNELS))
def test_the_delivery_gate_is_blind_to_the_channel_axis(channel: str) -> None:
    """Pins the assumption every other guard in this file rests on.

    ``_preference_allows`` checks ``paused``, the matrix cell and quiet hours. It has
    no notion of a delivery path, so a member who stored ``slack: True`` on the one
    dispatched event gets ``True`` back — the ONLY thing keeping that column inert is
    that no caller passes ``"slack"``.

    That relationship was stated in prose and asserted nowhere. If this ever returns
    False the gate grew a channel-axis check, and
    ``test_an_undeliverable_channel_is_referenced_nowhere`` drops from load-bearing
    to belt-and-braces — say so in its docstring in the same change.
    """
    import datetime
    from zoneinfo import ZoneInfo

    from trueppm_api.apps.notifications.models import ProjectNotificationPreference
    from trueppm_api.apps.notifications.services import _preference_allows

    pref = ProjectNotificationPreference(
        matrix={ProjectNotificationEventType.COMMENT_MENTION.value: {channel: True}},
        quiet_hours_enabled=False,
    )

    assert (
        _preference_allows(
            pref,
            event_type=ProjectNotificationEventType.COMMENT_MENTION.value,
            channel=channel,
            now=datetime.datetime(2026, 6, 1, 12, 0, tzinfo=datetime.UTC),
            tz=ZoneInfo("UTC"),
        )
        is True
    ), (
        f"{channel} no longer passes the delivery gate — if the gate now checks "
        "PROJECT_NOTIFICATION_DELIVERABLE_CHANNELS, delete this test and downgrade "
        "the AST guard's docstring."
    )
