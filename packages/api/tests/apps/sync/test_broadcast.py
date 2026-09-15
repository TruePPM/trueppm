"""Tests for evict_project_connection (#813) — the push-based WS eviction helper.

The consumer-side connection_evict handler is covered in test_consumers.py; this
file covers the broadcast helper that pushes the evict to the board group,
including its best-effort failure handling.
"""

from __future__ import annotations

import pathlib
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest

from trueppm_api.apps.sync.broadcast import (
    abroadcast_board_event,
    broadcast_board_event,
    evict_project_connection,
)

from .ws_event_scan import (
    ScanError,
    Waiver,
    WaiverLedger,
    broadcast_event_types_in_source,
    evaluate,
    handler_registrations_in_source,
)
from .ws_handler_waivers import LEDGER

# The frontend registration table this file's conformance gate reads (#3775).
_WEB_WS_HOOK = pathlib.Path(__file__).resolve().parents[4] / "web/src/hooks/useProjectWebSocket.ts"

_GET_LAYER = "channels.layers.get_channel_layer"


class _FakeChannelLayer:
    """Records group_send calls instead of touching a real channel backend."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, dict[str, Any]]] = []

    async def group_send(self, group: str, message: dict[str, Any]) -> None:
        self.sent.append((group, message))


def test_evict_sends_to_board_group() -> None:
    layer = _FakeChannelLayer()
    with patch(_GET_LAYER, return_value=layer):
        evict_project_connection("p1", "u9")
    assert layer.sent == [
        ("project_p1", {"type": "connection.evict", "user_id": "u9"}),
    ]


def test_evict_is_noop_when_no_channel_layer_configured() -> None:
    # No layer (e.g. layers disabled in a worker) → log + return, never raise.
    with patch(_GET_LAYER, return_value=None):
        evict_project_connection("p1", "u9")


def test_evict_swallows_group_send_failure() -> None:
    """Best-effort like broadcast_board_event: a layer error is logged, not raised."""

    class _BoomLayer:
        async def group_send(self, group: str, message: dict[str, Any]) -> None:
            raise RuntimeError("channel layer down")

    with patch(_GET_LAYER, return_value=_BoomLayer()):
        evict_project_connection("p1", "u9")


# ---------------------------------------------------------------------------
# abroadcast_board_event (#958) — async-native broadcast for event-loop callers
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_abroadcast_awaits_group_send_with_board_envelope() -> None:
    """The async helper awaits group_send directly with the flat board.event shape."""
    layer = _FakeChannelLayer()
    with patch(_GET_LAYER, return_value=layer):
        await abroadcast_board_event("p1", "presence_join", {"user_id": "u9"})
    assert layer.sent == [
        (
            "project_p1",
            {
                "type": "board.event",
                "protocol_version": 1,
                "event_type": "presence_join",
                "payload": {"user_id": "u9"},
                # presence_join is ephemeral → not persisted → no replay sequence.
                "seq": None,
            },
        )
    ]


@pytest.mark.asyncio
async def test_abroadcast_is_noop_when_no_channel_layer_configured() -> None:
    with patch(_GET_LAYER, return_value=None):
        await abroadcast_board_event("p1", "presence_join", {"user_id": "u9"})


@pytest.mark.asyncio
async def test_abroadcast_swallows_group_send_failure() -> None:
    """Best-effort like the sync helper: a layer error is logged, not raised."""

    class _BoomLayer:
        async def group_send(self, group: str, message: dict[str, Any]) -> None:
            raise RuntimeError("channel layer down")

    with patch(_GET_LAYER, return_value=_BoomLayer()):
        await abroadcast_board_event("p1", "presence_join", {"user_id": "u9"})


# ---------------------------------------------------------------------------
# BoardEvent replay-buffer persistence (ADR-0236, #321)
# ---------------------------------------------------------------------------


@pytest.fixture
def replay_project(db: object) -> Any:
    """A real Project so BoardEvent's FK insert succeeds."""
    from trueppm_api.apps.projects.models import Calendar, Project

    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(
        name="Replay Proj", start_date=date(2026, 1, 1), calendar=calendar
    )


