"""Tests for chain-aware pruning of the agent-action log (ADR-0361, #1842).

Covers the OSS admin-triggered prune and its checkpoint:

  * ``prune_agent_actions`` — dry-run reports without deleting; a committed prune deletes
    the oldest prefix, writes one checkpoint, and re-anchors the chain;
  * ``manage.py audit_verify`` — still passes across one and multiple prunes, on an
    empty-after-full prune, and after prune-then-append; still reports a break when a
    surviving row is tampered, or when rows are deleted **without** a checkpoint;
  * the ``agent_action_prune_requested`` legal-hold seam — a raising receiver vetoes the
    whole prune (fail-closed: nothing deleted, no checkpoint);
  * window validation and the ``audit_prune`` management command.
"""

from __future__ import annotations

from datetime import timedelta
from io import StringIO
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.utils import timezone

from trueppm_api.apps.agents.models import (
    AgentAction,
    AgentActionChainHead,
    AgentActionCheckpoint,
    AgentActionVerdict,
    AgentActorKind,
)
from trueppm_api.apps.agents.services import prune_agent_actions, record_agent_action
from trueppm_api.apps.agents.signals import agent_action_prune_requested
from trueppm_api.apps.projects.models import SCOPE_MCP_READ

User = get_user_model()


def _record(**overrides: Any) -> AgentAction:
    """Append one action with sensible defaults; ``occurred_at`` overridable for age tests."""
    kwargs: dict[str, Any] = dict(
        actor_kind=AgentActorKind.MCP_TOKEN,
        actor_token=None,
        principal=None,
        action="task-list",
        method="GET",
        capability_used=SCOPE_MCP_READ,
        verdict=AgentActionVerdict.ALLOWED,
        payload_hash="0" * 64,
    )
    kwargs.update(overrides)
    return record_agent_action(**kwargs)


def _chain(n: int) -> list[AgentAction]:
    return [_record(action=f"op-{i}") for i in range(n)]


# ---------------------------------------------------------------------------
# Dry-run
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_dry_run_reports_but_deletes_nothing() -> None:
    _chain(5)
    result = prune_agent_actions(keep_last=2, commit=False)

    assert result.eligible == 3
    assert result.deleted == 0
    assert result.committed is False
    assert result.cutoff_sequence == 3
    assert result.first_retained_sequence == 4
    # Nothing removed, no checkpoint written.
    assert AgentAction.objects.count() == 5
    assert AgentActionCheckpoint.objects.count() == 0


@pytest.mark.django_db
def test_dry_run_with_nothing_eligible_is_noop() -> None:
    _chain(2)
    result = prune_agent_actions(keep_last=10, commit=False)
    assert result.eligible == 0
    assert result.cutoff_sequence is None
    assert AgentActionCheckpoint.objects.count() == 0


# ---------------------------------------------------------------------------
# Committed prune + checkpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_keep_last_prunes_prefix_and_writes_checkpoint() -> None:
    rows = _chain(5)
    cutoff_hash = rows[2].record_hash  # sequence 3 — the last row that will be deleted

    result = prune_agent_actions(keep_last=2, commit=True)

    assert result.deleted == 3
    assert result.committed is True
    assert list(AgentAction.objects.values_list("sequence", flat=True)) == [4, 5]

    checkpoint = AgentActionCheckpoint.objects.get()
    assert checkpoint.pruned_through_sequence == 3
    assert checkpoint.pruned_through_hash == cutoff_hash
    assert checkpoint.first_retained_sequence == 4
    assert checkpoint.pruned_count == 3


@pytest.mark.django_db
def test_keep_days_prunes_only_old_prefix() -> None:
    now = timezone.now()
    # Three old rows, then two recent — occurred_at ascending with sequence.
    for i in range(3):
        _record(action=f"old-{i}", occurred_at=now - timedelta(days=100 + i))
    for i in range(2):
        _record(action=f"new-{i}", occurred_at=now - timedelta(days=1))

    result = prune_agent_actions(keep_days=30, commit=True)

    assert result.deleted == 3
    assert list(AgentAction.objects.values_list("sequence", flat=True)) == [4, 5]
    assert AgentActionCheckpoint.objects.get().pruned_through_sequence == 3


