"""Robust dispatch for the OSS→Enterprise extension signals (#2606).

The boundary contract is that OSS keeps working regardless of what enterprise
code does. That is a property of the dispatch, not the declaration: ``send()``
propagates a receiver's exception to the sender, so a bug in an enterprise
receiver fails the OSS write path that fired the signal.

Two things are worth pinning down, and the second is the one that rots:

1. A raising receiver does not break the caller, and does not stop the other
   receivers from running.
2. ``history_record_created`` in particular. It is fired from the ``post_save``
   of every ``Historical*`` row for Project, Task and Dependency — one receiver
   away from breaking every task save in the product. The blast radius is what
   made it the first site to fix, and it is why it gets an end-to-end test
   through a real ``Task.save()`` rather than a direct dispatch.

The complement lives in ``tests/apps/agents/test_agent_action_prune.py``:
``agent_action_prune_requested`` is a fail-closed veto and must keep raising.
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

import django.dispatch
import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.history.signals import history_record_created
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.core.extension_signals import dispatch_extension_signal

User = get_user_model()


def _boom(sender: object, **kwargs: object) -> None:
    raise ValueError("receiver exploded")


# ---------------------------------------------------------------------------
# The helper itself
# ---------------------------------------------------------------------------


def test_raising_receiver_does_not_propagate() -> None:
    sig = django.dispatch.Signal()
    sig.connect(_boom, weak=False)
    try:
        dispatch_extension_signal(sig, sender=object)
    finally:
        sig.disconnect(_boom)


def test_a_failing_receiver_does_not_starve_the_others() -> None:
    """send_robust runs every receiver; a first-receiver crash must not stop the rest.

    This is the difference that matters to an operator running enterprise: one
    broken integration should degrade itself, not the others registered beside it.
    """
    sig = django.dispatch.Signal()
    seen: list[str] = []

    def _ok(sender: object, **kwargs: object) -> None:
        seen.append("ok")

    sig.connect(_boom, weak=False)
    sig.connect(_ok, weak=False)
    try:
        dispatch_extension_signal(sig, sender=object)
    finally:
        sig.disconnect(_boom)
        sig.disconnect(_ok)
    assert seen == ["ok"]


def test_receiver_failure_is_logged(caplog: pytest.LogCaptureFixture) -> None:
    """Contained is not the same as invisible.

    ``send_robust`` swallows silently on its own — a receiver that has been
    failing for a week leaves no trace. The helper exists to make the failure
    both contained and findable, so the log line is part of the contract.
    """
    sig = django.dispatch.Signal()
    sig.connect(_boom, weak=False)
    try:
        with caplog.at_level(logging.ERROR, logger="trueppm_api.core.extension_signals"):
            dispatch_extension_signal(sig, sender=object)
    finally:
        sig.disconnect(_boom)

    assert any("Extension-signal receiver failed" in r.message for r in caplog.records)
    # The traceback must be attached, or the log line names a failure with no
    # way to diagnose it.
    assert any(r.exc_info is not None for r in caplog.records)


def test_payload_reaches_receivers() -> None:
    """Guard against the helper silently dropping kwargs while looking correct."""
    sig = django.dispatch.Signal()
    received: dict[str, Any] = {}

    def _capture(sender: object, **kwargs: object) -> None:
        received.update(kwargs)

    sig.connect(_capture, weak=False)
    try:
        dispatch_extension_signal(sig, sender=object, alpha=1, beta="two")
    finally:
        sig.disconnect(_capture)
    assert received["alpha"] == 1
    assert received["beta"] == "two"


# ---------------------------------------------------------------------------
# history_record_created — the highest-blast-radius site
# ---------------------------------------------------------------------------


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Std")
    owner = User.objects.create_user(username="owner-2606", password="pw")
    p = Project.objects.create(name="P", start_date=date(2026, 1, 1), calendar=calendar)
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


@pytest.mark.django_db
def test_task_save_survives_a_raising_history_receiver(project: Project) -> None:
    """A broken enterprise history receiver must not fail an ordinary task save.

    Exercised through a real save rather than a direct dispatch: the signal is
    wired from HistoryConfig.ready() to the Historical* post_save, and the point
    of the test is that the whole wired path is robust — a direct dispatch would
    still pass if the wiring changed underneath it.
    """
    history_record_created.connect(_boom, weak=False)
    try:
        task = Task.objects.create(project=project, name="T", duration=2)
        task.name = "T renamed"
        task.save(update_fields=["name"])
    finally:
        history_record_created.disconnect(_boom)

    task.refresh_from_db()
    assert task.name == "T renamed"


@pytest.mark.django_db
def test_history_receiver_still_receives_its_payload(project: Project) -> None:
    """Robustness must not have been bought by not firing the signal at all."""
    seen: list[str] = []

    def _capture(sender: object, **kwargs: object) -> None:
        history_type = kwargs.get("history_type")
        if isinstance(history_type, str):
            seen.append(history_type)

    history_record_created.connect(_capture, weak=False)
    try:
        Task.objects.create(project=project, name="Tracked", duration=1)
    finally:
        history_record_created.disconnect(_capture)

    assert "+" in seen