@pytest.mark.django_db
def test_broadcast_persists_boardevent_with_seq_in_payload(replay_project: Any) -> None:
    """A replayable broadcast writes a BoardEvent row and rides its seq on the wire."""
    from trueppm_api.apps.sync.models import BoardEvent

    layer = _FakeChannelLayer()
    with patch(_GET_LAYER, return_value=layer):
        broadcast_board_event(str(replay_project.pk), "task_created", {"id": "t1"})

    row = BoardEvent.objects.get(project_id=replay_project.pk, event_type="task_created")
    assert row.payload == {"id": "t1"}
    # The live envelope carries the persisted row's sequence (its PK).
    _group, message = layer.sent[0]
    assert message["seq"] == row.pk
    assert message["event_type"] == "task_created"


@pytest.mark.django_db
def test_broadcast_sequence_is_monotonic_per_project(replay_project: Any) -> None:
    """Successive persisted events get strictly increasing sequences (ADR-0236)."""
    from trueppm_api.apps.sync.models import BoardEvent

    layer = _FakeChannelLayer()
    with patch(_GET_LAYER, return_value=layer):
        broadcast_board_event(str(replay_project.pk), "task_created", {"id": "t1"})
        broadcast_board_event(str(replay_project.pk), "task_updated", {"id": "t1"})
        broadcast_board_event(str(replay_project.pk), "task_deleted", {"id": "t1"})

    seqs = [msg["seq"] for _g, msg in layer.sent]
    assert seqs == sorted(seqs) and len(set(seqs)) == 3
    assert BoardEvent.objects.filter(project_id=replay_project.pk).count() == 3


@pytest.mark.django_db
def test_broadcast_does_not_persist_ephemeral_events(replay_project: Any) -> None:
    """Ephemeral events (task_run progress) broadcast live but are never buffered."""
    from trueppm_api.apps.sync.models import BoardEvent

    layer = _FakeChannelLayer()
    with patch(_GET_LAYER, return_value=layer):
        broadcast_board_event(
            str(replay_project.pk), "task_run_progress", {"task_run_id": "r1", "pct": 40}
        )

    assert BoardEvent.objects.filter(project_id=replay_project.pk).count() == 0
    # Still broadcast live, just with no replay sequence.
    _group, message = layer.sent[0]
    assert message["event_type"] == "task_run_progress"
    assert message["seq"] is None


@pytest.mark.django_db
def test_project_hard_deleted_is_not_persisted(replay_project: Any) -> None:
    """project_hard_deleted fires after the project row is gone — persisting it would
    dangle the FK (the DEFERRABLE check surfaces at COMMIT, past the try/except), so
    it must be denylisted. Regression for the CI FK-violation on project hard-delete."""
    from trueppm_api.apps.sync.models import BoardEvent

    layer = _FakeChannelLayer()
    with patch(_GET_LAYER, return_value=layer):
        broadcast_board_event(
            str(replay_project.pk), "project_hard_deleted", {"id": str(replay_project.pk)}
        )

    assert BoardEvent.objects.filter(project_id=replay_project.pk).count() == 0
    _group, message = layer.sent[0]
    assert message["event_type"] == "project_hard_deleted"
    assert message["seq"] is None  # not buffered → no replay sequence


@pytest.mark.django_db
@pytest.mark.parametrize(
    "event_type",
    [
        "program_split",
        "program_deleted",
        "program_closed",
        "program_reopened",
        "program_sponsorship_transferred",
    ],
)
def test_program_scoped_events_are_not_persisted(event_type: str) -> None:
    """Program lifecycle events fan out on a *program*'s WS group, passing the Program
    pk as project_id. A Program pk is never a projects.Project pk, so persisting a
    BoardEvent for one always violates the Project FK at COMMIT → unhandled 500 (#2126).
    They must be denylisted like project_hard_deleted: broadcast live, never buffered,
    and — critically — never attempt the FK insert. Using a random uuid (no Project row)
    proves no insert is issued (an insert would raise, not merely miss)."""
    import uuid

    from trueppm_api.apps.sync.models import BoardEvent

    program_id = str(uuid.uuid4())  # deliberately NOT a Project pk
    layer = _FakeChannelLayer()
    with patch(_GET_LAYER, return_value=layer):
        # Must not raise IntegrityError despite program_id having no Project row.
        broadcast_board_event(program_id, event_type, {"id": program_id})

    assert BoardEvent.objects.filter(project_id=program_id).count() == 0
    _group, message = layer.sent[0]
    assert message["event_type"] == event_type
    assert message["seq"] is None  # not buffered → no replay sequence