@pytest.mark.django_db
def test_before_never_deletes_a_row_newer_than_the_cutoff() -> None:
    # A younger row sits at a LOWER sequence than an older one (clock skew). The prefix rule
    # must stop at the first not-old row and never leave a mid-chain gap.
    now = timezone.now()
    _record(action="old-1", occurred_at=now - timedelta(days=100))  # seq 1 old
    _record(action="young", occurred_at=now)  # seq 2 young (boundary)
    _record(action="old-2", occurred_at=now - timedelta(days=100))  # seq 3 old but AFTER young

    result = prune_agent_actions(before=now - timedelta(days=30), commit=True)

    # Only the leading old row is pruned; seq 3 survives despite being old (contiguity wins).
    assert result.deleted == 1
    assert list(AgentAction.objects.values_list("sequence", flat=True)) == [2, 3]


# ---------------------------------------------------------------------------
# audit_verify across prunes
# ---------------------------------------------------------------------------


def _verify() -> str:
    out = StringIO()
    call_command("audit_verify", stdout=out)
    return out.getvalue()


@pytest.mark.django_db
def test_audit_verify_passes_across_a_prune() -> None:
    _chain(6)
    prune_agent_actions(keep_last=2, commit=True)
    out = _verify()  # must not raise
    assert "2 records verified" in out
    assert "checkpoint @seq 4" in out


@pytest.mark.django_db
def test_audit_verify_passes_across_multiple_prunes() -> None:
    _chain(6)
    prune_agent_actions(keep_last=4, commit=True)  # prune seq 1-2 → checkpoint @2
    prune_agent_actions(keep_last=2, commit=True)  # prune seq 3-4 → checkpoint @4
    assert AgentActionCheckpoint.objects.count() == 2
    out = _verify()
    # Seeds from the LATEST checkpoint (seq 4), verifies the surviving tail 5-6.
    assert "2 records verified" in out
    assert "checkpoint @seq 4" in out


@pytest.mark.django_db
def test_audit_verify_ok_when_everything_pruned() -> None:
    _chain(3)
    prune_agent_actions(keep_last=0, commit=True)
    assert AgentAction.objects.count() == 0
    out = _verify()
    assert "empty" in out.lower()


@pytest.mark.django_db
def test_prune_then_append_keeps_the_chain_sound() -> None:
    _chain(4)
    prune_agent_actions(keep_last=1, commit=True)
    # New appends continue from the untouched head.
    fifth = _record(action="after-prune")
    assert fifth.sequence == 5
    out = _verify()
    assert "2 records verified" in out  # seq 4 (retained) + seq 5 (new)


@pytest.mark.django_db
def test_audit_verify_still_detects_tampering_in_the_surviving_tail() -> None:
    _chain(5)
    prune_agent_actions(keep_last=2, commit=True)
    # Tamper a retained row without recomputing its hash.
    survivor = AgentAction.objects.get(sequence=5)
    survivor.summary = "tampered"
    survivor.save(update_fields=["summary"])
    with pytest.raises(CommandError, match="record_hash does not recompute"):
        call_command("audit_verify")


@pytest.mark.django_db
def test_deleting_rows_without_a_checkpoint_reports_a_break() -> None:
    # A raw prefix delete with NO checkpoint (i.e. bypassing the service) must surface as a
    # break — this is what makes the checkpoint, not silent deletion, the sanctioned path.
    _chain(5)
    AgentAction.objects.filter(sequence__lte=2).delete()
    assert AgentActionCheckpoint.objects.count() == 0
    with pytest.raises(CommandError, match="expected sequence 1"):
        call_command("audit_verify")


