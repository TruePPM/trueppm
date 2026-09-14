"""Dispatch contract for the OSS→Enterprise extension signals (#2606, #3777).

Two independent ways for this extension point to fail silently, guarded here
together because they share one helper.

**Robust dispatch (#2606).** The boundary contract is that OSS keeps working
regardless of what enterprise code does. That is a property of the dispatch, not
the declaration: ``send()`` propagates a receiver's exception to the sender, so a
bug in an enterprise receiver fails the OSS write path that fired the signal.
Two things are worth pinning down, and the second is the one that rots:

1. A raising receiver does not break the caller, and does not stop the other
   receivers from running.
2. ``history_record_created`` in particular. It is fired from the ``post_save``
   of every ``Historical*`` row for Project, Task and Dependency — one receiver
   away from breaking every task save in the product. The blast radius is what
   made it the first site to fix, and it is why it gets an end-to-end test
   through a real ``Task.save()`` rather than a direct dispatch.

**The sender convention (#3777).** ``sender`` had no convention: ten sites passed
a model class and six passed a string. Django filters receivers on sender
*identity*, so ``@receiver(celery_task_started, sender=SomeTask)`` against a
string-sendered dispatch never fired — no error, no warning, and nothing on the
Enterprise side that could notice. The rule is now **a model class, or ``None``
where the signal is not about a model row**, and it is enforced in three places,
each covering a hole the others have:

- ``mypy --strict`` rejects a non-class at any call site whose sender expression
  it can type — but every Celery bridge argument is ``Any``, and ``Any`` is
  assignable to ``type[Any] | None``, which is why the bug type-checked clean for
  its whole life. The signature tripwire below guards that layer.
- ``scripts/check-extension-signals.sh`` re-checks the *shape* of every
  ``sender=`` expression in the tree, catching those ``Any`` cases. It owns the
  tree-wide scan; deliberately not re-implemented here, because a second copy of
  a detection pattern is a copy that drifts.
- This module owns what neither can observe: that a class-sendered dispatch
  really does reach a class-filtered receiver, and that a convention violation at
  runtime is loud without being fatal.

The complement lives in ``tests/apps/agents/test_agent_action_prune.py``:
``agent_action_prune_requested`` is a fail-closed veto and must keep raising.
"""

from __future__ import annotations

import inspect
import logging
from datetime import date
from typing import Any

import django.dispatch
import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.history.signals import history_record_created
from trueppm_api.apps.projects.models import Calendar, Project, Risk, Task, TaskStatus
from trueppm_api.apps.projects.signals import risk_changed, task_status_changed
from trueppm_api.core.extension_signals import dispatch_extension_signal

User = get_user_model()

_LOGGER = "trueppm_api.core.extension_signals"


class _Model:
    """Stand-in for an OSS model class — the sender tests need no real one."""


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
# The sender convention (#3777)
# ---------------------------------------------------------------------------


def test_class_sender_reaches_a_class_filtered_receiver() -> None:
    """The whole point of the convention: the receiver Enterprise writes fires."""
    sig = django.dispatch.Signal()
    seen: list[Any] = []
    sig.connect(lambda sender, **kw: seen.append(sender), sender=_Model, weak=False)

    dispatch_extension_signal(sig, sender=_Model, thing_id="1")

    assert seen == [_Model]


def test_string_sender_would_not_reach_it() -> None:
    """The bug, pinned as a negative control.

    Without this, every other assertion here would also pass on a tree that had
    never been fixed — a receiver that simply never runs is indistinguishable
    from a signal that was never sent.
    """
    sig = django.dispatch.Signal()
    seen: list[Any] = []
    sig.connect(lambda sender, **kw: seen.append(sender), sender=_Model, weak=False)

    dispatch_extension_signal(sig, sender=_Model.__name__, thing_id="1")  # type: ignore[arg-type]

    assert seen == []


def test_none_sender_reaches_an_unfiltered_receiver_only() -> None:
    """What ``sender=None`` buys, and what it costs.

    The five Celery worker-run signals use it because they are not about a model
    row. An unfiltered receiver gets everything; a class-filtered one gets
    nothing — which is why those signals carry ``task_name`` in every payload as
    the discriminator a receiver branches on instead.
    """
    sig = django.dispatch.Signal()
    unfiltered: list[Any] = []
    filtered: list[Any] = []
    sig.connect(lambda sender, **kw: unfiltered.append(kw), weak=False)
    sig.connect(lambda sender, **kw: filtered.append(kw), sender=_Model, weak=False)

    dispatch_extension_signal(sig, sender=None, task_name="recalculate_schedule")

    assert unfiltered == [{"signal": sig, "task_name": "recalculate_schedule"}]
    assert filtered == []