@pytest.mark.django_db
def test_broadcast_swallows_persist_failure_and_still_sends(replay_project: Any) -> None:
    """A BoardEvent insert failure is logged, not raised; the live event still goes out."""
    layer = _FakeChannelLayer()
    with (
        patch(_GET_LAYER, return_value=layer),
        patch(
            "trueppm_api.apps.sync.models.BoardEvent.objects.create",
            side_effect=__import__("django.db", fromlist=["DatabaseError"]).DatabaseError("boom"),
        ),
    ):
        broadcast_board_event(str(replay_project.pk), "task_created", {"id": "t1"})

    _group, message = layer.sent[0]
    assert message["event_type"] == "task_created"
    assert message["seq"] is None  # persistence failed → no sequence, best-effort


# ---------------------------------------------------------------------------
# Broadcast metric (#1900) — trueppm.ws.broadcast.count is bumped once per fan-out.
# ---------------------------------------------------------------------------


def _broadcast_count(reader: Any) -> float:
    """Read the summed trueppm.ws.broadcast.count value from an in-memory reader."""
    data = reader.get_metrics_data()
    for resource_metric in data.resource_metrics:
        for scope_metric in resource_metric.scope_metrics:
            for metric in scope_metric.metrics:
                if metric.name == "trueppm.ws.broadcast.count":
                    return sum(point.value for point in metric.data.data_points)
    return 0.0


@pytest.mark.django_db
def test_broadcast_increments_ws_broadcast_counter(replay_project: Any) -> None:
    """A successful fan-out bumps trueppm.ws.broadcast.count exactly once (#1900)."""
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import InMemoryMetricReader

    from trueppm_api.apps.observability import otel
    from trueppm_api.apps.observability.otel import metrics
    from trueppm_api.apps.observability.otel.provider import OTelBootstrapContext

    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader])
    ctx = OTelBootstrapContext(
        schema_version=1,
        enabled=True,
        edition="community",
        resource=None,
        tracer_provider=None,
        meter_provider=provider,
    )

    metrics.reset_for_testing()
    try:
        otel.install_metrics(ctx, meter_provider=provider)
        layer = _FakeChannelLayer()
        with patch(_GET_LAYER, return_value=layer):
            broadcast_board_event(str(replay_project.pk), "task_created", {"id": "t1"})
        assert _broadcast_count(reader) == 1
    finally:
        metrics.reset_for_testing()


@pytest.mark.django_db
def test_failed_broadcast_does_not_increment_counter(replay_project: Any) -> None:
    """A group_send failure is not counted — the metric rides the successful send only."""
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import InMemoryMetricReader

    from trueppm_api.apps.observability import otel
    from trueppm_api.apps.observability.otel import metrics
    from trueppm_api.apps.observability.otel.provider import OTelBootstrapContext

    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader])
    ctx = OTelBootstrapContext(
        schema_version=1,
        enabled=True,
        edition="community",
        resource=None,
        tracer_provider=None,
        meter_provider=provider,
    )

    class _BoomLayer:
        async def group_send(self, group: str, message: dict[str, Any]) -> None:
            raise RuntimeError("channel layer down")

    metrics.reset_for_testing()
    try:
        otel.install_metrics(ctx, meter_provider=provider)
        with patch(_GET_LAYER, return_value=_BoomLayer()):
            broadcast_board_event(str(replay_project.pk), "task_created", {"id": "t1"})
        assert _broadcast_count(reader) == 0
    finally:
        metrics.reset_for_testing()