# ---------------------------------------------------------------------------
# Legal-hold seam
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_prune_requested_receiver_can_veto_the_prune() -> None:
    def _veto(sender: Any, **kwargs: Any) -> None:
        raise RuntimeError("legal hold")

    agent_action_prune_requested.connect(_veto)
    try:
        _chain(4)
        with pytest.raises(RuntimeError, match="legal hold"):
            prune_agent_actions(keep_last=1, commit=True)
    finally:
        agent_action_prune_requested.disconnect(_veto)

    # Fail-closed: the atomic prune rolled back — nothing deleted, no checkpoint.
    assert AgentAction.objects.count() == 4
    assert AgentActionCheckpoint.objects.count() == 0


@pytest.mark.django_db
def test_prune_requested_fires_with_the_cutoff() -> None:
    seen: dict[str, Any] = {}

    def _capture(sender: Any, **kwargs: Any) -> None:
        seen.update(kwargs)

    agent_action_prune_requested.connect(_capture)
    try:
        _chain(3)
        prune_agent_actions(keep_last=1, commit=True)
    finally:
        agent_action_prune_requested.disconnect(_capture)

    assert seen["cutoff_sequence"] == 2
    assert "cutoff_at" in seen


# ---------------------------------------------------------------------------
# Window validation + management command
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_exactly_one_window_required() -> None:
    with pytest.raises(ValueError, match="exactly one"):
        prune_agent_actions(commit=False)
    with pytest.raises(ValueError, match="exactly one"):
        prune_agent_actions(keep_last=1, keep_days=1, commit=False)


@pytest.mark.django_db
def test_command_dry_run_by_default_does_not_delete() -> None:
    _chain(4)
    out = StringIO()
    call_command("audit_prune", keep_last=1, stdout=out)
    assert "Dry-run only" in out.getvalue()
    assert AgentAction.objects.count() == 4
    assert AgentActionCheckpoint.objects.count() == 0


@pytest.mark.django_db
def test_command_commit_with_yes_deletes_and_checkpoints() -> None:
    _chain(4)
    out = StringIO()
    call_command("audit_prune", keep_last=1, commit=True, yes=True, stdout=out)
    assert "Pruned 3 row(s)" in out.getvalue()
    assert AgentAction.objects.count() == 1
    assert AgentActionCheckpoint.objects.count() == 1


@pytest.mark.django_db
def test_command_reports_nothing_to_prune() -> None:
    _chain(2)
    out = StringIO()
    call_command("audit_prune", keep_last=10, commit=True, yes=True, stdout=out)
    assert "Nothing to prune" in out.getvalue()
    assert AgentActionChainHead.objects.get(pk=1).last_sequence == 2


@pytest.mark.django_db
def test_command_records_actor_on_checkpoint() -> None:
    operator = User.objects.create_user(username="ops", password="pw")
    _chain(3)
    call_command("audit_prune", keep_last=1, commit=True, yes=True, actor="ops", stdout=StringIO())
    assert AgentActionCheckpoint.objects.get().pruned_by == operator


@pytest.mark.django_db
def test_command_unknown_actor_errors_before_deleting() -> None:
    _chain(3)
    with pytest.raises(CommandError, match="no user with username"):
        call_command("audit_prune", keep_last=1, commit=True, yes=True, actor="nobody")
    assert AgentAction.objects.count() == 3


@pytest.mark.django_db
def test_command_renders_clean_error_on_veto() -> None:
    def _veto(sender: Any, **kwargs: Any) -> None:
        raise RuntimeError("legal hold active")

    agent_action_prune_requested.connect(_veto)
    try:
        _chain(3)
        with pytest.raises(CommandError, match="Prune aborted — nothing deleted"):
            call_command("audit_prune", keep_last=1, commit=True, yes=True, stdout=StringIO())
    finally:
        agent_action_prune_requested.disconnect(_veto)
    assert AgentAction.objects.count() == 3


@pytest.mark.django_db
def test_through_sequence_pins_the_cutoff() -> None:
    _chain(5)
    # Pinning ignores any window and deletes exactly the prefix through the given sequence.
    result = prune_agent_actions(through_sequence=2, commit=True)
    assert result.deleted == 2
    assert list(AgentAction.objects.values_list("sequence", flat=True)) == [3, 4, 5]
    assert AgentActionCheckpoint.objects.get().pruned_through_sequence == 2