@pytest.mark.parametrize("bad", ["_Model", 17, _Model()], ids=["str", "int", "instance"])
def test_bad_sender_is_logged_and_still_dispatched(
    bad: Any, caplog: pytest.LogCaptureFixture
) -> None:
    """A violation is loud, and never fatal.

    Deliberately not a raise. The helper exists so a third-party receiver cannot
    break the OSS write path that fired the signal; letting a *dispatch-site* bug
    break that same path would be a worse version of the failure it was written
    to prevent. The enforcement that stops one reaching main is static and runs
    before the code does.
    """
    sig = django.dispatch.Signal()
    seen: list[Any] = []
    sig.connect(lambda sender, **kw: seen.append(sender), weak=False)

    with caplog.at_level(logging.ERROR, logger=_LOGGER):
        dispatch_extension_signal(sig, sender=bad, thing_id="1")

    assert "#3777" in caplog.text
    # Still delivered to the receivers that would have got it anyway: a bad
    # sender must not also become a silent drop.
    assert seen == [bad]


def test_valid_senders_log_nothing(caplog: pytest.LogCaptureFixture) -> None:
    """The convention check must not become a permanent line of noise in the log."""
    sig = django.dispatch.Signal()
    with caplog.at_level(logging.ERROR, logger=_LOGGER):
        dispatch_extension_signal(sig, sender=_Model, thing_id="1")
        dispatch_extension_signal(sig, sender=None, task_name="x")

    assert [r for r in caplog.records if r.name == _LOGGER] == []


def test_sender_annotation_stays_narrow() -> None:
    """Tripwire on the mypy layer.

    ``sender: Any`` is what let the string form type-check clean at six call
    sites. Widening it back would disarm the cheapest of the three enforcement
    layers silently — nothing else in the pipeline would say a word.
    """
    annotation = inspect.signature(dispatch_extension_signal).parameters["sender"].annotation
    assert annotation == "type[Any] | None"


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


@pytest.mark.django_db
def test_history_record_created_senders_are_the_historical_classes(project: Project) -> None:
    """The sender is ``HistoricalTask``, not ``Task`` — reachable as ``Task.history.model``.

    Pinned because the site reads ``sender=type(instance)`` and the two candidate
    readings ("the row that was written" vs "the model that was mutated") are both
    defensible; the declaration in ``apps/history/signals.py`` documents this one,
    and a receiver filtering on the wrong class is the exact silent no-op #3777 is
    about.
    """
    seen: list[type] = []
    history_record_created.connect(
        lambda sender, **kw: seen.append(sender), sender=Task.history.model, weak=False
    )
    try:
        Task.objects.create(project=project, name="Tracked", duration=1)
    finally:
        history_record_created.disconnect(sender=Task.history.model)

    assert seen == [Task.history.model]


@pytest.mark.django_db
def test_task_status_changed_reaches_a_sender_filtered_receiver(project: Project) -> None:
    """``Task.save()`` really does dispatch with ``sender=Task``.

    The unit tests above prove the helper honors whatever it is handed; this
    proves a call site hands it the right thing, through the write path an
    Enterprise receiver would actually be wired to. It also covers the
    ``type(self)`` → ``Task`` normalization: both spellings satisfy this today,
    and the literal is the one that keeps satisfying it if Task is subclassed.
    """
    task = Task.objects.create(
        project=project, name="Design", duration=5, status=TaskStatus.NOT_STARTED
    )
    seen: list[dict[str, Any]] = []

    def _capture(sender: object, **kwargs: Any) -> None:
        seen.append(kwargs)

    task_status_changed.connect(_capture, sender=Task, weak=False)
    try:
        task.status = TaskStatus.IN_PROGRESS
        task.save()
    finally:
        task_status_changed.disconnect(_capture, sender=Task)

    assert len(seen) == 1
    assert seen[0]["old_status"] == TaskStatus.NOT_STARTED
    assert seen[0]["new_status"] == TaskStatus.IN_PROGRESS
    # Dispatched inline, inside the caller's transaction, so the payload carries
    # the instance rather than an id — the kwarg rule in the helper's module
    # docstring. A receiver cannot safely re-read an uncommitted row by id.
    assert seen[0]["task"] is task


@pytest.mark.django_db
def test_risk_changed_reaches_a_sender_filtered_receiver(project: Project) -> None:
    """Both ``Risk`` dispatch sites reach a ``sender=Risk`` receiver.

    The save path and the soft-delete path are separate call sites that were
    separately normalized from ``type(self)``, and ``Risk.save()`` suppresses its
    own signal when ``is_deleted`` is set so the delete emission comes from
    ``soft_delete()`` instead. Filtering on ``sender=Risk`` here rather than
    connecting unfiltered is the whole point: an unfiltered spy passes no matter
    what the sender is, which is why the existing suite could not have caught the
    bug class this issue is about.
    """
    seen: list[str] = []
    captured_senders: list[Any] = []

    def _capture(sender: Any, **kwargs: Any) -> None:
        captured_senders.append(sender)
        action = kwargs.get("action")
        if isinstance(action, str):
            seen.append(action)

    risk_changed.connect(_capture, sender=Risk, weak=False)
    try:
        risk = Risk.objects.create(project=project, title="R", probability=2, impact=3)
        risk.soft_delete()
    finally:
        risk_changed.disconnect(_capture, sender=Risk)

    assert seen == ["saved", "deleted"]
    assert captured_senders == [Risk, Risk]