# ---------------------------------------------------------------------------
# WS event-type freeze (#1019) — the WebSocket analogue of test_event_type_cap.
#
# WS event types are scattered as string literals in broadcast_board_event() /
# abroadcast_board_event() call sites rather than centralized in an enum (unlike
# the webhook WebhookEventType cap). That makes the WS contract easy to drift: a
# new mutation can broadcast a brand-new event_type with no review gate. The
# 0.4 read-only MCP server and external integrators bind to this set, so it must
# freeze before launch. This test re-derives the live set by AST-scanning the
# source for the second positional (or event_type=) literal of those two helpers
# and asserts it equals the frozen list below. Adding or removing a broadcast
# event without updating FROZEN_WS_EVENT_TYPES fails loudly — the WS analogue of
# the webhook OSS_WEBHOOK_EVENT_CAP guard.
#
# Two call sites pass event_type as a *variable* (the inbound-sync relay and the
# generic services.py dispatcher), not a literal; they forward an already-frozen
# type and so are intentionally excluded — there is nothing to freeze there.
#
# The scanner also follows ONE level of wrapper indirection (#1381): a local
# function/method that forwards one of its *parameters* into the event_type slot
# of a helper (e.g. taskruns/tracker.py:_broadcast, projects/retro_board_services
# .py:_broadcast) is itself a broadcast site whose real event types live at its
# *call* sites as literals. Without this, a wrapper-emitted event (task_run_*,
# retro_item_*) silently escapes the freeze guard.
#
# The scanner itself moved to ws_event_scan.py in #3775 so the freeze guard and
# the event-to-frontend-handler conformance gate share ONE implementation of
# "what does the API broadcast". Two scanners answering that question separately
# is how the halves of a contract drift apart. FROZEN_WS_EVENT_TYPES stays here:
# scripts/check-ws-event-reachability.sh parses it out of this file by name.
# ---------------------------------------------------------------------------

FROZEN_WS_EVENT_TYPES = frozenset(
    {
        "api_token_minted",
        "api_token_revoked",
        "assignment_created",
        "assignment_deleted",
        "assignment_updated",
        "backlog_reranked",
        "baseline_activated",
        "baseline_created",
        "baseline_deleted",
        "board_config_updated",
        "board_view_created",
        "board_view_deleted",
        "board_view_updated",
        "comment_created",
        "cpm_complete",
        "cpm_error",
        "demo_presenter_set",
        "demo_reordered",
        "demo_toggled",
        "dependency_accepted",
        "dependencies_bulk_created",
        "dependency_created",
        "dependency_deleted",
        "dependency_rejected",
        "dependency_updated",
        "flagged_for_backlog",
        "guardrail_policy_updated",
        "label_created",
        "label_deleted",
        "label_updated",
        "member_added",
        "member_removed",
        "member_role_changed",
        "mention_group_changed",
        "milestone_forecast_updated",
        "milestone_rollup_updated",
        "phases_reordered",
        "poker_session_updated",
        "presence_join",
        "presence_leave",
        "retro_item_created",
        "retro_item_deleted",
        "retro_item_moved",
        "retro_item_updated",
        "program_closed",
        "program_deleted",
        "program_reopened",
        "program_split",
        "program_sponsorship_transferred",
        "project_archived",
        "project_calendar_changed",
        "project_created",
        "project_custom_fields_updated",
        "project_deleted",
        "project_hard_deleted",
        "project_restored",
        "project_transferred",
        "project_unarchived",
        "project_updated",
        "queue_reordered",
        "review_note_set",
        "risk_created",
        "risk_deleted",
        "risk_updated",
        "risks_imported",
        "roster_changed",
        "signal_ceiling_proposal_changed",
        "signal_ceiling_vote_cast",
        "signal_privacy_changed",
        "slip_conflict_acknowledged",
        "slip_conflicts_updated",
        "sprint_activated",
        "sprint_cancelled",
        "sprint_close_failed",
        "sprint_closed",
        "sprint_created",
        "sprint_deleted",
        "sprint_reranked",
        "sprint_retro_updated",
        "sprint_scope_changed",
        "sprint_updated",
        "suggestion_created",
        "suggestion_declined",
        "suggestion_revoked",
        "task_attachment_created",
        "task_attachment_deleted",
        "task_comment_ack_changed",
        "task_comment_created",
        "task_comment_deleted",
        "task_comment_reaction_added",
        "task_comment_reaction_removed",
        "task_comment_updated",
        "task_created",
        "task_dates_updated",
        "task_deleted",
        "task_duration_changed",
        "task_link_created",
        "task_link_deleted",
        "task_link_updated",
        "task_note_created",
        "task_note_decision_toggled",
        "task_note_deleted",
        "task_note_pinned",
        "task_note_updated",
        "task_relation_created",
        "task_relation_deleted",
        "task_relation_updated",
        "task_restored",
        "task_run_cancelled",
        "task_run_completed",
        "task_run_failed",
        "task_run_progress",
        "task_run_started",
        "task_updated",
        "tasks_bulk_mutated",
        "tasks_reordered",
        "tasks_restructured",
        "team_member_changed",
        "velocity_suggestion_accepted",
        "velocity_suggestion_dismissed",
    }
)


def _broadcast_event_types_in_source() -> set[str]:
    """Literal event types reaching the broadcast helpers, via the shared scanner.

    Delegates to ws_event_scan.broadcast_event_types_in_source (#3775) — the same
    sweep scripts/check-ws-handler-conformance.sh runs, so the freeze guard and
    the handler-conformance gate can never disagree about what the API emits. It
    discovers event types two ways: a string literal in the ``event_type`` slot of
    a ``broadcast_board_event`` / ``abroadcast_board_event`` call, and one level of
    wrapper indirection (#1381) — a local function that forwards one of its
    *parameters* into that slot, whose real types are the literals at the
    wrapper's own call sites (``taskruns/tracker.py:_broadcast``,
    ``retro_board_services.py:_broadcast``).
    """
    import trueppm_api

    return broadcast_event_types_in_source(pathlib.Path(trueppm_api.__file__).resolve().parent)


def test_ws_event_type_set_is_frozen() -> None:
    """The set of WS event types broadcast from source must match the frozen list.

    If this fails, a broadcast_board_event() / abroadcast_board_event() call added
    or removed a literal event_type. Update FROZEN_WS_EVENT_TYPES *and* the WS↔
    webhook taxonomy table in docs/api (packages/website/src/content/docs/api/
    websockets.md) in the same change — the WS contract is frozen for MCP/external
    consumers (#1019)."""
    live = _broadcast_event_types_in_source()
    missing = FROZEN_WS_EVENT_TYPES - live
    added = live - FROZEN_WS_EVENT_TYPES
    assert not missing, f"Frozen WS event types no longer broadcast in source: {sorted(missing)}"
    assert not added, f"New WS event types broadcast without freezing them: {sorted(added)}"


def test_wrapper_emitted_events_are_discovered_and_frozen() -> None:
    """Events emitted only through a one-level broadcast wrapper are still frozen (#1381).

    ``task_run_*`` (taskruns/tracker.py:_broadcast) and ``retro_item_*``
    (retro_board_services.py:_broadcast) reach broadcast_board_event with a
    *variable* event_type, so the scanner must follow the wrapper to its call
    sites to find their literals. This guards both halves: the scanner discovers
    them, and they are in the frozen set."""
    wrapper_emitted = {
        "task_run_started",
        "task_run_progress",
        "task_run_completed",
        "task_run_failed",
        "task_run_cancelled",
        "retro_item_created",
        "retro_item_updated",
        "retro_item_moved",
        "retro_item_deleted",
    }
    live = _broadcast_event_types_in_source()
    undiscovered = wrapper_emitted - live
    assert not undiscovered, (
        "Wrapper-emitted WS events not discovered by the scanner — wrapper "
        f"indirection regressed: {sorted(undiscovered)}"
    )
    assert wrapper_emitted <= FROZEN_WS_EVENT_TYPES


# ---------------------------------------------------------------------------
# WS event → frontend handler conformance (#3775, proposed in #2845).
#
# The freeze guard above proves the API's event set did not move. It says nothing
# about whether anything on the client CONSUMES an event, and nothing did check
# that: #2847, #3245 and the 0.4 pre-release pass each found a different slice of
# "broadcast correctly, handled nowhere" because the only mechanism was convention
# plus review.
#
# These tests run the same evaluator as the lint:ws-handler-conformance CI job
# (scripts/check-ws-handler-conformance.sh), over the same shared scanner. The job
# exists as well as these tests because api:test is gated on
# `changes: packages/api/**` — deleting a handler is a WEB-only diff, which these
# tests would never see.
#
# The negative controls below are the point. A conformance test that only passes
# on the current tree proves nothing about whether it can fail; a scanner that
# quietly matches nothing is the failure mode this gate exists to prevent.
# ---------------------------------------------------------------------------


def _ledger(
    unhandled: dict[str, Waiver] | None = None,
    unemitted: dict[str, Waiver] | None = None,
) -> WaiverLedger:
    """A ledger whose budgets match its contents, so a case tests one thing."""
    unhandled = unhandled or {}
    unemitted = unemitted or {}
    return WaiverLedger(
        unhandled=unhandled,
        unemitted=unemitted,
        unhandled_budget=len(unhandled),
        unemitted_budget=len(unemitted),
    )


def _fixture_tree(tmp_path: pathlib.Path, api_body: str, ts_body: str) -> tuple[Any, Any]:
    api_src = tmp_path / "api"
    api_src.mkdir()
    (api_src / "views.py").write_text(api_body, encoding="utf-8")
    ts_path = tmp_path / "hook.ts"
    ts_path.write_text(ts_body, encoding="utf-8")
    return api_src, ts_path


_EMIT_TWO = (
    'def a(self):\n    broadcast_board_event(project_id, "alpha_happened", {})\n\n\n'
    'def b(self):\n    broadcast_board_event(project_id, "beta_happened", {})\n'
)


def test_every_broadcast_event_has_a_frontend_handler_or_a_waiver() -> None:
    """The live tree: every emitted WS event is handled, or waived with an issue.

    If this fails with `emitted-no-handler`, a new broadcast landed with no
    consumer in packages/web/src/hooks/useProjectWebSocket.ts. Wire the handler,
    or — if the omission is deliberate or the event is structurally undeliverable
    — add an entry to ws_handler_waivers.py with a reason and the issue number
    that removes it, and raise that budget by one in the same diff.
    """
    violations = evaluate(
        pathlib.Path(__import__("trueppm_api").__file__).resolve().parent, _WEB_WS_HOOK, LEDGER
    )
    assert not violations, "\n".join(v.render() for v in violations)


def test_gate_fails_on_an_emitted_event_with_no_handler(tmp_path: pathlib.Path) -> None:
    """NEGATIVE CONTROL — the exact defect #2847/#3245/the 0.4 pass each re-found.

    Without this the suite could not tell a working gate from an inert one: a
    conformance test that has only ever been run against a conformant tree never
    executes its detection path.
    """
    api_src, ts_path = _fixture_tree(tmp_path, _EMIT_TWO, "on('alpha_happened', () => {});\n")
    violations = evaluate(api_src, ts_path, _ledger())
    assert [(v.kind, v.subject) for v in violations] == [("emitted-no-handler", "beta_happened")]

    # ...and the same tree passes once the gap is waived.
    waived = _ledger({"beta_happened": Waiver(reason="tracked", issue=2847)})
    assert evaluate(api_src, ts_path, waived) == []


def test_gate_fails_on_a_wrapper_emitted_event_with_no_handler(tmp_path: pathlib.Path) -> None:
    """The #1381 wrapper indirection reaches the conformance half too.

    An event emitted only through a parameter-forwarding helper (task_run_*,
    retro_item_*) is invisible to a scanner that looks only at direct literals —
    it would read as "not emitted" and silently need no handler.
    """
    api_src, ts_path = _fixture_tree(
        tmp_path,
        "def _broadcast(self, event_type, payload):\n"
        "    broadcast_board_event(self.project_id, event_type, payload)\n\n\n"
        'def run(self):\n    self._broadcast("wrapped_only", {})\n',
        "on('something_else', () => {});\n",
    )
    kinds = {(v.kind, v.subject) for v in evaluate(api_src, ts_path, _ledger())}
    assert ("emitted-no-handler", "wrapped_only") in kinds


def test_gate_fails_on_a_duplicate_handler_registration(tmp_path: pathlib.Path) -> None:
    """`on()` is last-write-wins, so a second registration is silent dead code.

    `eventHandlers[type] = handler` overwrites rather than appending — the hook's
    own comments warn about this twice — so a duplicate is a real defect, not a
    style nit, and must not be collapsed by a `set()` on the way in.
    """
    api_src, ts_path = _fixture_tree(
        tmp_path,
        _EMIT_TWO,
        "on('alpha_happened', () => {});\non(['beta_happened', 'alpha_happened'], () => {});\n",
    )
    assert [(v.kind, v.subject) for v in evaluate(api_src, ts_path, _ledger())] == [
        ("duplicate-registration", "alpha_happened")
    ]


def test_waiver_ledger_is_shrink_only(tmp_path: pathlib.Path) -> None:
    """The ratchet: a waiver whose gap has closed fails until it is deleted.

    Both staleness directions, plus the budget line that makes an *addition*
    visible in review. Without these a ledger only ever grows, which is how a
    waiver list becomes a permanent exemption list.
    """
    api_src, ts_path = _fixture_tree(
        tmp_path, _EMIT_TWO, "on(['alpha_happened', 'beta_happened'], () => {});\n"
    )
    # The handler landed; the waiver did not come off.
    stale = _ledger({"beta_happened": Waiver(reason="tracked", issue=2847)})
    assert [(v.kind, v.subject) for v in evaluate(api_src, ts_path, stale)] == [
        ("stale-waiver", "beta_happened")
    ]
    # A waiver for an event the API no longer broadcasts at all.
    ghost = _ledger({"ghost_event": Waiver(reason="tracked", issue=1)})
    assert [(v.kind, v.subject) for v in evaluate(api_src, ts_path, ghost)] == [
        ("stale-waiver", "ghost_event")
    ]
    # An entry added without the budget line a reviewer reads.
    unbudgeted = WaiverLedger(
        unhandled={"beta_happened": Waiver(reason="tracked", issue=2847)},
        unemitted={},
        unhandled_budget=0,
        unemitted_budget=0,
    )
    assert any(v.kind == "waiver-budget" for v in evaluate(api_src, ts_path, unbudgeted))
    # A waiver with no issue, or no reason, is a bug waiting to be re-found.
    no_issue = _ledger({"beta_happened": Waiver(reason="tracked", issue=0)})
    assert any(v.kind == "waiver-no-issue" for v in evaluate(api_src, ts_path, no_issue))
    no_reason = _ledger({"beta_happened": Waiver(reason="   ", issue=2847)})
    assert any(v.kind == "waiver-no-reason" for v in evaluate(api_src, ts_path, no_reason))
    # The reverse-direction ledger is held to the same shape, not just the forward one.
    reverse = WaiverLedger(
        unhandled={},
        unemitted={"never_emitted": Waiver(reason="", issue=0)},
        unhandled_budget=0,
        unemitted_budget=0,
    )
    kinds = {v.kind for v in evaluate(api_src, ts_path, reverse)}
    assert {"waiver-no-issue", "waiver-no-reason", "waiver-budget"} <= kinds


def test_gate_fails_on_a_handler_for_an_event_nothing_emits(tmp_path: pathlib.Path) -> None:
    """Reverse direction — a registration for an event no call site broadcasts."""
    api_src, ts_path = _fixture_tree(
        tmp_path,
        _EMIT_TWO,
        "on(['alpha_happened', 'beta_happened', 'never_emitted'], () => {});\n",
    )
    assert [(v.kind, v.subject) for v in evaluate(api_src, ts_path, _ledger())] == [
        ("handler-no-emitter", "never_emitted")
    ]


def test_a_commented_out_registration_is_not_a_handler(tmp_path: pathlib.Path) -> None:
    """Prose naming an event is not coverage.

    useProjectWebSocket.ts opens with a doc block that names most of the event
    types in sentences. A scanner that did not strip comments would read those as
    registrations and pass on a genuinely unhandled event — a gate reporting OK
    because it matched the documentation instead of the code.
    """
    api_src, ts_path = _fixture_tree(
        tmp_path,
        _EMIT_TWO,
        "// beta_happened is described here\n"
        "/* on(['beta_happened'], () => {}); */\n"
        "on('alpha_happened', () => {});\n",
    )
    assert [(v.kind, v.subject) for v in evaluate(api_src, ts_path, _ledger())] == [
        ("emitted-no-handler", "beta_happened")
    ]


def test_an_on_call_inside_a_string_literal_is_not_a_handler(tmp_path: pathlib.Path) -> None:
    """Stripping comments is not enough — a string literal can say `on('x')` too.

    An error message, a log line or a doc string in the *code* reads exactly like a
    registration to a comment-only scanner. This direction is the dangerous one: it
    does not add a false finding, it MASKS a real `emitted-no-handler` one, which is
    the silent pass this gate exists to prevent.
    """
    api_src, ts_path = _fixture_tree(
        tmp_path,
        _EMIT_TWO,
        "const msg = \"register it with on('beta_happened') — see the guide\";\n"
        "const alt = `or on('beta_happened') in a template literal`;\n"
        "on('alpha_happened', () => {});\n",
    )
    assert handler_registrations_in_source(ts_path) == ["alpha_happened"]
    assert [(v.kind, v.subject) for v in evaluate(api_src, ts_path, _ledger())] == [
        ("emitted-no-handler", "beta_happened")
    ]


def test_scanner_refuses_to_pass_vacuously(tmp_path: pathlib.Path) -> None:
    """Either half inspecting nothing raises, and never reports conformance.

    An empty scan satisfies every set difference above, so "no violations" and
    "nothing was scanned" are indistinguishable at the assertion. They must not be
    indistinguishable at the exit code: `boundary:imports` passed a real
    enterprise import for the whole life of the gate on exactly this shape (#3172).
    """
    api_src, ts_path = _fixture_tree(tmp_path, "def a(self):\n    return 1\n", "const x = 1;\n")
    with pytest.raises(ScanError, match="no broadcast_board_event"):
        broadcast_event_types_in_source(api_src)
    with pytest.raises(ScanError, match="no on\\(\\.\\.\\.\\) handler registrations"):
        handler_registrations_in_source(ts_path)


def test_scanner_refuses_an_unreadable_registration_form(tmp_path: pathlib.Path) -> None:
    """An `on(...)` whose types are not literals is loud, not silently "unhandled".

    Registering from a variable would make every event in it read as having no
    handler — a flood of false findings — or, if the parser skipped the call, make
    a real gap invisible. Neither is acceptable silently.
    """
    ts_path = tmp_path / "hook.ts"
    ts_path.write_text("on('alpha_happened', () => {});\non(EVENT_TYPES, () => {});\n", "utf-8")
    with pytest.raises(ScanError, match="cannot read as a literal"):
        handler_registrations_in_source(ts_path)


def test_every_waived_event_is_in_the_frozen_set() -> None:
    """A waiver naming an event the freeze guard does not know is a typo, not a decision.

    The ledger keys are hand-written; nothing else would catch `label_creted`, and
    a mistyped key silently waives nothing while looking like it waives something.
    Unemitted waivers are exempt: they name events that reach the client by a path
    the broadcast contract does not cover (`resync_required`, ADR-0236).
    """
    unknown = sorted(set(LEDGER.unhandled) - FROZEN_WS_EVENT_TYPES)
    assert not unknown, f"waived events absent from FROZEN_WS_EVENT_TYPES: {unknown}"
